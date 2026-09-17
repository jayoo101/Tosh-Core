// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

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

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice Migration spike — the whole lifecycle against the **deployed**
///         Uniswap V4 singleton on BNB Smart Chain (56).
///
/// @dev    Deliberately a separate file from `ToshV5Fork.t.sol` rather than a
///         subclass of it. Those addresses are source-code constants on
///         purpose — a wrong `POOL_MANAGER` silently mis-`CREATE2`s every hook
///         instead of reverting — so making them overridable to share the
///         tests would trade the property the constants exist to protect for
///         some saved lines. A second chain gets a second address book.
///
///         Skips rather than fails when `BSC_RPC` is unset, for the same reason
///         the Robinhood suite does.
///
///         ─── What this spike is for ───
///
///         `docs/BSC_MIGRATION.md` argues from measurements that a move to BSC
///         is mostly free at the contract layer. Two of those claims are
///         arguments rather than observations, and this file turns them into
///         observations:
///
///         **`_hasArbSys` falls back correctly.** The hook decides once, in its
///         constructor, whether to read height from the `ArbSys` precompile or
///         from `block.number`, by asking whether `0x64` holds code. On
///         Robinhood that is true and `ToshV5Fork.t.sol` asserts it. Here the
///         claim is the mirror image and has never been checked against a real
///         non-Arbitrum chain: `0x64` is empty, so the fallback engages and the
///         hook reads a genuine BSC block height. Note what that buys — this
///         suite needs no `_installArbSys` at all, and its absence is the
///         evidence.
///
///         **The router tuple matches.** BSC's Universal Router 2.1.1 is
///         byte-length-identical to Robinhood's and differs only in runs no
///         longer than a word, i.e. immutables. That is strong evidence for
///         "same build, same six-field `ExactInputSingleParams`" but it is
///         still inference from a bytecode diff.
///         `test_forkBsc_deployedRouterReadsTheSixthField` is the measurement.
///
///         ─── The trap this file also pins ───
///
///         BSC lists a SECOND Universal Router, `0x1906c1d6…ae07`, at 19,499
///         bytes — a different, older build. Wiring that one would not revert:
///         per `scripts/checkV4RouterTuple.mjs`, a tuple the decoder does not
///         expect is reinterpreted rather than rejected, so the swap succeeds
///         with the right amounts and silently discarded `hookData`.
///         `test_forkBsc_theOtherRouterIsADifferentBuild` exists so that the
///         choice between the two addresses is recorded as a test rather than
///         as a comment nobody re-reads.
contract ToshV5ForkBscTest is Test {
    using MessageHashUtils for bytes32;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ─── The live BSC deployment ──────────────────────────────────────────────
    //
    // From Uniswap's published deployments, then checked against the chain by
    // `test_forkBsc_liveAddressesAreTheOnesWeWouldShipTo`.

    address internal constant POOL_MANAGER = 0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF;
    address internal constant UNIVERSAL_ROUTER = 0x8B844f885672f333Bc0042cB669255f93a4C1E6b;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant POSITION_MANAGER = 0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b;
    address internal constant STATE_VIEW = 0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4;

    /// @dev The older BSC Universal Router. Named only to be refused.
    address internal constant UNIVERSAL_ROUTER_OLD = 0x1906c1d672b88cD1B9aC7593301cA990F94Eae07;

    /// @dev Where `ArbSys` would be if this were an Arbitrum chain. It is not.
    address internal constant ARB_SYS = 0x0000000000000000000000000000000000000064;

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

    /// @dev Denominated in BNB here, not ETH. The figure is unchanged from the
    ///      Robinhood suite because this spike is about mechanics; what the
    ///      band and the soft cap should BE in BNB is `docs/BSC_MIGRATION.md`
    ///      §6 and is not a question a fork test can answer.
    uint256 internal constant SOFT_CAP = 1 ether;
    uint256 internal constant POG_CAP = 10 ether;

    int24 internal constant TICK_LOWER = -887200;
    int24 internal constant TICK_UPPER = 887200;

    bool internal forked;

    /// @dev `ARB_SYS.code.length` as BSC reports it. Recorded in `setUp` for
    ///      symmetry with the Robinhood suite, where the value has to be read
    ///      before an etch covers it. Nothing etches it here, which is the
    ///      point.
    uint256 internal liveArbSysCodeLength;

    function setUp() public {
        string memory rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        forked = true;

        liveArbSysCodeLength = ARB_SYS.code.length;

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

    function _requireFork() internal {
        vm.skip(!forked, "BSC_RPC unset");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Helpers — duplicated from ToshV5Fork.t.sol for the reason stated there:
    //  an independent second opinion should not share a base with what it
    //  double-checks.
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
            factory.createLaunch{value: fee}("BscSpike", "BSCS", projTreasury, projTreasury, salt, fee, 24 hours);
        return (ToshToken(t), ToshLaunchpadHook(payable(h)));
    }

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
    //  The live deployment is what the migration doc claims
    // ══════════════════════════════════════════════════════════════════════════

    function test_forkBsc_liveAddressesAreTheOnesWeWouldShipTo() public {
        _requireFork();

        assertGt(POOL_MANAGER.code.length, 0, "no PoolManager on BSC at the published address");
        assertGt(UNIVERSAL_ROUTER.code.length, 0, "no UniversalRouter 2.1.1 on BSC");
        assertGt(PERMIT2.code.length, 0, "no Permit2 on BSC");
        assertGt(POSITION_MANAGER.code.length, 0, "no PositionManager on BSC");
        assertGt(STATE_VIEW.code.length, 0, "no StateView on BSC");

        // Same v4-core build this repository compiles against, and the same
        // length as Robinhood's and Ethereum's. The periphery is where chains
        // diverge; the singleton is where they do not.
        assertEq(POOL_MANAGER.code.length, 24_009, "BSC PoolManager is not the v4-core build we compile against");

        assertEq(block.chainid, 56, "fork is not BNB Smart Chain");
    }

    /// @notice `ArbSys` is ABSENT here, so the hook's fallback is the branch
    ///         that runs — and it reads a real BSC block height.
    ///
    /// @dev    The exact inverse of `test_fork_arbSysIsRegisteredOnThisChain`,
    ///         and the reason a BSC move needs no contract change for block
    ///         height. `_hasArbSys` is immutable, set in the constructor from
    ///         this code length, so one assertion here covers every hook the
    ///         factory will ever clone on this chain.
    ///
    ///         The whole rest of this file is corroboration: the Robinhood
    ///         suite cannot run a single test without `_installArbSys` etching
    ///         an implementation over the stub, and this one has no such
    ///         helper. Every swap below reaches `beforeSwap`, stamps
    ///         `_lastSwapBlock` and clears the same-block lockout using
    ///         `block.number` alone.
    function test_forkBsc_arbSysIsAbsentSoTheFallbackIsWhatRuns() public {
        _requireFork();

        assertEq(liveArbSysCodeLength, 0, "something lives at 0x64 on BSC; _hasArbSys would take the wrong branch");
    }

    /// @notice The other published BSC router is a different build, which is
    ///         why the address above is the one this project would ship.
    ///
    /// @dev    Recorded as a test because the consequence of picking wrong is
    ///         invisible. Both addresses accept a V4 swap; only one of them
    ///         decodes the tuple we encode. A length difference is not proof of
    ///         a tuple difference on its own — the proof is
    ///         `test_forkBsc_deployedRouterReadsTheSixthField` below — but it
    ///         is proof that the two are not interchangeable, which is the
    ///         thing an operator reaching for "the BSC Universal Router" needs
    ///         to be stopped by.
    function test_forkBsc_theOtherRouterIsADifferentBuild() public {
        _requireFork();

        assertGt(UNIVERSAL_ROUTER_OLD.code.length, 0, "the older router is not even there");
        assertTrue(
            UNIVERSAL_ROUTER_OLD.code.length != UNIVERSAL_ROUTER.code.length,
            "the two BSC routers now have equal length; re-do the bytecode comparison before trusting either"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The lifecycle, against the singleton that is really there
    // ══════════════════════════════════════════════════════════════════════════

    function test_forkBsc_lifecycleAgainstLivePoolManager() public {
        _requireFork();

        (ToshToken token, ToshLaunchpadHook hook) = _launchProject();

        assertTrue(hook.launched(), "hook does not consider itself launched");

        PoolKey memory key = hook.getPoolKey();
        PoolId id = key.toId();

        (uint160 sqrtPriceX96,,,) = IPoolManager(POOL_MANAGER).getSlot0(id);
        assertGt(sqrtPriceX96, 0, "live BSC singleton has no price for our pool");

        (uint128 liquidity,,) =
            IPoolManager(POOL_MANAGER).getPositionInfo(id, address(hook), TICK_LOWER, TICK_UPPER, bytes32(0));
        assertGt(liquidity, 0, "genesis LP is not in the live BSC singleton");

        // Native BNB here rather than native ETH, but the currency sorting and
        // the zero address are the same, so `zeroForOne: true` still holds for
        // every pool this factory creates.
        assertEq(Currency.unwrap(key.currency0), address(0), "currency0 is not the native coin");
        assertEq(Currency.unwrap(key.currency1), address(token), "currency1 is not the project token");
    }

    function test_forkBsc_ourPoolIdIsFreshOnTheLiveSingleton() public {
        _requireFork();

        (, ToshLaunchpadHook hook) = _createProject();
        PoolId id = hook.getPoolKey().toId();

        (uint160 before,,,) = IPoolManager(POOL_MANAGER).getSlot0(id);
        assertEq(before, 0, "the live BSC singleton already has a pool at our id");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  The production swap path
    // ══════════════════════════════════════════════════════════════════════════

    function _buyInputs(PoolKey memory key, uint128 amountIn, uint128 minOut)
        internal
        pure
        returns (bytes[] memory inputs)
    {
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

    function test_forkBsc_buyThroughRealUniversalRouter() public {
        _requireFork();

        (ToshToken token, ToshLaunchpadHook hook) = _launchProject();

        uint128 amountIn = 0.05 ether;
        uint256 tokensBefore = token.balanceOf(trader);
        uint256 bnbBefore = trader.balance;

        _buyThroughRouter(hook.getPoolKey(), amountIn, 0);

        assertGt(token.balanceOf(trader) - tokensBefore, 0, "the production router path delivered no tokens");
        assertEq(bnbBefore - trader.balance, amountIn, "router spent an amount we did not authorise");
    }

    function test_forkBsc_buyTaxIsExactThroughTheRealRouter() public {
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

        assertEq(reservoirCut, expectedReservoir, "reservoir share through the real BSC router is wrong");
        assertEq(platformCut, expectedPlatform, "platform share through the real BSC router is wrong");
        assertEq(
            reservoirCut + platformCut,
            (uint256(amountIn) * hook.TAX_BPS()) / 10_000,
            "the split must conserve the whole skim, or V4 would not have settled"
        );
    }

    function test_forkBsc_routerSlippageBoundIsEnforcedOverOurTax() public {
        _requireFork();

        (, ToshLaunchpadHook hook) = _launchProject();

        uint128 amountIn = 0.05 ether;
        bytes[] memory inputs = _buyInputs(hook.getPoolKey(), amountIn, type(uint128).max);

        vm.prank(trader);
        vm.expectRevert();
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: amountIn}(
            abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp + 60
        );
    }

    /// @notice BSC's Universal Router 2.1.1 reads a sixth field where we put
    ///         `minHopPriceX36` — the same layout Robinhood's router decodes.
    ///
    /// @dev    This is the test the whole spike exists for, and the reasoning
    ///         behind it is `ToshV5Fork.t.sol`'s at length: the decoder is a
    ///         raw calldata pointer cast with no length check, so a layout
    ///         mismatch is reinterpreted rather than rejected, and every other
    ///         test in this file passes under BOTH layouts. Only forcing the
    ///         sixth field to a bound nothing can satisfy can tell them apart.
    ///
    ///         A revert here means BSC's router read OUR word 9, at the offset
    ///         the six-field layout puts it — which turns the bytecode-diff
    ///         inference in `docs/BSC_MIGRATION.md` §2 into a measurement.
    function test_forkBsc_deployedRouterReadsTheSixthField() public {
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
