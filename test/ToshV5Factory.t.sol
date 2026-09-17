// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookAddress} from "../src/libraries/HookAddress.sol";

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

    /// @dev A second mock, because Infinity split what V4 did in one contract:
    ///      the CL pool manager runs the pool, the Vault holds every balance,
    ///      and the factory takes both so it can pass them to each hook it
    ///      deploys. These tests never call through either, so mocks suffice.
    address internal mockVault = makeAddr("vault");

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);

        vm.startPrank(admin);
        factory = new ToshFactory(mockPoolManager, mockVault, pogSigner, treasury, ladder);
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

    function _pickSalt() internal view returns (bytes32 rawSalt) {
        return _pickSalt(24 hours);
    }

    function _pickSalt(uint256 duration) internal view returns (bytes32 rawSalt) {
        bytes32 initHash = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), duration
        );
        for (uint256 i; i < 1000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(creator, rawSalt));
            address predicted = HookAddress.computeAddress(address(factory), finalSalt, initHash);
            if (predicted.code.length == 0) return rawSalt;
        }
        revert("_pickSalt: first 1000 salts are all occupied");
    }

    function _createLaunch(string memory n, string memory s) internal returns (address token, address hook) {
        return _createLaunch(n, s, 24 hours);
    }

    /// @dev The salt the most recent `_createLaunch` used, so a test can check
    ///      the deployed address against its prediction without replicating the
    ///      helper.
    bytes32 internal _lastSalt;

    function _createLaunch(string memory n, string memory s, uint256 duration)
        internal
        returns (address token, address hook)
    {
        bytes32 salt = _pickSalt(duration);
        _lastSalt = salt;
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (token, hook) = factory.createLaunch{value: fee}(
            n, s, projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, duration
        );
    }

    function _h(address hook) internal pure returns (ToshLaunchpadHook) {
        return ToshLaunchpadHook(payable(hook));
    }

    /// @notice End-to-end gas guard on the single most expensive user action on
    ///         the platform.
    ///
    /// @dev    `createLaunch` measured 5,016,031 gas when the hook and the token
    ///         were each deployed as a full copy per project — 91.6 % of it code
    ///         deposit at 200 gas/byte.  Both are now EIP-1167 clones, which
    ///         brought it to roughly 543 k.
    ///
    ///         The budget is set above the current figure rather than snug
    ///         against it: the point is to catch a regression that puts code
    ///         deposit back on this path, not to fail on a compiler upgrade
    ///         shifting a few thousand gas.  Anything that trips this has almost
    ///         certainly stopped cloning something, or added an immutable arg.
    ///
    ///         Run under `--isolate` this measures 557 k and under plain `forge
    ///         test` 525 k, the difference being storage the harness keeps warm.
    ///         The budget clears the higher one.
    ///
    ///         Mining is excluded on purpose — the salt is ground off-chain and
    ///         the creator pays nothing for it.
    function test_createLaunch_gasStaysUnderBudget() public {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();

        vm.prank(creator);
        uint256 before = gasleft();
        factory.createLaunch{value: fee}(
            "Budget",
            "BGT",
            projTreasury,
            projTreasury,
            salt,
            fee,
            factory.defaultSoftCap(),
            factory.maxPogAllocationLimit(),
            24 hours
        );
        uint256 used = before - gasleft();

        emit log_named_uint("createLaunch gas", used);
        emit log_named_uint("was, before cloning", 5_016_031);

        assertLt(used, 640_000, "createLaunch regressed: code deposit is probably back");
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    function test_ctor_revertsOnZeroPoolManager() public {
        vm.expectRevert(bytes("zero poolManager"));
        new ToshFactory(address(0), mockVault, pogSigner, treasury, ladder);
    }

    function test_ctor_revertsOnZeroPogSigner() public {
        vm.expectRevert(bytes("zero pogSigner"));
        new ToshFactory(mockPoolManager, mockVault, address(0), treasury, ladder);
    }

    function test_ctor_revertsOnZeroTreasury() public {
        vm.expectRevert(bytes("zero platformTreasury"));
        new ToshFactory(mockPoolManager, mockVault, pogSigner, address(0), ladder);
    }

    function test_ctor_revertsOnZeroLadderTreasury() public {
        vm.expectRevert(bytes("zero ladderTreasury"));
        new ToshFactory(mockPoolManager, mockVault, pogSigner, treasury, payable(address(0)));
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

    // ── platformTreasury: immutable, and the same address the hook pays ───────
    //
    // `setPlatformTreasury` used to live here.  It was deleted when this field
    // went back onto a money path (`PLATFORM_SWAP_FEE_BPS`, 30 bps of every
    // buy's ETH input): a mutable fee-routing target is audit finding M-2, so
    // the mutability went rather than the inflow.  The three tests that pinned
    // the setter's happy path, its zero guard, and its owner gate are replaced
    // by the three below, which pin the property that replaced it.

    /// @dev The setter is gone from the ABI, not merely gated.  A gated setter
    ///      still routes money at the owner's discretion, which is the thing
    ///      M-2 objected to, so "reverts for non-owners" would be the wrong
    ///      assertion — the selector must not resolve at all.
    function test_platformTreasury_hasNoSetter() public {
        // keccak256("setPlatformTreasury(address)")[0:4]
        bytes4 gone = bytes4(keccak256("setPlatformTreasury(address)"));
        (bool ok,) = address(factory).call(abi.encodeWithSelector(gone, makeAddr("newTreasury")));
        assertFalse(ok, "setPlatformTreasury must not be callable");
        assertEq(factory.platformTreasury(), treasury, "and the address must be unchanged");
    }

    /// @dev Non-zero is a constructor invariant (`test_ctor_revertsOnZeroTreasury`),
    ///      and because the field is immutable that guard holds for the whole
    ///      life of the factory rather than only until the next admin call.
    function test_platformTreasury_isNonZeroForever() public {
        assertTrue(factory.platformTreasury() != address(0));
        vm.warp(block.timestamp + 3650 days);
        vm.prank(admin);
        factory.setPogSigner(makeAddr("rotated"));
        assertEq(factory.platformTreasury(), treasury, "immutable across any other admin activity");
    }

    /// @dev THE ANTI-DIVERGENCE GUARD.  The factory records the platform's
    ///      payout address; the hook implementation bakes the SAME address in
    ///      as its own `platformFeeRecipient` immutable, and it is the hook —
    ///      not the factory — that actually performs the `take` on every buy.
    ///      Back when the factory field was mutable these two could drift: an
    ///      operator rotates the factory's copy, reads it back changed, and
    ///      every swap keeps paying the old address with nothing on chain
    ///      contradicting them.  Both are immutable and both are wired from
    ///      the same constructor argument, so the only way this can fail is a
    ///      wiring regression in `HookDeployLib.deployImplementation`.
    function test_platformTreasury_matchesHookPlatformFeeRecipient() public view {
        ToshLaunchpadHook impl = ToshLaunchpadHook(payable(factory.hookImplementation()));
        assertEq(impl.platformFeeRecipient(), payable(factory.platformTreasury()), "factory and hook must agree");
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

    /// @dev The ceiling is inclusive, so the boundary is a legal setting rather
    ///      than an off-by-one that only shows up when someone tries to use it.
    function test_setLaunchFee_atBoundary() public {
        // Read the ceiling first: `vm.prank` applies to the next call, and a
        // getter in the argument list is that call.
        uint256 ceiling = factory.MAX_LAUNCH_FEE();
        vm.prank(admin);
        factory.setLaunchFee(ceiling);
        assertEq(factory.launchFee(), ceiling);
    }

    /// @dev `setLaunchFee` was the only setter here with no validation at all.
    ///      The realistic failure is a wei/ether slip in a Safe transaction
    ///      builder, which would make `createLaunch` unaffordable for everyone
    ///      until a second owner transaction undid it — an outage from a typo.
    function test_setLaunchFee_rejectsAboveCeiling() public {
        uint256 ceiling = factory.MAX_LAUNCH_FEE();
        vm.prank(admin);
        vm.expectRevert(ToshFactory.LaunchFeeTooHigh.selector);
        factory.setLaunchFee(ceiling + 1);
    }

    /// @dev The slip this exists for, at its real magnitude: 0.1 ether typed as
    ///      0.1e18 ether. Nothing in the old setter would have stopped it.
    function test_setLaunchFee_rejectsOrderOfMagnitudeSlip() public {
        vm.prank(admin);
        vm.expectRevert(ToshFactory.LaunchFeeTooHigh.selector);
        factory.setLaunchFee(0.1e18 ether);
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

    function test_setMaxPogAllocationLimit_atBoundary() public {
        uint256 ceiling = factory.MAX_POG_ALLOCATION_LIMIT();
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(ceiling);
        assertEq(factory.maxPogAllocationLimit(), ceiling);
    }

    function test_setMaxPogAllocationLimit_rejectsAboveCeiling() public {
        uint256 ceiling = factory.MAX_POG_ALLOCATION_LIMIT();
        vm.prank(admin);
        vm.expectRevert(ToshFactory.PogLimitTooHigh.selector);
        factory.setMaxPogAllocationLimit(ceiling + 1);
    }

    /// @dev The slip at its real magnitude: 0.1 ether typed as 0.1e18 ether.
    function test_setMaxPogAllocationLimit_rejectsOrderOfMagnitudeSlip() public {
        vm.prank(admin);
        vm.expectRevert(ToshFactory.PogLimitTooHigh.selector);
        factory.setMaxPogAllocationLimit(0.1e18 ether);
    }

    /// @dev The reason this ceiling is 1 M ETH and not something tidy like 100x
    ///      the default. These two values are not hypothetical: `setUp` here
    ///      raises the limit to 1000 ETH so the `registerPoG` tests can work in
    ///      round numbers, and `test_registerPoG_noSilentClamp` needs 300. A
    ///      bound chosen for neatness would have failed this repo's own suite,
    ///      which is the cheapest available evidence that it was the wrong bound.
    function test_setMaxPogAllocationLimit_admitsTheValuesThisSuiteUses() public {
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(1000 ether);
        assertEq(factory.maxPogAllocationLimit(), 1000 ether);

        vm.prank(admin);
        factory.setMaxPogAllocationLimit(300 ether);
        assertEq(factory.maxPogAllocationLimit(), 300 ether);
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

    function test_setDefaultSoftCap_atBoundary() public {
        uint256 ceiling = factory.MAX_DEFAULT_SOFT_CAP();
        vm.prank(admin);
        factory.setDefaultSoftCap(ceiling);
        assertEq(factory.defaultSoftCap(), ceiling);
    }

    /// @dev Unreachable rather than unaffordable, which is why the floor alone was
    ///      not enough: a soft cap no depositor base can clear does not revert
    ///      anything, it lets every project created afterwards open a genesis
    ///      round that can only ever end in refunds.
    function test_setDefaultSoftCap_rejectsAboveCeiling() public {
        uint256 ceiling = factory.MAX_DEFAULT_SOFT_CAP();
        vm.prank(admin);
        vm.expectRevert(ToshFactory.SoftCapTooHigh.selector);
        factory.setDefaultSoftCap(ceiling + 1);
    }

    /// @dev 10 ether typed as 10e18 ether — the default, off by the wei/ether
    ///      confusion this ceiling exists for.
    function test_setDefaultSoftCap_rejectsOrderOfMagnitudeSlip() public {
        vm.prank(admin);
        vm.expectRevert(ToshFactory.SoftCapTooHigh.selector);
        factory.setDefaultSoftCap(10e18 ether);
    }

    /// @dev Companion to `test_setMaxPogAllocationLimit_admitsTheValuesThisSuiteUses`:
    ///      8000 ETH is the soft cap `soat-frontend/scripts/batchA-R2-fresh.ps1`
    ///      sets against a local Anvil node, so it has to keep working.
    function test_setDefaultSoftCap_admitsALargeButRealRaise() public {
        vm.prank(admin);
        factory.setDefaultSoftCap(8000 ether);
        assertEq(factory.defaultSoftCap(), 8000 ether);
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
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        vm.prank(admin);
        factory.pause();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createLaunch{value: fee}(
            "P", "P", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
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

        assertEq(_h(hook).nativeDeposited(user1), 0.01 ether, "a live raise keeps taking deposits while paused");
    }

    /// @dev The other half of the same rule: no NEW exposure while paused.
    function test_pause_stillBlocksNewLaunchesAndNewQuota() public {
        _register(user1, 0.05 ether); // registered before the pause

        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();

        vm.prank(admin);
        factory.pause();

        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createLaunch{value: fee}(
            "New", "NEW", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );

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
        assertEq(_h(hook).nativeDeposited(user1), 0.01 ether);
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
        vm.warp(_h(hook).genesisDeadline() + _h(hook).LAUNCH_WINDOW() + 1);

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
        // Was `assertTrue(HookAddress.isValidHookAddress(hook))`, which asserted
        // the address carried V4's permission mask. Infinity takes permissions
        // from the hook's bitmap, so the surviving property is that the address
        // is the one the salt predicted.
        assertTrue(
            factory.verifyHookDeployment(
                hook,
                creator,
                projTreasury,
                factory.defaultSoftCap(),
                factory.maxPogAllocationLimit(),
                24 hours,
                _lastSalt
            ),
            "the deployed hook is at the address its salt predicted"
        );
        assertEq(ToshToken(token).hook(), hook);
        assertEq(address(_h(hook).projectToken()), token);
        assertEq(_h(hook).perWalletCap(), factory.maxPogAllocationLimit());
    }

    function test_createLaunch_revertsOnUnderpayment() public {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InsufficientLaunchFee.selector);
        factory.createLaunch{value: fee - 1}(
            "Short", "SHT", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
    }

    /// @notice ⚠ `test_createLaunch_rejectsInvalidSalt` WAS DELETED HERE, along
    ///         with the `_mineInvalidSalt` helper that fed it.
    ///
    ///         There is no such thing as an invalid salt any more. The test
    ///         searched for a salt whose CREATE2 address lacked V4's permission
    ///         mask and asserted `InvalidHookSalt`; PancakeSwap Infinity reads
    ///         permissions from the hook's bitmap, so every salt is acceptable
    ///         and the error is gone from the factory.
    ///
    ///         Nothing replaces it, because there is no remaining property to
    ///         assert: a salt's only job now is to be free, and
    ///         `test_createLaunch_deploysContracts` already checks that the one
    ///         used lands where it was predicted to.
    function test_anySaltIsAcceptedNow() public {
        // Including salts the old gate would have rejected outright. 0 is the
        // sharpest case: `_pickSalt` starts its search there, so under V4 this
        // was overwhelmingly a rejected value.
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (, address hook) = factory.createLaunch{value: fee}(
            "Any", "ANY", projTreasury, projTreasury, bytes32(0), fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
        assertTrue(hook != address(0), "a launch on a salt V4 would have refused");
    }

    function test_createLaunch_revertsWhenFeeBumpedAboveExpected() public {
        bytes32 salt = _pickSalt();
        uint256 stale = factory.launchFee();
        vm.prank(admin);
        factory.setLaunchFee(stale + 1);
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.FeeChanged.selector);
        factory.createLaunch{value: stale + 1 ether}(
            "Tok", "TOK", projTreasury, projTreasury, salt, stale, agreedSoftCap, agreedWalletCap, 24 hours
        );
    }

    function test_createLaunch_revertsForZeroProjectAdmin() public {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InvalidAdmin.selector);
        factory.createLaunch{value: fee}(
            "Tok", "TOK", projTreasury, address(0), salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
    }

    function test_createLaunch_rejectsEmptyName() public {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.EmptyName.selector);
        factory.createLaunch{value: fee}(
            "", "TOK", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
    }

    function test_createLaunch_rejectsEmptySymbol() public {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.EmptyName.selector);
        factory.createLaunch{value: fee}(
            "Tok", "", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
    }

    function test_createLaunch_rejectsDuplicateNamePair() public {
        _createLaunch("Same", "SAM");
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.NameTaken.selector);
        factory.createLaunch{value: fee}(
            "Same", "SAM", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
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
        vm.warp(_h(hook).genesisDeadline() + _h(hook).LAUNCH_WINDOW() + 1);
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

    /// @dev A round that took real money but whose creator never called
    ///      `launch()` is dead too.  Depositors are made whole by `refund()`;
    ///      this covers the part that would otherwise stay unrecoverable — the
    ///      creator's ticker.
    function test_releaseAbandonedName_recoversANameAfterAPartiallyFundedMiss() public {
        vm.prank(admin);
        factory.setDefaultSoftCap(5 ether);

        (, address hook) = _createLaunch("Undr", "UND");
        _register(user1, 0.05 ether);

        vm.prank(user1);
        factory.deposit{value: 0.05 ether}(hook, address(0));

        vm.warp(_h(hook).genesisDeadline() + _h(hook).LAUNCH_WINDOW() + 1);
        assertTrue(_h(hook).canRefund(), "an unlaunched round must be refundable after the launch window");

        // The round is dead, but the name is not.
        factory.releaseAbandonedName(hook);
        assertFalse(factory.nameTaken(keccak256(abi.encode("Undr", "UND"))), "ticker must be reclaimable");
    }

    function test_createLaunch_rejectsZeroProjectTreasury() public {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(bytes("zero treasury"));
        factory.createLaunch{value: fee}(
            "Tok", "TOK", address(0), projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
    }

    function test_createLaunch_succeedsWhenFeeIsZero() public {
        vm.prank(admin);
        factory.setLaunchFee(0);
        (address token,) = _createLaunch("Free", "FRE");
        assertTrue(token != address(0));
    }

    /// @notice A rotated soft cap stops the launch, by an explicit guard rather
    ///         than a side effect.
    ///
    /// @dev    Descends from `test_createLaunch_revertsWhenSoftCapRotatedAfterMining`
    ///         and reaches the same OUTCOME by a different mechanism, which is
    ///         worth stating because the mechanism was the whole problem.
    ///
    ///         The old revert was `InvalidHookSalt`, and it was never a
    ///         deliberate guard. It fell out of Uniswap V4's address-bit gate:
    ///         rotating the cap changed the initcode, re-rolled the CREATE2
    ///         address, and the new address then failed the permission mask about
    ///         96% of the time. The creator got a loud failure by accident — and
    ///         the other ~4% got a silent one.
    ///
    ///         The PancakeSwap Infinity port removed the gate, which removed the
    ///         accident, and for a while every rotation was silently honoured.
    ///         The guard is now `CapsChanged`, checked against arguments the
    ///         caller supplies, so it catches 100% rather than 96% and does not
    ///         lean on address arithmetic to do it. See
    ///         docs/PANCAKESWAP_INFINITY.md §11.3.
    ///
    ///         `expectedSoftCap` is a STALE local here rather than a live read.
    ///         Every other call site in this file reads live, which is what a
    ///         caller should do; this one holds the value from before the
    ///         rotation, because that is the situation being tested.
    function test_createLaunch_refusesARotatedSoftCap() public {
        bytes32 salt = _pickSalt();
        uint256 agreedCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();

        vm.prank(admin);
        factory.setDefaultSoftCap(agreedCap + 1 ether);

        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.CapsChanged.selector);
        factory.createLaunch{value: fee}(
            "Rot", "ROT", projTreasury, projTreasury, salt, fee, agreedCap, agreedWalletCap, 24 hours
        );
    }

    /// @dev The wallet cap is the other half of the same guard, and it gets its
    ///      own test because the two dials have separate setters — a guard that
    ///      watched only the soft cap would look right and be half blind.
    function test_createLaunch_refusesARotatedWalletCap() public {
        bytes32 salt = _pickSalt();
        uint256 agreedCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();

        vm.prank(admin);
        factory.setMaxPogAllocationLimit(agreedWalletCap - 1);

        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.CapsChanged.selector);
        factory.createLaunch{value: fee}(
            "Rot2", "RT2", projTreasury, projTreasury, salt, fee, agreedCap, agreedWalletCap, 24 hours
        );
    }

    /// @dev Exact, not a bound, and this is what separates the caps from
    ///      `expectedFee`. A fee that moved DOWN leaves the caller better off, so
    ///      that guard is one-sided. A cap that moved in the caller's favour
    ///      still re-rolls the address they predicted, so there is no direction
    ///      in which a mismatch is harmless and equality is the only useful test.
    function test_createLaunch_refusesEvenAFavourableRotation() public {
        bytes32 salt = _pickSalt();
        uint256 agreedCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();

        // Upward: a larger per-wallet allowance is strictly better for anyone
        // depositing into this project.
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(agreedWalletCap + 1);

        uint256 fee = factory.launchFee();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.CapsChanged.selector);
        factory.createLaunch{value: fee}(
            "Fav", "FAV", projTreasury, projTreasury, salt, fee, agreedCap, agreedWalletCap, 24 hours
        );
    }

    /// @dev And the address the guard protects really is the one the caller
    ///      predicted, which is the property that makes passing the dials worth
    ///      the two extra arguments.
    function test_createLaunch_landsWhereTheAgreedDialsPredicted() public {
        bytes32 salt = _pickSalt();
        uint256 agreedCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();

        address predicted = factory.predictHookAddress(
            creator, salt, factory.hookInitcodeHash(projTreasury, creator, agreedCap, agreedWalletCap, 24 hours)
        );

        uint256 fee = factory.launchFee();
        vm.prank(creator);
        (, address hook) = factory.createLaunch{value: fee}(
            "Pred", "PRD", projTreasury, projTreasury, salt, fee, agreedCap, agreedWalletCap, 24 hours
        );

        assertEq(hook, predicted, "the launch landed where the agreed dials predicted");
        assertEq(_h(hook).softCap(), agreedCap, "and froze the cap that was agreed to");
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
        assertEq(_h(hook).nativeDeposited(user1), 0.05 ether);
        assertEq(_h(hook).totalNativeDeposited(), 0.05 ether);
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
        assertEq(_h(hook).nativeDeposited(user1), 0.02 ether);
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
        assertEq(_h(hook).nativeDeposited(user1), 0.01 ether);
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
        assertEq(_h(hook).nativeDeposited(user1), 0.01 ether);
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
        bytes32 salt = _pickSalt();
        bytes32 initHash = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        address predicted = factory.predictHookAddress(creator, salt, initHash);
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (, address hook) = factory.createLaunch{value: fee}(
            "A", "A", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
        assertEq(predicted, hook);
    }

    function test_verifyHookDeployment_true() public {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (, address hook) = factory.createLaunch{value: fee}(
            "A", "A", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
        assertTrue(
            factory.verifyHookDeployment(
                hook, creator, projTreasury, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours, salt
            )
        );
    }

    function test_verifyHookDeployment_falseForUnregisteredHook() public {
        assertFalse(
            factory.verifyHookDeployment(
                makeAddr("randomHook"),
                creator,
                projTreasury,
                factory.defaultSoftCap(),
                factory.maxPogAllocationLimit(),
                24 hours,
                bytes32(0)
            )
        );
    }

    function test_verifyHookDeployment_falseForMismatchedSalt() public {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (, address hook) = factory.createLaunch{value: fee}(
            "A", "A", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
        assertFalse(
            factory.verifyHookDeployment(
                hook,
                creator,
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

    /// @dev Rebuilds the initcode byte by byte instead of calling
    ///      `ToshCloneLib`, which would make the assertion a tautology. This
    ///      is the executable spec for the off-chain miner in
    ///      `soat-frontend/src/app/lib/hookAddress.ts`: any implementation that
    ///      produces these 131 bytes will predict the right address, and any that
    ///      does not will mine salts that fail `InvalidHookSalt`.
    ///
    ///      Layout, and why each field is where it is:
    ///        10 B  creation stub, returning the 121 (0x79) bytes that follow
    ///        45 B  EIP-1167 runtime, with the implementation address at [10..29]
    ///        76 B  immutable args: creator, projectTreasury, softCap:uint128,
    ///              perWalletCap:uint128, genesisDuration:uint32
    ///
    ///      Note what is NOT here: `poolManager`, `factory` and `ladderTreasury`
    ///      are identical for every launch, so they are ordinary immutables on the
    ///      shared implementation and cost no per-project byte. `projectAdmin` is
    ///      not here either — it is mutable by design and is set by
    ///      `initializeToken`.
    function test_hookInitcodeHash_matchesHandBuiltCloneInitcode() public view {
        uint256 softCap = factory.defaultSoftCap();
        uint256 walletCap = factory.maxPogAllocationLimit();

        bytes32 fromFactory = factory.hookInitcodeHash(projTreasury, creator, softCap, walletCap, 24 hours);

        bytes memory initcode = abi.encodePacked(
            hex"3d607980600a3d3981f3",
            hex"363d3d373d3d3d363d73",
            factory.hookImplementation(),
            hex"5af43d82803e903d91602b57fd5bf3",
            creator,
            projTreasury,
            uint128(softCap),
            uint128(walletCap),
            uint32(24 hours)
        );

        assertEq(initcode.length, 131, "initcode is 131 bytes");
        assertEq(keccak256(initcode), fromFactory, "factory agrees with the hand-built layout");
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
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 3 hours
        );
        bytes32 standard = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        bytes32 slow = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 72 hours
        );

        assertTrue(fast != standard, "3h and 24h hash differently");
        assertTrue(standard != slow, "24h and 72h hash differently");
        assertTrue(fast != slow, "3h and 72h hash differently");
    }

    /// @notice One salt, two windows, two addresses.
    ///
    /// @dev    Replaces `test_createLaunch_rejectsSaltMinedForAnotherWindow`,
    ///         which expected `InvalidHookSalt` when a salt prepared for the 72 h
    ///         window was spent on the 3 h one. As in
    ///         `test_createLaunch_silentlyAcceptsARotatedSoftCap`, that revert
    ///         was a side effect of V4's address-bit gate and went with it.
    ///
    ///         Losing it costs less here, and the reason is worth stating: the
    ///         window is a named argument to `createLaunch`, not something the
    ///         salt decides. A creator who asks for 3 h gets 3 h. The old test's
    ///         stated fear — "a creator could advertise 72 h and ship 3 h" — was
    ///         never held off by the salt; it is held off by the argument being
    ///         explicit and by `initializeToken` refusing unlisted values.
    ///
    ///         What the salt does decide is the address, and that binding does
    ///         still hold. `test_hookInitcodeHash_isWindowSpecific` above proves
    ///         the two windows hash differently; this proves the difference
    ///         reaches the deployed address, which is what makes
    ///         `verifyHookDeployment` able to tell a 3 h launch from a 72 h one.
    function test_predictedAddressIsWindowSpecific() public view {
        uint256 soft = factory.defaultSoftCap();
        uint256 cap = factory.maxPogAllocationLimit();
        bytes32 salt = bytes32(uint256(7));

        address slow = factory.predictHookAddress(
            creator, salt, factory.hookInitcodeHash(projTreasury, creator, soft, cap, 72 hours)
        );
        address fast = factory.predictHookAddress(
            creator, salt, factory.hookInitcodeHash(projTreasury, creator, soft, cap, 3 hours)
        );

        assertTrue(slow != fast, "the same salt under two windows must predict two addresses");
    }

    /// @dev An unlisted window is rejected by `initializeToken`, which reverts the
    ///      whole `createLaunch`.
    ///
    ///      This used to surface as `DeployFailed`: the duration was a constructor
    ///      argument, so a bad one reverted the constructor, CREATE2 returned
    ///      address(0), and the factory reported the deployment as having failed.
    ///      A clone has no constructor to reject anything — it deploys fine and
    ///      carries the bad duration in its bytecode — so the rejection now
    ///      happens one step later, on the hook's own terms, and says what is
    ///      actually wrong.
    function test_createLaunch_rejectsUnlistedWindow() public {
        bytes32 salt = _pickSalt(12 hours);
        uint256 fee = factory.launchFee();

        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshLaunchpadHook.InvalidDuration.selector);
        factory.createLaunch{value: fee}(
            "Odd", "ODD", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 12 hours
        );
    }

    /// @dev `getLiveHookInitcodeHash` hard-codes 24 h because Solidity will not
    ///      let the factory read `DURATION_STANDARD` off the contract type.
    ///      This is the pin that catches the two drifting apart.
    function test_factory_liveInitcodeHash_tracksStandardDuration() public {
        (, address hook) = _createLaunch("Pin", "PIN");
        uint256 standard = _h(hook).DURATION_STANDARD();

        address sentinel = factory.platformTreasury();
        bytes32 expected = factory.hookInitcodeHash(
            sentinel, sentinel, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), standard
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

        // Past genesis, still inside the 7-day launch window: no refund yet.
        vm.warp(block.timestamp + 2);
        assertFalse(_h(hook).canRefund(), "refund stays closed until the launch window lapses");

        vm.warp(_h(hook).genesisDeadline() + _h(hook).LAUNCH_WINDOW() + 1);
        assertTrue(_h(hook).canRefund(), "refund opens once the 7-day launch window lapses");
    }
}
