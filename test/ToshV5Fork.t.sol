// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolIdLibrary, PoolId} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
// Imported rather than restated, unlike `test/ToshV5ForkInfinity.t.sol`, which
// keeps its own copy so `scripts/checkV4RouterTuple.mjs` has a handwritten tuple
// to diff against upstream. A fork test wants the opposite: if PancakeSwap
// reshapes the params, this should break at compile time.
import {ICLRouterBase} from "infinity-periphery/src/pool-cl/interfaces/ICLRouterBase.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookAddress} from "../src/libraries/HookAddress.sol";

/// @dev Minimal view of the deployed UniversalRouter. Declared here rather than
///      imported because `lib/` carries v4-core and v4-periphery but not
///      universal-router, and `execute` is the entire surface a swap needs.
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice The one Permit2 entry point this suite needs.
///
/// @dev    Hand-declared rather than imported, and the reason is the same one
///         given for the router tuple below: the deployed contract is the
///         authority, and a `lib/` bump should not be able to change what this
///         file believes about it. One function, no structs, no ambiguity.
///
///         ⚠ NEW WITH THE QUOTE ASSET. Under native settlement the router's
///         `SETTLE_ALL` took `msg.value` and Permit2 was never in the path. An
///         ERC20 input goes through it, so a production-path buy now requires two
///         approvals instead of none — which is a real change to what a trader's
///         first transaction looks like, not only to this test.
interface IAllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice The periphery's own answer to "which Permit2 do you use".
///
/// @dev    One getter, declared here rather than imported, because the point of
///         asking is that the deployed contract is the authority and this file's
///         beliefs are what is being checked.
interface ICLPositionManagerPermit2 {
    function permit2() external view returns (address);
}

