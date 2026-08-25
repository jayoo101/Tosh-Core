// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookMiner} from "../src/libraries/HookMiner.sol";

/// @notice v5.0 factory surface: PoG, pause, blacklist, createLaunch, ETH deposits,
///         eligibility, and CREATE2 helpers.  Uses a dummy PoolManager because
///         none of these paths initialise a pool.
contract ToshV5FactoryTest is Test {
    using MessageHashUtils for bytes32;

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal user1 = makeAddr("user1");
    address internal user2 = makeAddr("user2");
    address internal treasury = makeAddr("treasury");
    address internal projTreasury = makeAddr("projTreasury");
    address payable internal ladder = payable(makeAddr("ladder"));

    uint256 internal pogSignerPk = 0xDEADBEEF1234;
    address internal pogSigner;

    ToshFactory internal factory;
    address internal mockPoolManager = makeAddr("poolManager");

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);

        vm.startPrank(admin);
        factory = new ToshFactory(mockPoolManager, pogSigner, treasury, ladder);
        factory.setMaxPogAllocationLimit(1000 ether);
        vm.stopPrank();

        vm.deal(creator, 100 ether);
        vm.deal(user1, 100 ether);
        vm.deal(user2, 100 ether);
        vm.deal(admin, 100 ether);
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
        return _mineSalt(24 hours);
    }

    function _mineSalt(uint256 duration) internal view returns (bytes32 rawSalt) {
        bytes32 initHash = factory.hookInitcodeHash(
            projTreasury, creator, projTreasury, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), duration
        );
        for (uint256 i; i < 500_000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(creator, rawSalt));
            address predicted = HookMiner.computeAddress(address(factory), finalSalt, initHash);
            if (HookMiner.isValidHookAddress(predicted) && predicted.code.length == 0) return rawSalt;
        }
        revert("_mineSalt: none found");
    }

    function _mineInvalidSalt() internal view returns (bytes32 rawSalt) {
        bytes32 initHash = factory.hookInitcodeHash(
            projTreasury, creator, projTreasury, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        for (uint256 i; i < 500_000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(creator, rawSalt));
            address predicted = HookMiner.computeAddress(address(factory), finalSalt, initHash);
            if (!HookMiner.isValidHookAddress(predicted)) return rawSalt;
        }
        revert("_mineInvalidSalt: none found");
    }

    function _createLaunch(string memory n, string memory s) internal returns (address token, address hook) {
        return _createLaunch(n, s, 24 hours);
    }

    function _createLaunch(string memory n, string memory s, uint256 duration)
        internal
        returns (address token, address hook)
    {
        bytes32 salt = _mineSalt(duration);
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (token, hook) = factory.createLaunch{value: fee}(n, s, projTreasury, projTreasury, salt, fee, duration);
    }

    function _h(address hook) internal pure returns (ToshLaunchpadHook) {
        return ToshLaunchpadHook(payable(hook));
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    function test_ctor_revertsOnZeroPoolManager() public {
        vm.expectRevert(bytes("zero poolManager"));
        new ToshFactory(address(0), pogSigner, treasury, ladder);
    }

    function test_ctor_revertsOnZeroPogSigner() public {
        vm.expectRevert(bytes("zero pogSigner"));
        new ToshFactory(mockPoolManager, address(0), treasury, ladder);
    }

    function test_ctor_revertsOnZeroTreasury() public {
        vm.expectRevert(bytes("zero treasury"));
        new ToshFactory(mockPoolManager, pogSigner, address(0), ladder);
    }

    function test_ctor_revertsOnZeroLadderTreasury() public {
        vm.expectRevert(bytes("zero ladderTreasury"));
        new ToshFactory(mockPoolManager, pogSigner, treasury, payable(address(0)));
    }

    function test_ctor_wiresImmutables() public view {
        assertEq(factory.poolManager(), mockPoolManager);
        assertEq(factory.ladderTreasury(), ladder);
        assertEq(factory.pogSigner(), pogSigner);
        assertEq(factory.platformTreasury(), treasury);
        assertEq(factory.owner(), admin);
        assertGt(uint256(factory.HOOK_CREATION_CODEHASH()), 0);
    }

    // ── PoG ───────────────────────────────────────────────────────────────────

    function test_registerPoG_setsQuota() public {
        _register(user1, 0.05 ether);
        assertEq(factory.pogQuota(user1), 0.05 ether);
        assertEq(factory.pogNonces(user1), 1);
    }

    function test_registerPoG_rejectsExpiredSig() public {
        uint256 deadline = block.timestamp - 1;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.SignatureExpired.selector);
        factory.registerPoG(0.05 ether, deadline, 0, _buildPoGSig(user1, 0.05 ether, 0, deadline));
    }

    function test_registerPoG_rejectsInvalidSig() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 hash = keccak256(
                abi.encode(user1, uint256(0.05 ether), uint256(0), deadline, address(factory), block.chainid)
            ).toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEAD, hash);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.InvalidSignature.selector);
        factory.registerPoG(0.05 ether, deadline, 0, abi.encodePacked(r, s, v));
    }

    function test_registerPoG_rejectsReplayedNonce() public {
        _register(user1, 0.05 ether);
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.NonceConflict.selector);
        factory.registerPoG(0.05 ether, deadline, 0, _buildPoGSig(user1, 0.05 ether, 0, deadline));
    }

    function test_registerPoG_rejectsSignatureTooLong() public {
        uint256 deadline = block.timestamp + factory.MAX_SIG_VALIDITY() + 1;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.SignatureTooLong.selector);
        factory.registerPoG(0.05 ether, deadline, 0, _buildPoGSig(user1, 0.05 ether, 0, deadline));
    }

    function test_registerPoG_rejectsWrongNonce_skipAhead() public {
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.NonceConflict.selector);
        factory.registerPoG(0.05 ether, deadline, 1, _buildPoGSig(user1, 0.05 ether, 1, deadline));
    }

    function test_registerPoG_keepsHigherQuotaOnReregister() public {
        _register(user1, 0.08 ether);
        _register(user1, 0.03 ether);
        assertEq(factory.pogQuota(user1), 0.08 ether);
    }

    function test_registerPoG_raisesQuotaOnReregister() public {
        _register(user1, 0.03 ether);
        _register(user1, 0.08 ether);
        assertEq(factory.pogQuota(user1), 0.08 ether);
    }

    function test_registerPoG_revertsAboveGlobalLimit() public {
        uint256 tooMuch = factory.maxPogAllocationLimit() + 1;
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.ExceedsGlobalPogLimit.selector);
        factory.registerPoG(tooMuch, deadline, 0, _buildPoGSig(user1, tooMuch, 0, deadline));
    }

    function test_registerPoG_noSilentClamp() public {
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(300 ether);
        _register(user1, 200 ether);
        assertEq(factory.pogQuota(user1), 200 ether);
    }

    function test_registerPoG_rejectsBlacklisted() public {
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(bl, 1 days);

        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.IsBlacklisted.selector);
        factory.registerPoG(0.05 ether, deadline, 0, _buildPoGSig(user1, 0.05 ether, 0, deadline));
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function test_blacklist_banAndLift() public {
        address[] memory targets = new address[](1);
        targets[0] = user2;
        vm.prank(admin);
        factory.setBlacklist(targets, 1 days);
        assertGt(factory.blacklistedUntil(user2), block.timestamp);
        vm.prank(admin);
        factory.liftBlacklist(targets);
        assertEq(factory.blacklistedUntil(user2), 0);
    }

    function test_blacklist_rejectsNonAdmin() public {
        address[] memory targets = new address[](1);
        targets[0] = user1;
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.setBlacklist(targets, 1 days);
    }

    function test_setBlacklist_permanentSentinel() public {
        address[] memory targets = new address[](1);
        targets[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(targets, type(uint256).max);
        assertEq(factory.blacklistedUntil(user1), type(uint256).max);
        vm.warp(block.timestamp + 365 days);
        assertEq(factory.blacklistedUntil(user1), type(uint256).max);
    }

    function test_setBlacklist_rejectsBatchAboveLimit() public {
        address[] memory targets = new address[](201);
        vm.prank(admin);
        vm.expectRevert(bytes("Batch too large"));
        factory.setBlacklist(targets, 1 days);
    }

    function test_liftBlacklist_rejectsBatchAboveLimit() public {
        address[] memory targets = new address[](201);
        vm.prank(admin);
        vm.expectRevert(bytes("Batch too large"));
        factory.liftBlacklist(targets);
    }

    function test_liftBlacklist_rejectsNonOwner() public {
        address[] memory targets = new address[](1);
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.liftBlacklist(targets);
    }

    function test_setPlatformTreasury() public {
        address neu = makeAddr("newTreasury");
        vm.prank(admin);
        factory.setPlatformTreasury(neu);
        assertEq(factory.platformTreasury(), neu);
    }

    function test_setPlatformTreasury_rejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(bytes("zero treasury"));
        factory.setPlatformTreasury(address(0));
    }

    function test_setPlatformTreasury_rejectsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.setPlatformTreasury(user1);
    }

    function test_setPogSigner_happy() public {
        address neu = makeAddr("signer2");
        vm.prank(admin);
        factory.setPogSigner(neu);
        assertEq(factory.pogSigner(), neu);
    }

    function test_setPogSigner_rejectsZero() public {
        vm.prank(admin);
        vm.expectRevert(bytes("zero signer"));
        factory.setPogSigner(address(0));
    }

    function test_setPogSigner_rejectsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.setPogSigner(user1);
    }

    function test_setLaunchFee_rejectsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.setLaunchFee(1);
    }

    function test_setLaunchFee_allowsZero() public {
        vm.prank(admin);
        factory.setLaunchFee(0);
        assertEq(factory.launchFee(), 0);
    }

    function test_setCooldownDuration_acceptsZero() public {
        vm.prank(admin);
        factory.setCooldownDuration(0);
        assertEq(factory.cooldownDuration(), 0);
    }

    function test_setCooldownDuration_atBoundary() public {
        uint256 maxCd = factory.MAX_COOLDOWN();
        vm.prank(admin);
        factory.setCooldownDuration(maxCd);
        assertEq(factory.cooldownDuration(), maxCd);
    }

    function test_setCooldownDuration_rejectsAboveMax() public {
        uint256 tooMuch = factory.MAX_COOLDOWN() + 1;
        vm.prank(admin);
        vm.expectRevert(bytes("cooldown > MAX_COOLDOWN"));
        factory.setCooldownDuration(tooMuch);
    }

    function test_setCooldownDuration_rejectsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.setCooldownDuration(1);
    }

    function test_setQuotaWindowDuration_acceptsZero() public {
        vm.prank(admin);
        factory.setQuotaWindowDuration(0);
        assertEq(factory.quotaWindowDuration(), 0);
    }

    function test_setQuotaWindowDuration_atBoundary() public {
        uint256 maxCd = factory.MAX_COOLDOWN();
        vm.prank(admin);
        factory.setQuotaWindowDuration(maxCd);
        assertEq(factory.quotaWindowDuration(), maxCd);
    }

    function test_setQuotaWindowDuration_rejectsAboveMax() public {
        uint256 tooMuch = factory.MAX_COOLDOWN() + 1;
        vm.prank(admin);
        vm.expectRevert(bytes("quota window > MAX_COOLDOWN"));
        factory.setQuotaWindowDuration(tooMuch);
    }

    function test_setQuotaWindowDuration_rejectsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.setQuotaWindowDuration(1);
    }

    function test_setMaxPogAllocationLimit_rotatesDial() public {
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(0.2 ether);
        assertEq(factory.maxPogAllocationLimit(), 0.2 ether);
    }

    function test_setMaxPogAllocationLimit_rejectsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.setMaxPogAllocationLimit(1);
    }

    function test_setDefaultSoftCap_rotatesAndBakesIntoNewHook() public {
        vm.prank(admin);
        factory.setDefaultSoftCap(2 ether);
        (, address hook) = _createLaunch("Soft", "SFT");
        assertEq(_h(hook).softCap(), 2 ether);
    }

    function test_setDefaultSoftCap_doesNotAffectExistingHooks() public {
        (, address hook) = _createLaunch("Old", "OLD");
        uint256 frozen = _h(hook).softCap();
        vm.prank(admin);
        factory.setDefaultSoftCap(3 ether);
        assertEq(_h(hook).softCap(), frozen);
    }

    function test_setDefaultSoftCap_rejectsBelowFloor() public {
        uint256 tooSmall = factory.MIN_SOFT_CAP_PROD() - 1;
        vm.prank(admin);
        vm.expectRevert(ToshFactory.InvalidSoftCap.selector);
        factory.setDefaultSoftCap(tooSmall);
    }

    function test_setDefaultSoftCap_rejectsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.setDefaultSoftCap(1 ether);
    }

    // ── Pause ─────────────────────────────────────────────────────────────────

    function test_pause_blocksRegisterPoG() public {
        vm.prank(admin);
        factory.pause();
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.registerPoG(0.05 ether, deadline, 0, _buildPoGSig(user1, 0.05 ether, 0, deadline));
    }

    function test_pause_blocksCreateLaunch() public {
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(admin);
        factory.pause();
        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createLaunch{value: fee}("P", "P", projTreasury, projTreasury, salt, fee, 24 hours);
    }

    /// @notice A pause stops the platform taking on new projects; it must not
    ///         reach into a raise that is already open.
    ///
    ///   Gating `deposit` would be a unilateral veto: a genesis round fails by
    ///   missing its soft cap, so withholding deposits for long enough kills a
    ///   project the platform had already accepted money for and forces every
    ///   depositor into refund.  A wallet that already holds quota therefore
    ///   keeps funding an in-flight round for the full window, paused or not.
    function test_pause_doesNotBlockDepositIntoALiveRound() public {
        (, address hook) = _createLaunch("Paus", "PAU");
        _register(user1, 0.05 ether);

        vm.prank(admin);
        factory.pause();

        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(hook, address(0));

        assertEq(_h(hook).ethDeposited(user1), 0.01 ether, "a live raise keeps taking deposits while paused");
    }

    /// @dev The other half of the same rule: no NEW exposure while paused.
    function test_pause_stillBlocksNewLaunchesAndNewQuota() public {
        _register(user1, 0.05 ether); // registered before the pause

        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();

        vm.prank(admin);
        factory.pause();

        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createLaunch{value: fee}("New", "NEW", projTreasury, projTreasury, salt, fee, 24 hours);

        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user2);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.registerPoG(0.05 ether, deadline, 0, _buildPoGSig(user2, 0.05 ether, 0, deadline));
    }

    function test_unpause_restoresAllPaths() public {
        vm.startPrank(admin);
        factory.pause();
        factory.unpause();
        vm.stopPrank();
        _register(user1, 0.05 ether);
        (, address hook) = _createLaunch("Up", "UP");
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(hook, address(0));
        assertEq(_h(hook).ethDeposited(user1), 0.01 ether);
    }

    function test_pause_rejectsNonOwner() public {
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.pause();
    }

    function test_unpause_rejectsNonOwner() public {
        vm.prank(admin);
        factory.pause();
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.unpause();
    }

    function test_pause_doesNotBlockRefund() public {
        vm.prank(admin);
        factory.setDefaultSoftCap(5 ether);
        (, address hook) = _createLaunch("Rfnd", "RFD");
        _register(user1, 0.05 ether);
        vm.prank(user1);
        factory.deposit{value: 0.05 ether}(hook, address(0));

        vm.prank(admin);
        factory.pause();
        vm.warp(_h(hook).genesisDeadline() + 1);

        uint256 before = user1.balance;
        vm.prank(user1);
        _h(hook).refund();
        assertEq(user1.balance - before, 0.05 ether);
    }

    // ── createLaunch ──────────────────────────────────────────────────────────

    function test_createLaunch_deploysContracts() public {
        (address token, address hook) = _createLaunch("TestToken", "TST");
        assertTrue(token != address(0));
        assertTrue(hook != address(0));
        assertEq(factory.launchCount(), 1);
        assertTrue(factory.registeredHooks(hook));
        assertEq(factory.tokenToHook(token), hook);
        assertTrue(HookMiner.isValidHookAddress(hook));
        assertEq(ToshToken(token).hook(), hook);
        assertEq(address(_h(hook).projectToken()), token);
        assertEq(_h(hook).perWalletCap(), factory.maxPogAllocationLimit());
    }

    function test_createLaunch_revertsOnUnderpayment() public {
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InsufficientLaunchFee.selector);
        factory.createLaunch{value: fee - 1}("Short", "SHT", projTreasury, projTreasury, salt, fee, 24 hours);
    }

    function test_createLaunch_rejectsInvalidSalt() public {
        bytes32 bad = _mineInvalidSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InvalidHookSalt.selector);
        factory.createLaunch{value: fee}("Bad", "BAD", projTreasury, projTreasury, bad, fee, 24 hours);
    }

    function test_createLaunch_revertsWhenFeeBumpedAboveExpected() public {
        bytes32 salt = _mineSalt();
        uint256 stale = factory.launchFee();
        vm.prank(admin);
        factory.setLaunchFee(stale + 1);
        vm.prank(creator);
        vm.expectRevert(ToshFactory.FeeChanged.selector);
        factory.createLaunch{value: stale + 1 ether}("Tok", "TOK", projTreasury, projTreasury, salt, stale, 24 hours);
    }

    function test_createLaunch_revertsForZeroProjectAdmin() public {
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InvalidAdmin.selector);
        factory.createLaunch{value: fee}("Tok", "TOK", projTreasury, address(0), salt, fee, 24 hours);
    }

    function test_createLaunch_rejectsEmptyName() public {
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.EmptyName.selector);
        factory.createLaunch{value: fee}("", "TOK", projTreasury, projTreasury, salt, fee, 24 hours);
    }

    function test_createLaunch_rejectsEmptySymbol() public {
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.EmptyName.selector);
        factory.createLaunch{value: fee}("Tok", "", projTreasury, projTreasury, salt, fee, 24 hours);
    }

    function test_createLaunch_rejectsDuplicateNamePair() public {
        _createLaunch("Same", "SAM");
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.NameTaken.selector);
        factory.createLaunch{value: fee}("Same", "SAM", projTreasury, projTreasury, salt, fee, 24 hours);
    }

    function test_createLaunch_allowsDifferentNameSamePrefix() public {
        _createLaunch("Alpha", "ALP");
        (address t,) = _createLaunch("Alpha2", "AL2");
        assertTrue(t != address(0));
    }

    /// @notice A reservation held by a launch that never cleared genesis goes
    ///         back on the market, so 0.1 ETH cannot buy a ticker forever.
    function test_releaseAbandonedName_freesTheTickerAfterAFailedGenesis() public {
        (, address hook) = _createLaunch("Ghost", "GHO");

        // Nobody funded it and the window closed: the hook's own refund path
        // is the objective proof the launch is dead.
        vm.warp(_h(hook).genesisDeadline() + 1);
        assertTrue(_h(hook).canRefund(), "fixture must actually be abandoned");

        factory.releaseAbandonedName(hook);

        // Claimable again.
        (address token2,) = _createLaunch("Ghost", "GHO");
        assertTrue(token2 != address(0), "the ticker must be claimable again");
    }

    function test_releaseAbandonedName_refusesWhileTheGenesisIsStillLive() public {
        (, address hook) = _createLaunch("Live", "LIV");

        vm.expectRevert(ToshFactory.NameStillHeld.selector);
        factory.releaseAbandonedName(hook);
    }

    /// @dev A round that took real money but still missed its soft cap is dead
    ///      too.  Depositors are made whole by `refund()`; this covers the part
    ///      that would otherwise stay unrecoverable — the creator's ticker.
    function test_releaseAbandonedName_recoversANameAfterAPartiallyFundedMiss() public {
        vm.prank(admin);
        factory.setDefaultSoftCap(5 ether);

        (, address hook) = _createLaunch("Undr", "UND");
        _register(user1, 0.05 ether);

        vm.prank(user1);
        factory.deposit{value: 0.05 ether}(hook, address(0));

        vm.warp(_h(hook).genesisDeadline() + 1);
        assertTrue(_h(hook).canRefund(), "an under-funded round must be refundable");

        // The round is dead, but the name is not.
        factory.releaseAbandonedName(hook);
        assertFalse(factory.nameTaken(keccak256(abi.encode("Undr", "UND"))), "ticker must be reclaimable");
    }

    function test_createLaunch_rejectsZeroProjectTreasury() public {
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(bytes("zero treasury"));
        factory.createLaunch{value: fee}("Tok", "TOK", address(0), projTreasury, salt, fee, 24 hours);
    }

    function test_createLaunch_succeedsWhenFeeIsZero() public {
        vm.prank(admin);
        factory.setLaunchFee(0);
        (address token,) = _createLaunch("Free", "FRE");
        assertTrue(token != address(0));
    }

    function test_createLaunch_revertsWhenSoftCapRotatedAfterMining() public {
        bytes32 salt = _mineSalt();

        // Rotating the cap changes the initcode hash and so the CREATE2
        // address — but `isValidHookAddress` is a SUBSET test on the flag bits,
        // so a re-rolled address still carries the required four about 3.5% of
        // the time.  Hard-coding one replacement cap therefore made this assert
        // on a coin flip that any bytecode change could lose.  Search the cap
        // space instead, so the test is about the binding it claims to test.
        uint256 rotated = _softCapThatInvalidates(salt);

        vm.prank(admin);
        factory.setDefaultSoftCap(rotated);
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InvalidHookSalt.selector);
        factory.createLaunch{value: fee}("Rot", "ROT", projTreasury, projTreasury, salt, fee, 24 hours);
    }

    /// @dev A soft cap under which `salt` no longer lands on a valid hook
    ///      address.  Terminates on the first candidate ~96% of the time.
    function _softCapThatInvalidates(bytes32 salt) internal view returns (uint256) {
        bytes32 finalSalt = keccak256(abi.encode(creator, salt));
        for (uint256 cap = 2 ether; cap < 2 ether + 1000; ++cap) {
            bytes32 initHash = factory.hookInitcodeHash(
                projTreasury, creator, projTreasury, cap, factory.maxPogAllocationLimit(), 24 hours
            );
            if (!HookMiner.isValidHookAddress(HookMiner.computeAddress(address(factory), finalSalt, initHash))) {
                return cap;
            }
        }
        revert("_softCapThatInvalidates: none found");
    }

    function test_createLaunch_fundsLadderTreasury() public {
        uint256 fee = factory.launchFee();
        uint256 before = ladder.balance;
        _createLaunch("Fee", "FEE");
        assertEq(ladder.balance - before, fee);
    }

    // ── Deposits ──────────────────────────────────────────────────────────────

    function test_deposit_succeedsWhenEligible() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.05 ether);
        vm.prank(user1);
        factory.deposit{value: 0.05 ether}(hook, address(0));
        assertEq(_h(hook).ethDeposited(user1), 0.05 ether);
        assertEq(_h(hook).totalEthDeposited(), 0.05 ether);
        assertGt(factory.userLaunchCooldownEnd(user1, hook), block.timestamp);
    }

    function test_deposit_blockedWhenBlacklisted() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.05 ether);
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(bl, 1 days);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.IsBlacklisted.selector);
        factory.deposit{value: 0.01 ether}(hook, address(0));
    }

    function test_deposit_blockedWithoutPoG() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        vm.prank(user1);
        vm.expectRevert(ToshFactory.NoPogQuota.selector);
        factory.deposit{value: 0.01 ether}(hook, address(0));
    }

    function test_deposit_blockedDuringCooldown() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.08 ether);
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(hook, address(0));
        vm.prank(user1);
        vm.expectRevert(ToshFactory.CooldownActive.selector);
        factory.deposit{value: 0.01 ether}(hook, address(0));
    }

    function test_deposit_blockedWhenQuotaExceeded() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.02 ether);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.QuotaExceeded.selector);
        factory.deposit{value: 0.03 ether}(hook, address(0));
    }

    function test_deposit_quotaIsGlobalAcrossHooks() public {
        (, address a) = _createLaunch("A", "AAA");
        (, address b) = _createLaunch("B", "BBB");
        _register(user1, 0.05 ether);
        vm.prank(user1);
        factory.deposit{value: 0.04 ether}(a, address(0));
        vm.prank(user1);
        vm.expectRevert(ToshFactory.QuotaExceeded.selector);
        factory.deposit{value: 0.02 ether}(b, address(0));
    }

    function test_deposit_cooldownLiftsAfterDuration() public {
        // Default cooldown is 24h, which collides with the 24h genesis window.
        vm.prank(admin);
        factory.setCooldownDuration(1 hours);

        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.08 ether);
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(hook, address(0));
        vm.warp(factory.userLaunchCooldownEnd(user1, hook) + 1);
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(hook, address(0));
        assertEq(_h(hook).ethDeposited(user1), 0.02 ether);
    }

    function test_deposit_rejectsZeroAmount() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.05 ether);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.ZeroAmount.selector);
        factory.deposit{value: 0}(hook, address(0));
    }

    function test_deposit_rejectsUnregisteredHook() public {
        _register(user1, 0.05 ether);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.HookNotRegistered.selector);
        factory.deposit{value: 0.01 ether}(makeAddr("nope"), address(0));
    }

    function test_blacklist_blocksEvenAfterPreRegisteredQuota() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.05 ether);
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(bl, 1 days);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.IsBlacklisted.selector);
        factory.deposit{value: 0.01 ether}(hook, address(0));
    }

    function test_blacklist_expiresAfterBanDuration() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.05 ether);
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(bl, 1 hours);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(hook, address(0));
        assertEq(_h(hook).ethDeposited(user1), 0.01 ether);
    }

    function test_liftBlacklist_immediatelyRestores() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.05 ether);
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.startPrank(admin);
        factory.setBlacklist(bl, 7 days);
        factory.liftBlacklist(bl);
        vm.stopPrank();
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(hook, address(0));
        assertEq(_h(hook).ethDeposited(user1), 0.01 ether);
    }

    function test_blacklist_blocksAttackerAcrossAllHooks() public {
        (, address a) = _createLaunch("A", "AAA");
        (, address b) = _createLaunch("B", "BBB");
        _register(user1, 1 ether);
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(bl, 1 days);
        vm.startPrank(user1);
        vm.expectRevert(ToshFactory.IsBlacklisted.selector);
        factory.deposit{value: 0.01 ether}(a, address(0));
        vm.expectRevert(ToshFactory.IsBlacklisted.selector);
        factory.deposit{value: 0.01 ether}(b, address(0));
        vm.stopPrank();
    }

    // ── Eligibility / views ───────────────────────────────────────────────────

    function test_eligibility_returnsFalseForBlacklistedUser() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.05 ether);
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(bl, 1 days);
        (bool ok,,) = factory.eligibility(user1, hook);
        assertFalse(ok);
    }

    function test_eligibility_returnsFalseWithoutPoG() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        (bool ok,,) = factory.eligibility(user1, hook);
        assertFalse(ok);
    }

    function test_eligibility_returnsCooldownRemaining() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.05 ether);
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(hook, address(0));
        (bool ok,, uint256 cd) = factory.eligibility(user1, hook);
        assertFalse(ok);
        assertGt(cd, 0);
    }

    function test_eligibility_returnsTrueOnUnregisteredHookWithQuota() public {
        _register(user1, 0.05 ether);
        (bool ok, uint256 remaining,) = factory.eligibility(user1, makeAddr("randomHook"));
        assertTrue(ok);
        assertEq(remaining, 0.05 ether);
    }

    function test_eligibility_returnsFalseWhenQuotaExhaustedSameHook() public {
        vm.prank(admin);
        factory.setCooldownDuration(0);
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 0.02 ether);
        vm.prank(user1);
        factory.deposit{value: 0.02 ether}(hook, address(0));
        (bool ok, uint256 remaining,) = factory.eligibility(user1, hook);
        assertFalse(ok);
        assertEq(remaining, 0);
    }

    function test_launchCount_startsAtZero() public view {
        assertEq(factory.launchCount(), 0);
    }

    function test_launchCount_incrementsAfterLaunch() public {
        _createLaunch("A", "A");
        assertEq(factory.launchCount(), 1);
    }

    function test_predictHookAddress_matchesActual() public {
        bytes32 salt = _mineSalt();
        bytes32 initHash = factory.hookInitcodeHash(
            projTreasury, creator, projTreasury, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        address predicted = factory.predictHookAddress(creator, salt, initHash);
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (, address hook) = factory.createLaunch{value: fee}("A", "A", projTreasury, projTreasury, salt, fee, 24 hours);
        assertEq(predicted, hook);
    }

    function test_verifyHookDeployment_true() public {
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (, address hook) = factory.createLaunch{value: fee}("A", "A", projTreasury, projTreasury, salt, fee, 24 hours);
        assertTrue(
            factory.verifyHookDeployment(
                hook,
                creator,
                projTreasury,
                projTreasury,
                factory.defaultSoftCap(),
                factory.maxPogAllocationLimit(),
                24 hours,
                salt
            )
        );
    }

    function test_verifyHookDeployment_falseForUnregisteredHook() public {
        assertFalse(
            factory.verifyHookDeployment(
                makeAddr("randomHook"),
                creator,
                projTreasury,
                projTreasury,
                factory.defaultSoftCap(),
                factory.maxPogAllocationLimit(),
                24 hours,
                bytes32(0)
            )
        );
    }

    function test_verifyHookDeployment_falseForMismatchedSalt() public {
        bytes32 salt = _mineSalt();
        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (, address hook) = factory.createLaunch{value: fee}("A", "A", projTreasury, projTreasury, salt, fee, 24 hours);
        assertFalse(
            factory.verifyHookDeployment(
                hook,
                creator,
                projTreasury,
                projTreasury,
                factory.defaultSoftCap(),
                factory.maxPogAllocationLimit(),
                24 hours,
                bytes32(uint256(salt) + 1)
            )
        );
    }

    function test_getLiveHookInitcodeHash_isStable() public view {
        assertEq(factory.getLiveHookInitcodeHash(), factory.getLiveHookInitcodeHash());
    }

    function test_hookInitcodeHash_matchesHookMiner() public view {
        bytes32 fromFactory = factory.hookInitcodeHash(
            projTreasury, creator, projTreasury, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        bytes32 local = keccak256(
            abi.encodePacked(
                type(ToshLaunchpadHook).creationCode,
                abi.encode(
                    mockPoolManager,
                    address(factory),
                    projTreasury,
                    creator,
                    projTreasury,
                    ladder,
                    factory.defaultSoftCap(),
                    factory.maxPogAllocationLimit(),
                    24 hours
                )
            )
        );
        assertEq(fromFactory, local);
    }

    // ── Genesis window selection ──────────────────────────────────────────────

    function test_createLaunch_honoursEachGenesisWindow() public {
        uint256[3] memory windows = [uint256(3 hours), 24 hours, 72 hours];
        string[3] memory names = ["Fast", "Standard", "Slow"];

        for (uint256 i; i < windows.length; ++i) {
            uint256 openedAt = block.timestamp;
            (, address hook) = _createLaunch(names[i], names[i], windows[i]);
            assertEq(_h(hook).genesisDuration(), windows[i], "hook stored the chosen window");
            assertEq(_h(hook).genesisDeadline(), openedAt + windows[i], "deadline honours the chosen window");
        }
    }

    /// @dev The window is part of the initcode hash, so a salt is only valid for
    ///      the window it was mined against.  This is what forces the frontend
    ///      miner to take the creator's choice as an input.
    function test_hookInitcodeHash_isWindowSpecific() public view {
        bytes32 fast = factory.hookInitcodeHash(
            projTreasury, creator, projTreasury, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 3 hours
        );
        bytes32 standard = factory.hookInitcodeHash(
            projTreasury, creator, projTreasury, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        bytes32 slow = factory.hookInitcodeHash(
            projTreasury, creator, projTreasury, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 72 hours
        );

        assertTrue(fast != standard, "3h and 24h hash differently");
        assertTrue(standard != slow, "24h and 72h hash differently");
        assertTrue(fast != slow, "3h and 72h hash differently");
    }

    /// @dev A salt mined for one window must not deploy under another, otherwise
    ///      a creator could advertise 72 h and ship 3 h.
    function test_createLaunch_rejectsSaltMinedForAnotherWindow() public {
        // A salt is window-specific because duration is in the initcode hash.
        // The usual outcome is InvalidHookSalt, but ~1/32 of salts that fit
        // window A also fit window B by chance (five required flag bits).
        // Search for a pair that actually diverges, otherwise the test is
        // asserting a coincidence rather than the CREATE2 binding.
        uint256 soft = factory.defaultSoftCap();
        uint256 cap = factory.maxPogAllocationLimit();
        bytes32 hashSlow = factory.hookInitcodeHash(projTreasury, creator, projTreasury, soft, cap, 72 hours);
        bytes32 hashFast = factory.hookInitcodeHash(projTreasury, creator, projTreasury, soft, cap, 3 hours);

        bytes32 saltForSlow;
        bool found;
        for (uint256 i; i < 500_000; ++i) {
            bytes32 raw = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(creator, raw));
            address slowAddr = HookMiner.computeAddress(address(factory), finalSalt, hashSlow);
            address fastAddr = HookMiner.computeAddress(address(factory), finalSalt, hashFast);
            if (HookMiner.isValidHookAddress(slowAddr) && !HookMiner.isValidHookAddress(fastAddr)) {
                saltForSlow = raw;
                found = true;
                break;
            }
        }
        require(found, "no cross-window salt");

        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InvalidHookSalt.selector);
        factory.createLaunch{value: fee}("Swap", "SWP", projTreasury, projTreasury, saltForSlow, fee, 3 hours);
    }

    /// @dev An unlisted window is rejected by the hook's constructor, which makes
    ///      the CREATE2 return address(0) and surfaces as `DeployFailed` here.
    function test_createLaunch_rejectsUnlistedWindow() public {
        bytes32 salt = _mineSalt(12 hours);
        uint256 fee = factory.launchFee();

        vm.prank(creator);
        vm.expectRevert(ToshFactory.DeployFailed.selector);
        factory.createLaunch{value: fee}("Odd", "ODD", projTreasury, projTreasury, salt, fee, 12 hours);
    }

    /// @dev `getLiveHookInitcodeHash` hard-codes 24 h because Solidity will not
    ///      let the factory read `DURATION_STANDARD` off the contract type.
    ///      This is the pin that catches the two drifting apart.
    function test_factory_liveInitcodeHash_tracksStandardDuration() public {
        (, address hook) = _createLaunch("Pin", "PIN");
        uint256 standard = _h(hook).DURATION_STANDARD();

        address sentinel = factory.platformTreasury();
        bytes32 expected = factory.hookInitcodeHash(
            sentinel, sentinel, sentinel, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), standard
        );

        assertEq(factory.getLiveHookInitcodeHash(), expected, "live hash must use DURATION_STANDARD");
    }

    function test_fastWindow_refundOpensAfterThreeHours() public {
        (, address hook) = _createLaunch("Quick", "QCK", 3 hours);
        _register(user1, 0.05 ether);
        vm.prank(user1);
        factory.deposit{value: 0.05 ether}(hook, address(0));

        // Still inside the window: the genesis is live, so no refund yet.
        vm.warp(block.timestamp + 3 hours - 1);
        assertFalse(_h(hook).canRefund(), "no refund while the window is open");

        // Past it, and under the soft cap, refunds open.
        vm.warp(block.timestamp + 2);
        assertTrue(_h(hook).canRefund(), "refund opens once a failed 3h window lapses");
    }
}
