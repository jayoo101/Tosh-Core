// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {
    ICLHooks,
    HOOKS_BEFORE_INITIALIZE_OFFSET,
    HOOKS_BEFORE_ADD_LIQUIDITY_OFFSET,
    HOOKS_BEFORE_REMOVE_LIQUIDITY_OFFSET,
    HOOKS_BEFORE_SWAP_OFFSET,
    HOOKS_AFTER_SWAP_OFFSET,
    HOOKS_BEFORE_SWAP_RETURNS_DELTA_OFFSET,
    HOOKS_AFTER_SWAP_RETURNS_DELTA_OFFSET
} from "infinity-core/src/pool-cl/interfaces/ICLHooks.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookAddress} from "../src/libraries/HookAddress.sol";
import {ToshCloneLib} from "../src/libraries/ToshCloneLib.sol";

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

    /// @dev A second mock, because Infinity split what V4 did in one contract.
    ///      The manager still drives the hook callbacks this file pranks; the
    ///      Vault holds the balances and is what `lockAcquired` now checks
    ///      against, where V4's `unlockCallback` checked the manager.
    address internal mockVault = makeAddr("vault");

    uint256 internal pogSignerPk = 0xC0FFEE;
    address internal pogSigner;

    ToshFactory internal factory;
    ToshLaunchpadHook internal hook;
    ToshToken internal token;

    /// @dev A hook implementation whose `factory` immutable is this test contract,
    ///      so the tests below can drive `initializeToken` directly.  Projects are
    ///      clones, which run no constructor, so every check that used to happen
    ///      at construction now happens in the initialiser — and that is where
    ///      these tests exercise it.
    ToshLaunchpadHook internal implAsSelf;

    /// @dev Bumped per clone so CREATE2 never collides.
    uint256 internal cloneNonce;

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);

        vm.startPrank(admin);
        factory = new ToshFactory(mockPoolManager, mockVault, pogSigner, treasury, ladder);
        factory.setMaxPogAllocationLimit(1000 ether);
        vm.stopPrank();

        vm.deal(creator, 100 ether);
        vm.deal(user1, 100 ether);
        vm.deal(admin, 100 ether);

        (address t, address h) = _createLaunch("Guard", "GRD");
        token = ToshToken(t);
        hook = ToshLaunchpadHook(payable(h));

        implAsSelf = new ToshLaunchpadHook(mockPoolManager, mockVault, address(this), ladder, treasury);
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
        bytes32 initHash = factory.hookInitcodeHash(
            projTreasury, creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        for (uint256 i; i < 1000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(creator, rawSalt));
            address predicted = HookAddress.computeAddress(address(factory), finalSalt, initHash);
            if (predicted.code.length == 0) return rawSalt;
        }
        revert("_pickSalt: first 1000 salts are all occupied");
    }

    function _createLaunch(string memory n, string memory s) internal returns (address t, address h) {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (t, h) = factory.createLaunch{value: fee}(
            n, s, projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
    }

    function _emptyKey() internal view returns (PoolKey memory) {
        return hook.getPoolKey();
    }

    function _liqParams() internal pure returns (ICLPoolManager.ModifyLiquidityParams memory) {
        return ICLPoolManager.ModifyLiquidityParams({tickLower: 0, tickUpper: 0, liquidityDelta: 0, salt: bytes32(0)});
    }

    function _swapParams() internal pure returns (ICLPoolManager.SwapParams memory) {
        return ICLPoolManager.SwapParams({zeroForOne: true, amountSpecified: 0, sqrtPriceLimitX96: 0});
    }

    /// @dev A project hook, uninitialised: a clone of `implAsSelf` carrying the
    ///      given immutable args.  `implAsSelf.factory()` is this test contract,
    ///      so the caller can then drive `initializeToken` itself.
    function _freshClone(uint256 softCap_, uint256 walletCap_, uint256 duration_) internal returns (ToshLaunchpadHook) {
        return ToshLaunchpadHook(
            payable(ToshCloneLib.deployHook(
                    bytes32(++cloneNonce), address(implAsSelf), creator, projTreasury, softCap_, walletCap_, duration_
                ))
        );
    }

    function _freshHook() internal returns (ToshLaunchpadHook) {
        return _freshClone(1 ether, 1 ether, 24 hours);
    }

    // ── Hook constructor ──────────────────────────────────────────────────────
    //
    // The constructor now runs ONCE PER PLATFORM rather than once per project,
    // so the only arguments left are the platform-global ones.  Everything
    // per-project became a clone immutable arg, and every check that guarded
    // those arguments moved with them into `initializeToken` — see that block
    // below.

    function test_hook_ctor_revertsOnZeroPoolManager() public {
        vm.expectRevert(bytes("zero poolManager"));
        new ToshLaunchpadHook(address(0), mockVault, address(factory), ladder, treasury);
    }

    function test_hook_ctor_revertsOnZeroFactory() public {
        vm.expectRevert(bytes("zero factory"));
        new ToshLaunchpadHook(mockPoolManager, mockVault, address(0), ladder, treasury);
    }

    function test_hook_ctor_revertsOnZeroLadderTreasury() public {
        vm.expectRevert(bytes("zero ladderTreasury"));
        new ToshLaunchpadHook(mockPoolManager, mockVault, address(factory), payable(address(0)), treasury);
    }

    /// @dev `platformFeeRecipient` is on a money path — it takes
    ///      `PLATFORM_SWAP_FEE_BPS` of every buy's ETH input via a raw
    ///      `poolManager.take`.  Zero would burn that cut to an address nobody
    ///      controls on every single swap, so it is rejected at construction
    ///      exactly like `ladderTreasury`.
    function test_hook_ctor_revertsOnZeroPlatformFeeRecipient() public {
        vm.expectRevert(bytes("zero platformFeeRecipient"));
        new ToshLaunchpadHook(mockPoolManager, mockVault, address(factory), ladder, address(0));
    }

    function test_hook_windowConstantsAreThreeTwentyFourSeventyTwo() public view {
        assertEq(hook.DURATION_FAST(), 3 hours);
        assertEq(hook.DURATION_STANDARD(), 24 hours);
        assertEq(hook.DURATION_SLOW(), 72 hours);
    }

    /// @dev The platform-global values are ordinary immutables on the shared
    ///      implementation; the per-project ones are read out of the clone's own
    ///      bytecode.  Asserting both halves on one live hook is the premise of
    ///      the whole design: under DELEGATECALL the implementation's immutables
    ///      and the clone's args resolve together.
    function test_hook_configIsWired() public view {
        // Baked into the implementation's code, shared by every project.
        assertEq(address(hook.poolManager()), mockPoolManager);
        assertEq(hook.factory(), address(factory));
        assertEq(hook.ladderTreasury(), ladder);
        assertEq(hook.platformFeeRecipient(), payable(treasury));

        // Baked into this clone's code.
        assertEq(hook.projectTreasury(), projTreasury);
        assertEq(hook.creator(), creator);
        assertEq(hook.softCap(), factory.defaultSoftCap());
        assertEq(hook.perWalletCap(), factory.maxPogAllocationLimit());
        assertEq(hook.genesisDuration(), 24 hours);

        // Storage, written by `initializeToken`.
        assertEq(hook.projectAdmin(), projTreasury);
        assertEq(hook.genesisDeadline(), block.timestamp + 24 hours);

        assertEq(hook.POOL_FEE(), 3000);
        assertEq(hook.TAX_BPS(), 100);
        assertEq(hook.PLATFORM_SWAP_FEE_BPS(), 30);
    }

    /// @dev Every clone hard-codes the implementation it delegates to, inside its
    ///      own runtime bytecode.  No admin slot, no setter on the clone, and
    ///      `hookImplementation` is immutable on the factory — which is what
    ///      "these proxies are not upgradeable" means concretely.
    function test_hook_cloneIsPinnedToTheImplementation() public view {
        bytes memory code = address(hook).code;
        assertEq(code.length, ToshCloneLib.RUNTIME_LEN, "a clone, not a full copy");

        address embedded;
        for (uint256 i; i < 20; ++i) {
            embedded = address(uint160((uint256(uint160(embedded)) << 8) | uint8(code[10 + i])));
        }
        assertEq(embedded, factory.hookImplementation(), "delegates to the factory's implementation");
    }

    /// @notice The permission set is declared, not encoded in the address.
    ///
    /// @dev    ⚠ REPLACES `test_hookMiner_requiredFlagsAre0x20CC`, which
    ///         asserted `uint160(address(hook)) & 0x20CC == 0x20CC`.
    ///
    ///         That test could not be ported, only replaced. Uniswap V4 read a
    ///         hook's permissions out of its address, so the mask WAS the
    ///         permission set and pinning it was pinning behaviour. PancakeSwap
    ///         Infinity asks the contract, and `CLPoolManager.initialize`
    ///         refuses a pool whose `PoolKey.parameters` disagrees with the
    ///         answer. Keeping the old assertion would have pinned 0x20CC
    ///         against an address that no longer carries it, for a reader that
    ///         no longer exists.
    ///
    ///         What is worth pinning is the same fact in its new location: that
    ///         the hook still claims exactly the six callbacks it implements.
    ///         Six, not five — `BEFORE_ADD_LIQUIDITY` is registered here and was
    ///         absent from the V4 mask, because Infinity requires a hook to
    ///         declare a callback it means to gate.
    function test_hooksRegistrationBitmapNamesExactlyTheImplementedCallbacks() public view {
        uint16 bitmap = hook.getHooksRegistrationBitmap();

        assertTrue(bitmap & (1 << HOOKS_BEFORE_INITIALIZE_OFFSET) != 0, "beforeInitialize");
        assertTrue(bitmap & (1 << HOOKS_BEFORE_ADD_LIQUIDITY_OFFSET) != 0, "beforeAddLiquidity");
        assertTrue(bitmap & (1 << HOOKS_BEFORE_SWAP_OFFSET) != 0, "beforeSwap");
        assertTrue(bitmap & (1 << HOOKS_AFTER_SWAP_OFFSET) != 0, "afterSwap");
        assertTrue(bitmap & (1 << HOOKS_BEFORE_SWAP_RETURNS_DELTA_OFFSET) != 0, "beforeSwap returns a delta");
        assertTrue(bitmap & (1 << HOOKS_AFTER_SWAP_RETURNS_DELTA_OFFSET) != 0, "afterSwap returns a delta");

        // Exact, not a subset, and deliberately a LITERAL rather than the same
        // OR-expression the hook builds. Rebuilding it here from the same
        // constants would restate the source instead of pinning it: a change to
        // the hook copied into the test would pass. 0xCC5 is bits 0, 2, 6, 7, 10
        // and 11, and it is the Infinity-side counterpart of the 0x20CC this test
        // replaced — a magic number checked in on purpose so that moving it
        // requires saying so.
        assertEq(bitmap, uint16(0xCC5), "the bitmap claims exactly these six and nothing else");

        // `beforeRemoveLiquidity` above all must stay unclaimed: claiming it
        // would put the hook in the path of every retail LP withdrawal, and the
        // genesis position needs no callback to stay locked.
        assertTrue(bitmap & (1 << HOOKS_BEFORE_REMOVE_LIQUIDITY_OFFSET) == 0, "beforeRemoveLiquidity stays unclaimed");
    }

    // ── initializeToken ───────────────────────────────────────────────────────
    //
    // A clone runs no constructor, so this is where a project's configuration is
    // vetted.  Every rejection the constructor used to own now lives here, and
    // it is checked against the bytes actually baked into the clone rather than
    // against the factory's intent — an offset bug in the arg layout would show
    // up as exactly the degenerate config these tests reject.

    function test_initializeToken_rejectsNonFactory() public {
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyFactory.selector);
        hook.initializeToken(makeAddr("fakeToken"), projTreasury);
    }

    function test_initializeToken_rejectsAlreadyInitialized() public {
        vm.prank(address(factory));
        vm.expectRevert(ToshLaunchpadHook.AlreadyInitialized.selector);
        hook.initializeToken(makeAddr("anotherToken"), projTreasury);
    }

    function test_initializeToken_rejectsZeroToken() public {
        ToshLaunchpadHook fresh = _freshHook();
        vm.expectRevert(bytes("zero token"));
        fresh.initializeToken(address(0), projTreasury);
    }

    function test_initializeToken_rejectsZeroAdmin() public {
        ToshLaunchpadHook fresh = _freshHook();
        vm.expectRevert(ToshLaunchpadHook.InvalidAdmin.selector);
        fresh.initializeToken(makeAddr("tok"), address(0));
    }

    function test_initializeToken_rejectsZeroSoftCap() public {
        ToshLaunchpadHook fresh = _freshClone(0, 1 ether, 24 hours);
        vm.expectRevert(bytes("zero softCap"));
        fresh.initializeToken(makeAddr("tok"), projTreasury);
    }

    function test_initializeToken_rejectsZeroPerWalletCap() public {
        ToshLaunchpadHook fresh = _freshClone(1 ether, 0, 24 hours);
        vm.expectRevert(bytes("zero perWalletCap"));
        fresh.initializeToken(makeAddr("tok"), projTreasury);
    }

    function test_initializeToken_acceptsTheThreeAllowedWindows() public {
        uint256[3] memory allowed = [hook.DURATION_FAST(), hook.DURATION_STANDARD(), hook.DURATION_SLOW()];

        for (uint256 i; i < allowed.length; ++i) {
            ToshLaunchpadHook h = _freshClone(1 ether, 1 ether, allowed[i]);
            h.initializeToken(makeAddr("tok"), projTreasury);

            assertEq(h.genesisDuration(), allowed[i], "window is frozen in the clone's code");
            assertEq(h.genesisDeadline(), block.timestamp + allowed[i], "deadline is now + window");
        }
    }

    /// @dev The interesting rejections are the two degenerate ends the closed
    ///      set exists to keep out — a window nobody can deposit into, and one
    ///      that locks deposits up with no refund path — plus a plausible
    ///      near-miss that a caller might reasonably assume is allowed.
    ///
    ///      Rejecting here rather than in the factory is deliberate: the value
    ///      is committed to by the hook's mined address, so the check has to run
    ///      against what the address actually pledges.
    function test_initializeToken_rejectsUnlistedWindow() public {
        uint256[5] memory rejected = [uint256(0), 1 seconds, 12 hours, 25 hours, 3650 days];

        for (uint256 i; i < rejected.length; ++i) {
            ToshLaunchpadHook h = _freshClone(1 ether, 1 ether, rejected[i]);
            vm.expectRevert(ToshLaunchpadHook.InvalidDuration.selector);
            h.initializeToken(makeAddr("tok"), projTreasury);
        }
    }

    /// @dev The shared implementation is a complete, callable hook, and its arg
    ///      offsets land inside its own ~19 KB of runtime code — so they return
    ///      live bytecode reinterpreted as a config, not zeros.  A `> 0` check
    ///      would wave that straight through, which is why the guard compares
    ///      `address(this)` against the address captured at construction
    ///      instead.
    ///
    ///      `initializeToken` is the only writer of `tokenInitialized`, and every
    ///      value-bearing path is gated on it, so refusing to run here is what
    ///      makes the implementation inert as itself.
    function test_implementationIsInertAsItself() public {
        address impl = factory.hookImplementation();

        assertTrue(ToshLaunchpadHook(payable(impl)).softCap() != 0, "reads its own code, not zeros");

        vm.prank(address(factory));
        vm.expectRevert(ToshLaunchpadHook.NotAClone.selector);
        ToshLaunchpadHook(payable(impl)).initializeToken(makeAddr("tok"), projTreasury);

        assertFalse(ToshLaunchpadHook(payable(impl)).tokenInitialized(), "still uninitialised");

        // And therefore unable to take value.
        vm.deal(address(this), 1 ether);
        (bool ok,) = impl.call{value: 1 ether}("");
        assertFalse(ok, "implementation refuses ETH");
    }

    function test_hook_deposit_revertsBeforeTokenInitialised() public {
        ToshLaunchpadHook fresh = _freshHook();
        vm.expectRevert(ToshLaunchpadHook.NotInitialized.selector);
        fresh.deposit{value: 1}(user1, address(0), address(0));
    }

    function test_hook_deposit_rejectsNonFactory() public {
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyFactory.selector);
        hook.deposit{value: 1 ether}(user1, address(0), address(0));
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

    function test_canRefund_falseWhenUnderCapAfterDeadline() public {
        _register(user1, 1 ether);
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(address(hook), address(0));
        vm.warp(hook.genesisDeadline() + 1);
        assertFalse(hook.canRefund());
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

    function test_refund_revertsUnderCapUntilLaunchWindowLapses() public {
        _register(user1, 1 ether);
        vm.prank(user1);
        factory.deposit{value: 0.01 ether}(address(hook), address(0));
        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(user1);
        vm.expectRevert(bytes("Refund not available"));
        hook.refund();
    }

    function test_refund_revertsWithNoDeposit() public {
        vm.warp(hook.genesisDeadline() + hook.LAUNCH_WINDOW() + 1);
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

    function test_launch_revertsIfNothingRaised() public {
        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        vm.expectRevert(ToshLaunchpadHook.ZeroAmount.selector);
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
        _setPhase2Minted(hook.BONDING_MAX());
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

    // ── lockAcquired / ICLHooks ───────────────────────────────────────────────
    //
    // Two callers, not one, and the split is the point. `lockAcquired` is the
    // Vault's callback and answers only to the Vault; the `beforeX`/`afterX`
    // hooks are the pool manager's and answer only to it. Under Uniswap V4 both
    // belonged to the same contract, so both tests below pranked the same
    // address and either guard would have caught either mistake. They no longer
    // would.

    function test_lockAcquired_revertsUnknownAction() public {
        vm.prank(mockVault);
        vm.expectRevert(ToshLaunchpadHook.UnknownAction.selector);
        hook.lockAcquired(abi.encode(uint8(99)));
    }

    function test_lockAcquired_rejectsNonVault() public {
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyVault.selector);
        hook.lockAcquired(abi.encode(uint8(1)));
    }

    /// @dev The pool manager is not the Vault, and this is the test that would
    ///      have caught the port getting it backwards. `mockPoolManager` is a
    ///      legitimate caller for every other callback in this file.
    function test_lockAcquired_rejectsEvenThePoolManager() public {
        vm.prank(mockPoolManager);
        vm.expectRevert(ToshLaunchpadHook.OnlyVault.selector);
        hook.lockAcquired(abi.encode(uint8(1)));
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
        ICLPoolManager.SwapParams memory p = _swapParams();
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyPoolManager.selector);
        hook.beforeSwap(address(0), k, p, "");
    }

    function test_afterSwap_rejectsNonPoolManager() public {
        PoolKey memory k = _emptyKey();
        ICLPoolManager.SwapParams memory p = _swapParams();
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyPoolManager.selector);
        hook.afterSwap(address(0), k, p, BalanceDelta.wrap(0), "");
    }

    function test_beforeRemoveLiquidity_rejectsNonPoolManager() public {
        PoolKey memory k = _emptyKey();
        ICLPoolManager.ModifyLiquidityParams memory p = _liqParams();
        vm.prank(user1);
        vm.expectRevert(ToshLaunchpadHook.OnlyPoolManager.selector);
        hook.beforeRemoveLiquidity(address(this), k, p, "");
    }

    function test_beforeRemoveLiquidity_passthroughForPoolManager() public {
        PoolKey memory k = _emptyKey();
        ICLPoolManager.ModifyLiquidityParams memory p = _liqParams();
        vm.prank(mockPoolManager);
        bytes4 s = hook.beforeRemoveLiquidity(address(this), k, p, "");
        assertEq(s, ICLHooks.beforeRemoveLiquidity.selector);
    }

    function test_ihooks_afterInitialize_returnsSelector() public view {
        assertEq(hook.afterInitialize(address(0), _emptyKey(), 0, 0), ICLHooks.afterInitialize.selector);
    }

    function test_ihooks_beforeAddLiquidity_returnsSelector() public view {
        assertEq(
            hook.beforeAddLiquidity(address(0), _emptyKey(), _liqParams(), ""), ICLHooks.beforeAddLiquidity.selector
        );
    }

    function test_ihooks_afterAddLiquidity_returnsSelector() public view {
        (bytes4 s,) = hook.afterAddLiquidity(
            address(0), _emptyKey(), _liqParams(), BalanceDelta.wrap(0), BalanceDelta.wrap(0), ""
        );
        assertEq(s, ICLHooks.afterAddLiquidity.selector);
    }

    function test_ihooks_afterRemoveLiquidity_returnsSelector() public view {
        (bytes4 s,) = hook.afterRemoveLiquidity(
            address(0), _emptyKey(), _liqParams(), BalanceDelta.wrap(0), BalanceDelta.wrap(0), ""
        );
        assertEq(s, ICLHooks.afterRemoveLiquidity.selector);
    }

    function test_ihooks_beforeDonate_returnsSelector() public view {
        assertEq(hook.beforeDonate(address(0), _emptyKey(), 0, 0, ""), ICLHooks.beforeDonate.selector);
    }

    function test_ihooks_afterDonate_returnsSelector() public view {
        assertEq(hook.afterDonate(address(0), _emptyKey(), 0, 0, ""), ICLHooks.afterDonate.selector);
    }

    // ── ToshToken ─────────────────────────────────────────────────────────────

    function test_token_ctor_rejectsZeroFactory() public {
        vm.expectRevert(bytes("zero factory"));
        new ToshToken(address(0));
    }

    function test_token_initialize_rejectsNonFactory() public {
        ToshToken t = new ToshToken(address(this));
        vm.prank(user1);
        vm.expectRevert(ToshToken.OnlyFactory.selector);
        t.initialize(makeAddr("hookHere"), "X", "X");
    }

    function test_token_initialize_rejectsZeroHook() public {
        ToshToken t = new ToshToken(address(this));
        vm.expectRevert(bytes("zero hook"));
        t.initialize(address(0), "X", "X");
    }

    function test_token_initialize_rejectsEmptyMetadata() public {
        ToshToken a = new ToshToken(address(this));
        vm.expectRevert(bytes("empty metadata"));
        a.initialize(makeAddr("hookHere"), "", "X");

        ToshToken b = new ToshToken(address(this));
        vm.expectRevert(bytes("empty metadata"));
        b.initialize(makeAddr("hookHere"), "X", "");
    }

    function test_token_initialize_rejectsRepeatedInit() public {
        vm.prank(address(factory));
        vm.expectRevert(ToshToken.AlreadyInitialized.selector);
        token.initialize(makeAddr("again"), "X", "X");
    }

    /// @dev Metadata moved from the constructor into storage because a clone runs
    ///      no constructor.  `initialize` is its only writer, so it is as frozen
    ///      as it was before — this pins that the round trip actually works and
    ///      that the clone is a clone.
    function test_token_metadataSurvivesTheClone() public view {
        assertEq(token.name(), "Guard");
        assertEq(token.symbol(), "GRD");
        assertEq(token.decimals(), 18);

        assertEq(address(token).code.length, ToshCloneLib.BARE_RUNTIME_LEN, "token is a bare clone");

        address embedded;
        bytes memory code = address(token).code;
        for (uint256 i; i < 20; ++i) {
            embedded = address(uint160((uint256(uint160(embedded)) << 8) | uint8(code[10 + i])));
        }
        assertEq(embedded, factory.tokenImplementation(), "delegates to the factory's implementation");
    }

    /// @dev Two clones of one implementation must not share supply, balances or
    ///      the minter grant — this is the property that makes MAX_SUPPLY a
    ///      per-project cap rather than a platform-wide one.
    function test_token_clonesAreIsolated() public {
        (address t2,) = _createLaunch("Second", "SND");
        ToshToken other = ToshToken(t2);

        assertTrue(address(other) != address(token), "distinct addresses");
        assertEq(other.name(), "Second", "own metadata");
        assertEq(token.name(), "Guard", "unaffected by the other");

        assertTrue(other.hook() != token.hook(), "own minter");
        assertFalse(other.hasRole(other.MINTER_ROLE(), address(hook)), "our hook cannot mint theirs");

        // And the shared implementation holds nothing.
        ToshToken impl = ToshToken(factory.tokenImplementation());
        assertEq(impl.totalSupply(), 0);
        assertEq(impl.hook(), address(0));
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

    /// @notice The production treasury still arms on `TRIGGER_STEP` and spends
    ///         `SPEND_BPS`, i.e. `_nextSpendAmount` is not overridden.
    ///
    ///   `_nextSpendAmount` is `virtual` so that `test/probe/PiggybackGasProbe.sol`
    ///   can subclass it with a threshold a testnet can reach — the only way to
    ///   execute the piggyback branch on a chain where nobody has a spare ETH,
    ///   and how RH-B4 was finally measured on chain 4663.
    ///
    ///   The keyword costs production nothing today: the runtime bytecode is
    ///   byte-identical with and without it. But "nothing overrides this" is a
    ///   property of the current source rather than of the language, and it is
    ///   the sort that decays quietly — an override added later would change how
    ///   much of the reservoir is deployed per cycle, with no compiler
    ///   complaint and no other test noticing.
    ///
    ///   Asserted behaviourally rather than structurally. Solidity offers no way
    ///   to ask whether a function was overridden, and an override that
    ///   reproduces this behaviour exactly is not the thing worth catching.
    function test_nextSpendAmountIsNotOverridden() public {
        ToshLadderTreasury t = new ToshLadderTreasury(address(0xBEEF), address(0xCAFE), address(this));

        uint256 step = t.TRIGGER_STEP();

        vm.deal(address(t), step - 1);
        assertEq(t.nextSpendAmount(), 0, "unarmed one wei below the step");

        vm.deal(address(t), step);
        assertEq(t.nextSpendAmount(), step, "at the step, the floor applies");

        // Above 10x the step the proportional term overtakes the floor.
        vm.deal(address(t), 20 * step);
        assertEq(t.nextSpendAmount(), (20 * step * t.SPEND_BPS()) / 10_000, "proportional term applies");
    }

    /// @dev Forces `phase2Minted` to `value`.  Reaching `BONDING_MAX` honestly
    ///      would mean clearing 4000 shelves, and `MAX_TIERS_PER_TX` caps a mint
    ///      at a handful, so the ceiling is only observable by writing it.
    ///
    ///      Field-aware rather than word-aware: `phase2Minted` is the top
    ///      `uint96` of the packed `LadderState`, so this writes that window and
    ///      leaves the shelf cursor sharing the slot untouched.  The previous
    ///      version stored a full word and compared the getter against it, which
    ///      stopped finding anything the moment the three fields were packed.
    ///
    ///      Still searches for the slot instead of hardcoding one, so ordinary
    ///      storage edits do not break it — only a change to the field's OFFSET
    ///      does, which is the thing worth being told about.
    function _setPhase2Minted(uint256 value) internal {
        require(value != 0, "a zero probe would match the first slot it tried");
        require(value <= type(uint96).max, "value does not fit the packed field");

        uint256 offset = 16 + 88; // uint16 tierIndex, uint88 tierSold, then minted
        uint256 mask = ((uint256(1) << 96) - 1) << offset;

        for (uint256 i; i < 64; ++i) {
            bytes32 prev = vm.load(address(hook), bytes32(i));
            vm.store(address(hook), bytes32(i), bytes32((uint256(prev) & ~mask) | (value << offset)));
            if (hook.phase2Minted() == value) return;
            vm.store(address(hook), bytes32(i), prev);
        }
        revert("phase2Minted field not found");
    }
}