/// @notice Fork suite — the whole launch lifecycle against the **deployed**
///         PancakeSwap Infinity CL manager and Vault on BSC mainnet (56).
///
/// @dev    This closes a gap every other suite had: every
///         other suite runs against a manager and Vault this repository compiles
///         and deploys itself. That is the same source, but it is not the same
///         bytecode, and it is never the same surrounding state. What only a
///         fork can answer:
///
///           - the manager actually on chain accepts our hook, under ITS
///             compiled copy of the permission-bitmap rules rather than ours;
///           - `initialize` and the genesis liquidity mint work against a
///             manager that already holds live pools, so our pool id cannot
///             collide with and our accounting cannot disturb what is there;
///           - the periphery addresses `contracts.ts` ships (§2.2 of the
///             checklist) are the addresses that are really there, and the
///             manager and Vault name each other;
///           - `ArbSys` is ABSENT on this chain, which is the fact the hook's
///             `_hasArbSys` discriminator now has to come out false on.
///
///         ⚠ THE FIRST AND LAST OF THOSE BOTH FLIPPED IN THE PORT. This file
///           used to prove the deployed Uniswap V4 singleton accepted an address
///           our miner produced under the 0x20CC flag rules, and that Robinhood
///           registered `ArbSys` at `0x64`. Infinity reads permissions from the
///           hook rather than its address, and BSC has one clock — so the first
///           claim has no subject any more and the second is inverted. Neither
///           was weakened; both are now claims about a different platform.
///
///         **Skips rather than fails when `BSC_RPC` is unset**, which is how CI
///         sees it. A fork suite that goes red on a missing credential teaches
///         everyone to ignore red.
///
///         **It is not pinned**, and this is the one unfaithful thing left. It
///         had a fixed block until the Robinhood cutover, where the public
///         endpoint refused to serve one: state older than a few thousand blocks
///         came back `metadata is not found`. BSC's public endpoints are more
///         forgiving, so pinning is now a one-line change (`FORK_BLOCK`) that is
///         worth making and has not been made yet. Until then a failure is a
///         claim about the chain as it was that morning rather than one anybody
///         else can re-run.
///
///         Nothing here is mocked any more. The Robinhood era needed a
///         `ForkArbSys` etched over the chain's 1-byte stub at `0x64`, because a
///         fork copies the stub but not the node behind it and every test died
///         inside `beforeSwap`. On BSC there is nothing at `0x64` to work around.
contract ToshV5ForkTest is Test {
    using MessageHashUtils for bytes32;
    using PoolIdLibrary for PoolKey;

    // ─── The live deployment ──────────────────────────────────────────────────
    //
    // PancakeSwap Infinity on BSC mainnet (56). Sourced from PancakeSwap's
    // developer docs, tabulated in docs/PANCAKESWAP_INFINITY.md §7, and checked
    // against the chain itself by `test_fork_liveAddressesAreTheOnesWeShipTo` —
    // the one source that cannot be out of date. These must stay equal to
    // `soat-frontend/src/lib/contracts.ts`.
    //
    // ⚠ THESE USED TO BE UNISWAP V4 ON ROBINHOOD CHAIN (4663). Every address
    //   changed, and one is new: `VAULT`. Infinity splits what V4's PoolManager
    //   did in one contract — the CL manager runs the pool, the Vault holds every
    //   balance — so a fork test that only knows the manager cannot settle
    //   anything.

    address internal constant POOL_MANAGER = 0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b;
    address internal constant VAULT = 0x238a358808379702088667322f80aC48bAd5e6c4;
    address internal constant UNIVERSAL_ROUTER = 0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB;
    /// @dev ⚑ NOT UNISWAP'S CANONICAL PERMIT2, and the canonical address is the
    ///      trap. `0x000000000022D473030F116dDEE9F6B43aC78BA3` IS deployed on BSC
    ///      and does hold 9 KB of working Permit2 — so every check that looks for
    ///      Permit2 passes against it, and approving it looks like it worked. It is
    ///      simply not the one PancakeSwap's periphery consults.
    ///
    ///      Both `UniversalRouter` and `CLPositionManager` read this address
    ///      instead; `CLPositionManager.permit2()` returns it, which is how it was
    ///      identified. Approving the canonical one produced `AllowanceExpired`
    ///      from a contract this suite never mentioned, because an unset allowance
    ///      on the real Permit2 reports an expiry of zero.
    ///
    ///      This was invisible under native settlement: Permit2 was not in the path
    ///      at all, so nothing in the suite had to name it correctly.
    address internal constant PERMIT2 = 0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768;

    /// @dev Kept only so the assertion below can state the hazard rather than
    ///      leaving it in a comment.
    address internal constant UNISWAP_CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant POSITION_MANAGER = 0x55f4c8abA71A1e923edC303eb4fEfF14608cC226;

    /// @dev BEM on BSC mainnet — the quote asset every raise is denominated in,
    ///      and `currency0` of every pool.
    ///
    ///      ⚠ THIS SUITE IS NOW THE PRIMARY EVIDENCE THAT THE QUOTE ASSET WORKS,
    ///      and that is a deliberate trade rather than a happy accident. BEM is
    ///      not deployed on BSC testnet 97, so moving the unit of account to it
    ///      gave up the real-network rehearsal that choosing PancakeSwap Infinity
    ///      had been about acquiring (docs/BEM_QUOTE_ASSET.md §0, decision 1). A
    ///      mainnet fork against BEM's real bytecode is what was accepted in its
    ///      place.
    ///
    ///      What a fork still cannot substitute for is the passage of time on a
    ///      live network: the TWAP maturing over 30 real minutes, and a deploy
    ///      sequence that spans days. Those remain unrehearsed.
    ///
    ///      Balances here are written with `deal(token, to, amount)`, which
    ///      pokes the balance slot rather than acquiring BEM through its own
    ///      market. That is the right call for a test — BEM's only pool of
    ///      consequence held 1,959 tokens, so a genuine market buy of a raise-sized
    ///      amount would move the price it is trying to measure — but it does mean
    ///      nothing here says the supply exists to be bought.
    address internal constant BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;

    /// @dev The ArbSys precompile, kept only so its ABSENCE can be asserted:
    ///      `_hasArbSys` branches on the code length at this address, and on BSC
    ///      it must find nothing. Nothing etches over it any more.
    address internal constant ARB_SYS = 0x0000000000000000000000000000000000000064;

    // ─── UniversalRouter encoding ─────────────────────────────────────────────
    //
    // Encoded with `IV4Router.ExactInputSingleParams` straight out of `lib/`,
    // which is only safe because the two agree here. On Ethereum they did not:
    // that router predates this repository's v4-periphery and its decoder knows
    // nothing about the sixth `minHopPriceX36` field, so this file used to carry
    // a hand-rolled five-field copy of the deployed ABI. Robinhood's router is
    // the NEWER of the two — verified source on Blockscout, six fields — so the
    // hand-roll became the wrong one and importing became the honest one.
    //
    // The agreement is not a standing property of the world, it is a fact about
    // two versions that happen to line up today. `scripts/checkV4RouterTuple.mjs`
    // pins the deployed layout as a literal and fails the build if a `lib/` bump
    // moves out from under it, because the failure mode is silent: a longer or
    // reordered tuple is still valid calldata and the router would misread every
    // field after `poolKey` rather than revert.

    uint8 internal constant CMD_INFI_SWAP = 0x10;
    uint8 internal constant ACTION_CL_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACTION_SETTLE_ALL = 0x0c;
    uint8 internal constant ACTION_TAKE_ALL = 0x0f;

    // ─── Fixture ──────────────────────────────────────────────────────────────

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal funder = makeAddr("funder");
    address internal trader = makeAddr("trader");
    address internal platformTreasury = makeAddr("platformTreasury");
    address internal projTreasury = makeAddr("projTreasury");

    uint256 internal pogSignerPk = 0xBEEF_CAFE;
    address internal pogSigner;

    ToshLadderTreasury internal ladder;
    ToshFactory internal factory;

    /// @dev Real BEM, not a mock. Typed as `IERC20` rather than `MockQuoteAsset`
    ///      precisely so nothing in this file can call `mint`.
    IERC20 internal quote;

    uint256 internal constant SOFT_CAP = 100e8;
    uint256 internal constant POG_CAP = 1000e8;

    int24 internal constant TICK_LOWER = -887200;
    int24 internal constant TICK_UPPER = 887200;

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        // Unpinned. See the contract docstring — the public endpoint cannot
        // serve a fixed block for longer than it takes to write one down.
        vm.createSelectFork(rpc);
        forked = true;

        // No `_installArbSys()`. BSC has no such precompile, which is the branch
        // the hook's constructor takes when it finds nothing at 0x64 — so this
        // fork exercises the fallback rather than needing a mock to get past it.

        pogSigner = vm.addr(pogSignerPk);

        // No mock quote asset here, unlike every other suite. The point of this
        // file is the real deployment, and after the BEM decision that includes
        // the real quote asset: `MockQuoteAsset` would only confirm that an
        // 8-decimal ERC20 works, which the local suite already does.
        quote = IERC20(BEM);
        assertEq(IERC20Metadata(BEM).decimals(), 8, "BEM must still be 8 decimals for any of this to hold");

        vm.startPrank(admin);
        ladder = new ToshLadderTreasury(POOL_MANAGER, VAULT, admin, BEM);
        factory = new ToshFactory(POOL_MANAGER, VAULT, pogSigner, platformTreasury, address(ladder), BEM);
        ladder.setFactory(address(factory));

        factory.setDefaultSoftCap(SOFT_CAP);
        factory.setMaxPogAllocationLimit(POG_CAP);
        factory.setCooldownDuration(0);
        factory.setQuotaWindowDuration(0);
        vm.stopPrank();

        // Native for gas only.
        vm.deal(creator, 100 ether);
        vm.deal(funder, 100 ether);
        vm.deal(trader, 100 ether);

        _endow(creator);
        _endow(funder);
        _endow(trader);
    }

    /// @dev Write a BEM balance and approve the platform-global spenders.
    ///
    ///      `deal(token, ...)` rather than `mint`: BEM is somebody else's
    ///      contract, and this fixture has no authority over it. Foundry finds
    ///      the balance slot and writes it, which is the only way a fork test can
    ///      hold an amount the open market could not supply.
    ///
    ///      100,000 BEM is over HALF OF BEM'S ENTIRE SUPPLY (191,739). That is
    ///      acceptable in a test whose subject is the code path, and it is exactly
    ///      the sort of figure `docs/BEM_QUOTE_ASSET.md` §1.2 is about: nothing
    ///      here is evidence that a real depositor could assemble it.
    function _endow(address who) internal {
        deal(BEM, who, 100_000e8);
        vm.startPrank(who);
        quote.approve(address(factory), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Set an exact BEM balance, the way `vm.deal` set an exact native one.
    ///      The buyback reservoir arms on its token balance now.
    function _setQuote(address who, uint256 amount) internal {
        deal(BEM, who, amount);
    }

    /// @dev Every test calls this first. `vm.skip` reports the test as skipped
    ///      rather than passed, so a run without an RPC cannot be mistaken for
    ///      evidence that the fork path works.
    function _requireFork() internal {
        vm.skip(!forked, "BSC_RPC unset, see .env.example");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Helpers — deliberately duplicated from ToshV5.t.sol rather than shared
    //
    //  A shared base would let a refactor of the local suite quietly change
    //  what the fork suite asserts. These are short, and the point of this file
    //  is to be an independent second opinion.
    // ══════════════════════════════════════════════════════════════════════════

    function _pickSalt() internal view returns (bytes32 rawSalt) {
        bytes32 initcodeHash = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        for (uint256 i; i < 1000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(creator, rawSalt));
            address predicted = HookAddress.computeAddress(address(factory), finalSalt, initcodeHash);
            if (predicted.code.length == 0) return rawSalt;
        }
        revert("_pickSalt: first 1000 salts are all occupied");
    }

    function _registerPoG(address user) internal {
        uint256 nonce = factory.pogNonces(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encode(user, POG_CAP, nonce, deadline, address(factory), block.chainid))
            .toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pogSignerPk, digest);
        vm.prank(user);
        factory.registerPoG(POG_CAP, deadline, nonce, abi.encodePacked(r, s, v));
    }

    function _createProject() internal returns (ToshToken token, ToshLaunchpadHook hook) {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (address t, address h) = factory.createLaunch(
            "ForkTest", "FRK", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
        return (ToshToken(t), ToshLaunchpadHook(payable(h)));
    }

    /// @dev Create -> fund to the soft cap -> `launch()`. After this the pool is
    ///      live inside the deployed singleton.
    function _launchProject() internal returns (ToshToken token, ToshLaunchpadHook hook) {
        (token, hook) = _createProject();

        _registerPoG(funder);
        vm.prank(funder);
        factory.deposit(address(hook), address(0), SOFT_CAP);

        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        hook.launch();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The live deployment is what we think it is
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Every address the mainnet cutover will hard-code is present and
    ///         is a contract, checked against the chain rather than a document.
    ///
    /// @dev    §2.2 of the checklist carries these as a table verified against
    ///         three off-chain sources. All three can be stale at once; the
    ///         chain cannot. `POOL_MANAGER` matters most: it is deliberately a
    ///         source-code constant rather than env-bound, because a wrong
    ///         value silently mis-`CREATE2`s every hook rather than reverting.
    function test_fork_liveAddressesAreTheOnesWeShipTo() public {
        _requireFork();

        assertGt(POOL_MANAGER.code.length, 0, "no CLPoolManager at the cutover address");
        assertGt(VAULT.code.length, 0, "no Vault at the cutover address");
        assertGt(UNIVERSAL_ROUTER.code.length, 0, "no UniversalRouter at the cutover address");
        assertGt(PERMIT2.code.length, 0, "no Permit2 at the cutover address");

        // "There is code there" is not evidence of the right Permit2, and this is
        // the assertion that says so: the canonical Uniswap address is ALSO live on
        // BSC, so a presence check cannot distinguish them. The periphery's own
        // answer can, so ask it.
        assertGt(UNISWAP_CANONICAL_PERMIT2.code.length, 0, "fixture assumes the canonical one is live too");
        assertTrue(PERMIT2 != UNISWAP_CANONICAL_PERMIT2, "and that these are two different contracts");
        assertEq(
            ICLPositionManagerPermit2(POSITION_MANAGER).permit2(),
            PERMIT2,
            "the periphery must agree on which Permit2 it pulls through"
        );
        assertGt(POSITION_MANAGER.code.length, 0, "no CLPositionManager at the cutover address");

        // ⚠ A BYTECODE-LENGTH ASSERTION WAS REMOVED HERE, and replaced by a
        //   stronger one rather than re-measured.
        //
        //   It read `assertEq(POOL_MANAGER.code.length, 24_009)`, and its
        //   argument was that Robinhood's V4 singleton being byte-identical in
        //   length to Ethereum's was cheap evidence of the same v4-core build.
        //   Carrying that idea over would mean pinning Infinity's own length,
        //   which proves nothing: there is no second deployment to agree with.
        //
        //   What is checkable here, and was not on V4, is that the two contracts
        //   we depend on agree about each other. The manager names its Vault
        //   immutably, so a squatted or mismatched address cannot satisfy this.
        assertEq(address(ICLPoolManager(POOL_MANAGER).vault()), VAULT, "the manager does not name this Vault");

        assertEq(block.chainid, 56, "fork is not BSC mainnet");
    }

    /// @notice `ArbSys` is NOT registered at `0x64` on this chain, so the hook
    ///         counts blocks with `block.number`.
    ///
    /// @dev    ⚠ THIS ASSERTION IS INVERTED FROM WHAT IT SAID ON ROBINHOOD, and
    ///           inverting it was the point rather than a consequence.
    ///
    ///         The hook decides once, in its constructor, whether to read the
    ///         chain's height from `ArbSys` or from `block.number`, and it
    ///         decides by asking whether `0x64` holds code. On Robinhood the
    ///         answer had to be yes: `NUMBER` there returns the L1 height, so a
    ///         hook that trusted it would stamp `lastSwapBlock` ~21M blocks away
    ///         from everything comparing against it, and the same-block lockout
    ///         would never once fire.
    ///
    ///         BSC has one clock. `block.number` IS the chain's height, there is
    ///         no precompile at `0x64`, and the discriminator must therefore come
    ///         out false. That is not a weaker claim than the old one — it is the
    ///         same claim about a different chain, and it is the premise the
    ///         lockout now rests on. A future BSC upgrade that put anything at
    ///         `0x64` would silently route the hook down the Arbitrum branch and
    ///         make `arbBlockNumber()` the source of truth for a guard that has
    ///         no business calling it.
    ///
    ///         Read live rather than mocked. `ForkArbSys` and `_installArbSys`
    ///         used to sit in this file to get past the Robinhood stub, and both
    ///         are gone: there is nothing to etch over, and a mock here would
    ///         defeat the only test that asks the chain directly.
    ///         `test/ToshV5ArbSys.t.sol` still forces the two clocks apart, which
    ///         is where the branch itself is exercised.
    /// @notice Real BEM's `approve` accepts a nonzero-to-nonzero change, and the
    ///         whole frontend approval flow depends on it.
    ///
    /// @dev    Every quote-denominated action in the UI now needs an allowance, and
    ///         `useQuoteApproval` grants exactly what the action costs rather than
    ///         an unlimited one. That leaves a small residue behind whenever the
    ///         charged amount comes in under the approved bound — `mintBondingCurve`
    ///         charges the true cost against a `maxCost` ceiling — so the NEXT
    ///         approve is routinely a nonzero-to-nonzero write.
    ///
    ///         Plain ERC-20 permits that. USDT-style tokens do not: they
    ///         `require(allowance == 0)` and revert, which would strand any user
    ///         carrying a residue behind a button that could never be unstuck
    ///         without a manual zero-approve they have no way to discover. Whether
    ///         BEM is one of those is a property of deployed bytecode, not of a
    ///         standard, so it is measured here against the real contract rather
    ///         than assumed anywhere in the frontend.
    ///
    ///         If this ever fails, `useQuoteApproval` needs a zero-first step and
    ///         the mock in the unit suites needs the same behaviour to match.
    function test_fork_realBemApproveAcceptsANonzeroToNonzeroChange() public {
        address holder = makeAddr("approver");
        address spender = makeAddr("puller");

        vm.startPrank(holder);
        quote.approve(spender, 1_000e8);
        assertEq(quote.allowance(holder, spender), 1_000e8, "first approve must land");

        // The case a residue produces: overwrite a live, nonzero allowance.
        quote.approve(spender, 7e8);
        assertEq(quote.allowance(holder, spender), 7e8, "BEM must allow a nonzero-to-nonzero approve");

        // And the zero-first path still works, so the fallback remains available.
        quote.approve(spender, 0);
        quote.approve(spender, 42e8);
        assertEq(quote.allowance(holder, spender), 42e8, "and zero-first must remain a valid route");
        vm.stopPrank();
    }

    function test_fork_theChainHasNoArbSysSoTheHookUsesBlockNumber() public {
        _requireFork();

        assertEq(ARB_SYS.code.length, 0, "something lives at 0x64: the hook would read heights from ArbSys");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The lifecycle, against the singleton that is really there
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Mine, create, fund, launch — and the deployed singleton holds an
    ///         initialised pool with our genesis liquidity locked in it.
    ///
    /// @dev    The assertion that matters is not that the calls returned, it is
    ///         that `getSlot0` on the LIVE singleton reports a price for our
    ///         pool id. That can only be true if the deployed contract accepted
    ///         our hook address under its own copy of the flag rules, accepted
    ///         our `PoolKey`, and ran our `beforeInitialize`/`afterInitialize`
    ///         callbacks to completion.
    function test_fork_lifecycleAgainstLivePoolManager() public {
        _requireFork();

        (ToshToken token, ToshLaunchpadHook hook) = _launchProject();

        assertTrue(hook.launched(), "hook does not consider itself launched");

        PoolKey memory key = hook.getPoolKey();
        PoolId id = key.toId();

        (uint160 sqrtPriceX96,,,) = ICLPoolManager(POOL_MANAGER).getSlot0(id);
        assertGt(sqrtPriceX96, 0, "live singleton has no price for our pool");

        // `getLiquidity`, not V4's `getPositionInfo` behind `StateLibrary`:
        // Infinity's CLPoolManager exposes position state as a plain view
        // function, so there is no `extsload` reader to go through.
        uint128 liquidity =
            ICLPoolManager(POOL_MANAGER).getLiquidity(id, address(hook), TICK_LOWER, TICK_UPPER, bytes32(0));
        assertGt(liquidity, 0, "genesis LP is not in the live singleton");

        // The hook holds the position, and nothing can withdraw it: there is no
        // code path in the hook that decreases this liquidity. Asserted here
        // because a fork is the only place the position is real.
        // On a fork this is a stronger statement than in the unit suites: the
        // ordering is checked against REAL BEM's address rather than a mock's, so it
        // is the CREATE2 grind clearing the actual floor it will have to clear in
        // production. It used to read `address(0)`, which the native quote asset
        // made true for free.
        assertEq(Currency.unwrap(key.currency0), BEM, "currency0 must be BEM");
        assertEq(Currency.unwrap(key.currency1), address(token), "currency1 is not the project token");
        assertLt(uint160(BEM), uint160(address(token)), "the grind must have sorted the token above real BEM");
    }

    /// @notice Our pool id does not collide with anything already live, and
    ///         initialising it leaves the rest of the singleton alone.
    ///
    /// @dev    A fresh local `PoolManager` has exactly one pool in it, so this
    ///         property is vacuous everywhere except here. The pool id is a
    ///         hash of the key including the hook address, and the hook address
    ///         is CREATE2-derived from a factory nobody has deployed before —
    ///         but "should be unique" and "is unique against the real set" are
    ///         different claims, and only one of them is testable.
    function test_fork_ourPoolIdIsFreshOnTheLiveSingleton() public {
        _requireFork();

        (, ToshLaunchpadHook hook) = _createProject();
        PoolId id = hook.getPoolKey().toId();

        (uint160 before,,,) = ICLPoolManager(POOL_MANAGER).getSlot0(id);
        assertEq(before, 0, "the live singleton already has a pool at our id");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The production swap path
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Encode a production-path buy: BEM in, project token out.
    ///
    ///      `zeroForOne` is still always true, but NOT for the reason it used to
    ///      be. Native ETH sorted to `currency0` because nothing sorts below
    ///      `address(0)`; BEM sits at `0x5ce0…` and would be `currency1` for
    ///      roughly a third of nonce-derived token addresses. The ordering now
    ///      holds because `ToshCloneLib.deployBareCloneAbove` grinds every project
    ///      token above the quote asset — so this `true` is an assertion about the
    ///      factory rather than about the address space.
    ///
    ///      `minOut` is passed to both the swap (as `amountOutMinimum`) and to
    ///      `TAKE_ALL`, which is how the router expects a caller to state a
    ///      slippage bound.
    ///
    ///      Returns the calldata rather than firing it so a caller that needs
    ///      `vm.expectRevert` can put the cheatcode immediately before the call
    ///      instead of behind a helper's `vm.prank`.
    /// @dev ⚠ THE FOUR-ARGUMENT OVERLOAD IS GONE, and with it the ability to set
    ///      `minHopPriceX36`. Infinity's tuple has no such field, so there is
    ///      nothing to vary — `amountOutMinimum` is the only slippage bound the
    ///      router offers, which is what the frontend sends anyway.
    function _buyInputs(PoolKey memory key, uint128 amountIn, uint128 minOut)
        internal
        pure
        returns (bytes[] memory inputs)
    {
        bytes memory actions = abi.encodePacked(ACTION_CL_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL);

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ICLRouterBase.CLSwapExactInputSingleParams({
                poolKey: key, zeroForOne: true, amountIn: amountIn, amountOutMinimum: minOut, hookData: ""
            })
        );
        params[1] = abi.encode(key.currency0, amountIn);
        params[2] = abi.encode(key.currency1, uint256(minOut));

        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
    }

    function _buyThroughRouter(PoolKey memory key, uint128 amountIn, uint128 minOut) internal {
        bytes[] memory inputs = _buyInputs(key, amountIn, minOut);
        // `SETTLE_ALL` on an ERC20 currency pulls through Permit2, not through
        // `msg.value`. The router asks Permit2 for the tokens, and Permit2 asks
        // the token for them, so BOTH approvals are needed and neither is
        // redundant: without the first, Permit2 has no allowance to draw on;
        // without the second, the router has no Permit2 permission to invoke.
        vm.startPrank(trader);
        quote.approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2)
            .approve(address(quote), UNIVERSAL_ROUTER, type(uint160).max, uint48(block.timestamp + 3600));
        vm.stopPrank();

        vm.prank(trader);
        IUniversalRouter(UNIVERSAL_ROUTER).execute(abi.encodePacked(CMD_INFI_SWAP), inputs, block.timestamp + 60);
    }

    /// @notice A buy through the **deployed UniversalRouter**, which is the path
    ///         real traffic takes.
    ///
    /// @dev    This is the second half of the §4 gap. Every other swap in this
    ///         repository goes through v4-core's `CLPoolManagerRouter`, a test double
    ///         that calls `unlock` directly. The UniversalRouter reaches the
    ///         same `swap` through its own command dispatcher, its own delta
    ///         settlement and its own slippage accounting — and our hook takes
    ///         a 100 bps cut inside that flow via `beforeSwap`/`afterSwap`.
    ///         Whether those two agree about who owes what is not something the
    ///         test double can answer.
    ///
    ///         The trace this produces is worth reading once (`-vvvv`): the
    ///         router calls `unlock` on the singleton, the singleton calls back
    ///         into the router, and only then does `swap` reach `beforeSwap`
    ///         with `sender` set to the router rather than to a test contract.
    function test_fork_buyThroughRealUniversalRouter() public {
        _requireFork();

        (ToshToken token, ToshLaunchpadHook hook) = _launchProject();

        uint128 amountIn = 5e8;
        uint256 tokensBefore = token.balanceOf(trader);
        uint256 ethBefore = quote.balanceOf(trader);

        _buyThroughRouter(hook.getPoolKey(), amountIn, 0);

        assertGt(token.balanceOf(trader) - tokensBefore, 0, "the production router path delivered no tokens");
        // The router took what it was told to and no more: no leftover pull, no
        // silent sweep of the caller's remaining balance.
        assertEq(ethBefore - quote.balanceOf(trader), amountIn, "router spent an amount we did not authorise");
    }

    /// @notice The buy tax is **exactly** 100 bps of the input through the
    ///         production router, and it arrives SPLIT — 70 bps to the ladder
    ///         treasury, 30 bps to the platform.
    ///
    /// @dev    Asserted as equality rather than `> 0` on purpose. The tax is
    ///         skimmed inside the hook's swap callbacks, so it is the part most
    ///         exposed to a difference in how the caller settles its deltas —
    ///         and the failure that would actually cost money is not "no tax"
    ///         but "wrong tax", which a `> 0` assertion cannot see.
    ///
    ///         ⚠ The treasury's expected delta is `TAX_BPS - PLATFORM_SWAP_FEE_BPS`,
    ///         NOT `TAX_BPS`.  It was `TAX_BPS` while the two happened to be the
    ///         same number, and reading the headline rate off the hook made that
    ///         look principled rather than coincidental.  It is the reservoir's
    ///         own share that belongs here.
    ///
    ///         The conservation assertion is the one that matters most on this
    ///         path: both call sites hand V4 a hook delta of exactly `tax`, so
    ///         if the two `take`s do not sum back to it the swap reverts
    ///         `CurrencyNotSettled` rather than merely mispaying.  Against the
    ///         real singleton, this is the check that says the split did not
    ///         break settlement.
    function test_fork_buyTaxIsExactThroughTheRealRouter() public {
        _requireFork();

        (, ToshLaunchpadHook hook) = _launchProject();

        uint256 ladderBefore = quote.balanceOf(address(ladder));
        uint256 platformBefore = quote.balanceOf(platformTreasury);
        uint128 amountIn = 5e8;

        _buyThroughRouter(hook.getPoolKey(), amountIn, 0);

        uint256 reservoirCut = quote.balanceOf(address(ladder)) - ladderBefore;
        uint256 platformCut = quote.balanceOf(platformTreasury) - platformBefore;

        uint256 expectedReservoir = (amountIn * (hook.TAX_BPS() - hook.PLATFORM_SWAP_FEE_BPS())) / 10_000;
        uint256 expectedPlatform = (amountIn * hook.PLATFORM_SWAP_FEE_BPS()) / 10_000;

        assertEq(reservoirCut, expectedReservoir, "reservoir share through the real router is wrong");
        assertEq(platformCut, expectedPlatform, "platform share through the real router is wrong");
        assertEq(
            reservoirCut + platformCut,
            (uint256(amountIn) * hook.TAX_BPS()) / 10_000,
            "the split must conserve the whole skim, or V4 would not have settled"
        );
    }

    /// @notice A slippage bound the pool cannot satisfy makes the deployed router
    ///         revert the whole swap.
    ///
    /// @dev    This is the property that protects users from the tax rather than
    ///         the one that collects it. Our hook reduces the input before the
    ///         swap prices it, so if the router computed its `amountOutMinimum`
    ///         check against the PRE-tax figure it would let a trader through a
    ///         bound they did not actually clear. The bound below is far past
    ///         anything this pool can pay, so a pass means the router is reading
    ///         the real, post-hook output.
    function test_fork_routerSlippageBoundIsEnforcedOverOurTax() public {
        _requireFork();

        (, ToshLaunchpadHook hook) = _launchProject();

        // Orders of magnitude past the whole genesis supply, so this can only
        // fail to revert if the check is not happening at all.
        uint128 amountIn = 5e8;
        bytes[] memory inputs = _buyInputs(hook.getPoolKey(), amountIn, type(uint128).max);

        // Approved first, deliberately. Without this the revert would still
        // happen and the test would still pass — on a Permit2 allowance failure
        // rather than on the slippage bound, which is the assertion quietly
        // evaporating. The bound is what has to do the reverting.
        vm.startPrank(trader);
        quote.approve(PERMIT2, type(uint256).max);
        IAllowanceTransfer(PERMIT2)
            .approve(address(quote), UNIVERSAL_ROUTER, type(uint160).max, uint48(block.timestamp + 3600));
        vm.stopPrank();

        vm.prank(trader);
        vm.expectRevert();
        IUniversalRouter(UNIVERSAL_ROUTER).execute(abi.encodePacked(CMD_INFI_SWAP), inputs, block.timestamp + 60);
    }

    // ⚠ `test_fork_deployedRouterReadsTheSixthField` WAS DELETED HERE, and it is
    //   worth saying why it is not replaced in this file.
    //
    //   It forced `minHopPriceX36` to `type(uint256).max` and expected a revert,
    //   which proved the deployed router read word 9 at the offset the six-field
    //   Uniswap layout puts it. Infinity's tuple has no `minHopPriceX36`, so
    //   there is no field to force and no sixth word to find.
    //
    //   The question it answered — does the deployed router decode the layout we
    //   encode? — still needs answering, and it is answered in
    //   `test/ToshV5ForkInfinity.t.sol` by two tests written for the harder case
    //   the port created. The Uniswap and Infinity tuples encode to the SAME ten
    //   head slots and the same `0x160` length floor, because Infinity drops
    //   `minHopPriceX36` exactly as its `PoolKey` gains a member. Neither
    //   decoder's length check can therefore reject the other's calldata, which
    //   is a sharper trap than the one this test was built for.
    //   `test_forkInfinity_theUniswapShapedTupleIsNotInterchangeable` measures
    //   the near-miss; `scripts/checkV4RouterTuple.mjs` check 6 pins it. See
    //   docs/PANCAKESWAP_INFINITY.md §10.

    // ══════════════════════════════════════════════════════════════════════════
    //  The buyback, which the testnet rehearsal cannot reach
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice The ladder treasury's buy-and-burn settles through the DEPLOYED
    ///         Vault, and the listing gate that guards it opens on a clock.
    ///
    /// @dev    Two things brought this test here, and neither is reachable
    ///         elsewhere.
    ///
    ///         First, the buyback is the last piece of Infinity plumbing with no
    ///         evidence against real bytecode. The ten local buyback tests all
    ///         run against a Vault this repository compiled, and the RH-F1
    ///         testnet rehearsal cannot close the gap for a reason no amount of
    ///         care fixes: `TRIGGER_STEP` is a 3.5 BNB constant, so arming the
    ///         reservoir from swap tax alone needs roughly 500 BNB of volume
    ///         through a testnet pool. `vm.deal` on a fork is the only way to
    ///         stand the reservoir up and still be driving deployed code.
    ///
    ///         Second, the listing gate. `addLadderToken` reads
    ///         `twapSqrtPriceX96()` and refuses 0, and `launch()` sets both
    ///         oracle checkpoints to the launching timestamp — so a token cannot
    ///         be listed until `TWAP_WINDOW` has passed, and no ordering of
    ///         transactions shortens that. The local suite has always known this
    ///         (`_matureTwap()` precedes every `addLadderToken` in it) but the
    ///         knowledge lived only in a helper, so nothing FAILED when the
    ///         testnet rehearsal script broadcast `launch()` and
    ///         `addLadderToken` as one script. It reverted `TwapNotMature()` in
    ///         simulation on every attempt. The negative assertion below is that
    ///         helper's reason, stated as a test.
    function test_fork_buybackSettlesThroughTheDeployedVault() public {
        _requireFork();

        (ToshToken token, ToshLaunchpadHook hook) = _launchProject();

        // The gate, before the clock has moved. This is the exact call the
        // rehearsal script made one transaction after `launch()`.
        assertEq(hook.twapSqrtPriceX96(), 0, "a TWAP exists in the launch window");
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TwapNotMature.selector);
        ladder.addLadderToken(address(token));

        vm.warp(block.timestamp + hook.TWAP_WINDOW());
        assertGt(hook.twapSqrtPriceX96(), 0, "TWAP_WINDOW passed and the TWAP is still 0");

        vm.prank(admin);
        ladder.addLadderToken(address(token));
        assertEq(ladder.ladderTokenCount(), 1, "token not listed");

        // Arm the reservoir directly. Its provenance is irrelevant to what is
        // under test here — the treasury's payable fallback is the same door the
        // buy tax arrives through, and `ToshV5.t.sol` covers the tax path.
        _setQuote(address(ladder), 10 ether);
        vm.roll(block.number + 1);

        uint256 reservoirBefore = quote.balanceOf(address(ladder));
        uint256 burnedBefore = token.balanceOf(ladder.DEAD_ADDRESS());
        uint256 vaultTokensBefore = token.balanceOf(VAULT);

        // Permissionless, and deliberately called by an address with no role.
        vm.prank(trader);
        ladder.pokeBuyback();

        assertLt(quote.balanceOf(address(ladder)), reservoirBefore, "the reservoir did not spend");
        assertGt(token.balanceOf(ladder.DEAD_ADDRESS()), burnedBefore, "nothing was bought and burned");

        // The Vault is the settlement layer, not the manager: a buyback that
        // paid native in and took token out has to have moved the Vault's token
        // balance down. Asserting on the manager instead would read 0 on a
        // healthy fill, which is the mistake `scripts/auditLaunch.mjs` was
        // carrying before the port.
        assertLt(token.balanceOf(VAULT), vaultTokensBefore, "the swap did not settle through the deployed Vault");

        // A buyback is a swap, so it must arm the same-block mint lockout like
        // any other. `afterSwap` returns early for the treasury, and the stamp
        // used to sit inside that early return.
        assertEq(hook.lastSwapBlock(), block.number, "the buyback did not stamp lastSwapBlock");
    }
}
