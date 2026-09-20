// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookAddress} from "../src/libraries/HookAddress.sol";
import {MockQuoteAsset} from "./utils/MockQuoteAsset.sol";

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

    Vault internal vault;

    CLPoolManager internal poolManager;
    CLPoolManagerRouter internal router;
    ToshLadderTreasury internal ladder;
    ToshFactory internal factory;

    /// @dev Stands in for BEM, at eight decimals.
    MockQuoteAsset internal quote;

    uint256 internal constant SOFT_CAP = 100e8;
    uint256 internal constant POG_CAP = 1000e8;

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

        // Vault first, and the manager registered with it before it may move any

        // balance. See test/ToshV5.t.sol for the full argument.

        vault = new Vault();

        poolManager = new CLPoolManager(IVault(address(vault)));

        vault.registerApp(address(poolManager));

        router = new CLPoolManagerRouter(IVault(address(vault)), ICLPoolManager(address(poolManager)));

        _installArbSys();

        quote = new MockQuoteAsset();

        vm.startPrank(admin);
        ladder = new ToshLadderTreasury(address(poolManager), address(vault), admin, address(quote));
        factory = new ToshFactory(
            address(poolManager), address(vault), pogSigner, platformTreasury, address(ladder), address(quote)
        );
        ladder.setFactory(address(factory));
        factory.setDefaultSoftCap(SOFT_CAP);
        factory.setMaxPogAllocationLimit(POG_CAP);
        factory.setCooldownDuration(0);
        factory.setQuotaWindowDuration(0);
        vm.stopPrank();

        // Native balances for gas only; nothing a depositor or trader does moves
        // native value now.
        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(trader, 100 ether);

        _endow(creator);
        _endow(alice);
        _endow(bob);
        _endow(trader);
    }

    /// @dev Mint a quote balance and approve the two platform-global spenders.
    ///      The factory pulls launch fees and deposits; the router pulls a swap's
    ///      input side. See `ToshV5Test._endow` for why the swap allowance names
    ///      the router rather than the Vault.
    function _endow(address who) internal {
        quote.mint(who, 100_000e8);
        vm.startPrank(who);
        quote.approve(address(factory), type(uint256).max);
        quote.approve(address(router), type(uint256).max);
        vm.stopPrank();
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
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();

        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (, address h) = factory.createLaunch{value: fee}(
            "ArbSys", "ARB", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
        hook = ToshLaunchpadHook(payable(h));
        // Shelf mints are pulled by the hook itself, which does not exist until
        // now, so this approval cannot live in `_endow`.
        vm.prank(bob);
        quote.approve(address(hook), type(uint256).max);

        _registerPoG(alice, POG_CAP);
        vm.prank(alice);
        factory.deposit(address(hook), address(0), SOFT_CAP);

        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        hook.launch();
    }

    /// @dev Infinity names these the opposite of V4 and means the opposite by
    ///      them: V4 took `{takeClaims: false, settleUsingBurn: false}` where
    ///      this takes `{withdrawTokens: true, settleUsingTransfer: true}`. Both
    ///      say the same thing — hand over real tokens, settle by transferring
    ///      them. Copying the old `false, false` across would have left every
    ///      swap settling through claim tokens this suite never mints. Reasoned
    ///      out once in test/ToshV5.t.sol.
    function _swapSettings() internal pure returns (CLPoolManagerRouter.SwapTestSettings memory) {
        return CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true});
    }

    function _swapBuy(ToshLaunchpadHook hook, uint256 nativeIn) internal {
        // Read before the prank: an argument that is itself an external call
        // is evaluated first and would consume it. See _swapBuy.
        PoolKey memory key = hook.getPoolKey();
        vm.prank(trader);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(nativeIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            _swapSettings(),
            ""
        );
    }

    /// @dev Buy the pool up and let the new level age into the TWAP, so the
    ///      105 % ceiling stops being the binding constraint and the lockout is
    ///      the only thing these tests are measuring.
    function _openLadder(ToshLaunchpadHook hook) internal {
        _swapBuy(hook, 1e8);
        _nextBlock();
        vm.warp(block.timestamp + 1900);
        _swapBuy(hook, 1e6);
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

        _swapBuy(hook, 1e8);

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

        _swapBuy(hook, 1e6);
        assertEq(hook.maxMintable(), 0, "a swap shuts the lockout");

        vm.roll(vm.getBlockNumber() + 500);
        assertEq(hook.maxMintable(), 0, "L1 moving cannot clear a lockout keyed on this chain's height");

        vm.prank(bob);
        vm.expectRevert(ToshLaunchpadHook.SameBlockMintForbidden.selector);
        hook.mintBondingCurve(1e18, 100e8);
    }

    /// @notice ...and advancing the chain's own height by one does clear it.
    function test_arbSys_advancingTheChainsHeightClearsTheLockout() public {
        ToshLaunchpadHook hook = _launchProject();
        _openLadder(hook);

        _swapBuy(hook, 1e6);
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
        _swapBuy(hook, 1e8);

        assertEq(hook.lastSwapBlock(), vm.getBlockNumber(), "without ArbSys the stamp is block.number");
    }

    function test_noArbSys_lockoutClearsOnTheNextBlock() public {
        ToshLaunchpadHook hook = _launchProject();
        _openLadder(hook);

        _swapBuy(hook, 1e6);
        assertEq(hook.maxMintable(), 0, "a swap shuts the lockout");

        _nextBlock();
        assertGt(hook.maxMintable(), 0, "and the next block opens it");
    }
}
