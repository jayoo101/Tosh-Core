// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {CircuitNFT} from "../src/CircuitNFT.sol";
import {CircuitRevenueVault} from "../src/CircuitRevenueVault.sol";
import {HookAddress} from "../src/libraries/HookAddress.sol";
import {MockQuoteAsset} from "./utils/MockQuoteAsset.sol";

/// @notice v5.0 factory surface: PoG, pause, blacklist, createLaunch, ETH deposits,
///         eligibility, and CREATE2 helpers.  Uses a dummy PoolManager because
///         none of these paths initialise a pool.
contract ToshV5FactoryTest is Test {
    using MessageHashUtils for bytes32;

    address internal admin = makeAddr("admin");
    /// @dev `createLaunch` is `onlyOwner`, and the hook records its caller as
    ///      `creator`, so the launcher of every round is the owner.
    address internal creator = admin;
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

    /// @dev NOT a mock, unlike the pool manager and the Vault above, and it
    ///      cannot be: `ToshFactory`'s constructor deploys the hook
    ///      implementation, whose own constructor reads `decimals()` off the quote
    ///      asset and requires 8. A `makeAddr` placeholder holds no code, so the
    ///      whole fixture would fail to construct.
    MockQuoteAsset internal quote;

    /// @dev The per-launch hard cap fixture rounds are created with — the
    ///      factory ceiling, so it never binds unless a test means it to.
    uint256 internal constant HARD_CAP = 20_000e16;

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);

        quote = new MockQuoteAsset();

        vm.startPrank(admin);
        factory = new ToshFactory(mockPoolManager, mockVault, pogSigner, treasury, ladder, address(quote));
        // The suite's working ceiling. It used to be 1000 ETH, chosen so the
        // `registerPoG` tests could use round numbers with vast headroom under
        // `MAX_POG_ALLOCATION_LIMIT`. There is no vast headroom any more — the
        // ceiling is 20,000 BEM, a tenth of BEM's supply — so this is now a real
        // fraction of it rather than a rounding error against it.
        factory.setMaxPogAllocationLimit(1000e16);
        vm.stopPrank();

        // Native for gas only.
        vm.deal(creator, 100 ether);
        vm.deal(user1, 100 ether);
        vm.deal(user2, 100 ether);
        vm.deal(admin, 100 ether);

        // The factory pulls every deposit, so anyone who might
        // pay needs a balance and an allowance. This suite mostly asserts
        // refusals, which happen before any transfer — but a refusal that the
        // ERC20 raises first would be the wrong refusal, and silently so.
        _endow(creator);
        _endow(user1);
        _endow(user2);
    }

    function _endow(address who) internal {
        quote.mint(who, 100_000e16);
        vm.prank(who);
        quote.approve(address(factory), type(uint256).max);
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
        bytes32 initHash =
            factory.hookInitcodeHash(projTreasury, creator, HARD_CAP, factory.maxPogAllocationLimit(), duration);
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
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (token, hook) = factory.createLaunch(n, s, projTreasury, salt, HARD_CAP, agreedWalletCap, duration);
    }

    /// @dev A launch with caps other than the fixture's, salt picked for them.
    function _createLaunchWith(string memory n, string memory s, uint256 hardCap, uint256 walletCap)
        internal
        returns (address token, address hook)
    {
        bytes32 initHash = factory.hookInitcodeHash(projTreasury, creator, hardCap, walletCap, 24 hours);
        bytes32 salt;
        for (uint256 i; i < 1000; ++i) {
            salt = bytes32(i);
            if (factory.predictHookAddress(creator, salt, initHash).code.length == 0) break;
        }
        vm.prank(creator);
        (token, hook) = factory.createLaunch(n, s, projTreasury, salt, hardCap, walletCap, 24 hours);
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
    ///         brought it to roughly 543 k. GrantPad added the Circuit mint and
    ///         the 77-byte vault clone, about 37 k more (~651 k).
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
        // Read before the prank, not inside the argument list. See the note on the
        // same hoist in `test_gas_createLaunch`: an external getter in the argument
        // list consumes `vm.prank`.
        uint256 pogCap = factory.maxPogAllocationLimit();

        vm.prank(creator);
        uint256 before = gasleft();
        factory.createLaunch("Budget", "BGT", projTreasury, salt, HARD_CAP, pogCap, 24 hours);
        uint256 used = before - gasleft();

        emit log_named_uint("createLaunch gas", used);
        emit log_named_uint("was, before cloning", 5_016_031);

        assertLt(used, 700_000, "createLaunch regressed: code deposit is probably back");
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    function test_ctor_revertsOnZeroPoolManager() public {
        vm.expectRevert(bytes("zero poolManager"));
        new ToshFactory(address(0), mockVault, pogSigner, treasury, ladder, address(quote));
    }

    function test_ctor_revertsOnZeroPogSigner() public {
        vm.expectRevert(bytes("zero pogSigner"));
        new ToshFactory(mockPoolManager, mockVault, address(0), treasury, ladder, address(quote));
    }

    function test_ctor_revertsOnZeroTreasury() public {
        vm.expectRevert(bytes("zero platformTreasury"));
        new ToshFactory(mockPoolManager, mockVault, pogSigner, address(0), ladder, address(quote));
    }

    function test_ctor_revertsOnZeroLadderTreasury() public {
        vm.expectRevert(bytes("zero ladderTreasury"));
        new ToshFactory(mockPoolManager, mockVault, pogSigner, treasury, payable(address(0)), address(quote));
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
        _register(user1, 5e16);
        assertEq(factory.pogQuota(user1), 5e16);
        assertEq(factory.pogNonces(user1), 1);
    }

    function test_registerPoG_rejectsExpiredSig() public {
        uint256 deadline = block.timestamp - 1;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.SignatureExpired.selector);
        factory.registerPoG(5e16, deadline, 0, _buildPoGSig(user1, 5e16, 0, deadline));
    }

    function test_registerPoG_rejectsInvalidSig() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 hash = keccak256(
                abi.encode(user1, uint256(5e16), uint256(0), deadline, address(factory), block.chainid)
            ).toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEAD, hash);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.InvalidSignature.selector);
        factory.registerPoG(5e16, deadline, 0, abi.encodePacked(r, s, v));
    }

    function test_registerPoG_rejectsReplayedNonce() public {
        _register(user1, 5e16);
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.NonceConflict.selector);
        factory.registerPoG(5e16, deadline, 0, _buildPoGSig(user1, 5e16, 0, deadline));
    }

    function test_registerPoG_rejectsSignatureTooLong() public {
        uint256 deadline = block.timestamp + factory.MAX_SIG_VALIDITY() + 1;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.SignatureTooLong.selector);
        factory.registerPoG(5e16, deadline, 0, _buildPoGSig(user1, 5e16, 0, deadline));
    }

    function test_registerPoG_rejectsWrongNonce_skipAhead() public {
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.NonceConflict.selector);
        factory.registerPoG(5e16, deadline, 1, _buildPoGSig(user1, 5e16, 1, deadline));
    }

    function test_registerPoG_keepsHigherQuotaOnReregister() public {
        _register(user1, 8e16);
        _register(user1, 3e16);
        assertEq(factory.pogQuota(user1), 8e16);
    }

    function test_registerPoG_raisesQuotaOnReregister() public {
        _register(user1, 3e16);
        _register(user1, 8e16);
        assertEq(factory.pogQuota(user1), 8e16);
    }

    function test_registerPoG_revertsAboveGlobalLimit() public {
        uint256 tooMuch = factory.maxPogAllocationLimit() + 1;
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.ExceedsGlobalPogLimit.selector);
        factory.registerPoG(tooMuch, deadline, 0, _buildPoGSig(user1, tooMuch, 0, deadline));
    }

    /// @dev Raised to the ceiling rather than past it. The old version set 300
    ///      ETH against a 1 M ETH ceiling and registered 200; `MAX_POG_ALLOCATION_LIMIT`
    ///      is 20,000 BEM now, so "comfortably above what we register" and "above
    ///      the ceiling" have collapsed into the same figure.
    function test_registerPoG_noSilentClamp() public {
        uint256 ceiling = factory.MAX_POG_ALLOCATION_LIMIT();
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(ceiling);
        _register(user1, ceiling);
        assertEq(factory.pogQuota(user1), ceiling);
    }

    function test_registerPoG_rejectsBlacklisted() public {
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(bl, 1 days);

        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user1);
        vm.expectRevert(ToshFactory.IsBlacklisted.selector);
        factory.registerPoG(5e16, deadline, 0, _buildPoGSig(user1, 5e16, 0, deadline));
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
        factory.setMaxPogAllocationLimit(20e16);
        assertEq(factory.maxPogAllocationLimit(), 20e16);
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

    /// @dev The slip at its real magnitude: the default ceiling scaled by 1e18
    ///      twice (an `ether` literal passed through a `* 1e18` helper).
    function test_setMaxPogAllocationLimit_rejectsOrderOfMagnitudeSlip() public {
        vm.prank(admin);
        vm.expectRevert(ToshFactory.PogLimitTooHigh.selector);
        factory.setMaxPogAllocationLimit(1.3e36);
    }

    /// @dev The ceiling still has to admit the values this suite actually uses,
    ///      which is what this pins — but the headroom it is pinning shrank by
    ///      four orders of magnitude when the protocol changed unit of account,
    ///      and that is worth stating rather than quietly rescaling.
    ///
    ///      Under native settlement the ceiling was 1 M ETH against a 10 ETH
    ///      default: a wei/ether slip catcher with a factor of 1e5 to spare, so
    ///      "the values this suite uses" were nowhere near it. `MAX_POG_ALLOCATION_LIMIT`
    ///      is now 20,000 BEM against a 46.4 BEM default — about 430x, not 1e5 —
    ///      because 20,000 BEM is already a tenth of BEM's ENTIRE SUPPLY, and a
    ///      ceiling above that would be describing allocations the asset cannot
    ///      support regardless of typing errors.
    ///
    ///      So the two values below are the suite's own (`POG_CAP`, 1000 BEM) and
    ///      the ceiling itself. The second is the interesting one: it asserts the
    ///      boundary is inclusive, which `ceiling + 1` above only implies.
    function test_setMaxPogAllocationLimit_admitsTheValuesThisSuiteUses() public {
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(1000e16);
        assertEq(factory.maxPogAllocationLimit(), 1000e16);

        uint256 ceiling = factory.MAX_POG_ALLOCATION_LIMIT();
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(ceiling);
        assertEq(factory.maxPogAllocationLimit(), ceiling, "the ceiling itself must be admissible");
    }

    // ── Per-launch caps ───────────────────────────────────────────────────────

    function test_createLaunch_bakesTheFormCapsIntoTheHook() public {
        (, address hook) = _createLaunchWith("Caps", "CAP", 500e16, 25e16);
        assertEq(_h(hook).hardCap(), 500e16, "hard cap comes from the form");
        assertEq(_h(hook).perWalletCap(), 25e16, "wallet cap comes from the form, not the PoG ceiling");
    }

    function test_createLaunch_admitsTheHardCapBounds() public {
        uint256 lo = factory.MIN_HARD_CAP();
        uint256 hi = factory.MAX_HARD_CAP();
        (, address a) = _createLaunchWith("Lo", "LO", lo, lo);
        (, address b) = _createLaunchWith("Hi", "HI", hi, 1e16);
        assertEq(_h(a).hardCap(), lo);
        assertEq(_h(b).hardCap(), hi);
    }

    /// @dev 1 BNB. The shelf ladder needs ~21.04e8 wei of raise, so the floor is
    ///      a product minimum now, not a precision one.
    function test_minHardCap_clearsTheLadderFloor() public view {
        assertEq(factory.MIN_HARD_CAP(), 1 ether);
    }

    function test_createLaunch_rejectsHardCapBelowFloor() public {
        uint256 lo = factory.MIN_HARD_CAP();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.HardCapTooLow.selector);
        factory.createLaunch("Lo", "LO", projTreasury, bytes32(0), lo - 1, 1e16, 24 hours);
    }

    function test_createLaunch_rejectsHardCapAboveCeiling() public {
        uint256 hi = factory.MAX_HARD_CAP();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.HardCapTooHigh.selector);
        factory.createLaunch("Hi", "HI", projTreasury, bytes32(0), hi + 1, 1e16, 24 hours);
    }

    /// @dev The slip the floor catches: a cap written at BEM's eight decimals.
    function test_createLaunch_rejectsHardCapOrderOfMagnitudeSlip() public {
        vm.prank(creator);
        vm.expectRevert(ToshFactory.HardCapTooLow.selector);
        factory.createLaunch("Slip", "SLP", projTreasury, bytes32(0), 500e8, 1e16, 24 hours);
    }

    // ── No hard cap ───────────────────────────────────────────────────────────

    function test_createLaunch_zeroHardCapIsStoredAsUncapped() public {
        (, address hook) = _createLaunchWith("Open", "OPN", 0, 25e16);
        assertEq(_h(hook).hardCap(), factory.UNCAPPED(), "0 means no cap");
        assertEq(factory.UNCAPPED(), type(uint128).max, "the widest value the clone arg holds");
        assertEq(_h(hook).perWalletCap(), 25e16, "the wallet cap still binds");
    }

    /// @dev The address a caller predicts from the form's 0 is the one deployed,
    ///      and the deployment verifies against the same 0.
    function test_createLaunch_uncappedAddressIsPredictableFromZero() public {
        (, address hook) = _createLaunchWith("Open", "OPN", 0, 25e16);
        bytes32 salt;
        for (uint256 i; i < 1000; ++i) {
            salt = bytes32(i);
            if (
                factory.predictHookAddress(
                        creator, salt, factory.hookInitcodeHash(projTreasury, creator, 0, 25e16, 24 hours)
                    ) == hook
            ) break;
        }
        assertTrue(factory.verifyHookDeployment(hook, creator, projTreasury, 0, 25e16, 24 hours, salt));
        assertTrue(factory.verifyHookDeployment(hook, creator, projTreasury, factory.UNCAPPED(), 25e16, 24 hours, salt));
    }

    function test_createLaunch_uncappedStillRejectsZeroWalletCap() public {
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InvalidWalletCap.selector);
        factory.createLaunch("W0", "W0", projTreasury, bytes32(0), 0, 0, 24 hours);
    }

    /// @dev With no hard cap to bound it, the wallet cap takes over the unit-slip
    ///      guard: at most `MAX_HARD_CAP`, inclusive.
    function test_createLaunch_uncappedHoldsTheWalletCapToTheCeiling() public {
        uint256 hi = factory.MAX_HARD_CAP();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InvalidWalletCap.selector);
        factory.createLaunch("W1", "W1", projTreasury, bytes32(0), 0, hi + 1, 24 hours);

        (, address hook) = _createLaunchWith("W2", "W2", 0, hi);
        assertEq(_h(hook).perWalletCap(), hi);
    }

    /// @dev An uncapped round takes deposits past the capped ceiling — the whole
    ///      point — and is still bounded per wallet.
    function test_uncappedRound_acceptsDepositsPastTheCappedCeiling() public {
        uint256 ceiling = factory.MAX_POG_ALLOCATION_LIMIT();
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(ceiling);
        (, address hook) = _createLaunchWith("Open", "OPN", 0, 20_000e16);

        address[2] memory who = [user1, user2];
        for (uint256 i; i < who.length; ++i) {
            quote.mint(who[i], 20_000e16);
            _register(who[i], 20_000e16);
            vm.prank(who[i]);
            factory.deposit(hook, address(0), 20_000e16);
        }
        assertEq(_h(hook).totalNativeDeposited(), 40_000e16, "twice what any capped round may raise");

        address user3 = makeAddr("user3");
        _endow(user3);
        _register(user3, 20_000e16);
        vm.prank(user3);
        vm.expectRevert();
        factory.deposit(hook, address(0), 20_000e16 + 1);
    }

    function test_createLaunch_rejectsZeroWalletCap() public {
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InvalidWalletCap.selector);
        factory.createLaunch("W0", "W0", projTreasury, bytes32(0), 500e16, 0, 24 hours);
    }

    function test_createLaunch_rejectsWalletCapAboveHardCap() public {
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InvalidWalletCap.selector);
        factory.createLaunch("W1", "W1", projTreasury, bytes32(0), 500e16, 500e16 + 1, 24 hours);
    }

    /// @dev Moving the PoG ceiling after a launch does not reach into it: the
    ///      wallet cap is frozen in the clone's immutable args.
    function test_setMaxPogAllocationLimit_doesNotAffectExistingHooks() public {
        (, address hook) = _createLaunchWith("Old", "OLD", 500e16, 25e16);
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(5e16);
        assertEq(_h(hook).perWalletCap(), 25e16);
        assertEq(_h(hook).hardCap(), 500e16);
    }

    function test_deposit_revertsPastTheHardCap() public {
        (, address hook) = _createLaunchWith("Full", "FUL", 100e16, 100e16);
        _register(user1, 100e16);
        vm.prank(user1);
        factory.deposit(hook, address(0), 100e16);
        assertEq(_h(hook).totalNativeDeposited(), 100e16, "filling to the cap exactly is allowed");

        _register(user2, 100e16);
        vm.prank(user2);
        vm.expectRevert(ToshLaunchpadHook.HardCapExceeded.selector);
        factory.deposit(hook, address(0), 1);
    }

    /// @dev The cap binds the round's TOTAL, across wallets that are each
    ///      individually under their own limit.
    function test_deposit_hardCapIsCumulativeAcrossWallets() public {
        vm.prank(admin);
        factory.setCooldownDuration(0);
        (, address hook) = _createLaunchWith("Sum", "SUM", 100e16, 70e16);
        _register(user1, 100e16);
        _register(user2, 100e16);

        vm.prank(user1);
        factory.deposit(hook, address(0), 70e16);
        vm.prank(user2);
        factory.deposit(hook, address(0), 30e16);

        vm.prank(user2);
        vm.expectRevert(ToshLaunchpadHook.HardCapExceeded.selector);
        factory.deposit(hook, address(0), 1);
        assertEq(_h(hook).nativeDeposited(user2), 30e16, "user2 is still under its own wallet cap");
    }

    function test_deposit_walletCapFromTheFormBinds() public {
        vm.prank(admin);
        factory.setCooldownDuration(0);
        (, address hook) = _createLaunchWith("Wal", "WAL", 500e16, 25e16);
        _register(user1, 100e16);
        vm.prank(user1);
        factory.deposit(hook, address(0), 25e16);
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.PerWalletCapExceeded.selector);
        factory.deposit(hook, address(0), 1);
    }
    // ── Pause ─────────────────────────────────────────────────────────────────

    function test_pause_blocksRegisterPoG() public {
        vm.prank(admin);
        factory.pause();
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.registerPoG(5e16, deadline, 0, _buildPoGSig(user1, 5e16, 0, deadline));
    }

    function test_pause_blocksCreateLaunch() public {
        bytes32 salt = _pickSalt();
        vm.prank(admin);
        factory.pause();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createLaunch("P", "P", projTreasury, salt, HARD_CAP, agreedWalletCap, 24 hours);
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
        _register(user1, 5e16);

        vm.prank(admin);
        factory.pause();

        vm.prank(user1);
        factory.deposit(hook, address(0), 1e16);

        assertEq(_h(hook).nativeDeposited(user1), 1e16, "a live raise keeps taking deposits while paused");
    }

    /// @dev The other half of the same rule: no NEW exposure while paused.
    function test_pause_stillBlocksNewLaunchesAndNewQuota() public {
        _register(user1, 5e16); // registered before the pause

        bytes32 salt = _pickSalt();

        vm.prank(admin);
        factory.pause();

        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createLaunch("New", "NEW", projTreasury, salt, HARD_CAP, agreedWalletCap, 24 hours);

        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(user2);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.registerPoG(5e16, deadline, 0, _buildPoGSig(user2, 5e16, 0, deadline));
    }

    function test_unpause_restoresAllPaths() public {
        vm.startPrank(admin);
        factory.pause();
        factory.unpause();
        vm.stopPrank();
        _register(user1, 5e16);
        (, address hook) = _createLaunch("Up", "UP");
        vm.prank(user1);
        factory.deposit(hook, address(0), 1e16);
        assertEq(_h(hook).nativeDeposited(user1), 1e16);
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
        (, address hook) = _createLaunch("Rfnd", "RFD");
        _register(user1, 5e16);
        vm.prank(user1);
        factory.deposit(hook, address(0), 5e16);

        vm.prank(admin);
        factory.pause();
        vm.warp(_h(hook).genesisDeadline() + _h(hook).LAUNCH_WINDOW() + 1);

        uint256 before = quote.balanceOf(user1);
        vm.prank(user1);
        _h(hook).refund();
        assertEq(quote.balanceOf(user1) - before, 5e16, "a refund pays back in the quote asset");
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
                hook, creator, projTreasury, HARD_CAP, factory.maxPogAllocationLimit(), 24 hours, _lastSalt
            ),
            "the deployed hook is at the address its salt predicted"
        );
        assertEq(ToshToken(token).hook(), hook);
        assertEq(address(_h(hook).projectToken()), token);
        assertEq(_h(hook).perWalletCap(), factory.maxPogAllocationLimit());
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
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (, address hook) =
            factory.createLaunch("Any", "ANY", projTreasury, bytes32(0), HARD_CAP, agreedWalletCap, 24 hours);
        assertTrue(hook != address(0), "a launch on a salt V4 would have refused");
    }

    function test_createLaunch_revertsForNonOwner() public {
        bytes32 salt = _pickSalt();
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user1));
        factory.createLaunch("Tok", "TOK", projTreasury, salt, HARD_CAP, 1e16, 24 hours);
    }

    /// @dev Checked before anything is deployed, so the Circuit is never minted
    ///      to address(0).
    function test_createLaunch_revertsForZeroDeveloper() public {
        bytes32 salt = _pickSalt();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InvalidDeveloper.selector);
        factory.createLaunch("Tok", "TOK", address(0), salt, HARD_CAP, 1e16, 24 hours);
    }

    function test_createLaunch_rejectsEmptyName() public {
        bytes32 salt = _pickSalt();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.EmptyName.selector);
        factory.createLaunch("", "TOK", projTreasury, salt, HARD_CAP, agreedWalletCap, 24 hours);
    }

    function test_createLaunch_rejectsEmptySymbol() public {
        bytes32 salt = _pickSalt();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.EmptyName.selector);
        factory.createLaunch("Tok", "", projTreasury, salt, HARD_CAP, agreedWalletCap, 24 hours);
    }

    function test_createLaunch_rejectsDuplicateNamePair() public {
        _createLaunch("Same", "SAM");
        bytes32 salt = _pickSalt();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.NameTaken.selector);
        factory.createLaunch("Same", "SAM", projTreasury, salt, HARD_CAP, agreedWalletCap, 24 hours);
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
        (, address hook) = _createLaunch("Undr", "UND");
        _register(user1, 5e16);

        vm.prank(user1);
        factory.deposit(hook, address(0), 5e16);

        vm.warp(_h(hook).genesisDeadline() + _h(hook).LAUNCH_WINDOW() + 1);
        assertTrue(_h(hook).canRefund(), "an unlaunched round must be refundable after the launch window");

        // The round is dead, but the name is not.
        factory.releaseAbandonedName(hook);
        assertFalse(factory.nameTaken(keccak256(abi.encode("Undr", "UND"))), "ticker must be reclaimable");
    }

    /// @dev The address a launch lands at is the one its form predicted.
    function test_createLaunch_landsWhereTheAgreedDialsPredicted() public {
        bytes32 salt = _pickSalt();
        uint256 agreedCap = HARD_CAP;
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();

        address predicted = factory.predictHookAddress(
            creator, salt, factory.hookInitcodeHash(projTreasury, creator, agreedCap, agreedWalletCap, 24 hours)
        );

        vm.prank(creator);
        (, address hook) = factory.createLaunch("Pred", "PRD", projTreasury, salt, HARD_CAP, agreedWalletCap, 24 hours);

        assertEq(hook, predicted, "the launch landed where the agreed dials predicted");
        assertEq(_h(hook).hardCap(), agreedCap, "and froze the cap that was agreed to");
    }

    function test_createLaunch_chargesNothing() public {
        uint256 platformBefore = treasury.balance;
        uint256 ladderBefore = quote.balanceOf(ladder);
        uint256 creatorQuoteBefore = quote.balanceOf(creator);
        _createLaunch("Fee", "FEE");
        assertEq(treasury.balance, platformBefore, "no native fee");
        assertEq(quote.balanceOf(ladder), ladderBefore, "the reservoir is not credited");
        assertEq(quote.balanceOf(creator), creatorQuoteBefore, "and nothing is pulled from the launcher");
        assertEq(address(factory).balance, 0);
    }

    // ── Circuit issuance ──────────────────────────────────────────────────────

    function test_createLaunch_recordsTheOwnerAsCreator() public {
        (, address hook) = _createLaunch("Own", "OWN");
        assertEq(_h(hook).creator(), admin);
        assertEq(_h(hook).projectTreasury(), projTreasury, "the developer is recorded for display");
    }

    function test_createLaunch_mintsTheCircuitToTheDeveloper() public {
        (, address hook) = _createLaunch("Circ", "CIR");
        CircuitNFT circuit = CircuitNFT(factory.circuitNFT());
        uint256 tokenId = factory.circuitOf(hook);

        assertEq(tokenId, 1, "ids start at 1");
        assertEq(circuit.ownerOf(tokenId), projTreasury);
        assertEq(circuit.totalMinted(), 1);
        assertEq(factory.hookOfCircuit(tokenId), hook);
    }

    function test_createLaunch_pointsProjectAdminAtTheVault() public {
        (, address hook) = _createLaunch("Vlt", "VLT");
        uint256 tokenId = factory.circuitOf(hook);
        address vault = _h(hook).projectAdmin();

        assertEq(vault, factory.predictVaultAddress(tokenId), "vault is at its predicted address");
        assertGt(vault.code.length, 0);
        assertEq(CircuitRevenueVault(vault).tokenId(), tokenId);
        assertEq(CircuitRevenueVault(vault).holder(), projTreasury);
        assertTrue(vault != projTreasury, "revenue does not go to the developer directly");
    }

    function test_createLaunch_issuesDistinctCircuitsPerLaunch() public {
        (, address a) = _createLaunch("One", "ONE");
        (, address b) = _createLaunch("Two", "TWO");
        assertEq(factory.circuitOf(a), 1);
        assertEq(factory.circuitOf(b), 2);
        assertTrue(_h(a).projectAdmin() != _h(b).projectAdmin());
    }

    function test_createLaunch_emitsCircuitIssued() public {
        bytes32 salt = _pickSalt();
        uint256 walletCap = factory.maxPogAllocationLimit();
        address predictedHook = factory.predictHookAddress(
            creator, salt, factory.hookInitcodeHash(projTreasury, creator, HARD_CAP, walletCap, 24 hours)
        );
        address predictedVault = factory.predictVaultAddress(1);

        vm.expectEmit(true, true, true, true, address(factory));
        emit ToshFactory.CircuitIssued(1, predictedHook, projTreasury, predictedVault);
        vm.prank(creator);
        factory.createLaunch("Evt", "EVT", projTreasury, salt, HARD_CAP, walletCap, 24 hours);
    }

    function test_circuitNFT_isWiredToThisFactory() public view {
        CircuitNFT circuit = CircuitNFT(factory.circuitNFT());
        assertEq(circuit.factory(), address(factory));
        assertEq(address(CircuitRevenueVault(factory.vaultImplementation()).circuit()), address(circuit));
    }

    function test_launch_isOwnerOnly() public {
        (, address hook) = _createLaunch("Gate", "GTE");
        _register(user1, 100e16);
        vm.prank(user1);
        factory.deposit(hook, address(0), 100e16);
        vm.warp(_h(hook).genesisDeadline() + 1);

        vm.prank(projTreasury);
        vm.expectRevert();
        _h(hook).launch();
    }
    // ── Deposits ──────────────────────────────────────────────────────────────

    function test_deposit_succeedsWhenEligible() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 5e16);
        vm.prank(user1);
        factory.deposit(hook, address(0), 5e16);
        assertEq(_h(hook).nativeDeposited(user1), 5e16);
        assertEq(_h(hook).totalNativeDeposited(), 5e16);
        assertGt(factory.userLaunchCooldownEnd(user1, hook), block.timestamp);
    }

    function test_deposit_blockedWhenBlacklisted() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 5e16);
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(bl, 1 days);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.IsBlacklisted.selector);
        factory.deposit(hook, address(0), 1e16);
    }

    function test_deposit_blockedWithoutPoG() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        vm.prank(user1);
        vm.expectRevert(ToshFactory.NoPogQuota.selector);
        factory.deposit(hook, address(0), 1e16);
    }

    function test_deposit_blockedDuringCooldown() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 8e16);
        vm.prank(user1);
        factory.deposit(hook, address(0), 1e16);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.CooldownActive.selector);
        factory.deposit(hook, address(0), 1e16);
    }

    function test_deposit_blockedWhenQuotaExceeded() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 2e16);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.QuotaExceeded.selector);
        factory.deposit(hook, address(0), 3e16);
    }

    function test_deposit_quotaIsGlobalAcrossHooks() public {
        (, address a) = _createLaunch("A", "AAA");
        (, address b) = _createLaunch("B", "BBB");
        _register(user1, 5e16);
        vm.prank(user1);
        factory.deposit(a, address(0), 4e16);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.QuotaExceeded.selector);
        factory.deposit(b, address(0), 2e16);
    }

    function test_deposit_cooldownLiftsAfterDuration() public {
        // Default cooldown is 24h, which collides with the 24h genesis window.
        vm.prank(admin);
        factory.setCooldownDuration(1 hours);

        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 8e16);
        vm.prank(user1);
        factory.deposit(hook, address(0), 1e16);
        vm.warp(factory.userLaunchCooldownEnd(user1, hook) + 1);
        vm.prank(user1);
        factory.deposit(hook, address(0), 1e16);
        assertEq(_h(hook).nativeDeposited(user1), 2e16);
    }

    function test_deposit_rejectsZeroAmount() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 5e16);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.ZeroAmount.selector);
        factory.deposit(hook, address(0), 0);
    }

    function test_deposit_rejectsUnregisteredHook() public {
        _register(user1, 5e16);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.HookNotRegistered.selector);
        factory.deposit(makeAddr("nope"), address(0), 1e16);
    }

    // ── depositNative ─────────────────────────────────────────────────────────

    /// @dev Native BNB in, WBNB on the hook, credited exactly like `deposit`,
    ///      and nothing parked on the factory on the way through.
    function test_depositNative_wrapsAndCreditsLikeDeposit() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 5e16);
        vm.deal(user1, 3e16);
        uint256 quoteBefore = quote.balanceOf(user1);

        vm.prank(user1);
        factory.depositNative{value: 3e16}(hook, user2);

        assertEq(user1.balance, 0, "native BNB was spent");
        assertEq(quote.balanceOf(user1), quoteBefore, "the depositor's WBNB is untouched");
        assertEq(quote.balanceOf(hook), 3e16, "the hook custodies WBNB");
        assertEq(_h(hook).nativeDeposited(user1), 3e16);
        assertEq(factory.totalGenesisDeposited(user1), 3e16);
        assertEq(factory.globalReferrers(user1), user2, "the referral binds as it does for deposit");
        assertEq(quote.balanceOf(address(factory)), 0, "no WBNB left on the factory");
        assertEq(address(factory).balance, 0, "no BNB left on the factory");
    }

    function test_depositNative_rejectsZeroValue() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 5e16);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.ZeroAmount.selector);
        factory.depositNative{value: 0}(hook, address(0));
    }

    function test_depositNative_enforcesQuota() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 2e16);
        vm.deal(user1, 3e16);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.QuotaExceeded.selector);
        factory.depositNative{value: 3e16}(hook, address(0));
    }

    function test_depositNative_requiresPoG() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        vm.deal(user1, 1e16);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.NoPogQuota.selector);
        factory.depositNative{value: 1e16}(hook, address(0));
    }

    /// @dev One quota window covers both entry points.
    function test_depositNative_sharesTheQuotaWindowWithDeposit() public {
        vm.prank(admin);
        factory.setCooldownDuration(0);
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 5e16);
        vm.prank(user1);
        factory.deposit(hook, address(0), 4e16);
        vm.deal(user1, 2e16);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.QuotaExceeded.selector);
        factory.depositNative{value: 2e16}(hook, address(0));
    }

    function test_blacklist_blocksEvenAfterPreRegisteredQuota() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 5e16);
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(bl, 1 days);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.IsBlacklisted.selector);
        factory.deposit(hook, address(0), 1e16);
    }

    function test_blacklist_expiresAfterBanDuration() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 5e16);
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(bl, 1 hours);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(user1);
        factory.deposit(hook, address(0), 1e16);
        assertEq(_h(hook).nativeDeposited(user1), 1e16);
    }

    function test_liftBlacklist_immediatelyRestores() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 5e16);
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.startPrank(admin);
        factory.setBlacklist(bl, 7 days);
        factory.liftBlacklist(bl);
        vm.stopPrank();
        vm.prank(user1);
        factory.deposit(hook, address(0), 1e16);
        assertEq(_h(hook).nativeDeposited(user1), 1e16);
    }

    function test_blacklist_blocksAttackerAcrossAllHooks() public {
        (, address a) = _createLaunch("A", "AAA");
        (, address b) = _createLaunch("B", "BBB");
        _register(user1, 100e16);
        address[] memory bl = new address[](1);
        bl[0] = user1;
        vm.prank(admin);
        factory.setBlacklist(bl, 1 days);
        vm.startPrank(user1);
        vm.expectRevert(ToshFactory.IsBlacklisted.selector);
        factory.deposit(a, address(0), 1e16);
        vm.expectRevert(ToshFactory.IsBlacklisted.selector);
        factory.deposit(b, address(0), 1e16);
        vm.stopPrank();
    }

    // ── Eligibility / views ───────────────────────────────────────────────────

    function test_eligibility_returnsFalseForBlacklistedUser() public {
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 5e16);
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
        _register(user1, 5e16);
        vm.prank(user1);
        factory.deposit(hook, address(0), 1e16);
        (bool ok,, uint256 cd) = factory.eligibility(user1, hook);
        assertFalse(ok);
        assertGt(cd, 0);
    }

    function test_eligibility_returnsTrueOnUnregisteredHookWithQuota() public {
        _register(user1, 5e16);
        (bool ok, uint256 remaining,) = factory.eligibility(user1, makeAddr("randomHook"));
        assertTrue(ok);
        assertEq(remaining, 5e16);
    }

    function test_eligibility_returnsFalseWhenQuotaExhaustedSameHook() public {
        vm.prank(admin);
        factory.setCooldownDuration(0);
        (, address hook) = _createLaunch("Tok", "TOK");
        _register(user1, 2e16);
        vm.prank(user1);
        factory.deposit(hook, address(0), 2e16);
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
        bytes32 initHash =
            factory.hookInitcodeHash(projTreasury, creator, HARD_CAP, factory.maxPogAllocationLimit(), 24 hours);
        address predicted = factory.predictHookAddress(creator, salt, initHash);
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (, address hook) = factory.createLaunch("A", "A", projTreasury, salt, HARD_CAP, agreedWalletCap, 24 hours);
        assertEq(predicted, hook);
    }

    function test_verifyHookDeployment_true() public {
        bytes32 salt = _pickSalt();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (, address hook) = factory.createLaunch("A", "A", projTreasury, salt, HARD_CAP, agreedWalletCap, 24 hours);
        assertTrue(
            factory.verifyHookDeployment(
                hook, creator, projTreasury, HARD_CAP, factory.maxPogAllocationLimit(), 24 hours, salt
            )
        );
    }

    function test_verifyHookDeployment_falseForUnregisteredHook() public {
        assertFalse(
            factory.verifyHookDeployment(
                makeAddr("randomHook"),
                creator,
                projTreasury,
                HARD_CAP,
                factory.maxPogAllocationLimit(),
                24 hours,
                bytes32(0)
            )
        );
    }

    function test_verifyHookDeployment_falseForMismatchedSalt() public {
        bytes32 salt = _pickSalt();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (, address hook) = factory.createLaunch("A", "A", projTreasury, salt, HARD_CAP, agreedWalletCap, 24 hours);
        assertFalse(
            factory.verifyHookDeployment(
                hook,
                creator,
                projTreasury,
                HARD_CAP,
                factory.maxPogAllocationLimit(),
                24 hours,
                bytes32(uint256(salt) + 1)
            )
        );
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
    ///        76 B  immutable args: creator, projectTreasury, hardCap:uint128,
    ///              perWalletCap:uint128, genesisDuration:uint32
    ///
    ///      Note what is NOT here: `poolManager`, `factory` and `ladderTreasury`
    ///      are identical for every launch, so they are ordinary immutables on the
    ///      shared implementation and cost no per-project byte. `projectAdmin` is
    ///      not here either — it is the Circuit revenue vault, whose address
    ///      depends on the Circuit id, and is written once by `initializeToken`.
    function test_hookInitcodeHash_matchesHandBuiltCloneInitcode() public view {
        uint256 hardCap = HARD_CAP;
        uint256 walletCap = factory.maxPogAllocationLimit();

        bytes32 fromFactory = factory.hookInitcodeHash(projTreasury, creator, hardCap, walletCap, 24 hours);

        bytes memory initcode = abi.encodePacked(
            hex"3d607980600a3d3981f3",
            hex"363d3d373d3d3d363d73",
            factory.hookImplementation(),
            hex"5af43d82803e903d91602b57fd5bf3",
            creator,
            projTreasury,
            uint128(hardCap),
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
        bytes32 fast =
            factory.hookInitcodeHash(projTreasury, creator, HARD_CAP, factory.maxPogAllocationLimit(), 3 hours);
        bytes32 standard =
            factory.hookInitcodeHash(projTreasury, creator, HARD_CAP, factory.maxPogAllocationLimit(), 24 hours);
        bytes32 slow =
            factory.hookInitcodeHash(projTreasury, creator, HARD_CAP, factory.maxPogAllocationLimit(), 72 hours);

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
        uint256 soft = HARD_CAP;
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

        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshLaunchpadHook.InvalidDuration.selector);
        factory.createLaunch("Odd", "ODD", projTreasury, salt, HARD_CAP, agreedWalletCap, 12 hours);
    }

    /// @dev The raise is deliberately well over the ladder floor. This test is
    ///      about the 3-hour genesis shifting the whole schedule, and a raise
    ///      too small to launch now opens refunds at genesis close — which
    ///      would short-circuit the very window under test here. The small-raise
    ///      path has its own tests in ToshV5Guards.
    function test_fastWindow_refundOpensAfterThreeHours() public {
        (, address hook) = _createLaunch("Quick", "QCK", 3 hours);
        _register(user1, 100e16);
        vm.prank(user1);
        factory.deposit(hook, address(0), 100e16);
        assertTrue(_h(hook).ladderViable(), "the window, not the floor, is what this test exercises");

        // Still inside the window: the genesis is live, so no refund yet.
        vm.warp(block.timestamp + 3 hours - 1);
        assertFalse(_h(hook).canRefund(), "no refund while the window is open");

        // Past genesis, still inside the 7-day launch window: no refund yet,
        // because this raise COULD open a pool and the creator still may.
        vm.warp(block.timestamp + 2);
        assertFalse(_h(hook).canRefund(), "refund stays closed until the launch window lapses");

        vm.warp(_h(hook).genesisDeadline() + _h(hook).LAUNCH_WINDOW() + 1);
        assertTrue(_h(hook).canRefund(), "refund opens once the 7-day launch window lapses");
    }

    /// @dev The coupling that makes `cooldownDuration` a one-deposit rule rather
    ///      than a throttle, pinned because nothing structural holds it.
    ///
    ///      `cooldownDuration` is a dial on the factory and `DURATION_SLOW` is a
    ///      constant on the hook. The one-deposit property holds only while the
    ///      first is at least the second, and at 72 h against 72 h there is no
    ///      margin at all — a fourth, longer genesis rung, or a lowered dial,
    ///      restores instalment deposits and nothing would revert to say so.
    ///
    ///      Same shape as `test_factory_liveInitcodeHash_tracksStandardDuration`
    ///      above: two constants that must move together, in files that do not
    ///      reference each other.
    function test_cooldown_isAtLeastTheLongestGenesis() public {
        (, address hook) = _createLaunch("Pin2", "PN2");

        assertGe(
            factory.cooldownDuration(),
            _h(hook).DURATION_SLOW(),
            "cooldown below the longest genesis: a wallet can deposit into one project twice"
        );
    }

    /// @notice On the longest genesis, a wallet gets exactly one deposit per
    ///         project — the refilled PoG quota buys it nothing.
    ///
    /// @dev    The behavioural half of the test above, and it exercises the worst
    ///         case rather than a comfortable one. Nothing warps between
    ///         `_createLaunch` and the deposit, so the first deposit lands in the
    ///         creation block: `cooldownEnd == t1 + 72h == genesisDeadline`
    ///         EXACTLY. If the property survives here it survives everywhere,
    ///         because any later first deposit pushes the cooldown further past
    ///         the deadline.
    ///
    ///         The two gates hand off with zero overlap, which is what the two
    ///         assertions below are: one second before the deadline the cooldown
    ///         is what rejects, and at the deadline itself the cooldown has just
    ///         lapsed and the genesis window is what rejects. There is no instant
    ///         at which both allow.
    ///
    ///         `CooldownActive` is checked before the quota in
    ///         `ToshFactory.deposit`, so the first assertion is not accidentally
    ///         passing on `QuotaExceeded`: 72 h is three quota windows, the spend
    ///         has been rolled back to zero, and there is room for this amount.
    function test_deposit_slowGenesisAllowsExactlyOnePerWallet() public {
        (, address hook) = _createLaunch("Once", "ONCE", 72 hours);
        _register(user1, 40e16);

        vm.prank(user1);
        factory.deposit(hook, address(0), 5e16);

        uint256 deadline = _h(hook).genesisDeadline();

        // One second before the window shuts: quota has refilled twice over, and
        // the cooldown is the thing standing in the way.
        vm.warp(deadline - 1);
        vm.prank(user1);
        vm.expectRevert(ToshFactory.CooldownActive.selector);
        factory.deposit(hook, address(0), 5e16);

        // At the deadline the cooldown has lapsed to the instant — and the
        // genesis has shut on the same instant.
        vm.warp(deadline);
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.GenesisExpired.selector);
        factory.deposit(hook, address(0), 5e16);

        assertEq(_h(hook).nativeDeposited(user1), 5e16, "the wallet is held to its single deposit");
    }
}
