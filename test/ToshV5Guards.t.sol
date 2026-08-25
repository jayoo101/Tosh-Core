// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @notice v5.0 hook/token guards and views that do not need a live V4 pool.
contract ToshV5GuardsTest is Test {
    using MessageHashUtils for bytes32;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal user1 = makeAddr("user1");
    address internal treasury = makeAddr("treasury");
    address internal projTreasury = makeAddr("projTreasury");
    address payable internal ladder = payable(makeAddr("ladder"));
    address internal mockPoolManager = makeAddr("poolManager");

    uint256 internal pogSignerPk = 0xC0FFEE;
    address internal pogSigner;

    ToshFactory internal factory;
    ToshLaunchpadHook internal hook;
    ToshToken internal token;

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);

        vm.startPrank(admin);
        factory = new ToshFactory(mockPoolManager, pogSigner, treasury, ladder);
        factory.setMaxPogAllocationLimit(1000 ether);
        vm.stopPrank();

        vm.deal(creator, 100 ether);
        vm.deal(user1, 100 ether);
        vm.deal(admin, 100 ether);

        (address t, address h) = _createLaunch("Guard", "GRD");
        token = ToshToken(t);
        hook = ToshLaunchpadHook(payable(h));
    }

    function _buildPoGSig(address user, uint256 maxAlloc, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 hash = keccak256(abi.encode(user, maxAlloc, nonce, deadline, address(factory), block.chainid))
            .toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pogSignerPk, hash);
        sig = abi.encodePacked(r, s, v);
    }

    function _register(address user, uint256 maxAlloc) internal {
        uint256 nonce = factory.pogNonces(user);
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user);
        factory.registerPoG(maxAlloc, deadline, nonce, _buildPoGSig(user, maxAlloc, nonce, deadline));
    }

    function _mineSalt() internal view returns (bytes32 rawSalt) {
        bytes32 initHash = factory.hookInitcodeHash(
            projTreasury, creator, projTreasury, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        for (uint256 i; i < 500_000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(creator, rawSalt));
            address predicted = HookMiner.computeAddress(address(factory), finalSalt, initHash);
            if (HookMiner.isValidHookAddress(predicted) && predicted.code.length == 0) return rawSalt;
        }
        revert("_mineSalt: none found");
    }

    function _createLaunch(string memory n, string memory s) internal returns (address t, address h) {
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (t, h) = factory.createLaunch{value: fee}(n, s, projTreasury, projTreasury, salt, fee, 24 hours);
    }

    function _emptyKey() internal view returns (PoolKey memory) {
        return hook.getPoolKey();
    }

    function _liqParams() internal pure returns (ModifyLiquidityParams memory) {
        return ModifyLiquidityParams({tickLower: 0, tickUpper: 0, liquidityDelta: 0, salt: bytes32(0)});
    }

    function _swapParams() internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountSpecified: 0, sqrtPriceLimitX96: 0});
    }

    function _freshHook() internal returns (ToshLaunchpadHook) {
        return new ToshLaunchpadHook(
            mockPoolManager, address(this), projTreasury, creator, projTreasury, ladder, 1 ether, 1 ether, 24 hours
        );
    }

    // ── Hook constructor ──────────────────────────────────────────────────────

    function test_hook_ctor_revertsOnZeroPoolManager() public {
        vm.expectRevert(bytes("zero poolManager"));
        new ToshLaunchpadHook(
            address(0), address(factory), projTreasury, creator, projTreasury, ladder, 1 ether, 1 ether, 24 hours
        );
    }

    function test_hook_ctor_revertsOnZeroFactory() public {
        vm.expectRevert(bytes("zero factory"));
        new ToshLaunchpadHook(
            mockPoolManager, address(0), projTreasury, creator, projTreasury, ladder, 1 ether, 1 ether, 24 hours
        );
    }

    function test_hook_ctor_revertsOnZeroTreasury() public {
        vm.expectRevert(bytes("zero treasury"));
        new ToshLaunchpadHook(
            mockPoolManager, address(factory), address(0), creator, projTreasury, ladder, 1 ether, 1 ether, 24 hours
        );
    }

    function test_hook_ctor_revertsOnZeroCreator() public {
        vm.expectRevert(bytes("zero creator"));
        new ToshLaunchpadHook(
            mockPoolManager,
            address(factory),
            projTreasury,
            address(0),
            projTreasury,
            ladder,
            1 ether,
            1 ether,
            24 hours
        );
    }

    function test_hook_ctor_revertsOnZeroAdmin() public {
        vm.expectRevert(ToshLaunchpadHook.InvalidAdmin.selector);
        new ToshLaunchpadHook(
            mockPoolManager, address(factory), projTreasury, creator, address(0), ladder, 1 ether, 1 ether, 24 hours
        );
    }

    function test_hook_ctor_revertsOnZeroLadderTreasury() public {
        vm.expectRevert(bytes("zero ladderTreasury"));
        new ToshLaunchpadHook(
            mockPoolManager,
            address(factory),
            projTreasury,
            creator,
            projTreasury,
            payable(address(0)),
            1 ether,
            1 ether,
            24 hours
        );
    }

    function test_hook_ctor_revertsOnZeroSoftCap() public {
        vm.expectRevert(bytes("zero softCap"));
        new ToshLaunchpadHook(
            mockPoolManager, address(factory), projTreasury, creator, projTreasury, ladder, 0, 1 ether, 24 hours
        );
    }

    function test_hook_ctor_revertsOnZeroPerWalletCap() public {
        vm.expectRevert(bytes("zero perWalletCap"));
        new ToshLaunchpadHook(
            mockPoolManager, address(factory), projTreasury, creator, projTreasury, ladder, 1 ether, 0, 24 hours
        );
    }

    function test_hook_ctor_acceptsTheThreeAllowedWindows() public {
        uint256[3] memory allowed = [hook.DURATION_FAST(), hook.DURATION_STANDARD(), hook.DURATION_SLOW()];

        for (uint256 i; i < allowed.length; ++i) {
            ToshLaunchpadHook h = new ToshLaunchpadHook(
                mockPoolManager,
                address(factory),
                projTreasury,
                creator,
                projTreasury,
                ladder,
                1 ether,
                1 ether,
                allowed[i]
            );
            assertEq(h.genesisDuration(), allowed[i], "window is frozen as passed");
            assertEq(h.genesisDeadline(), block.timestamp + allowed[i], "deadline is now + window");
        }
    }

    function test_hook_ctor_windowConstantsAreThreeTwentyFourSeventyTwo() public view {
        assertEq(hook.DURATION_FAST(), 3 hours);
        assertEq(hook.DURATION_STANDARD(), 24 hours);
        assertEq(hook.DURATION_SLOW(), 72 hours);
    }

    /// @dev The interesting rejections are the two degenerate ends the closed
    ///      set exists to keep out — a window nobody can deposit into, and one
    ///      that locks deposits up with no refund path — plus a plausible
    ///      near-miss that a caller might reasonably assume is allowed.
    function test_hook_ctor_revertsOnUnlistedWindow() public {
        uint256[5] memory rejected = [uint256(0), 1 seconds, 12 hours, 25 hours, 3650 days];

        for (uint256 i; i < rejected.length; ++i) {
            vm.expectRevert(ToshLaunchpadHook.InvalidDuration.selector);
            new ToshLaunchpadHook(
                mockPoolManager,
                address(factory),
                projTreasury,
                creator,
                projTreasury,
                ladder,
                1 ether,
                1 ether,
                rejected[i]
            );
        }
    }

    function test_hook_ctor_wiresImmutables() public view {
        assertEq(address(hook.poolManager()), mockPoolManager);
        assertEq(hook.factory(), address(factory));
        assertEq(hook.projectTreasury(), projTreasury);
        assertEq(hook.creator(), creator);
        assertEq(hook.projectAdmin(), projTreasury);
        assertEq(hook.ladderTreasury(), ladder);
        assertEq(hook.softCap(), factory.defaultSoftCap());
        assertEq(hook.perWalletCap(), factory.maxPogAllocationLimit());
        assertEq(hook.POOL_FEE(), 3000);
        assertEq(hook.TAX_BPS(), 70);
    }

    function test_hookMiner_requiredFlagsAre0x20CC() public view {
        uint160 mask = 0x20CC;
        assertEq(uint160(address(hook)) & mask, mask);
        assertTrue(HookMiner.isValidHookAddress(address(hook)));
    }

    // ── initializeToken ───────────────────────────────────────────────────────

    function test_initializeToken_rejectsNonFactory() public {
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyFactory.selector);
        hook.initializeToken(makeAddr("fakeToken"));
    }

    function test_initializeToken_rejectsAlreadyInitialized() public {
        vm.prank(address(factory));
        vm.expectRevert(ToshLaunchpadHook.AlreadyInitialized.selector);
        hook.initializeToken(makeAddr("anotherToken"));
    }

    function test_initializeToken_rejectsZeroToken() public {
        ToshLaunchpadHook fresh = _freshHook();
        vm.expectRevert(bytes("zero token"));
        fresh.initializeToken(address(0));
    }

    function test_hook_deposit_revertsBeforeTokenInitialised() public {
        ToshLaunchpadHook fresh = _freshHook();
        vm.expectRevert(ToshLaunchpadHook.NotInitialized.selector);
        fresh.deposit{value: 1}(user1, address(0));
    }

    function test_hook_deposit_rejectsNonFactory() public {
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyFactory.selector);
        hook.deposit{value: 1 ether}(user1, address(0));
    }

    function test_deposit_revertsAfterDeadline() public {
        _register(user1, 1 ether);
        vm.warp(hook.genesisDeadline());
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.GenesisExpired.selector);
        factory.deposit{value: 0.01 ether}(address(hook), address(0));
    }

    // ── Admin rotation ────────────────────────────────────────────────────────

    function test_changeProjectAdmin_rotates() public {
        address neu = makeAddr("newAdmin");
        vm.prank(projTreasury);
        hook.changeProjectAdmin(neu);
        assertEq(hook.projectAdmin(), neu);
    }

    function test_changeProjectAdmin_rejectsNonAdmin() public {
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.Unauthorized.selector);
        hook.changeProjectAdmin(user1);
    }

    function test_changeProjectAdmin_rejectsZero() public {
        vm.prank(projTreasury);
        vm.expectRevert(ToshLaunchpadHook.InvalidAdmin.selector);
        hook.changeProjectAdmin(address(0));
    }

    // ── Refund / launch gates (no V4) ─────────────────────────────────────────

    function test_canRefund_falseWhileActive() public view {
        assertFalse(hook.canRefund());
    }

    function test_canRefund_falseWhenSoftCapMet() public {
        _register(user1, 10 ether);
        vm.prank(user1);
        factory.deposit{value: 10 ether}(address(hook), address(0));
        vm.warp(hook.genesisDeadline() + 1);
        assertFalse(hook.canRefund());
    }

    function test_canRefund_trueWhenGenesisFailed() public {
        _register(user1, 1 ether);
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(address(hook), address(0));
        vm.warp(hook.genesisDeadline() + 1);
        assertTrue(hook.canRefund());
    }

    function test_canRefund_trueAfterZombieWindowWhenSoftCapMet() public {
        _register(user1, 10 ether);
        vm.prank(user1);
        factory.deposit{value: 10 ether}(address(hook), address(0));
        vm.warp(hook.genesisDeadline() + hook.LAUNCH_WINDOW() + 1);
        assertTrue(hook.canRefund());
    }

    function test_refund_revertsBeforeDeadline() public {
        _register(user1, 1 ether);
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(address(hook), address(0));
        vm.prank(user1);
        vm.expectRevert(bytes("Genesis not ended yet"));
        hook.refund();
    }

    function test_refund_revertsIfSoftCapMet() public {
        _register(user1, 10 ether);
        vm.prank(user1);
        factory.deposit{value: 10 ether}(address(hook), address(0));
        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(user1);
        vm.expectRevert(bytes("Refund not available"));
        hook.refund();
    }

    function test_refund_succeedsAfterZombieWhenSoftCapMet() public {
        _register(user1, 10 ether);
        vm.prank(user1);
        factory.deposit{value: 10 ether}(address(hook), address(0));
        vm.warp(hook.genesisDeadline() + hook.LAUNCH_WINDOW() + 1);

        uint256 before = user1.balance;
        vm.prank(user1);
        hook.refund();
        assertEq(user1.balance - before, 10 ether);
        assertTrue(hook.zombieRefundEnabled());
    }

    function test_refund_lazyStateFlipOnSoftCapMiss() public {
        _register(user1, 1 ether);
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(address(hook), address(0));
        vm.warp(hook.genesisDeadline() + 1);
        assertFalse(hook.refundEnabled());
        vm.prank(user1);
        hook.refund();
        assertTrue(hook.refundEnabled());
    }

    function test_refund_revertsWithNoDeposit() public {
        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.NoDeposit.selector);
        hook.refund();
    }

    function test_launch_revertsNonCreator() public {
        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyCreator.selector);
        hook.launch();
    }

    function test_launch_revertsBeforeDeadline() public {
        vm.prank(creator);
        vm.expectRevert(ToshLaunchpadHook.GenesisActive.selector);
        hook.launch();
    }

    function test_launch_revertsIfSoftCapNotMet() public {
        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        vm.expectRevert(ToshLaunchpadHook.SoftCapNotMet.selector);
        hook.launch();
    }

    function test_launch_revertsAfterLaunchWindowExpired() public {
        _register(user1, 10 ether);
        vm.prank(user1);
        factory.deposit{value: 10 ether}(address(hook), address(0));
        vm.warp(hook.genesisDeadline() + hook.LAUNCH_WINDOW() + 1);
        vm.prank(creator);
        vm.expectRevert(ToshLaunchpadHook.LaunchWindowExpired.selector);
        hook.launch();
    }

    function test_claimGenesis_revertsBeforeLaunch() public {
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.NotLaunched.selector);
        hook.claimGenesis();
    }

    function test_claimReferralReward_revertsBeforeLaunch() public {
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.NotLaunched.selector);
        hook.claimReferralReward();
    }

    function test_mintBondingCurve_revertsBeforeLaunch() public {
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.NotLaunched.selector);
        hook.mintBondingCurve{value: 1 ether}(1e18);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function test_hasClaimed_falseInitially() public view {
        assertFalse(hook.hasClaimed(user1));
    }

    function test_currentBondingPrice_returnsZeroBeforeLaunch() public view {
        assertEq(hook.currentBondingPrice(), 0);
    }

    function test_quoteMint_zeroTokensReturnsZero() public view {
        assertEq(hook.quoteMint(0), 0);
    }

    function test_bondingRemaining_atCeilingReturnsZero() public {
        uint256 cap = hook.BONDING_MAX();
        uint256 slot = _phase2MintedSlot();
        vm.store(address(hook), bytes32(slot), bytes32(cap));
        assertEq(hook.bondingRemaining(), 0);
    }

    function test_bondingRemaining_startsAtMax() public view {
        assertEq(hook.bondingRemaining(), hook.BONDING_MAX());
    }

    function test_supplyPartitioning() public view {
        assertEq(hook.GENESIS_SUPPLY() + hook.BONDING_MAX(), token.MAX_SUPPLY());
        assertEq(hook.GENESIS_LP_SUPPLY() + hook.GENESIS_CLAIM_SUPPLY(), hook.GENESIS_SUPPLY());
        assertEq(hook.TIER_COUNT() * hook.TIER_SIZE(), hook.BONDING_MAX());
    }

    function test_tokenMaxSupply_is21M() public view {
        assertEq(token.MAX_SUPPLY(), 21_000_000e18);
    }

    // ── unlockCallback / IHooks ───────────────────────────────────────────────

    function test_unlockCallback_revertsUnknownAction() public {
        vm.prank(mockPoolManager);
        vm.expectRevert(ToshLaunchpadHook.UnknownAction.selector);
        hook.unlockCallback(abi.encode(uint8(99)));
    }

    function test_unlockCallback_rejectsNonPoolManager() public {
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyPoolManager.selector);
        hook.unlockCallback(abi.encode(uint8(1)));
    }

    function test_beforeInitialize_revertsForNonPoolManager() public {
        PoolKey memory k = _emptyKey();
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyPoolManager.selector);
        hook.beforeInitialize(address(hook), k, 0);
    }

    function test_beforeInitialize_revertsForExternalSender() public {
        PoolKey memory k = _emptyKey();
        vm.prank(mockPoolManager);
        vm.expectRevert(ToshLaunchpadHook.UnauthorizedInitialization.selector);
        hook.beforeInitialize(user1, k, 0);
    }

    function test_beforeSwap_rejectsNonPoolManager() public {
        PoolKey memory k = _emptyKey();
        SwapParams memory p = _swapParams();
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyPoolManager.selector);
        hook.beforeSwap(address(0), k, p, "");
    }

    function test_afterSwap_rejectsNonPoolManager() public {
        PoolKey memory k = _emptyKey();
        SwapParams memory p = _swapParams();
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyPoolManager.selector);
        hook.afterSwap(address(0), k, p, BalanceDelta.wrap(0), "");
    }

    function test_beforeRemoveLiquidity_rejectsNonPoolManager() public {
        PoolKey memory k = _emptyKey();
        ModifyLiquidityParams memory p = _liqParams();
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyPoolManager.selector);
        hook.beforeRemoveLiquidity(address(this), k, p, "");
    }

    function test_beforeRemoveLiquidity_passthroughForPoolManager() public {
        PoolKey memory k = _emptyKey();
        ModifyLiquidityParams memory p = _liqParams();
        vm.prank(mockPoolManager);
        bytes4 s = hook.beforeRemoveLiquidity(address(this), k, p, "");
        assertEq(s, IHooks.beforeRemoveLiquidity.selector);
    }

    function test_ihooks_afterInitialize_returnsSelector() public view {
        assertEq(hook.afterInitialize(address(0), _emptyKey(), 0, 0), IHooks.afterInitialize.selector);
    }

    function test_ihooks_beforeAddLiquidity_returnsSelector() public view {
        assertEq(hook.beforeAddLiquidity(address(0), _emptyKey(), _liqParams(), ""), IHooks.beforeAddLiquidity.selector);
    }

    function test_ihooks_afterAddLiquidity_returnsSelector() public view {
        (bytes4 s,) = hook.afterAddLiquidity(
            address(0), _emptyKey(), _liqParams(), BalanceDelta.wrap(0), BalanceDelta.wrap(0), ""
        );
        assertEq(s, IHooks.afterAddLiquidity.selector);
    }

    function test_ihooks_afterRemoveLiquidity_returnsSelector() public view {
        (bytes4 s,) = hook.afterRemoveLiquidity(
            address(0), _emptyKey(), _liqParams(), BalanceDelta.wrap(0), BalanceDelta.wrap(0), ""
        );
        assertEq(s, IHooks.afterRemoveLiquidity.selector);
    }

    function test_ihooks_beforeDonate_returnsSelector() public view {
        assertEq(hook.beforeDonate(address(0), _emptyKey(), 0, 0, ""), IHooks.beforeDonate.selector);
    }

    function test_ihooks_afterDonate_returnsSelector() public view {
        assertEq(hook.afterDonate(address(0), _emptyKey(), 0, 0, ""), IHooks.afterDonate.selector);
    }

    // ── ToshToken ─────────────────────────────────────────────────────────────

    function test_token_ctor_rejectsZeroFactory() public {
        vm.expectRevert(bytes("zero factory"));
        new ToshToken("X", "X", address(0));
    }

    function test_token_initialize_rejectsNonFactory() public {
        ToshToken t = new ToshToken("X", "X", address(this));
        vm.prank(user1);
        vm.expectRevert(ToshToken.OnlyFactory.selector);
        t.initialize(makeAddr("hookHere"));
    }

    function test_token_initialize_rejectsZeroHook() public {
        ToshToken t = new ToshToken("X", "X", address(this));
        vm.expectRevert(bytes("zero hook"));
        t.initialize(address(0));
    }

    function test_token_initialize_rejectsRepeatedInit() public {
        vm.prank(address(factory));
        vm.expectRevert(ToshToken.AlreadyInitialized.selector);
        token.initialize(makeAddr("again"));
    }

    function test_token_onlyHookHasMinterRole() public view {
        bytes32 minterRole = token.MINTER_ROLE();
        assertTrue(token.hasRole(minterRole, address(hook)));
        assertFalse(token.hasRole(minterRole, address(factory)));
        assertFalse(token.hasRole(minterRole, creator));
        assertEq(token.hook(), address(hook));
    }

    function test_token_nonMinterCannotMint() public {
        bytes32 minterRole = token.MINTER_ROLE();
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user1, minterRole)
        );
        token.mint(user1, 1);
    }

    function test_token_mintEnforcesHardCap() public {
        uint256 tooMuch = token.MAX_SUPPLY() + 1;
        vm.prank(address(hook));
        vm.expectRevert(ToshToken.MaxSupplyExceeded.selector);
        token.mint(user1, tooMuch);
    }

    /// @notice The minter set is frozen at exactly one address, forever.
    ///
    ///   This is what replaces the old kill-switch test.  `DEFAULT_ADMIN_ROLE`
    ///   is never granted, and both `grantRole` and `revokeRole` are gated on
    ///   it, so no party — not the factory, not the hook, not the deployer —
    ///   can add a second minter or strip the first.
    function test_token_minterSetIsFrozenAtOneAddress() public {
        bytes32 minterRole = token.MINTER_ROLE();
        assertTrue(token.hasRole(minterRole, address(hook)), "hook is the minter");
        assertEq(token.getRoleAdmin(minterRole), bytes32(0), "admin slot must be the vacant default");
        assertFalse(token.hasRole(bytes32(0), address(factory)), "factory must not hold the admin role");

        address[3] memory callers = [address(factory), address(hook), user1];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, callers[i], bytes32(0))
            );
            token.grantRole(minterRole, admin);

            vm.prank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, callers[i], bytes32(0))
            );
            token.revokeRole(minterRole, address(hook));
        }

        assertTrue(token.hasRole(minterRole, address(hook)), "hook still the sole minter");
    }

    function _phase2MintedSlot() internal returns (uint256 slot) {
        bytes32 probe = bytes32(uint256(123_456_789e18));
        for (uint256 i; i < 64; ++i) {
            bytes32 prev = vm.load(address(hook), bytes32(i));
            vm.store(address(hook), bytes32(i), probe);
            if (hook.phase2Minted() == uint256(probe)) {
                vm.store(address(hook), bytes32(i), prev);
                return i;
            }
            vm.store(address(hook), bytes32(i), prev);
        }
        revert("phase2Minted slot not found");
    }
}
