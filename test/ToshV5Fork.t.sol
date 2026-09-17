// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @dev Minimal view of the deployed UniversalRouter. Declared here rather than
///      imported because `lib/` carries v4-core and v4-periphery but not
///      universal-router, and `execute` is the entire surface a swap needs.
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
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
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant POSITION_MANAGER = 0x55f4c8abA71A1e923edC303eb4fEfF14608cC226;

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

    uint256 internal constant SOFT_CAP = 1 ether;
    uint256 internal constant POG_CAP = 10 ether;

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

        vm.startPrank(admin);
        ladder = new ToshLadderTreasury(POOL_MANAGER, VAULT, admin);
        factory = new ToshFactory(POOL_MANAGER, VAULT, pogSigner, platformTreasury, address(ladder));
        ladder.setFactory(address(factory));

        factory.setDefaultSoftCap(SOFT_CAP);
        factory.setMaxPogAllocationLimit(POG_CAP);
        factory.setCooldownDuration(0);
        factory.setQuotaWindowDuration(0);
        vm.stopPrank();

        vm.deal(creator, 100 ether);
        vm.deal(funder, 100 ether);
        vm.deal(trader, 100 ether);
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
            address predicted = HookMiner.computeAddress(address(factory), finalSalt, initcodeHash);
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
        (address t, address h) = factory.createLaunch{value: fee}(
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
        factory.deposit{value: SOFT_CAP}(address(hook), address(0));

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
        assertEq(Currency.unwrap(key.currency0), address(0), "currency0 is not native ETH");
        assertEq(Currency.unwrap(key.currency1), address(token), "currency1 is not the project token");
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

    /// @dev Encode a production-path buy: native ETH in, project token out.
    ///
    ///      `zeroForOne` is always true because native ETH sorts to `currency0`.
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
        vm.prank(trader);
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: amountIn}(
            abi.encodePacked(CMD_INFI_SWAP), inputs, block.timestamp + 60
        );
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

        uint128 amountIn = 0.05 ether;
        uint256 tokensBefore = token.balanceOf(trader);
        uint256 ethBefore = trader.balance;

        _buyThroughRouter(hook.getPoolKey(), amountIn, 0);

        assertGt(token.balanceOf(trader) - tokensBefore, 0, "the production router path delivered no tokens");
        // The router took what it was told to and no more: no leftover pull, no
        // silent sweep of the caller's remaining balance.
        assertEq(ethBefore - trader.balance, amountIn, "router spent an amount we did not authorise");
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

        uint256 ladderBefore = address(ladder).balance;
        uint256 platformBefore = platformTreasury.balance;
        uint128 amountIn = 0.05 ether;

        _buyThroughRouter(hook.getPoolKey(), amountIn, 0);

        uint256 reservoirCut = address(ladder).balance - ladderBefore;
        uint256 platformCut = platformTreasury.balance - platformBefore;

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
        uint128 amountIn = 0.05 ether;
        bytes[] memory inputs = _buyInputs(hook.getPoolKey(), amountIn, type(uint128).max);

        vm.prank(trader);
        vm.expectRevert();
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: amountIn}(
            abi.encodePacked(CMD_INFI_SWAP), inputs, block.timestamp + 60
        );
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
}
