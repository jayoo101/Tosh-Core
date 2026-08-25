// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";
import {MockERC20} from "./utils/MockERC20.sol";

/// @notice v5.0 suite —ETH-native launches, the global referral graph, the
///         discrete tier ladder with its anti-spike gates, the asymmetric
///         in-flight tax, and the round-robin piggyback buyback.
///
/// @dev    Every test runs against a REAL `PoolManager` and drives real swaps
///         through v4-core's `PoolSwapTest` router.  The v4.x suite mocked the
///         pool manager for factory-level tests; v5.0 cannot, because the tax,
///         the TWAP oracle, and the piggyback engine all live in the swap path.
contract ToshV5Test is Test {
    using MessageHashUtils for bytes32;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ─── Actors ───────────────────────────────────────────────────────────────

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal trader = makeAddr("trader");
    address internal platformTreasury = makeAddr("platformTreasury");
    address internal projTreasury = makeAddr("projTreasury");

    uint256 internal pogSignerPk = 0xBEEF_CAFE;
    address internal pogSigner;

    // ─── Contracts ────────────────────────────────────────────────────────────

    PoolManager internal poolManager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal liqRouter;
    ToshLadderTreasury internal ladder;
    ToshFactory internal factory;

    // ─── Fixture parameters ───────────────────────────────────────────────────

    /// @dev Small enough that a single wallet can fill a genesis round, which
    ///      keeps multi-project tests (the piggyback ladder needs four launches)
    ///      from degenerating into twenty-wallet deposit loops.
    uint256 internal constant SOFT_CAP = 1 ether;

    /// @dev Doubles as the PoG quota ceiling AND the per-project per-wallet cap
    ///      snapshotted into each hook.  Set well above `SOFT_CAP` so one wallet
    ///      can fund several projects without the cap becoming the thing under
    ///      test everywhere; the cap has its own dedicated tests.
    uint256 internal constant POG_CAP = 10 ether;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @dev Must match `ToshLaunchpadHook` genesis ticks.  Internal there, so
    ///      the suite pins the same literals rather than adding public getters.
    int24 internal constant TICK_LOWER = -887200;
    int24 internal constant TICK_UPPER = 887200;

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);

        poolManager = new PoolManager(admin);
        swapRouter = new PoolSwapTest(IPoolManager(address(poolManager)));
        liqRouter = new PoolModifyLiquidityTest(IPoolManager(address(poolManager)));

        vm.startPrank(admin);
        // Treasury first: the factory takes its address as an immutable.
        ladder = new ToshLadderTreasury(address(poolManager), admin);
        factory = new ToshFactory(address(poolManager), pogSigner, platformTreasury, address(ladder));
        ladder.setFactory(address(factory));

        factory.setDefaultSoftCap(SOFT_CAP);
        factory.setMaxPogAllocationLimit(POG_CAP);
        // Per-(wallet, hook) cooldown is orthogonal to everything under test and
        // would otherwise force a `vm.warp` past the 24h genesis window.  The
        // quota window is a separate knob; tests that care about refill set it
        // explicitly, everyone else runs on a lifetime budget.
        factory.setCooldownDuration(0);
        factory.setQuotaWindowDuration(0);
        vm.stopPrank();

        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(dave, 100 ether);
        vm.deal(trader, 100 ether);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Mine a raw salt whose factory-derived CREATE2 address carries the
    ///      v5.0 flag mask (0x20CC).  The initcode hash is read back from the
    ///      factory rather than reconstructed here, so the constructor tuple can
    ///      never drift out of sync with the test.
    function _mineSalt(address _projTreasury, address _creator, address _projAdmin)
        internal
        view
        returns (bytes32 rawSalt)
    {
        bytes32 initcodeHash = factory.hookInitcodeHash(
            _projTreasury, _creator, _projAdmin, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        for (uint256 i; i < 500_000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(_creator, rawSalt));
            address predicted = HookMiner.computeAddress(address(factory), finalSalt, initcodeHash);
            // Skip addresses already occupied: every project in a given test
            // shares the same constructor tuple, so without this the miner would
            // hand back the same salt twice and CREATE2 would collide.
            if (HookMiner.isValidHookAddress(predicted) && predicted.code.length == 0) return rawSalt;
        }
        revert("_mineSalt: no valid salt found");
    }

    function _createProject(string memory name, string memory symbol)
        internal
        returns (ToshToken token, ToshLaunchpadHook hook)
    {
        bytes32 salt = _mineSalt(projTreasury, creator, projTreasury);
        uint256 fee = factory.launchFee();

        vm.prank(creator);
        (address t, address h) =
            factory.createLaunch{value: fee}(name, symbol, projTreasury, projTreasury, salt, fee, 24 hours);

        token = ToshToken(t);
        hook = ToshLaunchpadHook(payable(h));
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

    /// @dev Give `user` the full lifetime PoG budget unless a test has already
    ///      pinned a specific (smaller) quota it wants to assert against.
    function _ensurePoG(address user) internal {
        if (factory.pogQuota(user) == 0) _registerPoG(user, POG_CAP);
    }

    function _deposit(address user, ToshLaunchpadHook hook, uint256 amount, address referrer) internal {
        _ensurePoG(user);
        vm.prank(user);
        factory.deposit{value: amount}(address(hook), referrer);
    }

    /// @dev Create -> fund to the soft cap -> `launch()`.  Returns a live project
    ///      with an initialised V4 pool and permanently locked genesis LP.
    function _launchProject(string memory name, string memory symbol, address funder, address referrer)
        internal
        returns (ToshToken token, ToshLaunchpadHook hook)
    {
        (token, hook) = _createProject(name, symbol);
        _deposit(funder, hook, SOFT_CAP, referrer);
        _launch(hook);
    }

    /// @dev `launch()` is creator-only and gated on the genesis deadline having
    ///      passed, so every launch needs both a warp and a prank.
    function _launch(ToshLaunchpadHook hook) internal {
        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        hook.launch();
    }

    /// @dev Advance exactly one block.
    ///
    ///      Deliberately NOT `vm.roll(block.number + 1)`: under `via_ir` the
    ///      optimizer common-subexpression-eliminates repeated `block.number`
    ///      reads (legitimate in a real transaction, where it cannot change),
    ///      so a second roll in the same test would re-use the stale value and
    ///      silently roll to the same block. `vm.getBlockNumber()` is an opaque
    ///      cheatcode call and always reads through.
    function _nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _genesisLiquidity(ToshLaunchpadHook hook) internal view returns (uint128 liq) {
        (liq,,) = IPoolManager(address(poolManager))
            .getPositionInfo(hook.getPoolKey().toId(), address(hook), TICK_LOWER, TICK_UPPER, bytes32(0));
    }

    function _retailLiquidity(ToshLaunchpadHook hook) internal view returns (uint128 liq) {
        (liq,,) = IPoolManager(address(poolManager))
            .getPositionInfo(hook.getPoolKey().toId(), address(liqRouter), TICK_LOWER, TICK_UPPER, bytes32(0));
    }

    /// @dev ETH -> token. `zeroForOne` because native ETH always sorts to
    ///      `currency0`; buying pushes ETH-per-token up.
    function _swapBuy(ToshLaunchpadHook hook, address who, uint256 ethIn) internal {
        vm.prank(who);
        swapRouter.swap{value: ethIn}(
            hook.getPoolKey(),
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Unlock the shelf ladder.
    ///
    ///      Shelf 0 costs `1.05 x p0` and the gate caps shelves at
    ///      `1.05 x min(spot, TWAP)`, so the ladder opens LOCKED and only
    ///      unlocks once the market holds at or above the genesis price.  Buy
    ///      the pool up, then let the new level age into the TWAP so the
    ///      `min()` follows it rather than the pre-move price.
    function _openLadder(ToshLaunchpadHook hook, uint256 ethIn) internal {
        _swapBuy(hook, trader, ethIn);
        _nextBlock();
        vm.warp(block.timestamp + 1900);
        _swapBuy(hook, trader, 1e14); // roll the oracle checkpoint at the new level
        _nextBlock();
    }

    /// @dev token -> ETH.  The router pays with `transferFrom(seller, manager)`,
    ///      so the seller approves the ROUTER, not the pool manager.
    function _swapSell(ToshLaunchpadHook hook, address who, uint256 tokensIn) internal {
        PoolKey memory key = hook.getPoolKey();
        vm.startPrank(who);
        IERC20(Currency.unwrap(key.currency1)).approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false, amountSpecified: -int256(tokensIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  1. ETH-native factory plumbing
    // ══════════════════════════════════════════════════════════════════════════

    function test_createLaunch_chargesEthFeeAndFundsLadderTreasury() public {
        uint256 fee = factory.launchFee();
        assertEq(fee, 0.1 ether, "default launch fee should be 0.1 ETH");

        uint256 ladderBefore = address(ladder).balance;
        (, ToshLaunchpadHook hook) = _createProject("Matrix", "MTRX");

        assertTrue(factory.registeredHooks(address(hook)));
        assertEq(address(ladder).balance - ladderBefore, fee, "launch fee must land in the buyback reservoir");
        assertEq(platformTreasury.balance, 0, "platform treasury must not receive launch fees in v5.0");
    }

    function test_createLaunch_refundsOverpayment() public {
        bytes32 salt = _mineSalt(projTreasury, creator, projTreasury);
        uint256 fee = factory.launchFee();
        uint256 before = creator.balance;

        vm.prank(creator);
        factory.createLaunch{value: fee + 3 ether}("Over", "OVR", projTreasury, projTreasury, salt, fee, 24 hours);

        assertEq(before - creator.balance, fee, "overpayment must be refunded");
    }

    function test_createLaunch_revertsOnUnderpayment() public {
        bytes32 salt = _mineSalt(projTreasury, creator, projTreasury);
        uint256 fee = factory.launchFee();

        vm.prank(creator);
        vm.expectRevert(ToshFactory.InsufficientLaunchFee.selector);
        factory.createLaunch{value: fee - 1}("Under", "UND", projTreasury, projTreasury, salt, fee, 24 hours);
    }

    /// @dev `expectedFee` is a slippage cap: an owner who raises the fee in the
    ///      mempool cannot front-run a creator into paying more than they agreed.
    function test_createLaunch_revertsWhenOwnerFrontRunsFeeIncrease() public {
        bytes32 salt = _mineSalt(projTreasury, creator, projTreasury);
        uint256 quotedFee = factory.launchFee();

        vm.prank(admin);
        factory.setLaunchFee(quotedFee + 1 ether);

        vm.prank(creator);
        vm.expectRevert(ToshFactory.FeeChanged.selector);
        factory.createLaunch{value: 5 ether}("Front", "FRT", projTreasury, projTreasury, salt, quotedFee, 24 hours);
    }

    function test_minedHookAddress_carriesV5FlagMask() public {
        (, ToshLaunchpadHook hook) = _createProject("Mask", "MSK");
        uint160 mask = 0x20CC;
        assertEq(uint160(address(hook)) & mask, mask, "hook address must carry the v5.0 flag mask");
    }

    /// @notice Total trader friction is 1.00 %, split 0.30 % native pool fee
    ///         (LPs, settled by V4) + 0.70 % hook tax (treasury / burn).
    function test_poolKey_chargesThirtyBpsToLPs() public {
        (, ToshLaunchpadHook hook) = _launchProject("PoolFee", "PFE", alice, address(0));

        assertEq(hook.POOL_FEE(), 3000, "native pool fee must be 0.30 %");
        assertEq(hook.TAX_BPS(), 70, "hook tax must be 0.70 %");
        assertEq(hook.getPoolKey().fee, 3000, "the live PoolKey must carry the 0.30 % fee");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  2. Genesis deposits in native ETH
    // ══════════════════════════════════════════════════════════════════════════

    function test_deposit_isNativeEthAndNeedsNoApproval() public {
        (, ToshLaunchpadHook hook) = _createProject("EthDep", "EDP");
        _registerPoG(alice, POG_CAP);

        _deposit(alice, hook, 0.4 ether, address(0));

        assertEq(hook.ethDeposited(alice), 0.4 ether);
        assertEq(hook.totalEthDeposited(), 0.4 ether);
        assertEq(address(hook).balance, 0.4 ether, "hook custodies raised ETH directly");
        assertEq(factory.totalGenesisDeposited(alice), 0.4 ether);
    }

    function test_deposit_revertsWithoutPogQuota() public {
        (, ToshLaunchpadHook hook) = _createProject("NoPog", "NPG");

        vm.prank(alice);
        vm.expectRevert(ToshFactory.NoPogQuota.selector);
        factory.deposit{value: 0.1 ether}(address(hook), address(0));
    }

    /// @dev The quota is a single platform-wide lifetime budget, spent across
    ///      every project a wallet ever touches.
    function test_deposit_quotaIsGlobalAcrossProjects() public {
        (, ToshLaunchpadHook hookA) = _createProject("QuotaA", "QTA");
        (, ToshLaunchpadHook hookB) = _createProject("QuotaB", "QTB");

        _registerPoG(bob, 0.5 ether);
        _deposit(bob, hookA, 0.4 ether, address(0));

        vm.prank(bob);
        vm.expectRevert(ToshFactory.QuotaExceeded.selector);
        factory.deposit{value: 0.2 ether}(address(hookB), address(0));
    }

    /// @notice The per-project wallet cap is a SEPARATE limit from the PoG
    ///         quota: a wallet with plenty of global headroom is still capped
    ///         on how much of a single project it may own.
    function test_perWalletCap_limitsHowMuchOfOneProjectAWalletCanTake() public {
        // Attest a generous quota while the dial is still high...
        _registerPoG(alice, POG_CAP);

        // ...then tighten the dial before the project is created, so the
        // project's cap bites well below alice's remaining quota.
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(0.1 ether);

        (, ToshLaunchpadHook hook) = _createProject("Capped", "CAP");
        assertEq(hook.perWalletCap(), 0.1 ether);

        _deposit(alice, hook, 0.1 ether, address(0));

        vm.prank(alice);
        vm.expectRevert(ToshLaunchpadHook.PerWalletCapExceeded.selector);
        factory.deposit{value: 1 wei}(address(hook), address(0));

        (, uint256 remaining,) = factory.eligibility(alice, address(hook));
        assertGt(remaining, 0, "global quota is untouched by the project cap");
    }

    /// @notice Retuning the cap must not rewrite the terms of a round that is
    ///         already open.  Each hook enforces the snapshot taken when it was
    ///         created, so the change only governs projects launched after it.
    function test_perWalletCap_isSnapshottedAtProjectCreation() public {
        // Attest the quota while the dial is still high; the cap and the quota
        // read the same dial, so the order matters.
        _registerPoG(alice, POG_CAP);

        (, ToshLaunchpadHook oldProject) = _createProject("Before", "BFR");
        assertEq(oldProject.perWalletCap(), POG_CAP);

        vm.prank(admin);
        factory.setMaxPogAllocationLimit(0.1 ether);

        (, ToshLaunchpadHook newProject) = _createProject("After", "AFT");
        assertEq(newProject.perWalletCap(), 0.1 ether, "new projects adopt the new dial");
        assertEq(oldProject.perWalletCap(), POG_CAP, "live rounds keep the cap they were deployed with");

        // The grandfathered round still accepts a deposit far above the new
        // platform-wide cap.
        _deposit(alice, oldProject, 1 ether, address(0));
        assertEq(oldProject.ethDeposited(alice), 1 ether);

        // The same deposit into the newer round is refused.
        vm.prank(alice);
        vm.expectRevert(ToshLaunchpadHook.PerWalletCapExceeded.selector);
        factory.deposit{value: 1 ether}(address(newProject), address(0));
    }

    /// @notice Refunding gives the ETH back but NOT the quota.  Otherwise a
    ///         single wallet could deposit/refund on a loop and recycle one
    ///         attestation's worth of allowance indefinitely.
    function test_pogQuota_isNotRestoredByRefund() public {
        // A window long enough to outlast the 24h genesis deadline, so the
        // refund lands while the quota window is still open.
        vm.prank(admin);
        factory.setQuotaWindowDuration(3 days);

        _registerPoG(alice, 0.3 ether);
        (, ToshLaunchpadHook hookA) = _createProject("Refunder", "RFD");
        _deposit(alice, hookA, 0.3 ether, address(0));

        vm.warp(block.timestamp + 25 hours);
        vm.prank(alice);
        hookA.refund();

        assertEq(factory.quotaSpent(alice), 0.3 ether, "refund must not credit the window back");

        (, ToshLaunchpadHook hookB) = _createProject("Retry", "RTY");
        vm.prank(alice);
        vm.expectRevert(ToshFactory.QuotaExceeded.selector);
        factory.deposit{value: 0.1 ether}(address(hookB), address(0));
    }

    /// @notice The quota is a cooling-off budget, not a lifetime one: once the
    ///         window lapses the wallet is topped back up and can participate
    ///         again.
    function test_pogQuota_refillsAfterTheCooldownWindow() public {
        vm.prank(admin);
        factory.setQuotaWindowDuration(1 days);

        _registerPoG(alice, 0.3 ether);
        (, ToshLaunchpadHook hookA) = _createProject("Window1", "WD1");
        _deposit(alice, hookA, 0.3 ether, address(0));

        (bool eligible,,) = factory.eligibility(alice, address(hookA));
        assertFalse(eligible, "budget is spent for the rest of the window");

        vm.warp(block.timestamp + 1 days + 1);

        // A fresh project, because hookA's own genesis window has closed.
        (, ToshLaunchpadHook hookB) = _createProject("Window2", "WD2");
        (, uint256 remaining,) = factory.eligibility(alice, address(hookB));
        assertEq(remaining, 0.3 ether, "the lapsed window reads as refilled");

        _deposit(alice, hookB, 0.3 ether, address(0));
        assertEq(factory.quotaSpent(alice), 0.3 ether, "the new window starts from zero");
        assertEq(factory.totalGenesisDeposited(alice), 0.6 ether, "lifetime tally keeps accumulating");
    }

    function test_refund_returnsEthWhenSoftCapMissed() public {
        (, ToshLaunchpadHook hook) = _createProject("Fail", "FAIL");
        _registerPoG(alice, POG_CAP);
        _deposit(alice, hook, 0.3 ether, address(0));

        vm.warp(block.timestamp + 25 hours);
        assertTrue(hook.canRefund(), "genesis should be refundable past the deadline");

        uint256 before = alice.balance;
        vm.prank(alice);
        hook.refund();

        assertEq(alice.balance - before, 0.3 ether, "refund must be paid in native ETH");
        assertEq(hook.ethDeposited(alice), 0);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  3. Global lifetime referral graph  [v5.0 acceptance test]
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice A wallet's FIRST referrer is bound platform-wide and forever.
    ///         Every later deposit —on any project —pays that same referrer,
    ///         and a competing referral code is silently ignored rather than
    ///         reverting (a stale link must never brick a deposit).
    function test_globalReferralPersistence() public {
        (, ToshLaunchpadHook hookA) = _createProject("RefA", "RFA");
        (, ToshLaunchpadHook hookB) = _createProject("RefB", "RFB");

        _registerPoG(alice, POG_CAP);
        // A referrer must itself hold PoG quota — see `_recordReferral`.  bob is
        // the referrer under test; carol is attested too so that the "competing
        // code is ignored" assertion below is testing immutability of the
        // binding rather than carol simply being ineligible.
        _registerPoG(bob, POG_CAP);
        _registerPoG(carol, POG_CAP);

        // First ever deposit binds alice -> bob.
        _deposit(alice, hookA, 1 ether, bob);
        assertEq(factory.globalReferrers(alice), bob, "first referrer must be bound");
        assertEq(factory.referralCount(bob), 1);
        assertEq(hookA.referralAccrued(bob), 0.1 ether, "referrer earns 10% of the deposit");

        // A different project, a different (competing) code: binding is immutable.
        _deposit(alice, hookB, 1 ether, carol);
        assertEq(factory.globalReferrers(alice), bob, "binding must be permanent");
        assertEq(factory.referralCount(carol), 0, "competing code must not rebind");
        assertEq(hookB.referralAccrued(carol), 0, "competing referrer earns nothing");
        assertEq(hookB.referralAccrued(bob), 0.1 ether, "original referrer earns on the new project too");

        // ...and the commission is real ETH, claimable once the project launches.
        _launch(hookB);
        uint256 before = bob.balance;
        vm.prank(bob);
        hookB.claimReferralReward();
        assertEq(bob.balance - before, 0.1 ether, "referral reward is paid in ETH");
    }

    function test_referral_selfReferralIsIgnored() public {
        (, ToshLaunchpadHook hook) = _createProject("SelfRef", "SRF");
        _registerPoG(alice, POG_CAP);

        _deposit(alice, hook, 0.5 ether, alice);

        assertEq(factory.globalReferrers(alice), address(0), "self-referral must not bind");
        assertEq(hook.referralAccrued(alice), 0, "nobody may farm their own commission");
        assertEq(hook.orphanReferral(), 0.05 ether, "unclaimed commission becomes buyback fuel");
    }

    /// @dev Deposits with no referrer still cut 10% —it just becomes buyback
    ///      ammunition instead of stuck ETH.
    function test_orphanReferralIsForwardedToLadderTreasuryAtLaunch() public {
        (, ToshLaunchpadHook hook) = _createProject("Orphan", "ORP");
        _registerPoG(alice, POG_CAP);
        _deposit(alice, hook, SOFT_CAP, address(0));

        assertEq(hook.orphanReferral(), 0.1 ether);

        uint256 before = address(ladder).balance;
        _launch(hook);
        assertEq(address(ladder).balance - before, 0.1 ether, "orphan commission funds the buyback reservoir");
        assertEq(hook.orphanReferral(), 0, "orphan pot must be drained at launch");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  4. Launch + genesis claim
    // ══════════════════════════════════════════════════════════════════════════

    function test_launch_seedsEthPairAndDerivesP0() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("Live", "LIVE", alice, address(0));

        assertTrue(hook.launched());

        PoolKey memory key = hook.getPoolKey();
        assertTrue(key.currency0.isAddressZero(), "ETH must be currency0");
        assertEq(Currency.unwrap(key.currency1), address(token), "project token must be currency1");

        // 90% of the 1 ETH raise seeds the LP against GENESIS_LP_SUPPLY (3.78 M).
        uint256 expectedP0 = (0.9 ether * 1e18) / hook.GENESIS_LP_SUPPLY();
        assertEq(hook.p0(), expectedP0, "p0 must be derived from the ETH/token seed ratio");
        assertGt(hook.p0(), 0, "p0 must never truncate to zero");

        // Full-range seeding takes the min of both legs, so a few wei of ETH
        // and a few wei of token stay on the hook.  There is no sweep path —
        // same one-way-valve choice as the treasury.  Pin the magnitude so a
        // future math change cannot silently start parking real money here.
        uint256 leftoverEth = address(hook).balance - hook.totalReferralReserved();
        uint256 leftoverTok = token.balanceOf(address(hook)) - hook.GENESIS_CLAIM_SUPPLY();
        assertLt(leftoverEth, 0.001 ether, "ETH dust left on the hook after seeding");
        assertLt(leftoverTok, 1e18, "token dust left on the hook after seeding");
    }

    function test_claimGenesis_paysProRataTokens() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("Claim", "CLM", alice, address(0));

        vm.prank(alice);
        hook.claimGenesis();

        // Sole depositor takes the whole claimable tranche.
        assertEq(token.balanceOf(alice), hook.GENESIS_CLAIM_SUPPLY());

        vm.prank(alice);
        vm.expectRevert(ToshLaunchpadHook.AlreadyClaimed.selector);
        hook.claimGenesis();
    }

    /// @notice The depositors' 10 % opening premium.
    ///
    ///   Pinned as a RELATIONSHIP between the three inputs that produce it —
    ///   `GENESIS_CLAIM_SUPPLY`, `GENESIS_LP_SUPPLY` and `REFERRAL_BPS` — rather
    ///   than as a hard-coded price.  The referral rate carves a flat 10 % off
    ///   every deposit, so the pool is seeded with `0.9 R` against the LP
    ///   tranche while the depositors' own cost basis is `R` over the claim
    ///   tranche.  The 55 / 45 split is what lands the ratio on exactly 1.10;
    ///   move any one of the three and this test is what notices.
    ///
    ///   `ToshLaunchpadHook`'s constants block names this test by hand, so it
    ///   also has to keep existing.
    function test_genesisPremium_isExactlyTenPercent() public {
        (, ToshLaunchpadHook hook) = _launchProject("Premium", "PRM", alice, address(0));

        uint256 raised = hook.totalEthDeposited();
        uint256 costPerToken = (raised * 1e18) / hook.GENESIS_CLAIM_SUPPLY();

        // Tolerance covers integer-division dust only: the two divisions land
        // within ~1e-9 of each other, so 1e-6 is tight enough to fail the
        // moment any of the three inputs actually moves.
        assertApproxEqRel(hook.p0(), (costPerToken * 11_000) / 10_000, 1e12, "depositors must open exactly 10% up");

        // Shelf 0 compounds the ladder's own 5 % on top of that, so Phase-2
        // issuance never undercuts a genesis depositor.
        assertApproxEqRel(
            hook.shelfP0(), (costPerToken * 11_550) / 10_000, 1e12, "shelf 0 must sit 15.5% over cost basis"
        );
    }

    function test_genesisLiquidityIsPermanentlyLocked() public {
        (, ToshLaunchpadHook hook) = _launchProject("Locked", "LCK", alice, address(0));

        uint128 genesisBefore = _genesisLiquidity(hook);
        assertGt(genesisBefore, 0, "genesis LP must exist after launch");

        // There is no code path —for anyone, including the creator —that can
        // pull the genesis position back out.  `unlockCallback` only knows how
        // to add liquidity.
        vm.prank(creator);
        vm.expectRevert();
        ToshLaunchpadHook(payable(address(hook))).unlockCallback(abi.encode(uint8(1)));

        assertEq(_genesisLiquidity(hook), genesisBefore, "a failed callback must not touch genesis LP");
    }

    /// @notice Third-party LPs use their own V4 position (owned by the router
    ///         they called through) and may add or withdraw freely.  Doing so
    ///         must not disturb the genesis position, which lives under a
    ///         different owner key.
    function test_retailLp_canAddAndRemoveWithoutTouchingGenesis() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("Retail", "RTL", alice, address(0));

        vm.prank(alice);
        hook.claimGenesis();

        uint256 tokenIn = 10_000e18;
        uint256 ethIn = 0.01 ether;
        vm.prank(alice);
        token.transfer(bob, tokenIn);

        PoolKey memory key = hook.getPoolKey();
        (uint160 sqrtPriceX96,,,) = IPoolManager(address(poolManager)).getSlot0(key.toId());
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(TICK_LOWER),
            TickMath.getSqrtPriceAtTick(TICK_UPPER),
            ethIn,
            tokenIn
        );
        assertGt(liq, 0);

        uint128 genesisBefore = _genesisLiquidity(hook);

        vm.startPrank(bob);
        token.approve(address(liqRouter), type(uint256).max);
        liqRouter.modifyLiquidity{value: ethIn}(
            key,
            ModifyLiquidityParams({
                tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: int256(uint256(liq)), salt: bytes32(0)
            }),
            ""
        );
        vm.stopPrank();

        assertEq(_retailLiquidity(hook), liq, "retail LP must land in its own position");
        assertEq(_genesisLiquidity(hook), genesisBefore, "adding retail LP must not move genesis");

        vm.prank(bob);
        liqRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: -int256(uint256(liq)), salt: bytes32(0)
            }),
            ""
        );

        assertEq(_retailLiquidity(hook), 0, "retail LP must be free to withdraw");
        assertEq(_genesisLiquidity(hook), genesisBefore, "withdrawing retail LP must not move genesis");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  5. Discrete tier ladder + anti-manipulation gates  [v5.0 acceptance test]
    // ══════════════════════════════════════════════════════════════════════════

    function test_tierLadder_geometryIsWellFormed() public {
        (, ToshLaunchpadHook hook) = _launchProject("Ladder", "LDR", alice, address(0));

        assertEq(hook.TIER_COUNT(), 4000);
        assertEq(hook.TIER_SIZE(), 3_150e18);
        assertEq(hook.BONDING_MAX(), 12_600_000e18);
        assertEq(hook.GENESIS_SUPPLY(), 8_400_000e18);

        // The ladder is anchored one 5% notch above the pool, not level with it.
        assertEq(hook.shelfP0(), (hook.p0() * 10_500) / 10_000, "ladder base is p0 + 5%");
        assertEq(hook.tierPriceAt(0), hook.shelfP0(), "shelf 0 opens at the ladder base");
        assertGt(hook.tierPriceAt(1), hook.tierPriceAt(0), "prices must be strictly increasing");

        // 4000 rungs of +0.19025% compound out to a 2000x span: the shelf
        // ladder carries the token from its opening price to more than three
        // orders of magnitude above it before Phase-2 issuance is exhausted.
        uint256 last = hook.tierPriceAt(hook.TIER_COUNT() - 1);
        assertApproxEqRel(last, hook.shelfP0() * 2000, 0.01e18, "top rung should land near 2000x the base");
    }

    /// @notice THE RATIFIED PARAMETER SET.  One place, every literal, so that
    ///         changing the economics is a deliberate act with a single gate.
    ///
    ///   Decision D1, taken after the red-team pass measured the real release
    ///   schedule: freeze
    ///
    ///     span     2000x across 4000 shelves
    ///     shelves  equal size, 3 150 tokens each
    ///     split    8.4 M genesis (4.62 M claim + 3.78 M LP) / 12.6 M ladder
    ///
    ///   and accept what that costs.  What it costs is stated plainly in
    ///   `test_earlyReleaseSchedule_isSetByTheSupplySplit`: a doubling in price
    ///   releases ~24.9 % of the tradeable float, not the ~10 % originally
    ///   targeted.  Closing that gap needs a wider span or a smaller Phase 2,
    ///   and both were judged worse than the thing they fix — a wider span
    ///   flattens the whole curve logarithmically for very little early relief,
    ///   and a smaller Phase 2 shrinks the only supply the market can price.
    ///
    ///   The other suites pin the CONSEQUENCES of these numbers (the schedule,
    ///   the 2000x endpoint, the supply closure, the genesis premium).  This one
    ///   pins the numbers themselves, so a diff that touches the economics
    ///   cannot land quietly as a side effect of some other edit.
    function test_ratifiedParameterSet_isFrozen() public {
        (, ToshLaunchpadHook hook) = _launchProject("Frozen", "FRZ", alice, address(0));

        // ── Supply split ──────────────────────────────────────────────────────
        assertEq(hook.GENESIS_SUPPLY(), 8_400_000e18, "genesis block");
        assertEq(hook.GENESIS_CLAIM_SUPPLY(), 4_620_000e18, "claim float (55 % of genesis)");
        assertEq(hook.GENESIS_LP_SUPPLY(), 3_780_000e18, "locked LP (45 % of genesis)");
        assertEq(hook.BONDING_MAX(), 12_600_000e18, "ladder");

        // ── Ladder geometry ───────────────────────────────────────────────────
        assertEq(hook.TIER_COUNT(), 4000, "shelf count");
        assertEq(hook.TIER_SIZE(), 3_150e18, "equal shelf size");
        assertEq(hook.MAX_TIERS_PER_TX(), 32, "shelves per call");

        // `TIER_STEP_E18` is internal, so freeze the literal by recomputing the
        // first rung with it.  An edit to the constant breaks this exactly.
        assertEq(
            hook.tierPriceAt(1),
            (hook.shelfP0() * 1_001_902_508_266_805_824) / 1e18,
            "TIER_STEP_E18 == 1_001_902_508_266_805_824"
        );

        // ── Closure, restated here so the set is self-evidently coherent ──────
        assertEq(hook.TIER_COUNT() * hook.TIER_SIZE(), hook.BONDING_MAX(), "shelves fill the ladder exactly");
        assertEq(hook.GENESIS_CLAIM_SUPPLY() + hook.GENESIS_LP_SUPPLY(), hook.GENESIS_SUPPLY(), "genesis splits 55/45");
        assertEq(hook.GENESIS_SUPPLY() + hook.BONDING_MAX(), 21_000_000e18, "and the two close on the hard cap");
    }

    /// @notice How much fresh supply the ladder hands the market on the way up,
    ///         pinned as a schedule rather than as the constants that produce it.
    ///
    ///   Equal-size shelves release `log(R) / log(SPAN)` of Phase 2 by the time
    ///   the market sits at `R x` the ladder base.  That fraction is a property
    ///   of the span alone, so the ONLY way to shrink the absolute number of
    ///   tokens arriving early is to shrink Phase 2 itself.  The 40 / 60
    ///   genesis-to-ladder split is that decision, and it is what carries this
    ///   number:
    ///
    ///     20/80 + 1000x span   2x released 1 688 400   40.2 % of GENESIS_SUPPLY
    ///     20/80 + 2000x span   2x released 1 533 000   36.5 %
    ///     40/60 + 2000x span   2x released 1 149 750   13.7 %   <- here
    ///
    ///   ── Mind the denominator ────────────────────────────────────────────
    ///
    ///   Those percentages are all against GENESIS_SUPPLY (8.4 M), which is the
    ///   right basis for comparing the three CONFIGURATIONS above but the wrong
    ///   one for asking "how much does the market have to absorb".  3.78 M of
    ///   the 8.4 M is sealed inside the genesis LP position — the hook owns it
    ///   and exposes no path that removes liquidity — so it is supply that
    ///   exists but never trades.  Only the 4.62 M claim side is float.
    ///
    ///   Against the float the same 1 149 750 tokens are 24.9 %, and 19.9 % of
    ///   everything actually circulating once they land.  Both readings are
    ///   pinned below so neither can be quoted without the other: a change that
    ///   improves the headline number while worsening the float number will
    ///   fail here rather than ship.
    ///
    ///   Every lever is pinned on purpose: `unlockedAtTwoX` moves if the span is
    ///   refitted, `released` moves if the split is resized, and all three
    ///   ratios move if either does.
    function test_earlyReleaseSchedule_isSetByTheSupplySplit() public {
        (, ToshLaunchpadHook hook) = _launchProject("Split", "SPL", alice, address(0));

        uint256 n = hook.TIER_COUNT();
        uint256 unlockedAtTwoX;
        uint256 twoX = hook.shelfP0() * 2;
        while (unlockedAtTwoX < n && hook.tierPriceAt(unlockedAtTwoX) <= twoX) {
            unlockedAtTwoX++;
        }

        assertEq(unlockedAtTwoX, 365, "the 2000x span puts 365 of the 4000 shelves under 2x");

        uint256 released = unlockedAtTwoX * hook.TIER_SIZE();
        assertEq(released, 1_149_750e18, "2x releases 1.14975 M tokens");

        // (a) against the whole genesis block — the configuration-comparison basis
        assertApproxEqRel((released * 10_000) / hook.GENESIS_SUPPLY(), 1369, 0.01e18, "13.7 % of GENESIS_SUPPLY");

        // (b) against the tradeable float — the basis that answers "who absorbs this"
        assertApproxEqRel((released * 10_000) / hook.GENESIS_CLAIM_SUPPLY(), 2488, 0.01e18, "24.9 % of the claim float");

        // (c) against everything circulating once it lands
        assertApproxEqRel(
            (released * 10_000) / (hook.GENESIS_CLAIM_SUPPLY() + released),
            1992,
            0.01e18,
            "19.9 % of post-release circulating supply"
        );

        // The LP side is the whole reason (a) and (b) differ, and it is locked.
        assertEq(
            hook.GENESIS_CLAIM_SUPPLY() + hook.GENESIS_LP_SUPPLY(),
            hook.GENESIS_SUPPLY(),
            "genesis is exactly claim float + locked LP"
        );

        // The genesis block is 40 % of supply and the ladder the remaining 60 %.
        assertEq(hook.GENESIS_SUPPLY() * 5, 21_000_000e18 * 2, "genesis is exactly 40 % of the hard cap");
        assertEq(hook.GENESIS_SUPPLY() + hook.BONDING_MAX(), 21_000_000e18, "and the two close on it");
    }

    function test_tierMint_sellsTheActiveShelfAndAdvances() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("Mint", "MNT", alice, address(0));
        _openLadder(hook, 0.01 ether);

        uint256 shelf = hook.TIER_SIZE();
        uint256 cost = hook.quoteMint(shelf);
        assertEq(cost, (hook.shelfP0() * shelf) / 1e18);

        uint256 ladderBefore = address(ladder).balance;

        vm.prank(bob);
        hook.mintBondingCurve{value: cost}(shelf);

        assertEq(token.balanceOf(bob), shelf);
        assertEq(hook.currentTierIndex(), 1, "a fully sold shelf advances the ladder");
        assertEq(hook.currentTierSold(), 0);
        assertEq(hook.phase2Minted(), shelf);

        // The 1% platform cut is buyback fuel, not platform profit.
        assertEq(address(ladder).balance - ladderBefore, (cost * 100) / 10_000);
    }

    /// @notice An order larger than the active shelf rolls into the next one
    ///         inside a single call, instead of reverting.
    function test_tierMint_spansShelvesInOneCall() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("Span", "SPN", alice, address(0));
        _openLadder(hook, 0.01 ether);

        uint256 shelf = hook.TIER_SIZE();
        uint256 want = shelf + 1_000e18;

        uint256 expected = (hook.tierPriceAt(0) * shelf) / 1e18 + (hook.tierPriceAt(1) * 1_000e18) / 1e18;
        assertEq(hook.quoteMint(want), expected, "quote must price each leg on its own shelf");

        vm.prank(bob);
        uint256 charged = hook.mintBondingCurve{value: expected}(want);

        assertEq(charged, expected);
        assertEq(token.balanceOf(bob), want);
        assertEq(hook.currentTierIndex(), 1, "the cleared shelf advanced the ladder");
        assertEq(hook.currentTierSold(), 1_000e18, "the overflow landed on shelf 1");
        assertEq(hook.phase2Minted(), want);
    }

    /// @notice The load-bearing invariant of the cross-shelf fill: sweeping N
    ///         shelves in one call is indistinguishable from N single-shelf
    ///         calls —same tokens, same total ETH, same ladder state.  Only
    ///         the gas differs, which is the whole point of allowing it.
    function test_tierMint_spanIsEquivalentToSequentialShelfBuys() public {
        (ToshToken tokenA, ToshLaunchpadHook hookA) = _launchProject("SpanA", "SPA", alice, address(0));
        (ToshToken tokenB, ToshLaunchpadHook hookB) = _launchProject("SpanB", "SPB", alice, address(0));
        _openLadder(hookA, 0.01 ether);
        _openLadder(hookB, 0.01 ether);

        assertEq(hookA.shelfP0(), hookB.shelfP0(), "twin projects must open at the same price");

        uint256 shelf = hookA.TIER_SIZE();
        uint256 tail = 2_500e18;
        uint256 want = 2 * shelf + tail;

        // A: one sweeping call.
        vm.prank(bob);
        uint256 sweptCost = hookA.mintBondingCurve{value: 10 ether}(want);

        // B: the same order, chopped by hand the way the old UI had to.
        uint256 pieceCost;
        vm.startPrank(carol);
        pieceCost += hookB.mintBondingCurve{value: 10 ether}(shelf);
        pieceCost += hookB.mintBondingCurve{value: 10 ether}(shelf);
        pieceCost += hookB.mintBondingCurve{value: 10 ether}(tail);
        vm.stopPrank();

        assertEq(sweptCost, pieceCost, "a swept order must not cost more or less than a split one");
        assertEq(tokenA.balanceOf(bob), tokenB.balanceOf(carol));
        assertEq(hookA.currentTierIndex(), hookB.currentTierIndex());
        assertEq(hookA.currentTierSold(), hookB.currentTierSold());
        assertEq(hookA.phase2Minted(), hookB.phase2Minted());
    }

    /// @notice `maxMintable()` is the exact boundary the mint path enforces:
    ///         one wei-token more must revert.  At launch the binding limit is
    ///         the 105 % ceiling, not `MAX_TIERS_PER_TX`.
    function test_maxMintable_isTheExactAcceptedBoundary() public {
        (, ToshLaunchpadHook hook) = _launchProject("MaxMint", "MXM", alice, address(0));
        _openLadder(hook, 0.01 ether);

        // Independently recount the unlocked shelves against the live ceiling.
        (,,,,, uint256 ceiling,) = hook.tierStatus();
        uint256 unlocked;
        while (unlocked < hook.MAX_TIERS_PER_TX() && hook.tierPriceAt(unlocked) <= ceiling) {
            unlocked++;
        }
        assertLt(unlocked, hook.MAX_TIERS_PER_TX(), "at p0 the ceiling should bind before the leg cap");

        uint256 cap = hook.maxMintable();
        assertEq(cap, unlocked * hook.TIER_SIZE(), "every unlocked shelf counts in full");

        vm.prank(bob);
        vm.expectRevert(ToshLaunchpadHook.TierPriceAboveCeiling.selector);
        hook.mintBondingCurve{value: 10 ether}(cap + 1);

        vm.prank(bob);
        hook.mintBondingCurve{value: 10 ether}(cap);
        assertEq(hook.currentTierIndex(), unlocked, "the whole unlocked run cleared");
    }

    /// @notice When the market runs far ahead of the ladder, many shelves unlock
    ///         at once and the gas bound takes over from the price bound.  It is
    ///         a per-call limit only: the buyer just sends a second transaction.
    function test_tierMint_legCapBindsWhenMarketRunsAhead() public {
        (, ToshLaunchpadHook hook) = _launchProject("LegCap", "LEG", alice, address(0));
        vm.prank(alice);
        hook.claimGenesis();

        // Pump the market and let the elevated price age into the TWAP, so
        // min(spot, TWAP) —not just spot —clears far above p0.
        _swapBuy(hook, trader, 20 ether);
        _nextBlock();
        vm.warp(block.timestamp + 1900);
        _swapBuy(hook, trader, 1e18);
        _nextBlock();

        uint256 legCap = hook.MAX_TIERS_PER_TX();
        assertEq(hook.maxMintable(), legCap * hook.TIER_SIZE(), "leg cap, not the ceiling, is binding now");

        uint256 tooManyLegs = legCap * hook.TIER_SIZE() + 1e18;
        vm.prank(bob);
        vm.expectRevert(ToshLaunchpadHook.SpanTooManyShelves.selector);
        hook.mintBondingCurve{value: 50 ether}(tooManyLegs);

        // Splitting it across two calls in the SAME block reaches the state the
        // single call was refused —proving the cap is gas, not safety.
        vm.startPrank(bob);
        hook.mintBondingCurve{value: 50 ether}(legCap * hook.TIER_SIZE());
        hook.mintBondingCurve{value: 50 ether}(1e18);
        vm.stopPrank();

        assertEq(hook.phase2Minted(), tooManyLegs);
    }

    /// @notice The ladder opens LOCKED, which is the whole point of anchoring
    ///         shelf 0 at `1.05 x p0`.
    ///
    ///   Because `SHELF_PREMIUM_BPS == PRICE_CEILING_BPS`, the markup cancels
    ///   on both sides of the gate and shelf `i` unlocks exactly when
    ///   `min(spot, TWAP) >= p0 * STEP^i`.  At launch the market sits AT p0 — ON
    ///   the boundary, and the gate's `>` is strict, so the price arithmetic
    ///   alone ADMITS shelf 0 whenever the round-tripped spot lands at or above
    ///   `p0`.  `launch()` therefore stamps `lastSwapBlock` and closes the
    ///   launch block outright; Phase 2 lifts from the next block, and only once
    ///   the market holds at or above the genesis price.
    ///
    ///   Anchoring the ladder level with the pool instead would leave shelves
    ///   0..25 —109 200 tokens —mintable in the launch block itself.
    ///
    ///   ── Why this sweeps raise sizes ─────────────────────────────────────
    ///
    ///   An earlier version of this test ran a single raise (`SOFT_CAP`) and
    ///   passed, which read as proof of a design property and was not one.
    ///   Whether spot round-trips to just below `p0` (locked) or just above it
    ///   (shelf 0 admitted, 3 150 tokens) is decided by truncation inside
    ///   `_toSqrtPriceX96` / `_sqrtPriceToEthPerToken` and varies with the
    ///   raise: over 1..12 ETH the old code opened at 10 ETH and locked at the
    ///   other eleven.  A property that holds for one fixture and not its
    ///   neighbours needs the fixture swept, so the lockout is what is being
    ///   asserted rather than the coin flip.
    function test_ladderOpensLockedAtLaunch() public {
        (, ToshLaunchpadHook hook) = _launchProject("Opening", "OPN", alice, address(0));

        assertEq(hook.shelfP0(), (hook.p0() * 10_500) / 10_000, "shelf 0 sits 5% over the pool");
        assertEq(hook.maxMintable(), 0, "nothing is mintable in the launch block");

        vm.prank(bob);
        vm.expectRevert(ToshLaunchpadHook.SameBlockMintForbidden.selector);
        hook.mintBondingCurve{value: 1 ether}(1e18);

        // A market that holds above p0 is what opens it.
        _openLadder(hook, 0.01 ether);
        assertGt(hook.maxMintable(), 0, "a market above p0 unlocks the ladder");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Ladder halt — the one platform brake that reaches a launched project
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice A halt stops shelf minting and NOTHING else.
    ///
    ///   `pause()` deliberately cannot touch a launched project, which left one
    ///   gap: a defect in the shelf pricing itself would keep selling supply
    ///   with no way to stop it.  `haltLadderMinting` closes exactly that gap,
    ///   and this test exists mostly to pin how narrow "exactly that" is —
    ///   trading, LP, genesis claims, referral claims and refunds must all keep
    ///   working, because a brake that can strand a balance is a different and
    ///   much worse thing than a brake that can cancel an opportunity.
    function test_ladderHalt_stopsMintingAndNothingElse() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("Halt", "HLT", alice, address(0));
        _openLadder(hook, 0.01 ether);
        assertGt(hook.maxMintable(), 0, "fixture needs an open ladder to halt");

        vm.prank(admin);
        factory.haltLadderMinting(address(hook), 1 days);

        assertTrue(factory.ladderMintingHalted(address(hook)));
        assertEq(hook.maxMintable(), 0, "the view must agree with the guard");

        vm.prank(bob);
        vm.expectRevert(ToshLaunchpadHook.LadderMintingHalted.selector);
        hook.mintBondingCurve{value: 1 ether}(1e18);

        // ...but the market is untouched.  Measured as price movement rather
        // than a balance, so the assertion is about the swap having executed
        // and not about which address the test router settles to.
        (,,, uint256 spotBefore,,,) = hook.tierStatus();
        _swapBuy(hook, trader, 0.5 ether);
        _nextBlock();
        (,,, uint256 spotAfter,,,) = hook.tierStatus();
        assertGt(spotAfter, spotBefore, "secondary trading keeps working while the ladder is halted");

        // ...and so is every path that returns value to a user.
        vm.prank(alice);
        hook.claimGenesis();
        assertGt(token.balanceOf(alice), 0, "genesis claims keep working");
    }

    /// @notice A halt lapses on its own, so it cannot become a permanent veto.
    ///
    ///   This is the property that makes the switch a break-glass brake rather
    ///   than a kill switch.  An owner who is hostile, compromised or simply
    ///   gone cannot brick Phase 2: the worst case is a rolling outage that has
    ///   to be re-armed in public, on-chain, at most a week at a time.
    function test_ladderHalt_expiresWithoutIntervention() public {
        (, ToshLaunchpadHook hook) = _launchProject("Lapse", "LPS", alice, address(0));
        _openLadder(hook, 0.01 ether);

        // Hoisted: `vm.prank` arms only the next CALL, and evaluating
        // `factory.MAX_HALT_DURATION()` inline as an argument would spend it.
        uint256 maxHalt = factory.MAX_HALT_DURATION();

        vm.prank(admin);
        factory.haltLadderMinting(address(hook), maxHalt);
        assertEq(hook.maxMintable(), 0);

        // One second past the deadline the ladder is live again, with nobody
        // having had to call anything.
        vm.warp(block.timestamp + maxHalt + 1);
        _nextBlock();
        assertFalse(factory.ladderMintingHalted(address(hook)));
        assertGt(hook.maxMintable(), 0, "the halt must lapse by itself");

        // And the cap is enforced, so no single call can outrun that guarantee.
        vm.prank(admin);
        vm.expectRevert(ToshFactory.HaltDurationTooLong.selector);
        factory.haltLadderMinting(address(hook), maxHalt + 1);

        vm.prank(admin);
        vm.expectRevert(ToshFactory.HaltDurationTooLong.selector);
        factory.haltLadderMinting(address(hook), 0);
    }

    /// @notice The halt is scoped: one bad market does not take Phase 2 offline
    ///         platform-wide, and the global form still exists when it should.
    function test_ladderHalt_isScopedPerHookAndGlobally() public {
        (, ToshLaunchpadHook hookA) = _launchProject("ScopeA", "SCA", alice, address(0));
        (, ToshLaunchpadHook hookB) = _launchProject("ScopeB", "SCB", alice, address(0));
        _openLadder(hookA, 0.01 ether);
        _openLadder(hookB, 0.01 ether);

        vm.prank(admin);
        factory.haltLadderMinting(address(hookA), 1 days);
        assertEq(hookA.maxMintable(), 0, "the named project is halted");
        assertGt(hookB.maxMintable(), 0, "its neighbour is not");

        // address(0) means every ladder.
        vm.prank(admin);
        factory.haltLadderMinting(address(0), 1 days);
        assertEq(hookB.maxMintable(), 0, "the global form reaches every project");

        // Resuming the global halt leaves the targeted one standing.
        vm.prank(admin);
        factory.resumeLadderMinting(address(0));
        assertEq(hookA.maxMintable(), 0, "hookA's own halt survives the global lift");
        assertGt(hookB.maxMintable(), 0, "hookB is free again");

        vm.prank(admin);
        factory.resumeLadderMinting(address(hookA));
        assertGt(hookA.maxMintable(), 0);
    }

    function test_ladderHalt_rejectsNonOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        factory.haltLadderMinting(address(0), 1 days);

        vm.prank(alice);
        vm.expectRevert();
        factory.resumeLadderMinting(address(0));
    }

    /// @notice The launch-block lock holds for EVERY raise, not just the one
    ///         this suite happens to fixture on.
    ///
    /// @dev    See `test_ladderOpensLockedAtLaunch` for why the sweep exists.
    ///         10 ETH is the raise that used to slip through, so it is the top
    ///         of the range on purpose — which is also where `POG_CAP` puts the
    ///         ceiling on a single depositor.
    function test_ladderOpensLockedAtLaunch_acrossRaiseSizes() public {
        for (uint256 i = 1; i <= 10; ++i) {
            uint256 snap = vm.snapshotState();

            (, ToshLaunchpadHook hook) = _createProject("Sweep", "SWP");
            _deposit(alice, hook, i * 1 ether, address(0));
            _launch(hook);

            assertEq(hook.maxMintable(), 0, "launch block must be shut at every raise size");

            vm.prank(bob);
            vm.expectRevert(ToshLaunchpadHook.SameBlockMintForbidden.selector);
            hook.mintBondingCurve{value: 1 ether}(1e18);

            vm.revertToState(snap);
        }
    }

    /// @notice Until a full TWAP window has elapsed, a pumped spot cannot
    ///         lift the mint ceiling above `1.05 × p0`.
    ///
    ///   `_getTWAPPrice` returns 0 while `span == 0` (the launch timestamp).
    ///   After a second or two it returns a stub averaged over that handful
    ///   of seconds — which is spot in all but name.  Blindly using either
    ///   number as the slow leg lets a two-block pump (buy in N, mint in
    ///   N+1) sweep 16 shelves against a fabricated reference.
    ///
    ///   `_safeReferencePrice` therefore uses `min(spot, p0)` until
    ///   `span >= TWAP_WINDOW`.  Same-block mint is still forbidden (gate 1).
    ///   The next block a pumped spot may open shelf 0 at the `p0` cap, but
    ///   cannot unlock the rest of the run.  After the window matures, a
    ///   price that was actually held is allowed to open further shelves.
    function test_preTwapWindow_capsReferenceAtP0AgainstATwoBlockPump() public {
        (, ToshLaunchpadHook hook) = _launchProject("TwapGap", "TWG", alice, address(0));

        assertEq(hook.twapSqrtPriceX96(), 0, "TWAP is unset in the launch block");
        assertEq(hook.maxMintable(), 0, "ladder still locked at p0");

        _swapBuy(hook, trader, 5 ether);

        vm.prank(bob);
        vm.expectRevert(ToshLaunchpadHook.SameBlockMintForbidden.selector);
        hook.mintBondingCurve{value: 1 ether}(1e18);

        // Same timestamp, next block — the Foundry path where TWAP stays 0.
        _nextBlock();
        assertEq(hook.twapSqrtPriceX96(), 0, "timestamp has not advanced");
        assertLe(hook.maxMintable(), hook.TIER_SIZE(), "p0 cap: at most shelf 0");

        // Real-chain path: ~2 s later TWAP is a non-zero stub, still not a window.
        vm.warp(block.timestamp + 2);
        _nextBlock();
        assertLe(hook.maxMintable(), hook.TIER_SIZE(), "short TWAP still capped at p0");

        // A price held for a full window is allowed to open the ladder further.
        vm.warp(block.timestamp + 1900);
        _nextBlock();
        assertGt(hook.maxMintable(), hook.TIER_SIZE(), "mature TWAP lets a held pump unlock further");
    }

    /// @notice Sweeping every unlocked shelf and dumping it is LOSS-MAKING, so
    ///         the ladder is not an arbitrage against its own pool.
    ///
    ///   The reason is structural, and the 5 % ladder premium makes it hold
    ///   everywhere on the ladder rather than only at the open.  A shelf mint
    ///   does not touch the pool, so it cannot drag spot up behind it: the
    ///   buyer pays at least 1.05 x the market and then has to sell back into
    ///   that same market, moving it DOWN with their own size, before the
    ///   1.00 % round-trip friction is even counted.
    ///
    ///   Ladder arbitrage only pays when the MARKET has already run ahead of
    ///   the ladder —which is exactly the mechanism meant to pull it up.
    function test_sweepAndDumpIsLossMaking() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("Arb", "ARB", alice, address(0));
        _openLadder(hook, 0.01 ether);

        address bot = makeAddr("sweepBot");
        vm.deal(bot, 100 ether);

        // The cross-shelf fill makes the whole unlocked run a single call, so
        // this is the cheapest form the attack can possibly take.
        uint256 unlocked = hook.maxMintable();
        assertGt(unlocked, 0, "the ladder must be open for this to be a test");

        vm.prank(bot);
        uint256 spent = hook.mintBondingCurve{value: 10 ether}(unlocked);
        assertEq(token.balanceOf(bot), unlocked);

        uint256 ethAfterMint = bot.balance;
        _swapSell(hook, bot, unlocked);
        uint256 recovered = bot.balance - ethAfterMint;

        assertLt(recovered, spent, "the round trip must never be profitable");
        assertGt(spent - recovered, spent / 20, "and it should lose materially, not marginally");
    }

    /// @notice The other half of the sentence above, pinned rather than assumed:
    ///         once the market HAS run ahead, sweeping the ladder is profitable,
    ///         and deliberately so.
    ///
    ///   The 105% gate is a ceiling, not a floor.  It refuses shelves priced
    ///   ABOVE `min(spot, TWAP)` and says nothing about shelves priced below,
    ///   so appreciation leaves the low shelves in the money.  That spread is
    ///   the entire incentive to sweep, and sweeping is how the ladder tracks a
    ///   market that has moved: the cursor advances 0.190% per 4,200 tokens
    ///   while a single swap can move price by any amount.
    ///
    ///   The cost is real and is borne by holders — the sweeper's exit drains
    ///   pool ETH and pushes price back toward the cursor, which caps how far a
    ///   rally can durably run.  This is an accepted trade, not an oversight.
    ///   If it is ever revisited, the fix is a floor on the charged unit price
    ///   (`max(tierPriceAt(i), min(spot, TWAP))`), which needs no change to the
    ///   shelf ledger.
    ///
    /// @dev No `vm.prank` in the measured path.  A prank spoofs `msg.sender`
    ///      only; `value` is still debited from the TEST CONTRACT, so a pranked
    ///      actor's balance shows the inflows without the outflows and reads as
    ///      profit that is not there.  `FreeRider` holds and spends its own ETH,
    ///      which makes its balance an honest ledger.
    function test_sweepIsProfitableOnceTheMarketHasRunAhead() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("Ahead", "AHD", alice, address(0));

        FreeRider rider = new FreeRider();
        vm.deal(address(rider), 100 ether);
        vm.deal(address(this), 10_000 ether); // the test contract funds the market's pumps

        // Organic demand, paid for by the market rather than by the sweeper.
        _openLadder(hook, 0.5 ether);

        uint256 unlocked = hook.maxMintable();
        assertGt(unlocked, 0, "the ladder must be open for this to be a test");
        uint256 cost = hook.quoteMint(unlocked);

        uint256 before = address(rider).balance;
        rider.mint(hook, unlocked, cost);
        _nextBlock();
        rider.sell(swapRouter, hook.getPoolKey(), token.balanceOf(address(rider)));

        assertGt(address(rider).balance, before, "an appreciated market makes the sweep pay");

        // No admin privilege is involved: this rider is an ordinary outsider.
        // Pinning the order of magnitude keeps a future pricing change from
        // silently widening the window.
        uint256 profit = address(rider).balance - before;
        assertLt(profit, (cost * 3) / 2, "sweep profit must stay under 1.5x the shelf cost");
    }

    /// @notice The two Phase-2 anti-manipulation gates, exercised end to end.
    ///
    ///   Gate 1 —same-block lockout: a mint may not share a block with a swap,
    ///            so a flash-loaned price spike cannot be minted against.
    ///   Gate 2 —105% ceiling on `min(spot, TWAP)`: the shelf price must be
    ///            met by a genuine, durable market price.  Here the market is
    ///            pushed DOWN through the shelf, which must lock the ladder.
    function test_tierMintAntiSpikeAndCeiling() public {
        (, ToshLaunchpadHook hook) = _launchProject("Gates", "GTS", alice, address(0));

        vm.prank(alice);
        hook.claimGenesis();

        // Baseline: with the market held above p0, shelf 0 is mintable.
        _openLadder(hook, 0.01 ether);
        uint256 probe = 1_000e18;
        uint256 cost = hook.quoteMint(probe);
        vm.prank(bob);
        hook.mintBondingCurve{value: cost}(probe);
        assertEq(hook.phase2Minted(), probe);

        // ── Gate 1 ────────────────────────────────────────────────────────────
        // Dump tokens into the pool; the mint that follows IN THE SAME BLOCK is
        // refused before any price is even consulted.
        _swapSell(hook, alice, 400_000e18);
        assertEq(hook.lastSwapBlock(), vm.getBlockNumber(), "afterSwap must stamp the swap block");

        vm.prank(bob);
        vm.expectRevert(ToshLaunchpadHook.SameBlockMintForbidden.selector);
        hook.mintBondingCurve{value: 1 ether}(probe);

        // ── Gate 2 ────────────────────────────────────────────────────────────
        // Next block: the lockout clears, but the market has collapsed well
        // below the shelf, so the 105% ceiling keeps the ladder shut.
        _nextBlock();

        vm.expectRevert(ToshLaunchpadHook.TierPriceAboveCeiling.selector);
        hook.quoteMint(probe);

        vm.prank(bob);
        vm.expectRevert(ToshLaunchpadHook.TierPriceAboveCeiling.selector);
        hook.mintBondingCurve{value: 1 ether}(probe);
    }

    /// @dev A single-block pump must not unlock a shelf: the reference price is
    ///      `min(spot, TWAP)`, and the TWAP still remembers the pre-pump market.
    function test_tierMint_twapDefeatsASingleBlockPump() public {
        (, ToshLaunchpadHook hook) = _launchProject("Twap", "TWP", alice, address(0));
        vm.prank(alice);
        hook.claimGenesis();

        // Sell the market down, then let the depressed price age into the TWAP.
        _swapSell(hook, alice, 400_000e18);
        _nextBlock();
        vm.warp(block.timestamp + 1900);
        _swapSell(hook, alice, 1e18); // roll the oracle checkpoint forward

        // Now pump spot back up hard in a single swap.
        _swapBuy(hook, trader, 20 ether);
        _nextBlock();

        // Spot is high again, but min(spot, TWAP) is not.
        vm.prank(bob);
        vm.expectRevert(ToshLaunchpadHook.TierPriceAboveCeiling.selector);
        hook.mintBondingCurve{value: 5 ether}(1_000e18);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  6. Asymmetric in-flight tax
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Buy leg: 0.7% of the INPUT ETH is skimmed and routed to the
    ///      buyback reservoir.  Nothing is burned on this leg.
    function test_buyTax_skimsSeventyBpsEthToLadderTreasury() public {
        (, ToshLaunchpadHook hook) = _launchProject("BuyTax", "BTX", alice, address(0));

        uint256 ethIn = 1 ether;
        uint256 before = address(ladder).balance;

        _swapBuy(hook, trader, ethIn);

        assertEq(address(ladder).balance - before, (ethIn * 70) / 10_000, "0.7% of input ETH must reach the treasury");
    }

    /// @dev Sell leg: 0.7% of the INPUT TOKENS is burned in place. No ETH moves.
    function test_sellTax_burnsSeventyBpsOfTokensInPlace() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("SellTax", "STX", alice, address(0));
        vm.prank(alice);
        hook.claimGenesis();

        uint256 tokensIn = 100_000e18;
        uint256 deadBefore = token.balanceOf(DEAD);
        uint256 ladderBefore = address(ladder).balance;

        _swapSell(hook, alice, tokensIn);

        assertEq(token.balanceOf(DEAD) - deadBefore, (tokensIn * 70) / 10_000, "0.7% of input tokens must be burned");
        assertEq(address(ladder).balance, ladderBefore, "the sell leg must not route ETH to the treasury");
    }

    /// @notice Exact-output buy: specified is TOKEN, but the tax must still
    ///         land on the ETH input.  Otherwise every aggregator buy is
    ///         constructed as "N tokens out" and the reservoir never fills.
    function test_buyTax_exactOutputSkimsEthNotTokens() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("BuyXOut", "BXO", alice, address(0));

        uint256 tokensOut = 10_000e18;
        uint256 deadBefore = token.balanceOf(DEAD);
        uint256 ladderBefore = address(ladder).balance;
        uint256 ethBefore = address(this).balance;

        vm.prank(trader);
        swapRouter.swap{value: 10 ether}(
            hook.getPoolKey(),
            SwapParams({
                zeroForOne: true, amountSpecified: int256(tokensOut), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 ethSpent = ethBefore - address(this).balance;
        uint256 taxIn = address(ladder).balance - ladderBefore;
        uint256 poolIn = ethSpent - taxIn;
        assertEq(taxIn, (poolIn * 70) / 10_000, "0.7% of the ETH input must reach the treasury");
        assertEq(token.balanceOf(DEAD), deadBefore, "exact-output buy must not burn tokens");
    }

    /// @notice Exact-output sell: specified is ETH, but the tax must still
    ///         burn the token input.  Mirrors the buy-side close so a router
    ///         cannot flip a sell into a treasury donation by asking for
    ///         exact ETH out.
    function test_sellTax_exactOutputBurnsTokensNotEth() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("SellXOut", "SXO", alice, address(0));
        vm.prank(alice);
        hook.claimGenesis();

        uint256 ethOut = 0.01 ether;
        uint256 deadBefore = token.balanceOf(DEAD);
        uint256 ladderBefore = address(ladder).balance;
        uint256 tokBefore = token.balanceOf(alice);

        PoolKey memory key = hook.getPoolKey();
        vm.startPrank(alice);
        IERC20(address(token)).approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false, amountSpecified: int256(ethOut), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        uint256 tokSpent = tokBefore - token.balanceOf(alice);
        uint256 burned = token.balanceOf(DEAD) - deadBefore;
        uint256 poolIn = tokSpent - burned;
        assertEq(burned, (poolIn * 70) / 10_000, "0.7% of the token input must burn");
        assertEq(address(ladder).balance, ladderBefore, "exact-output sell must not fund the treasury");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  7. Piggyback buyback engine  [v5.0 acceptance test]
    // ══════════════════════════════════════════════════════════════════════════

    function test_ladderCuration_listsALaunchedTokenAtItsCanonicalPool() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("Curate", "CUR", alice, address(0));

        vm.prank(admin);
        ladder.addLadderToken(address(token));
        assertTrue(ladder.isLadderToken(address(token)));

        // The venue is derived from the hook, never supplied by the owner.
        assertEq(
            keccak256(abi.encode(ladder.getPoolKey(address(token)))),
            keccak256(abi.encode(hook.getPoolKey())),
            "listed venue must be the hook's own pool"
        );

        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TokenAlreadyListed.selector);
        ladder.addLadderToken(address(token));
    }

    /// @notice The one-way valve depends on the owner being unable to choose
    ///         WHERE the reservoir spends.  Listing is therefore restricted to
    ///         tokens this platform launched: an owner-minted ERC-20 paired in
    ///         a pool the owner alone provides liquidity to would otherwise let
    ///         every 1 ETH buyback settle straight into their own position.
    function test_ladderCuration_rejectsForeignTokens() public {
        MockERC20 rogue = new MockERC20("Rogue", "RGE");

        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TokenNotLaunchedHere.selector);
        ladder.addLadderToken(address(rogue));
    }

    /// @dev A hook that has not run `launch()` has no pool key yet, so there is
    ///      no venue to spend into.
    function test_ladderCuration_rejectsUnlaunchedProjects() public {
        (ToshToken token,) = _createProject("Unlaunched", "UNL");

        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.InvalidPoolKey.selector);
        ladder.addLadderToken(address(token));
    }

    /// @notice Once the reservoir crosses 1 ETH, the next swap on ANY Tosh pool
    ///         gives the buyback engine a ride: `max(1 ETH, 10% of balance)` is
    ///         split evenly across the next three ladder tokens, market-bought,
    ///         and burned to 0xdead.
    function test_treasuryPiggybackRoundRobin() public {
        // One pool to trigger from, plus a three-token ladder so a full batch
        // fits in a single cycle.
        (, ToshLaunchpadHook trigger) = _launchProject("Trigger", "TRG", alice, address(0));
        (ToshToken tokenB,) = _launchProject("LadderB", "LDB", alice, address(0));
        (ToshToken tokenC,) = _launchProject("LadderC", "LDC", alice, address(0));
        (ToshToken tokenD,) = _launchProject("LadderD", "LDD", alice, address(0));

        vm.startPrank(admin);
        ladder.addLadderToken(address(tokenB));
        ladder.addLadderToken(address(tokenC));
        ladder.addLadderToken(address(tokenD));
        vm.stopPrank();

        assertEq(ladder.ladderTokenCount(), 3);
        assertEq(ladder.currentCursor(), 0);

        // Arm the engine.
        vm.deal(address(ladder), 1 ether);
        assertEq(ladder.untilNextTrigger(), 0, "reservoir should be armed");

        uint256 deadB = tokenB.balanceOf(DEAD);
        uint256 deadC = tokenC.balanceOf(DEAD);
        uint256 deadD = tokenD.balanceOf(DEAD);

        // Any swap now carries the buyback along with it.
        _swapBuy(trigger, trader, 0.5 ether);

        assertGt(tokenB.balanceOf(DEAD), deadB, "ladder token B must be bought and burned");
        assertGt(tokenC.balanceOf(DEAD), deadC, "ladder token C must be bought and burned");
        assertGt(tokenD.balanceOf(DEAD), deadD, "ladder token D must be bought and burned");

        // Cursor wraps a full batch of three.
        assertEq(ladder.currentCursor(), 0, "cursor advances by BATCH_SIZE and wraps");

        // 1 ETH was spent (the floor, since the pot was exactly TRIGGER_STEP);
        // the trigger swap's own 0.7% buy tax flowed back in.
        assertLt(address(ladder).balance, 1 ether, "reservoir must be drained by the floor spend");
    }

    /// @notice A full reservoir spends 10 % per cycle, not a 1 ETH drip.
    function test_piggyback_spendsTenPercentOnceThePotIsFull() public {
        (, ToshLaunchpadHook trigger) = _launchProject("FullPot", "FPT", alice, address(0));
        (ToshToken tokenB,) = _launchProject("FullB", "FPB", alice, address(0));
        (ToshToken tokenC,) = _launchProject("FullC", "FPC", alice, address(0));
        (ToshToken tokenD,) = _launchProject("FullD", "FPD", alice, address(0));

        vm.startPrank(admin);
        ladder.addLadderToken(address(tokenB));
        ladder.addLadderToken(address(tokenC));
        ladder.addLadderToken(address(tokenD));
        vm.stopPrank();

        vm.deal(address(ladder), 50 ether);
        assertEq(ladder.nextSpendAmount(), 5 ether, "10% of 50 ETH");

        uint256 before = address(ladder).balance;
        _swapBuy(trigger, trader, 0.5 ether);

        // The 10% slice is the OFFER.  Fresh genesis pools are only ~0.9 ETH
        // deep, so the fill binds on pool depth well before 5 ETH lands.
        // What we pin is that a full pot outspends the 1 ETH floor rather
        // than dripping TRIGGER_STEP regardless of how much is sitting there.
        uint256 taxIn = (0.5 ether * 70) / 10_000;
        uint256 spent = before + taxIn - address(ladder).balance;
        assertGt(spent, 1 ether, "a full pot must outspend the 1 ETH floor");
        assertGt(tokenB.balanceOf(DEAD), 0);
        assertGt(tokenC.balanceOf(DEAD), 0);
        assertGt(tokenD.balanceOf(DEAD), 0);
    }

    function test_piggyback_staysIdleBelowTriggerStep() public {
        (, ToshLaunchpadHook trigger) = _launchProject("Idle", "IDL", alice, address(0));
        (ToshToken tokenB,) = _launchProject("IdleB", "IDB", alice, address(0));

        vm.prank(admin);
        ladder.addLadderToken(address(tokenB));

        // Reservoir holds only launch fees + orphan referrals, well under 1 ETH.
        assertLt(address(ladder).balance, 1 ether);
        uint256 deadBefore = tokenB.balanceOf(DEAD);

        _swapBuy(trigger, trader, 0.1 ether);

        assertEq(tokenB.balanceOf(DEAD), deadBefore, "no buyback below the trigger threshold");
        assertEq(ladder.currentCursor(), 0, "cursor must not move");
    }

    /// @dev A broken ladder leg must not brick an innocent trader's swap: each
    ///      leg is fault-isolated, and the skipped leg's ETH stays in the pot.
    ///
    ///      The fault is injected on a genuinely listed project rather than a
    ///      bogus listing, because listing is now provenance-checked.  A token
    ///      whose `transfer` reverts breaks the `take` that delivers the burn,
    ///      which is the realistic shape of this failure.
    function test_piggyback_isolatesAFaultyLadderLeg() public {
        (, ToshLaunchpadHook trigger) = _launchProject("Fault", "FLT", alice, address(0));
        (ToshToken tokenB,) = _launchProject("FaultB", "FLB", alice, address(0));
        (ToshToken tokenC,) = _launchProject("FaultC", "FLC", alice, address(0));

        vm.startPrank(admin);
        ladder.addLadderToken(address(tokenB));
        ladder.addLadderToken(address(tokenC));
        vm.stopPrank();

        // Break C's delivery leg only.
        vm.mockCallRevert(address(tokenC), abi.encodeWithSelector(IERC20.transfer.selector), "broken token");

        vm.deal(address(ladder), 1 ether);
        uint256 deadBefore = tokenB.balanceOf(DEAD);

        // The swap must still succeed.
        _swapBuy(trigger, trader, 0.2 ether);

        assertGt(tokenB.balanceOf(DEAD), deadBefore, "the healthy leg still executes");
    }

    /// @dev The one-way valve: there is no owner path that moves ETH out.
    function test_ladderTreasury_hasNoWithdrawPath() public {
        vm.deal(address(ladder), 5 ether);

        vm.prank(admin);
        (bool ok,) = address(ladder).call(abi.encodeWithSignature("withdraw(uint256)", 1 ether));
        assertFalse(ok, "treasury must expose no withdraw path");

        assertEq(address(ladder).balance, 5 ether);
    }

    /// @notice The one-way valve, tested against the attack it actually has to
    ///         survive rather than against the absence of a `withdraw` selector.
    ///
    ///         Probing for a named withdraw function proves very little: the
    ///         real extraction route is to redirect where the reservoir SPENDS.
    ///         The owner mints a worthless ERC-20, pairs it in a hookless pool
    ///         they alone provide liquidity to, lists it, and lets each 1 ETH
    ///         buyback settle into their own position — emitting nothing but
    ///         ordinary buyback events.  Provenance checking is what closes it,
    ///         so this test pins the listing rejection at its root.
    function test_ladderTreasury_ownerCannotRedirectSpendToOwnPool() public {
        MockERC20 fake = new MockERC20("Fake", "FAKE");
        fake.mint(admin, 1_000_000e18);

        // Even a perfectly well-formed ETH/token pool is refused: the token was
        // not launched here, so no hook vouches for the venue.
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TokenNotLaunchedHere.selector);
        ladder.addLadderToken(address(fake));

        assertFalse(ladder.isLadderToken(address(fake)), "a foreign token must never reach the ladder");
    }

    function test_executeBuyAndBurn_isNotCallableExternally() public {
        (ToshToken tokenB,) = _launchProject("Guard", "GRD", alice, address(0));

        vm.prank(admin);
        ladder.addLadderToken(address(tokenB));

        vm.deal(address(ladder), 5 ether);
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.OnlySelf.selector);
        ladder.executeBuyAndBurn(address(tokenB), 1 ether);
    }

    function test_autoPiggybackBuyback_rejectsNonHookCallers() public {
        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.OnlyHook.selector);
        ladder.autoPiggybackBuyback();
    }

    /// @notice A buyback will not fill into a price someone just ran away from
    ///         the TWAP.
    ///
    ///         The poke is public and its size is known, so an unbounded leg is
    ///         a standing sandwich invitation: buy ahead of it, let the
    ///         reservoir fill against the inflated price, sell back into the
    ///         support it just supplied.  Nothing is stolen from a user — which
    ///         is why an earlier revision passed `MIN_SQRT_PRICE + 1` and called
    ///         it victimless — but the ETH buys fewer tokens to burn and the
    ///         difference is the attacker's. The bound is anchored to the TWAP
    ///         precisely because spot is the quantity being manipulated.
    function test_buyback_refusesToFillIntoAManipulatedPrice() public {
        (, ToshLaunchpadHook trigger) = _launchProject("Trig", "TRG", alice, address(0));
        (ToshToken victim, ToshLaunchpadHook victimHook) = _launchProject("Victim", "VIC", alice, address(0));

        vm.prank(admin);
        ladder.addLadderToken(address(victim));

        // Let the launch price age into the TWAP so there is a reference to
        // deviate FROM; without this the floor is disabled by design.
        vm.warp(block.timestamp + 1900);
        _nextBlock();
        assertGt(victimHook.twapSqrtPriceX96(), 0, "fixture needs an established TWAP");

        // The front-run: a whale walks the pool far past the deviation bound.
        // In the same block, so the TWAP cannot follow it.
        address sandwicher = makeAddr("sandwicher");
        vm.deal(sandwicher, 200 ether);
        _swapBuy(victimHook, sandwicher, 120 ether);

        uint160 twapSqrt = victimHook.twapSqrtPriceX96();
        (uint160 spotSqrt,,,) = IPoolManager(address(poolManager)).getSlot0(victimHook.getPoolKey().toId());
        assertLt(spotSqrt, (uint256(twapSqrt) * 9000) / 10_000, "fixture must clear the 1000bps sqrt bound");

        vm.deal(address(ladder), 1 ether);
        uint256 deadBefore = victim.balanceOf(DEAD);
        uint256 reservoirBefore = address(ladder).balance;

        // Poke from an unrelated pool; the trader's swap must still settle.
        _nextBlock();
        _swapBuy(trigger, trader, 0.1 ether);

        assertEq(victim.balanceOf(DEAD), deadBefore, "buyback must not fill into the manipulated price");
        assertGe(address(ladder).balance, reservoirBefore, "unspent ETH stays in the reservoir for later");
    }

    /// @dev The bound must not cost the protocol its buybacks in the normal
    ///      case, where spot sits close to the TWAP.
    function test_buyback_stillFillsAtAnHonestPrice() public {
        (, ToshLaunchpadHook trigger) = _launchProject("Trig2", "TG2", alice, address(0));
        (ToshToken healthy, ToshLaunchpadHook healthyHook) = _launchProject("Healthy", "HLT", alice, address(0));

        vm.prank(admin);
        ladder.addLadderToken(address(healthy));

        vm.warp(block.timestamp + 1900);
        _nextBlock();
        assertGt(healthyHook.twapSqrtPriceX96(), 0, "fixture needs an established TWAP");

        vm.deal(address(ladder), 1 ether);
        uint256 deadBefore = healthy.balanceOf(DEAD);

        _swapBuy(trigger, trader, 0.1 ether);

        assertGt(healthy.balanceOf(DEAD), deadBefore, "an honest pool must still be bought and burned");
        assertLt(address(ladder).balance, 1 ether, "the reservoir must actually spend");
    }

    /// @dev PoolSwapTest refunds unspent `msg.value` to the caller after an
    ///      exact-output swap.  Without a `receive` the refund reverts and
    ///      wraps the whole swap in `WrappedError`, which is not a protocol
    ///      failure.
    receive() external payable {}
}

/// @notice An actor that holds and spends its OWN ETH, for tests that measure
///         profit rather than just behaviour.
///
/// @dev    `vm.prank` cannot be used to measure an actor's economics: it
///         rewrites `msg.sender` but leaves the test contract as the payer, so
///         the pranked address collects every inflow — refunds, rebates, sale
///         proceeds — while its outflows land on someone else's balance sheet.
///         A round trip measured that way looks profitable no matter what the
///         protocol does.  Routing the calls through a real contract removes
///         the ambiguity entirely.
contract FreeRider {
    receive() external payable {}

    function mint(ToshLaunchpadHook hook, uint256 amount, uint256 cost) external returns (uint256) {
        return hook.mintBondingCurve{value: cost}(amount);
    }

    function sell(PoolSwapTest router, PoolKey calldata key, uint256 tokensIn) external {
        IERC20(Currency.unwrap(key.currency1)).approve(address(router), type(uint256).max);
        router.swap(
            key,
            SwapParams({
                zeroForOne: false, amountSpecified: -int256(tokensIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}
