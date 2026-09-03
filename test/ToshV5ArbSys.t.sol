// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @notice Stands in for Arbitrum's `ArbSys` precompile.
///
/// @dev    The height lives in slot 0 and is written with `vm.store` rather than
///         a setter, because this contract is never called at its own address:
///         its runtime code is `vm.etch`ed onto `0x64`, and a setter would write
///         to whichever account is executing.
contract MockArbSys {
    uint256 private _height;

    function arbBlockNumber() external view returns (uint256) {
        return _height;
    }
}

/// @notice Shared fixture. Deliberately abstract: the ONE thing these suites
///         differ on is whether `ArbSys` exists at construction time, and that
///         has to be decided before the factory runs.
abstract contract ArbSysHarness is Test {
    using MessageHashUtils for bytes32;

    address internal constant ARB_SYS = 0x0000000000000000000000000000000000000064;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal trader = makeAddr("trader");
    address internal platformTreasury = makeAddr("platformTreasury");
    address internal projTreasury = makeAddr("projTreasury");

    uint256 internal pogSignerPk = 0xBEEF_CAFE;
    address internal pogSigner;

    PoolManager internal poolManager;
    PoolSwapTest internal swapRouter;
    ToshLadderTreasury internal ladder;
    ToshFactory internal factory;

    uint256 internal constant SOFT_CAP = 1 ether;
    uint256 internal constant POG_CAP = 10 ether;

    /// @dev Mirrors the mock's slot 0 so tests can read it without a call.
    uint256 internal chainHeight;
    bool internal arbSysInstalled;

    /// @dev Runs BEFORE the factory is constructed, which is the whole reason
    ///      this is a hook rather than a line in `setUp`. `ToshFactory`'s
    ///      constructor deploys `hookImplementation`, and that is the moment
    ///      `_hasArbSys` latches. Installing the precompile afterwards would
    ///      produce an implementation that never takes the Arbitrum branch, and
    ///      the suite would pass while testing nothing.
    function _installArbSys() internal virtual {}

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);

        poolManager = new PoolManager(admin);
        swapRouter = new PoolSwapTest(IPoolManager(address(poolManager)));

        _installArbSys();

        vm.startPrank(admin);
        ladder = new ToshLadderTreasury(address(poolManager), admin);
        factory = new ToshFactory(address(poolManager), pogSigner, platformTreasury, address(ladder));
        ladder.setFactory(address(factory));
        factory.setDefaultSoftCap(SOFT_CAP);
        factory.setMaxPogAllocationLimit(POG_CAP);
        factory.setCooldownDuration(0);
        factory.setQuotaWindowDuration(0);
        vm.stopPrank();

        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(trader, 100 ether);
    }

    // ─── ArbSys control ───────────────────────────────────────────────────────

    function _etchArbSys(uint256 initialHeight) internal {
        vm.etch(ARB_SYS, address(new MockArbSys()).code);
        arbSysInstalled = true;
        _setChainHeight(initialHeight);
    }

    function _setChainHeight(uint256 h) internal {
        chainHeight = h;
        vm.store(ARB_SYS, bytes32(uint256(0)), bytes32(h));
    }

    /// @dev Advance one block of the chain the contracts actually run on.
    ///
    ///      On the Arbitrum fixture that means the mocked L2 height; `block.number`
    ///      is rolled too, so that anything keyed on it still moves, but it is
    ///      NOT what clears the lockout. `test_rollingBlockNumberAloneIsNotABlock`
    ///      is the test that pins the difference.
    function _nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
        if (arbSysInstalled) _setChainHeight(chainHeight + 1);
    }

    // ─── Launch fixture ───────────────────────────────────────────────────────

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
        revert("_mineSalt: no valid salt found");
    }

    function _registerPoG(address user, uint256 maxAlloc) internal {
        uint256 nonce = factory.pogNonces(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encode(user, maxAlloc, nonce, deadline, address(factory), block.chainid))
            .toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pogSignerPk, digest);
        vm.prank(user);
        factory.registerPoG(maxAlloc, deadline, nonce, abi.encodePacked(r, s, v));
    }

    function _launchProject() internal returns (ToshLaunchpadHook hook) {
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();

        vm.prank(creator);
        (, address h) =
            factory.createLaunch{value: fee}("ArbSys", "ARB", projTreasury, projTreasury, salt, fee, 24 hours);
        hook = ToshLaunchpadHook(payable(h));

        _registerPoG(alice, POG_CAP);
        vm.prank(alice);
        factory.deposit{value: SOFT_CAP}(address(hook), address(0));

        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        hook.launch();
    }

    function _swapBuy(ToshLaunchpadHook hook, uint256 ethIn) internal {
        vm.prank(trader);
        swapRouter.swap{value: ethIn}(
            hook.getPoolKey(),
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Buy the pool up and let the new level age into the TWAP, so the
    ///      105 % ceiling stops being the binding constraint and the lockout is
    ///      the only thing these tests are measuring.
    function _openLadder(ToshLaunchpadHook hook) internal {
        _swapBuy(hook, 0.01 ether);
        _nextBlock();
        vm.warp(block.timestamp + 1900);
        _swapBuy(hook, 1e14);
        _nextBlock();
    }
}

/// @notice The Arbitrum path: `_blockNumber()` reads the chain's own height.
///
/// @dev    This suite exists because no other one can reach the branch. Foundry
///         does not emulate Arbitrum's `block.number`, so on the devnet every
///         other suite runs against, `_hasArbSys` is false and the ArbSys arm of
///         `_blockNumber()` is unreachable dead code. Deleting this file would
///         not turn a single other test red.
contract ToshV5ArbSysTest is ArbSysHarness {
    /// @dev Two heights that cannot be confused: a plausible Robinhood L2 height
    ///      and a plausible Ethereum L1 height. Picked to be far apart so an
    ///      assertion cannot pass because the fixture happened to align them.
    uint256 internal constant L2_HEIGHT = 47_000_000;
    uint256 internal constant L1_HEIGHT = 25_800_000;

    function _installArbSys() internal override {
        _etchArbSys(L2_HEIGHT);
        vm.roll(L1_HEIGHT);
    }

    function test_arbSys_isDetectedAtConstruction() public view {
        assertGt(ARB_SYS.code.length, 0, "fixture must install the precompile before the factory");
        assertTrue(chainHeight != vm.getBlockNumber(), "fixture is vacuous unless the two heights differ");
    }

    /// @notice `afterSwap` stamps the chain's own height, not `block.number`.
    function test_arbSys_swapStampsTheChainsOwnHeight() public {
        ToshLaunchpadHook hook = _launchProject();
        _nextBlock();

        _swapBuy(hook, 0.01 ether);

        assertEq(hook.lastSwapBlock(), chainHeight, "stamp must be the chain's own height");
        assertTrue(hook.lastSwapBlock() != vm.getBlockNumber(), "stamp must not be block.number");
    }

    /// @notice `launch()` stamps it too, on the same clock.
    function test_arbSys_launchStampsTheChainsOwnHeight() public {
        ToshLaunchpadHook hook = _launchProject();

        assertEq(hook.lastSwapBlock(), chainHeight, "launch must stamp the chain's own height");
        assertEq(hook.maxMintable(), 0, "and therefore shut the launch block");
    }

    /// @notice The one that matters: moving L1 does not clear the lockout.
    ///
    /// @dev    This is the whole bug in one assertion. Before the fix the guard
    ///         read `block.number`, so on Robinhood a swap froze minting for the
    ///         ~10.7 s until L1 ticked — and conversely, an L1 tick released it
    ///         regardless of how many real blocks had passed. Rolling 500 L1
    ///         blocks here with the chain standing still must change nothing.
    function test_arbSys_rollingBlockNumberAloneIsNotABlock() public {
        ToshLaunchpadHook hook = _launchProject();
        _openLadder(hook);
        assertGt(hook.maxMintable(), 0, "ladder must be open before the lockout is measured");

        _swapBuy(hook, 1e14);
        assertEq(hook.maxMintable(), 0, "a swap shuts the lockout");

        vm.roll(vm.getBlockNumber() + 500);
        assertEq(hook.maxMintable(), 0, "L1 moving cannot clear a lockout keyed on this chain's height");

        vm.prank(bob);
        vm.expectRevert(ToshLaunchpadHook.SameBlockMintForbidden.selector);
        hook.mintBondingCurve{value: 1 ether}(1e18);
    }

    /// @notice ...and advancing the chain's own height by one does clear it.
    function test_arbSys_advancingTheChainsHeightClearsTheLockout() public {
        ToshLaunchpadHook hook = _launchProject();
        _openLadder(hook);

        _swapBuy(hook, 1e14);
        assertEq(hook.maxMintable(), 0, "a swap shuts the lockout");

        uint256 frozenL1 = vm.getBlockNumber();
        _setChainHeight(chainHeight + 1);

        assertEq(vm.getBlockNumber(), frozenL1, "this test must move nothing but the chain's own height");
        assertGt(hook.maxMintable(), 0, "one block of this chain must open it");
    }
}

/// @notice The plain-EVM path: no precompile, so `_blockNumber()` is
///         `block.number` and every other suite's assumptions still hold.
contract ToshV5NoArbSysTest is ArbSysHarness {
    function test_noArbSys_stampFallsBackToBlockNumber() public {
        assertEq(ARB_SYS.code.length, 0, "fixture must leave the precompile absent");

        ToshLaunchpadHook hook = _launchProject();
        _nextBlock();
        _swapBuy(hook, 0.01 ether);

        assertEq(hook.lastSwapBlock(), vm.getBlockNumber(), "without ArbSys the stamp is block.number");
    }

    function test_noArbSys_lockoutClearsOnTheNextBlock() public {
        ToshLaunchpadHook hook = _launchProject();
        _openLadder(hook);

        _swapBuy(hook, 1e14);
        assertEq(hook.maxMintable(), 0, "a swap shuts the lockout");

        _nextBlock();
        assertGt(hook.maxMintable(), 0, "and the next block opens it");
    }
}
