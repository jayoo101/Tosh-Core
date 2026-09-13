// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary, PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";

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

/// @dev Stand-in for the `ArbSys` precompile, needed because Foundry does not
///      have one. See `_installArbSys` for why a fork of an Arbitrum chain
///      cannot run this suite without it.
contract ForkArbSys {
    uint256 private _height;

    function arbBlockNumber() external view returns (uint256) {
        return _height;
    }

    function setHeight(uint256 h) external {
        _height = h;
    }
}

/// @notice Fork suite — the whole launch lifecycle against the **deployed**
///         Uniswap V4 singleton on Robinhood Chain (4663).
///
/// @dev    This closes a gap every other suite had: every
///         other suite runs against a `PoolManager` this repository compiles
///         and deploys itself. That is the same source, but it is not the same
///         bytecode, and it is never the same surrounding state. What only a
///         fork can answer:
///
///           - the 24,009-byte singleton actually on chain accepts a hook
///             address our miner produced, under ITS compiled copy of the
///             flag-validation rules rather than ours;
///           - `initialize` and the genesis liquidity mint work against a
///             singleton that already holds live pools, so our pool id cannot
///             collide with and our accounting cannot disturb what is there;
///           - the periphery addresses `contracts.ts` ships (§2.2 of the
///             checklist) are the addresses that are really there;
///           - `ArbSys` is registered on this chain, which is the fact the
///             hook's `_hasArbSys` discriminator is built on.
///
///         **Skips rather than fails when `ROBINHOOD_RPC` is unset**, which is
///         how CI sees it. A fork suite that goes red on a missing credential
///         teaches everyone to ignore red.
///
///         ─── Two things about this fork are not faithful, and both are the
///         tooling's fault rather than a choice ───
///
///         **It is not pinned.** Reproducibility would want a fixed block, and
///         until the Robinhood cutover this file had one. The public endpoint
///         will not serve it: state older than a few thousand blocks comes back
///         `metadata is not found`, and at 100 ms blocks a "few thousand" is
///         somewhere between two and seventeen minutes of history. Any constant
///         written here would be dead before it was committed. So the suite
///         forks the tip, and a failure is a claim about the chain as it was
///         that morning rather than one anybody else can re-run. Pinning comes
///         back the day an archive endpoint does — one line, `FORK_BLOCK`.
///
///         **`ArbSys` is mocked.** Foundry's EVM does not implement it. The
///         fork faithfully fetches the 1-byte stub the chain keeps at `0x64`,
///         so `_hasArbSys` comes out true, and then `arbBlockNumber()` reverts
///         because there is nothing behind the stub to answer it. Every test
///         here would die inside `beforeSwap`. `_installArbSys` etches a real
///         implementation over the stub, seeded from the forked header — see
///         there for why the seed is honest and what it still cannot tell us.
contract ToshV5ForkTest is Test {
    using MessageHashUtils for bytes32;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ─── The live deployment ──────────────────────────────────────────────────
    //
    // Sourced from Robinhood's own docs and confirmed on Blockscout, then
    // checked against the chain itself by
    // `test_fork_liveAddressesAreTheOnesWeShipTo` — the one source that cannot
    // be out of date. These must stay equal to `soat-frontend/src/lib/
    // contracts.ts` and to §2.2 of the checklist.

    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;

    /// @dev The ArbSys precompile. Read for its code length before being etched
    ///      over, because that length is what production actually branches on.
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

    uint8 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
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

    /// @dev `ARB_SYS.code.length` as the chain really reports it, captured
    ///      before the etch replaces it. Asserted on, not just recorded.
    uint256 internal liveArbSysCodeLength;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        // Unpinned. See the contract docstring — the public endpoint cannot
        // serve a fixed block for longer than it takes to write one down.
        vm.createSelectFork(rpc);
        forked = true;

        _installArbSys();

        pogSigner = vm.addr(pogSignerPk);

        vm.startPrank(admin);
        ladder = new ToshLadderTreasury(POOL_MANAGER, admin);
        factory = new ToshFactory(POOL_MANAGER, pogSigner, platformTreasury, address(ladder));
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
        vm.skip(!forked, "ROBINHOOD_RPC unset, see .env.example");
    }

    /// @dev Give the fork an `ArbSys` that answers, because Foundry will not.
    ///
    ///      The chain keeps a one-byte stub at `0x64` so that `extcodesize`
    ///      reports a contract; the actual `arbBlockNumber()` is served by the
    ///      node, below the EVM. A fork copies the stub and not the node, which
    ///      leaves the worst of both: `_hasArbSys` reads true and every call
    ///      through it reverts.
    ///
    ///      Seeded from `block.number`, which is not the arbitrary choice it
    ///      looks like. On the live chain the `NUMBER` opcode returns the L1
    ///      height — that difference is the entire reason `_blockNumber()`
    ///      exists — but Foundry populates it from the forked L2 header, so
    ///      here it IS the L2 height, and the mock starts life holding the real
    ///      one. Which means this suite is faithful about the VALUE and mute
    ///      about the DIVERGENCE: it cannot catch a regression that went back
    ///      to `block.number`, because in a fork the two agree. That property
    ///      is `test/ToshV5ArbSys.t.sol`'s job, where the two are forced apart.
    function _installArbSys() internal {
        liveArbSysCodeLength = ARB_SYS.code.length;

        ForkArbSys impl = new ForkArbSys();
        vm.etch(ARB_SYS, address(impl).code);
        ForkArbSys(ARB_SYS).setHeight(block.number);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Helpers — deliberately duplicated from ToshV5.t.sol rather than shared
    //
    //  A shared base would let a refactor of the local suite quietly change
    //  what the fork suite asserts. These are short, and the point of this file
    //  is to be an independent second opinion.
    // ══════════════════════════════════════════════════════════════════════════

    function _mineSalt() internal view returns (bytes32 rawSalt) {
        bytes32 initcodeHash = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        for (uint256 i; i < 500_000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(creator, rawSalt));
            address predicted = HookMiner.computeAddress(address(factory), finalSalt, initcodeHash);
            if (HookMiner.isValidHookAddress(predicted) && predicted.code.length == 0) return rawSalt;
        }
        revert("no valid salt found");
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
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (address t, address h) =
            factory.createLaunch{value: fee}("ForkTest", "FRK", projTreasury, projTreasury, salt, fee, 24 hours);
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

        assertGt(POOL_MANAGER.code.length, 0, "no PoolManager at the cutover address");
        assertGt(UNIVERSAL_ROUTER.code.length, 0, "no UniversalRouter at the cutover address");
        assertGt(PERMIT2.code.length, 0, "no Permit2 at the cutover address");
        assertGt(POSITION_MANAGER.code.length, 0, "no PositionManager at the cutover address");
        assertGt(STATE_VIEW.code.length, 0, "no StateView at the cutover address");

        // The singleton is a 24 KB contract, not a proxy or a stub someone
        // squatted the address with. It is in fact byte-for-byte the same
        // length as Ethereum's, which is the cheapest available evidence that
        // Robinhood runs the same v4-core build this repository compiles
        // against — the periphery is where the two chains diverged.
        assertEq(POOL_MANAGER.code.length, 24_009, "PoolManager is not the v4-core build we compile against");

        assertEq(block.chainid, 4663, "fork is not Robinhood Chain");
    }

    /// @notice `ArbSys` is registered at `0x64` on this chain.
    ///
    /// @dev    The hook decides once, in its constructor, whether to read the
    ///         chain's height from `ArbSys` or from `block.number`, and it
    ///         decides by asking whether `0x64` holds code. Get that wrong on
    ///         Robinhood and `lastSwapBlock` is stamped in L1 blocks while
    ///         everything comparing against it counts in L2 blocks — a ~21M
    ///         gap, and a flash-loan guard that never once fires.
    ///
    ///         Every other test of that branch supplies its own answer via
    ///         `vm.etch`. This one reads the real chain, before the etch in
    ///         `_installArbSys` covers it up, so the premise underneath the
    ///         mocks is checked exactly once against the thing it models.
    function test_fork_arbSysIsRegisteredOnThisChain() public {
        _requireFork();

        assertGt(liveArbSysCodeLength, 0, "ArbSys absent: the hook would fall back to L1 block numbers");
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

        (uint160 sqrtPriceX96,,,) = IPoolManager(POOL_MANAGER).getSlot0(id);
        assertGt(sqrtPriceX96, 0, "live singleton has no price for our pool");

        (uint128 liquidity,,) =
            IPoolManager(POOL_MANAGER).getPositionInfo(id, address(hook), TICK_LOWER, TICK_UPPER, bytes32(0));
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

        (uint160 before,,,) = IPoolManager(POOL_MANAGER).getSlot0(id);
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
    function _buyInputs(PoolKey memory key, uint128 amountIn, uint128 minOut)
        internal
        pure
        returns (bytes[] memory inputs)
    {
        // `minHopPriceX36: 0` disables the router's own per-hop price floor,
        // leaving `amountOutMinimum` as the only slippage bound — which is what
        // the slippage test below is about, and what the frontend sends.
        return _buyInputs(key, amountIn, minOut, 0);
    }

    function _buyInputs(PoolKey memory key, uint128 amountIn, uint128 minOut, uint256 minHopPriceX36)
        internal
        pure
        returns (bytes[] memory inputs)
    {
        bytes memory actions = abi.encodePacked(ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL);

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: true,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                minHopPriceX36: minHopPriceX36,
                hookData: ""
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
            abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp + 60
        );
    }

    /// @notice A buy through the **deployed UniversalRouter**, which is the path
    ///         real traffic takes.
    ///
    /// @dev    This is the second half of the §4 gap. Every other swap in this
    ///         repository goes through v4-core's `PoolSwapTest`, a test double
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
            abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp + 60
        );
    }

    /// @notice The deployed router really does read a sixth field where we put
    ///         `minHopPriceX36`, so the six-field struct we encode with is the
    ///         layout it decodes with.
    ///
    /// @dev    This is the only test in the file that pins the ABI, and it is
    ///         here because the obvious candidates do not. Encoding the OLD
    ///         five-field struct against this router passes every other test in
    ///         this file, which is worth understanding rather than shrugging at:
    ///
    ///           - the router's decoder is a raw calldata pointer cast with no
    ///             length check, so a short tuple is not rejected, it is
    ///             reinterpreted;
    ///           - the word it then reads as `minHopPriceX36` is the five-field
    ///             encoding's `hookData` offset, `0x120` — nonzero, so the price
    ///             check runs, but 288 in X36 fixed point is 4.2e-9 and every
    ///             real price clears it;
    ///           - the word it reads as the `hookData` offset is that tail's
    ///             length, `0`, which points back at the head, whose first word
    ///             is `currency0`. Ours is native ETH, so it reads `0` and
    ///             decodes an empty `hookData` — correctly, by luck. A pool with
    ///             an ERC20 as `currency0` would read an address as a length and
    ///             die. Every pool this project creates is ETH-paired.
    ///
    ///         Three coincidences, all of them contingent on facts about our
    ///         calldata rather than on the encoding being right. So `> 0 tokens`
    ///         and `exactly 100 bps` are true under both layouts and cannot tell
    ///         them apart. Forcing the field to a bound nothing can satisfy can:
    ///         a revert here means the router read OUR word 9, at the offset the
    ///         six-field layout puts it.
    ///
    ///         `type(uint256).max` rather than something merely large because
    ///         the comparison is against `amountOut * 1e36 / amountIn`, which
    ///         for a token priced in the billions per ETH lands around 1e45 —
    ///         well past `uint128` and not a number to eyeball.
    function test_fork_deployedRouterReadsTheSixthField() public {
        _requireFork();

        (, ToshLaunchpadHook hook) = _launchProject();

        uint128 amountIn = 0.05 ether;
        bytes[] memory inputs = _buyInputs(hook.getPoolKey(), amountIn, 0, type(uint256).max);

        vm.prank(trader);
        vm.expectRevert();
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: amountIn}(
            abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp + 60
        );
    }
}
