// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {LiquidityAmounts} from "infinity-periphery/src/pool-cl/libraries/LiquidityAmounts.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookAddress} from "../src/libraries/HookAddress.sol";
import {MockERC20} from "./utils/MockERC20.sol";

/// @dev Namespaced storage slot for `ReentrantLadderHook`'s counter. File-level
///      so the mock that writes it and the assertion that reads it cannot drift
///      apart — and namespaced because the mock is etched over a live EIP-1167
///      clone, where slot 0 belongs to the hook's own state.
uint256 constant _REENTRANT_HOOK_CALLS_SLOT = uint256(keccak256("tosh.test.reentrantHook.calls"));

/// @notice v5.0 suite —ETH-native launches, the global referral graph, the
///         discrete tier ladder with its anti-spike gates, the asymmetric
///         in-flight tax, and the round-robin piggyback buyback.
///
/// @dev    Every test runs against a REAL `PoolManager` and drives real swaps
///         through v4-core's `CLPoolManagerRouter` router.  The v4.x suite mocked the
///         pool manager for factory-level tests; v5.0 cannot, because the tax,
///         the TWAP oracle, and the piggyback engine all live in the swap path.
contract ToshV5Test is Test {
    using MessageHashUtils for bytes32;
    using PoolIdLibrary for PoolKey;

    // No `using StateLibrary` — the library does not exist here. Uniswap V4 kept
    // pool state behind `extsload` and StateLibrary was the typed reader for it;
    // Infinity's CLPoolManager exposes `getSlot0`, `getLiquidity` and
    // `getPosition` as ordinary view functions, so the calls below go straight
    // to the manager.

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

    Vault internal vault;
    CLPoolManager internal poolManager;

    /// @dev One router where V4 needed two. `CLPoolManagerRouter` and
    ///      `CLPoolManagerRouter` were separate harnesses; Infinity ships a
    ///      single `CLPoolManagerRouter` that does both, so `router` and
    ///      `router` collapse into this.
    ///
    ///      It matters for `_retailLiquidity`: retail LP positions are keyed to
    ///      whoever called `modifyPosition`, which is now the same address that
    ///      swaps. The two are still distinguishable because the genesis
    ///      position belongs to the hook, and that is the only distinction the
    ///      suite asserts on.
    CLPoolManagerRouter internal router;

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

        // Infinity splits what V4's PoolManager did into two contracts, and the
        // order here is forced by that: the Vault holds every balance and each
        // pool manager has to be registered with it before it may move any. An
        // unregistered manager reverts inside `vault.lock` with `AppUnregistered`,
        // which surfaces as an opaque failure several calls into a test.
        //
        // `registerApp` is `onlyOwner` and the Vault takes its deployer as owner,
        // so this runs outside the `admin` prank below — the test contract owns
        // the Vault, which is the same arrangement as the real deployment where
        // PancakeSwap owns it and we are merely a registered app's user.
        vault = new Vault();
        poolManager = new CLPoolManager(IVault(address(vault)));
        vault.registerApp(address(poolManager));

        router = new CLPoolManagerRouter(IVault(address(vault)), ICLPoolManager(address(poolManager)));

        vm.startPrank(admin);
        // Treasury first: the factory takes its address as an immutable.
        ladder = new ToshLadderTreasury(address(poolManager), address(vault), admin);
        factory = new ToshFactory(address(poolManager), address(vault), pogSigner, platformTreasury, address(ladder));
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

    /// @dev Pick a raw salt whose factory-derived CREATE2 address is free.
    ///
    ///      ⚠ THIS NO LONGER MINES. Under Uniswap V4 it searched for an address
    ///      carrying the 0x20CC flag mask, because that is where the PoolManager
    ///      read a hook's permissions from. Infinity reads them from
    ///      `getHooksRegistrationBitmap()`, the factory checks no address bits,
    ///      and `HookAddress.isValidHookAddress` was deleted with the gate.
    ///
    ///      The occupancy check is the half that had to survive, and it is doing
    ///      real work here rather than guarding a corner case: every project in
    ///      a given test shares the same immutable-arg tuple and the same
    ///      creator, so `keccak256(creator, rawSalt)` would hand back an
    ///      identical address on the second call and CREATE2 would collide.
    ///      The loop is what makes multi-project tests — the piggyback ladder
    ///      needs four launches — possible at all.
    ///
    ///      The initcode hash is read back from the factory rather than
    ///      reconstructed here, so the clone's immutable-arg tuple cannot drift
    ///      out of sync with the test.
    function _pickSalt(address _projTreasury, address _creator) internal view returns (bytes32 rawSalt) {
        bytes32 initcodeHash = factory.hookInitcodeHash(
            _projTreasury, _creator, factory.defaultSoftCap(), factory.maxPogAllocationLimit(), 24 hours
        );
        for (uint256 i; i < 1000; ++i) {
            rawSalt = bytes32(i);
            bytes32 finalSalt = keccak256(abi.encode(_creator, rawSalt));
            if (HookAddress.computeAddress(address(factory), finalSalt, initcodeHash).code.length == 0) return rawSalt;
        }
        revert("_pickSalt: first 1000 salts are all occupied");
    }

    function _createProject(string memory name, string memory symbol)
        internal
        returns (ToshToken token, ToshLaunchpadHook hook)
    {
        bytes32 salt = _pickSalt(projTreasury, creator);
        uint256 fee = factory.launchFee();

        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (address t, address h) = factory.createLaunch{value: fee}(
            name, symbol, projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );

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

    /// @dev One second past `ToshLaunchpadHook.TWAP_WINDOW` (1800 s).
    uint256 internal constant TWAP_MATURITY_WARP = 1801;

    /// @dev Age a fresh pool until `addLadderToken` will accept it.
    ///
    ///      `addLadderToken` refuses a pool whose `twapSqrtPriceX96()` reads 0,
    ///      which is every pool for its first `TWAP_WINDOW`, so a test that
    ///      lists straight after `_launchProject` would be testing that gate
    ///      rather than whatever it came to test.
    ///
    ///      A bare warp is enough, and is the smallest perturbation available.
    ///      `_twapSqrtPriceX96` returns 0 only while `block.timestamp -
    ///      _prevCheckpointTs < TWAP_WINDOW`; past that, a pool with no swap in
    ///      the trailing window takes the flat-price branch and reports
    ///      `lastTick` outright.  The two-swap sequence in
    ///      `ToshV5Attack.t.sol` is there to produce a genuinely AVERAGED
    ///      reading for the band-edge probes — it is not what non-zero
    ///      requires, and its 1 ETH of buying would move the balances and tier
    ///      state these tests assert on.
    ///
    ///      NOT folded into `_launch`:
    ///      `test_preTwapWindow_capsReferenceAtP0AgainstATwoBlockPump` needs
    ///      the immature window this skips past.
    function _matureTwap() internal {
        _warpBy(TWAP_MATURITY_WARP);
        _nextBlock();
    }

    /// @dev Advance the clock by `secs`.
    ///
    ///      Deliberately NOT `vm.warp(block.timestamp + secs)`, for the same
    ///      reason `_nextBlock` refuses `vm.roll(block.number + 1)`: under
    ///      `via_ir` the optimizer treats `block.timestamp` as invariant
    ///      within a call frame and reuses a read taken before an earlier
    ///      `vm.warp`, so the addition lands on a stale base.  It can warp
    ///      BACKWARD.
    ///
    ///      Measured in `_measureArmedSwap`, which had exactly this bug: after
    ///      the launches had moved the clock to 172_803,
    ///      `vm.warp(block.timestamp + 1900)` set it to 1901.  That left
    ///      `_prevCheckpointTs` — written at launch, so 172_803 — ahead of
    ///      `nowTs`, and `nowTs - _prevCheckpointTs` underflowed inside
    ///      `_twapSqrtPriceX96`, making the getter REVERT.  `_buybackSqrtFloor`
    ///      answers a reverting getter by falling back to unbounded, so the
    ///      helper had been measuring an unbounded buyback for as long as its
    ///      comment had been claiming an established TWAP.
    ///
    ///      `vm.getBlockTimestamp()` is an opaque cheatcode call and always
    ///      reads through.  The suite still holds ~36 bare
    ///      `vm.warp(block.timestamp + …)` sites, safe only where nothing
    ///      moved the clock earlier in the same frame.
    function _warpBy(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
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

    /// @dev How many bps of a BUY's ETH input actually land in `ladderTreasury`.
    ///
    ///      Not `TAX_BPS`.  The buy leg's 1.00 % skim is split — the platform's
    ///      `PLATFORM_SWAP_FEE_BPS` is `take`n to `platformFeeRecipient` and
    ///      never touches the reservoir — so anything reasoning about the
    ///      reservoir's BALANCE (the piggyback arming threshold, above all)
    ///      must use this and not the headline rate.  Derived from the hook's
    ///      own constants so the two cannot drift apart in a later rate change.
    function _reservoirBps(ToshLaunchpadHook hook) internal view returns (uint256) {
        return hook.TAX_BPS() - hook.PLATFORM_SWAP_FEE_BPS();
    }

    function _genesisLiquidity(ToshLaunchpadHook hook) internal view returns (uint128 liq) {
        return poolManager.getLiquidity(hook.getPoolKey().toId(), address(hook), TICK_LOWER, TICK_UPPER, bytes32(0));
    }

    function _retailLiquidity(ToshLaunchpadHook hook) internal view returns (uint128 liq) {
        return poolManager.getLiquidity(hook.getPoolKey().toId(), address(router), TICK_LOWER, TICK_UPPER, bytes32(0));
    }

    /// @dev ETH -> token. `zeroForOne` because native ETH always sorts to
    ///      `currency0`; buying pushes ETH-per-token up.
    function _swapBuy(ToshLaunchpadHook hook, address who, uint256 nativeIn) internal {
        vm.prank(who);
        router.swap{value: nativeIn}(
            hook.getPoolKey(),
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(nativeIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            _swapSettings(),
            ""
        );
    }

    /// @dev The two booleans mean the opposite of V4's and are named for the
    ///      opposite thing, so this is stated once rather than inline at every
    ///      call site.
    ///
    ///      V4's `CLPoolManagerRouter.TestSettings` was `{takeClaims, settleUsingBurn}`
    ///      and the suite passed `false, false` — take real tokens, settle by
    ///      transferring them. Infinity's `SwapTestSettings` is
    ///      `{withdrawTokens, settleUsingTransfer}`, where the same two choices
    ///      are `true, true`. Copying the old `false, false` across would have
    ///      left every swap settling through claim tokens the suite never mints.
    function _swapSettings() internal pure returns (CLPoolManagerRouter.SwapTestSettings memory) {
        return CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true});
    }

    /// @dev Unlock the shelf ladder.
    ///
    ///      Shelf 0 costs `1.05 x p0` and the gate caps shelves at
    ///      `1.05 x min(spot, TWAP)`, so the ladder opens LOCKED and only
    ///      unlocks once the market holds at or above the genesis price.  Buy
    ///      the pool up, then let the new level age into the TWAP so the
    ///      `min()` follows it rather than the pre-move price.
    function _openLadder(ToshLaunchpadHook hook, uint256 nativeIn) internal {
        _swapBuy(hook, trader, nativeIn);
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
        IERC20(Currency.unwrap(key.currency1)).approve(address(router), type(uint256).max);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: false, amountSpecified: -int256(tokensIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1
            }),
            _swapSettings(),
            ""
        );
        vm.stopPrank();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  1. ETH-native factory plumbing
    // ══════════════════════════════════════════════════════════════════════════

    function test_createLaunch_chargesEthFeeAndFundsLadderTreasury() public {
        uint256 fee = factory.launchFee();
        assertEq(fee, 0.35 ether, "default launch fee should be 0.35 BNB");

        uint256 ladderBefore = address(ladder).balance;
        (, ToshLaunchpadHook hook) = _createProject("Matrix", "MTRX");

        assertTrue(factory.registeredHooks(address(hook)));
        assertEq(address(ladder).balance - ladderBefore, fee, "launch fee must land in the buyback reservoir");
        assertEq(platformTreasury.balance, 0, "platform treasury must not receive launch fees in v5.0");
    }

    function test_createLaunch_refundsOverpayment() public {
        bytes32 salt = _pickSalt(projTreasury, creator);
        uint256 fee = factory.launchFee();
        uint256 before = creator.balance;

        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        factory.createLaunch{value: fee + 3 ether}(
            "Over", "OVR", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );

        assertEq(before - creator.balance, fee, "overpayment must be refunded");
    }

    function test_createLaunch_revertsOnUnderpayment() public {
        bytes32 salt = _pickSalt(projTreasury, creator);
        uint256 fee = factory.launchFee();

        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.InsufficientLaunchFee.selector);
        factory.createLaunch{value: fee - 1}(
            "Under", "UND", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
    }

    /// @dev `expectedFee` is a slippage cap: an owner who raises the fee in the
    ///      mempool cannot front-run a creator into paying more than they agreed.
    function test_createLaunch_revertsWhenOwnerFrontRunsFeeIncrease() public {
        bytes32 salt = _pickSalt(projTreasury, creator);
        uint256 quotedFee = factory.launchFee();

        vm.prank(admin);
        factory.setLaunchFee(quotedFee + 1 ether);

        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        vm.expectRevert(ToshFactory.FeeChanged.selector);
        factory.createLaunch{value: 5 ether}(
            "Front", "FRT", projTreasury, projTreasury, salt, quotedFee, agreedSoftCap, agreedWalletCap, 24 hours
        );
    }

    /// @notice The live pool key claims exactly the permissions the hook admits
    ///         to, and the manager is what enforces the agreement.
    ///
    /// @dev    ⚠ REPLACES `test_minedHookAddress_carriesV5FlagMask`, which
    ///         asserted `uint160(address(hook)) & 0x20CC == 0x20CC`.
    ///
    ///         Under Uniswap V4 that mask WAS the permission set, so the
    ///         assertion had teeth. PancakeSwap Infinity puts the set in
    ///         `PoolKey.parameters` and cross-checks it against the hook's own
    ///         `getHooksRegistrationBitmap()` at `initialize`, so the address
    ///         carries nothing and the old assertion could only fail.
    ///
    ///         The property worth keeping is the one the launch actually depends
    ///         on: the key the hook hands out is the key the pool was opened
    ///         with. `test_hooksRegistrationBitmapNamesExactlyTheImplementedCallbacks`
    ///         in ToshV5Guards pins WHICH six; this pins that the key agrees.
    function test_livePoolKeyClaimsTheHooksOwnPermissions() public {
        // `_launchProject`, not `_createProject`: the pool is not initialised
        // until the genesis round closes, and half of what this asserts is that
        // the pool the key describes is really open.
        (, ToshLaunchpadHook hook) = _launchProject("Mask", "MSK", alice, address(0));

        // The low 16 bits of `parameters` are the permission bitmap; the tick
        // spacing sits above them.
        uint16 claimed = uint16(uint256(hook.getPoolKey().parameters));
        assertEq(claimed, hook.getHooksRegistrationBitmap(), "the pool key claims what the hook registers");

        // And the pool really is open under that key — otherwise the two could
        // agree about a pool that was never initialised.
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(hook.getPoolKey().toId());
        assertGt(sqrtPriceX96, 0, "the pool the key describes must exist");
    }

    /// @notice Total trader friction is 1.30 %: a 0.30 % native pool fee that
    ///         V4 pays to third-party LPs, plus a 1.00 % hook tax.
    ///
    /// @dev    The hook tax used to be 0.70 % for a 1.00 % all-in toll.  The
    ///         extra 30 bps is the platform's maintenance cut; it is carved out
    ///         of the hook tax on the buy leg only, so the buyback reservoir
    ///         still receives the same 70 bps it always did.  The pool fee is
    ///         untouched — it is V4's, not ours.
    function test_poolKey_chargesThirtyBpsToLPs() public {
        (, ToshLaunchpadHook hook) = _launchProject("PoolFee", "PFE", alice, address(0));

        assertEq(hook.POOL_FEE(), 3000, "native pool fee must be 0.30 %");
        assertEq(hook.TAX_BPS(), 100, "hook tax must be 1.00 %");
        assertEq(hook.PLATFORM_SWAP_FEE_BPS(), 30, "the platform's carve-out must be 0.30 %");
        assertEq(hook.TAX_BPS() - hook.PLATFORM_SWAP_FEE_BPS(), 70, "leaving the reservoir's share at 0.70 %");
        assertEq(hook.getPoolKey().fee, 3000, "the live PoolKey must carry the 0.30 % fee");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  2. Genesis deposits in native ETH
    // ══════════════════════════════════════════════════════════════════════════

    function test_deposit_isNativeEthAndNeedsNoApproval() public {
        (, ToshLaunchpadHook hook) = _createProject("EthDep", "EDP");
        _registerPoG(alice, POG_CAP);

        _deposit(alice, hook, 0.4 ether, address(0));

        assertEq(hook.nativeDeposited(alice), 0.4 ether);
        assertEq(hook.totalNativeDeposited(), 0.4 ether);
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
        assertEq(oldProject.nativeDeposited(alice), 1 ether);

        // The same deposit into the newer round is refused.
        vm.prank(alice);
        vm.expectRevert(ToshLaunchpadHook.PerWalletCapExceeded.selector);
        factory.deposit{value: 1 ether}(address(newProject), address(0));
    }

    /// @notice Refunding gives the ETH back but NOT the quota.  Otherwise a
    ///         single wallet could deposit/refund on a loop and recycle one
    ///         attestation's worth of allowance indefinitely.
    function test_pogQuota_isNotRestoredByRefund() public {
        // Refunds now wait out LAUNCH_WINDOW (7 days), which is also
        // MAX_COOLDOWN, so a quota window cannot outlast the refund. The
        // claim under test is still the ledger: `refund()` must not write
        // `quotaSpent` down. Eligibility may refill from the clock; the
        // spent counter itself must not.
        vm.prank(admin);
        factory.setQuotaWindowDuration(7 days);

        _registerPoG(alice, 0.3 ether);
        (, ToshLaunchpadHook hookA) = _createProject("Refunder", "RFD");
        _deposit(alice, hookA, 0.3 ether, address(0));

        vm.warp(hookA.genesisDeadline() + hookA.LAUNCH_WINDOW() + 1);
        vm.prank(alice);
        hookA.refund();

        assertEq(factory.quotaSpent(alice), 0.3 ether, "refund must not credit the window back");

        (, ToshLaunchpadHook hookB) = _createProject("Retry", "RTY");
        (, uint256 remaining,) = factory.eligibility(alice, address(hookB));
        assertEq(remaining, 0.3 ether, "the lapsed window refills remaining; the spent counter did not move");
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

    function test_refund_returnsEthWhenLaunchWindowLapses() public {
        (, ToshLaunchpadHook hook) = _createProject("Fail", "FAIL");
        _registerPoG(alice, POG_CAP);
        _deposit(alice, hook, 0.3 ether, address(0));

        vm.warp(hook.genesisDeadline() + hook.LAUNCH_WINDOW() + 1);
        assertTrue(hook.canRefund(), "genesis should be refundable once the launch window lapses");

        uint256 before = alice.balance;
        vm.prank(alice);
        hook.refund();

        assertEq(alice.balance - before, 0.3 ether, "refund must be paid in native ETH");
        assertEq(hook.nativeDeposited(alice), 0);
    }

    function test_launch_succeedsBelowSoftCap() public {
        (, ToshLaunchpadHook hook) = _createProject("Thin", "THN");
        _registerPoG(alice, POG_CAP);
        _deposit(alice, hook, 0.3 ether, address(0));
        assertLt(hook.totalNativeDeposited(), hook.softCap(), "fixture must sit under the progress target");

        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        hook.launch();
        assertTrue(hook.launched(), "time-up launch does not require the soft cap");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  3. Two-slot referral graph  [v5.0 acceptance test]
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice A wallet's FIRST referrer is bound platform-wide and forever, and
    ///         keeps earning the LIFETIME leg on every later project.  A
    ///         competing referral code is silently ignored rather than
    ///         reverting (a stale link must never brick a deposit).
    ///
    /// @dev    The rate asserted here is 2 %, not the whole 10 %, and that is
    ///         the two-slot design working rather than a shortfall.  bob never
    ///         deposits into either project, so he never qualifies for the 8 %
    ///         project leg and it orphans to the buyback reservoir.  What bob
    ///         holds is the tail that follows alice around the platform.  The
    ///         other leg is covered by
    ///         `test_projectReferral_takesEightOfTheTenPoints`.
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
        assertEq(
            factory.projectReferrers(alice, address(hookA)),
            address(0),
            "bob holds no deposit in hookA, so the project slot must stay empty"
        );
        assertEq(hookA.referralAccrued(bob), 0.02 ether, "referrer earns the 2% lifetime leg");
        assertEq(hookA.orphanReferral(), 0.08 ether, "the unbound 8% leg becomes buyback fuel");

        // A different project, a different (competing) code: binding is immutable.
        _deposit(alice, hookB, 1 ether, carol);
        assertEq(factory.globalReferrers(alice), bob, "binding must be permanent");
        assertEq(factory.referralCount(carol), 0, "competing code must not rebind");
        assertEq(hookB.referralAccrued(carol), 0, "competing referrer earns nothing");
        assertEq(hookB.referralAccrued(bob), 0.02 ether, "original referrer earns on the new project too");

        // ...and the commission is real ETH, claimable once the project launches.
        _launch(hookB);
        uint256 before = bob.balance;
        vm.prank(bob);
        hookB.claimReferralReward();
        assertEq(bob.balance - before, 0.02 ether, "referral reward is paid in ETH");
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

    /// @notice The project leg is 8 of the 10 points, and it goes to whoever
    ///         brought the depositor to THIS project — not to the wallet that
    ///         first brought them to the platform.
    function test_projectReferral_takesEightOfTheTenPoints() public {
        (, ToshLaunchpadHook hookA) = _createProject("SplitA", "SPA");
        (, ToshLaunchpadHook hookB) = _createProject("SplitB", "SPB");

        _registerPoG(bob, POG_CAP);
        _registerPoG(carol, POG_CAP);

        // alice spends her one lifetime slot on carol, on a project carol has no
        // stake in.  That is the slot that follows alice from here on.
        _deposit(alice, hookA, 1 ether, carol);
        assertEq(factory.globalReferrers(alice), carol, "lifetime slot goes to the first link");

        // bob stakes hookB himself, which is what qualifies him to earn there.
        _deposit(bob, hookB, 1 ether, address(0));

        _deposit(alice, hookB, 1 ether, bob);

        assertEq(factory.projectReferrers(alice, address(hookB)), bob, "project slot binds to bob");
        assertEq(factory.globalReferrers(alice), carol, "and leaves the lifetime slot alone");
        assertEq(factory.projectReferralCount(address(hookB), bob), 1, "bob recruited one wallet here");

        assertEq(hookB.referralAccrued(bob), 0.08 ether, "project referrer takes 8% of the deposit");
        assertEq(hookB.referralAccrued(carol), 0.02 ether, "lifetime referrer takes the other 2%");
    }

    /// @notice A first-time depositor arriving on one link fills BOTH slots with
    ///         it, so that referrer earns the entire 10 %.  The split is between
    ///         slots, never a haircut on the sharer.
    function test_projectReferral_bothSlotsToOneWalletEarnTheWholeCarve() public {
        (, ToshLaunchpadHook hook) = _createProject("BothSlots", "BTH");

        _registerPoG(bob, POG_CAP);
        _deposit(bob, hook, 1 ether, address(0));

        _deposit(alice, hook, 1 ether, bob);

        assertEq(factory.globalReferrers(alice), bob, "lifetime slot");
        assertEq(factory.projectReferrers(alice, address(hook)), bob, "and the project slot");
        assertEq(hook.referralAccrued(bob), 0.1 ether, "one wallet in both slots earns the whole carve");
        assertEq(hook.orphanReferral(), 0.1 ether, "only bob's own unreferred deposit orphans");
    }

    /// @notice The project slot will not bind a referrer who holds no stake in
    ///         the project, and a rejected binding is not sticky.
    ///
    /// @dev    The first half is the cost this gate imposes on honest early
    ///         promoters — see `_recordProjectReferral`.  The second half is why
    ///         it is a delay and not a forfeit.
    function test_projectReferral_requiresTheReferrerToHoldADepositHere() public {
        (, ToshLaunchpadHook hook) = _createProject("Gate", "GAT");

        _registerPoG(bob, POG_CAP);

        // bob is attested but has staked nothing here, so the 8 % has nobody to
        // go to and becomes buyback fuel.
        _deposit(alice, hook, 1 ether, bob);
        assertEq(factory.projectReferrers(alice, address(hook)), address(0), "gate rejects an unstaked referrer");
        assertEq(hook.referralAccrued(bob), 0.02 ether, "only the lifetime leg pays");
        assertEq(hook.orphanReferral(), 0.08 ether, "the project leg orphans");

        // bob stakes the project, and alice's NEXT deposit binds him.  The empty
        // slot was never poisoned by the earlier rejection.
        _deposit(bob, hook, 1 ether, address(0));
        _deposit(alice, hook, 1 ether, bob);

        assertEq(factory.projectReferrers(alice, address(hook)), bob, "binding retries and succeeds");
        assertEq(
            hook.referralAccrued(bob),
            0.12 ether,
            "two lifetime legs at 2% plus one project leg at 8% on the second deposit"
        );
    }

    /// @notice The project slot is first-link-wins PER PROJECT: a later link
    ///         cannot rebind a project, and binding one says nothing about the
    ///         next.
    function test_projectReferral_isPerProjectAndFirstLinkWins() public {
        (, ToshLaunchpadHook hookA) = _createProject("PerProjA", "PPA");
        (, ToshLaunchpadHook hookB) = _createProject("PerProjB", "PPB");

        _registerPoG(bob, POG_CAP);
        _registerPoG(carol, POG_CAP);

        // Both qualify on both projects, so the only thing deciding the bindings
        // below is which link arrived first.
        _deposit(bob, hookA, 1 ether, address(0));
        _deposit(bob, hookB, 1 ether, address(0));
        _deposit(carol, hookA, 1 ether, address(0));
        _deposit(carol, hookB, 1 ether, address(0));

        _deposit(alice, hookA, 1 ether, bob);
        assertEq(factory.projectReferrers(alice, address(hookA)), bob, "first link on hookA wins");

        _deposit(alice, hookA, 1 ether, carol);
        assertEq(factory.projectReferrers(alice, address(hookA)), bob, "and cannot be rebound");
        assertEq(hookA.referralAccrued(carol), 0, "the later sharer earns nothing on hookA");

        // hookB is a separate slot, and carol takes it.
        _deposit(alice, hookB, 1 ether, carol);
        assertEq(factory.projectReferrers(alice, address(hookB)), carol, "a different project binds independently");
        assertEq(hookB.referralAccrued(carol), 0.08 ether, "carol takes the project leg there");
        assertEq(hookB.referralAccrued(bob), 0.02 ether, "bob keeps the lifetime leg everywhere");
    }

    /// @notice The two legs always sum back to the carve, including on amounts
    ///         where both divisions would round down.
    ///
    /// @dev    `1000000000000000033` wei is picked, not round.  Its carve is
    ///         `100000000000000003` wei, which is not divisible by 5, so
    ///         `commission * PROJECT_REFERRAL_SHARE_BPS / 10_000` truncates.
    ///         Deriving the second leg with its own mulDiv rather than by
    ///         subtraction loses exactly one wei on this amount — and an
    ///         uncarved wei does not stay put, it lands in `lpNative`, which is
    ///         the numerator of `p0`.  This is the test that would catch it.
    function test_referralSplit_sumsToTheCarveOnAmountsThatTruncate() public {
        (, ToshLaunchpadHook hook) = _createProject("Exact", "EXA");

        uint256 amount = 1_000_000_000_000_000_033;

        _registerPoG(bob, POG_CAP);
        _deposit(bob, hook, amount, address(0));
        _deposit(alice, hook, amount, bob);

        uint256 carvePerDeposit = (amount * hook.REFERRAL_BPS()) / 10_000;
        assertEq(
            hook.totalReferralReserved() + hook.orphanReferral(),
            2 * carvePerDeposit,
            "every wei of the carve is accounted for, in one pot or the other"
        );
    }

    /// @notice The share-side view agrees with the gate the binding applies, so
    ///         the UI does not have to reimplement it.
    function test_canBindProjectReferral_tracksTheGate() public {
        (, ToshLaunchpadHook hook) = _createProject("View", "VEW");

        assertFalse(factory.canBindProjectReferral(bob, address(hook)), "unattested and unstaked");

        _registerPoG(bob, POG_CAP);
        assertFalse(factory.canBindProjectReferral(bob, address(hook)), "attested but holds no stake here");

        _deposit(bob, hook, 1 ether, address(0));
        assertTrue(factory.canBindProjectReferral(bob, address(hook)), "attested and staked");

        assertFalse(factory.canBindProjectReferral(address(0), address(hook)), "the zero address is nobody");
        assertFalse(factory.canBindProjectReferral(bob, makeAddr("notAHook")), "an unregistered hook");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  4. Launch + genesis claim
    // ══════════════════════════════════════════════════════════════════════════

    function test_launch_seedsEthPairAndDerivesP0() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("Live", "LIVE", alice, address(0));

        assertTrue(hook.launched());

        PoolKey memory key = hook.getPoolKey();
        assertTrue(key.currency0.isNative(), "ETH must be currency0");
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

        uint256 raised = hook.totalNativeDeposited();
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

        // There is no code path — for anyone, including the creator — that can
        // pull the genesis position back out.  `lockAcquired` only knows how to
        // add liquidity.
        //
        // The guard it trips is stricter than it was: V4's `unlockCallback`
        // rejected anyone but the PoolManager, whereas `lockAcquired` rejects
        // anyone but the Vault, which is the contract that actually holds the
        // balances.
        vm.prank(creator);
        vm.expectRevert();
        ToshLaunchpadHook(payable(address(hook))).lockAcquired(abi.encode(uint8(1)));

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
        uint256 nativeIn = 0.01 ether;
        vm.prank(alice);
        token.transfer(bob, tokenIn);

        PoolKey memory key = hook.getPoolKey();
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(TICK_LOWER),
            TickMath.getSqrtRatioAtTick(TICK_UPPER),
            nativeIn,
            tokenIn
        );
        assertGt(liq, 0);

        uint128 genesisBefore = _genesisLiquidity(hook);

        vm.startPrank(bob);
        token.approve(address(router), type(uint256).max);
        router.modifyPosition{value: nativeIn}(
            key,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: int256(uint256(liq)), salt: bytes32(0)
            }),
            ""
        );
        vm.stopPrank();

        assertEq(_retailLiquidity(hook), liq, "retail LP must land in its own position");
        assertEq(_genesisLiquidity(hook), genesisBefore, "adding retail LP must not move genesis");

        vm.prank(bob);
        router.modifyPosition(
            key,
            ICLPoolManager.ModifyLiquidityParams({
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
    ///   `_toSqrtPriceX96` / `_sqrtPriceToNativePerToken` and varies with the
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

    /// @notice A halt cannot hold a FAILED GENESIS hostage.
    ///
    ///   `haltLadderMinting` takes any address and never checks that the target
    ///   has launched, so an owner can arm one against a round that is still
    ///   collecting. That is safe by construction rather than by accident — the
    ///   only guard it installs sits on `mintBondingCurve`, which is not a
    ///   reachable path before `launch()` — but "safe by construction" is a
    ///   claim, and an un-pinned claim about a brake reaching a depositor's own
    ///   ETH is exactly the one worth being wrong about.
    ///
    ///   This is the scenario the runbook calls a hostage situation: money in,
    ///   under the progress target, and a platform switch standing between the
    ///   creator and `launch()`. It must not exist — time-up launch does not
    ///   wait on the soft cap, and a halt must not invent that wait.
    function test_ladderHalt_cannotHoldAnUnderCapGenesisHostage() public {
        (, ToshLaunchpadHook hook) = _createProject("Strand", "STR");
        _deposit(alice, hook, 0.3 ether, address(0));
        assertLt(hook.totalNativeDeposited(), hook.softCap());

        uint256 maxHalt = factory.MAX_HALT_DURATION();
        vm.prank(admin);
        factory.haltLadderMinting(address(hook), maxHalt);
        assertTrue(factory.ladderMintingHalted(address(hook)), "halting a pre-launch hook is permitted");

        vm.warp(hook.genesisDeadline() + 1);
        assertTrue(factory.ladderMintingHalted(address(hook)), "and the halt outlives the genesis window");

        vm.prank(creator);
        hook.launch();
        assertTrue(hook.launched(), "an under-cap raise still opens while halted");
    }

    /// @notice A halt blocks minting and no other post-launch path — including
    ///         the two that pay a user out.
    ///
    ///   `launch()` itself is not gated either: a funded round still opens while
    ///   the platform is halted, it just opens with its ladder already shut.
    ///   Gating `launch()` would strand a round that had met its soft cap in the
    ///   window between the halt and the `LAUNCH_WINDOW` expiry, converting a
    ///   brake into exactly the hostage this design refuses to be.
    function test_ladderHalt_blocksNeitherLaunchNorPayouts() public {
        (ToshToken token, ToshLaunchpadHook hook) = _createProject("HaltRef", "HRF");

        // A referrer must hold PoG quota of their own — see `_recordReferral`.
        _registerPoG(bob, POG_CAP);
        _deposit(alice, hook, SOFT_CAP, bob);

        // The halt has to OUTLIVE the genesis window, because `_launch` warps to
        // `genesisDeadline + 1` to get there.  A `1 days` halt armed here lapses
        // exactly one second before that warp lands, and every assertion below
        // would then be measured against a platform that is not halted at all.
        uint256 maxHalt = factory.MAX_HALT_DURATION();
        vm.prank(admin);
        factory.haltLadderMinting(address(0), maxHalt);

        _launch(hook);
        assertTrue(hook.launched(), "a global halt must not stop a funded round from opening");
        assertTrue(factory.ladderMintingHalted(address(hook)), "and the halt is still live on the other side");

        // `launch()` stamps the same-block lockout AND the ladder opens below its
        // price gate, so a bare `maxMintable() == 0` here would read zero with no
        // halt in place.  Clear both, then attribute the zero to the halt by
        // lifting it and watching the ladder come back.
        _openLadder(hook, 0.01 ether);
        assertEq(hook.maxMintable(), 0, "it opens with the ladder shut, which is the point");

        vm.prank(admin);
        factory.resumeLadderMinting(address(0));
        assertGt(hook.maxMintable(), 0, "and nothing but the halt was holding it shut");

        vm.prank(admin);
        factory.haltLadderMinting(address(0), maxHalt);
        assertTrue(factory.ladderMintingHalted(address(hook)), "re-armed for the payout paths below");

        // bob is alice's LIFETIME referrer and holds no deposit in this project,
        // so he earns the 2 % leg rather than the whole 10 % carve — see
        // `test_globalReferralPersistence`. A literal rather than a re-derivation
        // from the constants: what this test owns is that a halt pays commission
        // out at all, so if the split ever moves, this should fail loudly and be
        // re-read rather than quietly agree with whatever the contract now does.
        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        hook.claimReferralReward();
        assertEq(bob.balance - bobBefore, SOFT_CAP / 50, "referral commission pays out mid-halt");

        vm.prank(alice);
        hook.claimGenesis();
        assertGt(token.balanceOf(alice), 0, "so does the genesis claim");
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
        rider.sell(router, hook.getPoolKey(), token.balanceOf(address(rider)));

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

    /// @dev Buy leg: 1.0% of the INPUT ETH is skimmed, and then SPLIT — 70 bps
    ///      to the buyback reservoir, 30 bps to the platform.  Nothing is
    ///      burned on this leg.
    ///
    ///      The reservoir's 70 bps is the same 70 bps it received before the
    ///      split existed, which is why this assertion's number did not move
    ///      when `TAX_BPS` went 70 → 100.  The platform's 30 bps is new money
    ///      out of the trader's pocket, not out of the reservoir's.
    function test_buyTax_splitsOnePercentEthBetweenReservoirAndPlatform() public {
        (, ToshLaunchpadHook hook) = _launchProject("BuyTax", "BTX", alice, address(0));

        uint256 nativeIn = 1 ether;
        uint256 before = address(ladder).balance;
        uint256 platformBefore = platformTreasury.balance;

        _swapBuy(hook, trader, nativeIn);

        uint256 reservoirCut = address(ladder).balance - before;
        uint256 platformCut = platformTreasury.balance - platformBefore;

        assertEq(reservoirCut, (nativeIn * 70) / 10_000, "0.7% of input ETH must reach the reservoir");
        assertEq(platformCut, (nativeIn * 30) / 10_000, "0.3% of input ETH must reach the platform");
        assertEq(reservoirCut + platformCut, (nativeIn * 100) / 10_000, "and together they must be the whole 1.0% tax");
    }

    /// @dev A CONTRACT platform treasury whose `receive()` costs far more than
    ///      the 2300-gas stipend must still be payable — because production's
    ///      is one.
    ///
    ///      `PLATFORM_TREASURY` is planned to be the 2-of-3 owner Safe, and a
    ///      Safe is not a cheap recipient: it emits `SafeReceived`, and a
    ///      measured plain send to a 1.4.1 Safe on chain 46630 used 29,944 gas,
    ///      roughly 8,900 of it inside the Safe.  Every other test here points
    ///      the fee at `makeAddr(...)`, a bare EOA that would be payable even
    ///      through a 2300-gas `transfer()`, so none of them can distinguish a
    ///      chain that forwards all gas from one that forwards a stipend.
    ///
    ///      That distinction is not ours to choose.  v4-core's
    ///      `CurrencyLibrary.transfer` sends native value with
    ///      `call(gas(), to, amount, 0, 0, 0, 0)`, forwarding everything left.
    ///      A Safe works as the fee recipient BECAUSE of that line, not by
    ///      margin — swap it for a stipend and this test is the one that
    ///      notices, which matters because `platformFeeRecipient` is immutable
    ///      on both the factory and the hook implementation.  Getting it wrong
    ///      is a factory redeploy and a migration of every pool.
    function test_buyTax_paysAPlatformTreasuryThatCostsRealGasToPay() public {
        vm.etch(platformTreasury, address(new SafeCostReceiver()).code);

        (, ToshLaunchpadHook hook) = _launchProject("SafeCost", "SFC", alice, address(0));

        uint256 nativeIn = 1 ether;
        uint256 platformBefore = platformTreasury.balance;

        _swapBuy(hook, trader, nativeIn);

        assertEq(
            platformTreasury.balance - platformBefore,
            (nativeIn * 30) / 10_000,
            "a Safe-shaped recipient must be paid the same 0.3% as an EOA"
        );

        // State the margin rather than implying it: this recipient really does
        // cost more than a stipend would have carried, so the assertion above
        // is evidence about gas forwarding and not just about arithmetic.
        uint256 gasBefore = gasleft();
        (bool ok,) = platformTreasury.call{value: 1 wei}("");
        uint256 receiveCost = gasBefore - gasleft();
        assertTrue(ok, "recipient must accept a plain send");
        assertGt(receiveCost, 2300, "recipient must be dearer than a transfer() stipend, or this test proves nothing");
    }

    /// @dev And the other edge of the same knife: a fee recipient that REVERTS
    ///      takes every buy on every pool down with it.
    ///
    ///      This is asserted rather than merely warned about in a comment, so
    ///      that nobody later "hardens" the fee payment into a try/catch and
    ///      quietly converts a loud, immediate, total failure into silent fee
    ///      loss.  The loudness is the safer behaviour here: the address is
    ///      immutable, so a swallowed error would mean bleeding 0.3% of every
    ///      buy into a reverting contract forever with nothing to show for it.
    ///
    ///      v4-core bubbles the failure up as `NativeTransferFailed`, wrapped
    ///      by the router, hence the untyped `expectRevert`.
    ///      Not written with `_swapBuy`, and the reason is a trap worth naming:
    ///      that helper passes `hook.getPoolKey()` as an argument, so the pool
    ///      key is fetched by an external call that Solidity evaluates BEFORE
    ///      the swap. `expectRevert` would bind to that getter, watch it return
    ///      a pool key perfectly happily, and report "next call did not revert"
    ///      — a failure that looks exactly like the protocol being fine. The
    ///      key is read up front so the next call really is the swap.
    function test_buyTax_revertingPlatformTreasuryBricksEveryBuy() public {
        vm.etch(platformTreasury, address(new RevertingReceiver()).code);

        (, ToshLaunchpadHook hook) = _launchProject("Brick", "BRK", alice, address(0));
        PoolKey memory key = hook.getPoolKey();

        uint256 nativeIn = 1 ether;
        vm.prank(trader);
        vm.expectRevert();
        router.swap{value: nativeIn}(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(nativeIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            _swapSettings(),
            ""
        );
    }

    /// @dev Sell leg: the FULL 1.0% of the INPUT TOKENS is burned in place, and
    ///      is NOT split.  No ETH moves and the platform is paid nothing.
    ///
    ///      This is the deliberate asymmetry.  The sell leg's input is the
    ///      project's own token, so paying the platform's cut in kind would
    ///      accumulate illiquid bags of every project's token; burning the
    ///      whole thing keeps the leg deflationary and the platform ETH-only.
    function test_sellTax_burnsTheFullOnePercentOfTokensInPlace() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("SellTax", "STX", alice, address(0));
        vm.prank(alice);
        hook.claimGenesis();

        uint256 tokensIn = 100_000e18;
        uint256 deadBefore = token.balanceOf(DEAD);
        uint256 ladderBefore = address(ladder).balance;
        uint256 platformTokBefore = token.balanceOf(platformTreasury);
        uint256 platformEthBefore = platformTreasury.balance;

        _swapSell(hook, alice, tokensIn);

        assertEq(token.balanceOf(DEAD) - deadBefore, (tokensIn * 100) / 10_000, "1.0% of input tokens must be burned");
        assertEq(address(ladder).balance, ladderBefore, "the sell leg must not route ETH to the treasury");
        assertEq(token.balanceOf(platformTreasury), platformTokBefore, "the platform must not be paid in tokens");
        assertEq(platformTreasury.balance, platformEthBefore, "nor in ETH on this leg");
    }

    /// @notice Exact-output buy: specified is TOKEN, but the tax must still
    ///         land on the ETH input.  Otherwise every aggregator buy is
    ///         constructed as "N tokens out" and the reservoir never fills.
    function test_buyTax_exactOutputSkimsEthNotTokens() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("BuyXOut", "BXO", alice, address(0));

        uint256 tokensOut = 10_000e18;
        uint256 deadBefore = token.balanceOf(DEAD);
        uint256 ladderBefore = address(ladder).balance;
        uint256 platformBefore = platformTreasury.balance;
        uint256 ethBefore = address(this).balance;

        vm.prank(trader);
        router.swap{value: 10 ether}(
            hook.getPoolKey(),
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: int256(tokensOut), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            _swapSettings(),
            ""
        );

        uint256 nativeSpent = ethBefore - address(this).balance;
        uint256 reservoirCut = address(ladder).balance - ladderBefore;
        uint256 platformCut = platformTreasury.balance - platformBefore;

        // Exact-output is EXCLUSIVE: the tax is charged on the input the pool
        // consumed and the trader pays it on top, so the base is `nativeSpent`
        // minus the whole skim, not `nativeSpent`.
        uint256 poolIn = nativeSpent - reservoirCut - platformCut;

        assertEq(reservoirCut, (poolIn * 70) / 10_000, "0.7% of the ETH input must reach the reservoir");
        assertEq(platformCut, (poolIn * 30) / 10_000, "0.3% of the ETH input must reach the platform");
        assertEq(
            reservoirCut + platformCut, (poolIn * 100) / 10_000, "the split must conserve the whole 1.0% skim on X-out"
        );
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
        uint256 platformEthBefore = platformTreasury.balance;
        uint256 tokBefore = token.balanceOf(alice);

        PoolKey memory key = hook.getPoolKey();
        vm.startPrank(alice);
        IERC20(address(token)).approve(address(router), type(uint256).max);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: false, amountSpecified: int256(ethOut), sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1
            }),
            _swapSettings(),
            ""
        );
        vm.stopPrank();

        uint256 tokSpent = tokBefore - token.balanceOf(alice);
        uint256 burned = token.balanceOf(DEAD) - deadBefore;
        uint256 poolIn = tokSpent - burned;
        assertEq(burned, (poolIn * 100) / 10_000, "1.0% of the token input must burn");
        assertEq(address(ladder).balance, ladderBefore, "exact-output sell must not fund the treasury");
        assertEq(platformTreasury.balance, platformEthBefore, "nor pay the platform: the sell leg is never split");
        assertEq(token.balanceOf(platformTreasury), 0, "and the platform is never paid in project tokens");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  6b. The buy-leg split
    //
    //  The buy leg's 1.00 % skim divides 70/30 between the buyback reservoir
    //  and the platform.  Three things have to hold, and only the first is
    //  about revenue:
    //
    //    1. each side gets its own rate off the ETH input;
    //    2. the two sum to EXACTLY the credit the hook claimed from V4 — this
    //       is a liveness property, not an accounting nicety.  Both call sites
    //       hand V4 a hook delta of `tax`; take less and the swap reverts
    //       `CurrencyNotSettled`, take more and the hook draws currency it was
    //       never credited.  A split that does not conserve does not mispay,
    //       it makes the pool untradeable;
    //    3. the sell leg is not split at all.
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Conservation, over the whole range of inputs a trader might use.
    ///
    /// @dev    This is the invariant that keeps the pool tradeable, so it is
    ///         fuzzed rather than sampled.  Note what is asserted and what is
    ///         not: the SUM is pinned exactly at every input, but the reservoir
    ///         is only pinned to its own 70 bps where the input is large enough
    ///         for that rate to be exact.
    ///
    ///         Below 334 wei the platform's floor division drops its share to
    ///         zero and the reservoir takes the whole tax — strictly more than
    ///         70 bps of the input.  That is the documented dust bias and the
    ///         reason `reservoirCut` is `tax - platformCut` rather than its own
    ///         multiplication.  Asserting each cut independently everywhere
    ///         would fail there, and "fixing" it by giving the reservoir its
    ///         own multiplication would break conservation instead.
    ///
    ///         `_swapBuy` bounds the low end at something the pool will price,
    ///         so the wei-scale end of that range is covered by PROBE D in
    ///         `ToshV5Attack.t.sol` where inputs are dust by construction.
    function testFuzz_buyTax_splitAlwaysConservesTheCreditedTax(uint256 ethInRaw) public {
        (, ToshLaunchpadHook hook) = _launchProject("FuzzSplit", "FZS", alice, address(0));

        uint256 nativeIn = bound(ethInRaw, 1e6, 5 ether);
        vm.deal(trader, nativeIn);

        uint256 ladderBefore = address(ladder).balance;
        uint256 platformBefore = platformTreasury.balance;

        _swapBuy(hook, trader, nativeIn);

        uint256 reservoirCut = address(ladder).balance - ladderBefore;
        uint256 platformCut = platformTreasury.balance - platformBefore;
        uint256 tax = (nativeIn * hook.TAX_BPS()) / 10_000;

        assertEq(reservoirCut + platformCut, tax, "the two cuts must sum to the tax V4 was told about");
        assertEq(platformCut, (nativeIn * hook.PLATFORM_SWAP_FEE_BPS()) / 10_000, "platform takes its own rate");
        assertEq(reservoirCut, tax - platformCut, "reservoir takes the remainder, never its own product");
        assertGe(reservoirCut, (nativeIn * _reservoirBps(hook)) / 10_000, "and dust may only ever favour the buyback");
    }

    /// @notice `PlatformSwapFeePaid` fires on a buy and never on a sell.
    ///
    /// @dev    The event is how an indexer separates platform revenue from
    ///         buyback fuel, and the two legs report differently on purpose:
    ///         a buy emits `BuyTaxToTreasury` (the reservoir's 70 bps) AND
    ///         `PlatformSwapFeePaid` (the platform's 30), while a sell emits
    ///         only `SellTaxBurned` carrying the whole skim.  An indexer that
    ///         summed `PlatformSwapFeePaid` across both legs and got a non-zero
    ///         sell-side figure would be reporting revenue that does not exist.
    function test_platformSwapFeePaid_firesOnBuysAndNeverOnSells() public {
        (, ToshLaunchpadHook hook) = _launchProject("EvtSplit", "EVS", alice, address(0));
        vm.prank(alice);
        hook.claimGenesis();

        uint256 nativeIn = 1 ether;

        vm.expectEmit(true, false, false, true, address(hook));
        emit ToshLaunchpadHook.PlatformSwapFeePaid(platformTreasury, (nativeIn * 30) / 10_000);
        _swapBuy(hook, trader, nativeIn);

        // The sell leg must emit `SellTaxBurned` for the FULL skim and no
        // platform event at all.  `recordLogs` rather than a negative
        // `expectEmit`, which cannot express "this never appears".
        uint256 tokensIn = 100_000e18;
        vm.recordLogs();
        _swapSell(hook, alice, tokensIn);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool sawBurn;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook)) continue;
            assertTrue(
                logs[i].topics[0] != ToshLaunchpadHook.PlatformSwapFeePaid.selector,
                "the sell leg must never pay the platform"
            );
            if (logs[i].topics[0] == ToshLaunchpadHook.SellTaxBurned.selector) {
                sawBurn = true;
                assertEq(abi.decode(logs[i].data, (uint256)), (tokensIn * 100) / 10_000, "burn carries the whole 1 %");
            }
        }
        assertTrue(sawBurn, "the sell leg must still report its burn");
    }

    /// @notice The platform's cut is taken from the TRADER, not from the
    ///         buyback: arming the piggyback still takes the same volume it
    ///         always did.
    ///
    /// @dev    The failure this rules out is the plausible reading of "split
    ///         the tax 70/30" — that the reservoir's existing 70 bps was
    ///         divided rather than the trader's bill raised.  Under that
    ///         reading the reservoir would receive 49 bps, `TRIGGER_STEP` would
    ///         need ~715 BNB of volume instead of ~500, and the buyback engine
    ///         would quietly slow by 30 % with no test failing: every existing
    ///         assertion is either about the tax total or about a balance the
    ///         fixture `vm.deal`s directly.
    ///
    ///         Measured as the volume actually required, not as a rate, because
    ///         the rate is what the plausible-but-wrong version also gets right.
    function test_platformCut_doesNotSlowTheBuybackArmingVolume() public {
        (, ToshLaunchpadHook hook) = _launchProject("ArmVol", "AVL", alice, address(0));

        uint256 nativeIn = 1 ether;
        uint256 before = address(ladder).balance;
        vm.deal(trader, nativeIn);
        _swapBuy(hook, trader, nativeIn);

        uint256 inflowPerEth = address(ladder).balance - before;
        assertEq(inflowPerEth, 0.007 ether, "the reservoir must still fill at 70 bps of buy volume");

        // Volume to arm one buyback, rounded up. Unchanged from before the split.
        uint256 volumeToArm = (ladder.TRIGGER_STEP() + inflowPerEth - 1) / inflowPerEth;
        assertEq(volumeToArm, 500, "arming still takes ~500 BNB of buy volume, exactly as it did at a flat 0.7 %");
    }

    /// @notice `TAX_BPS` and `PLATFORM_TAX_BPS` are both 100 and mean entirely
    ///         different things.  Referenced from the natspec on `TAX_BPS`.
    ///
    /// @dev    The hazard is purely one of reading: two constants thirty lines
    ///         apart share a literal, so a maintainer changing "the 1 %" can
    ///         easily change the wrong one, and a reviewer checking that "the
    ///         1 % is charged once" can convince themselves of it by finding
    ///         either.  They apply to DIFFERENT BASES on DIFFERENT PATHS and
    ///         never to the same wei:
    ///
    ///           `TAX_BPS`          — 1 % of a SWAP INPUT, split on the buy leg
    ///                                between reservoir and platform, burned
    ///                                whole on the sell leg. Charged in
    ///                                `beforeSwap` / `afterSwap`.
    ///           `PLATFORM_TAX_BPS` — 1 % of PHASE-2 SHELF PROCEEDS, routed
    ///                                entirely to the buyback reservoir, with
    ///                                the other 99 % going to `projectAdmin`.
    ///                                Charged in `mintBondingCurve`, which
    ///                                never touches the pool.
    ///
    ///         So this test drives both paths and shows each rate applying to
    ///         its own base — and, the part worth having, that a shelf mint
    ///         pays no swap tax and a swap pays no shelf cut.  If the two ever
    ///         did overlap, the same ETH would be charged twice and neither
    ///         constant's documentation would be wrong on its face.
    function test_taxRates_areDistinctPathsDespiteSharedLiteral() public {
        (, ToshLaunchpadHook hook) = _launchProject("TwoRates", "TWR", alice, address(0));

        assertEq(hook.TAX_BPS(), hook.PLATFORM_TAX_BPS(), "premise: the literal really is shared");

        // ── Path 1: a shelf mint. `PLATFORM_TAX_BPS` of the COST reaches the
        //    reservoir; the rest reaches the project. No burn, no platform fee
        //    recipient, no pool.
        _openLadder(hook, 0.01 ether);

        uint256 want = 1_000e18;
        uint256 cost = hook.quoteMint(want);

        uint256 ladderBefore = address(ladder).balance;
        uint256 projectBefore = projTreasury.balance;
        uint256 platformBefore = platformTreasury.balance;

        vm.deal(bob, cost);
        vm.prank(bob);
        hook.mintBondingCurve{value: cost}(want);

        uint256 shelfCut = address(ladder).balance - ladderBefore;
        assertEq(shelfCut, (cost * hook.PLATFORM_TAX_BPS()) / 10_000, "shelf cut is 1 % of the MINT COST");
        assertEq(projTreasury.balance - projectBefore, cost - shelfCut, "and the project takes the other 99 %");
        assertEq(platformTreasury.balance, platformBefore, "a shelf mint pays the swap tax's recipient nothing");

        // ── Path 2: a swap. `TAX_BPS` of the INPUT is skimmed and split; the
        //    project's admin receives nothing at all, because a swap is not a
        //    mint and the shelf cut never applies to it.
        _nextBlock();

        uint256 nativeIn = 1 ether;
        ladderBefore = address(ladder).balance;
        projectBefore = projTreasury.balance;
        platformBefore = platformTreasury.balance;

        vm.deal(trader, nativeIn);
        _swapBuy(hook, trader, nativeIn);

        uint256 reservoirCut = address(ladder).balance - ladderBefore;
        uint256 platformCut = platformTreasury.balance - platformBefore;

        assertEq(reservoirCut + platformCut, (nativeIn * hook.TAX_BPS()) / 10_000, "swap tax is 1 % of the SWAP INPUT");
        assertEq(projTreasury.balance, projectBefore, "a swap pays the shelf cut's counterparty nothing");

        // The two bases are unrelated quantities: neither figure is derivable
        // from the other, which is the concrete sense in which they never apply
        // to the same wei.
        assertTrue(cost != nativeIn, "fixture: the two bases must actually differ");
        assertTrue(shelfCut != reservoirCut + platformCut, "so the two 1 % charges are different amounts of ETH");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  7. Piggyback buyback engine  [v5.0 acceptance test]
    // ══════════════════════════════════════════════════════════════════════════

    function test_ladderCuration_listsALaunchedTokenAtItsCanonicalPool() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject("Curate", "CUR", alice, address(0));

        _matureTwap();
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

    /// @dev A hook that has not run `launch()` has no pool, so there is no venue
    ///      to spend into.
    ///
    ///      This was once caught incidentally: the hook stored its pool key at
    ///      launch, so an unlaunched hook returned a zero key and tripped the
    ///      `currency1` check.  The hook now restates the key from constants
    ///      instead of storing it, which is well-formed before launch too, so
    ///      the treasury asks the hook whether it is live and reverts with
    ///      `PoolNotLaunched`.
    function test_ladderCuration_rejectsUnlaunchedProjects() public {
        (ToshToken token,) = _createProject("Unlaunched", "UNL");

        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.PoolNotLaunched.selector);
        ladder.addLadderToken(address(token));
    }

    /// @notice Once the reservoir crosses 1 ETH, the next swap on ANY Tosh pool
    ///         gives the buyback engine a ride: `max(1 ETH, 10% of balance)` is
    ///         divided by `BATCH_SIZE` and one such slice is market-bought and
    ///         burned to 0xdead.
    ///
    /// @dev    A pot sitting exactly at `TRIGGER_STEP` funds one leg and then
    ///         falls back below the trigger, so the round is NOT completed here
    ///         — the remaining slices wait for tax to re-arm it.  That is the
    ///         intended cadence: throughput is unchanged (every `spend /
    ///         BATCH_SIZE` of fresh tax buys one leg, where it used to take a
    ///         full `spend` to buy three), the deployment is just finer-grained
    ///         and easier on the pools it lands in.
    ///
    ///         Coverage of the whole ladder is asserted by
    ///         `test_piggybackRunsOneLegPerPokeAndStillCoversTheLadder`, which
    ///         keeps the pot armed across a full round.
    function test_treasuryPiggybackRoundRobin() public {
        // One pool to trigger from, plus a three-token ladder.
        (, ToshLaunchpadHook trigger) = _launchProject("Trigger", "TRG", alice, address(0));
        (ToshToken tokenB,) = _launchProject("LadderB", "LDB", alice, address(0));
        (ToshToken tokenC,) = _launchProject("LadderC", "LDC", alice, address(0));
        (ToshToken tokenD,) = _launchProject("LadderD", "LDD", alice, address(0));

        _matureTwap();
        vm.startPrank(admin);
        ladder.addLadderToken(address(tokenB));
        ladder.addLadderToken(address(tokenC));
        ladder.addLadderToken(address(tokenD));
        vm.stopPrank();

        assertEq(ladder.ladderTokenCount(), 3);
        assertEq(ladder.currentCursor(), 0);

        // Arm the engine.
        vm.deal(address(ladder), ladder.TRIGGER_STEP());
        assertEq(ladder.untilNextTrigger(), 0, "reservoir should be armed");

        uint256 deadB = tokenB.balanceOf(DEAD);
        uint256 deadC = tokenC.balanceOf(DEAD);
        uint256 deadD = tokenD.balanceOf(DEAD);

        // Any swap now carries ONE leg along with it, not the whole batch, so no
        // single trader is billed for three V4 swaps on top of their own.
        _swapBuy(trigger, trader, 0.5 ether);

        assertGt(tokenB.balanceOf(DEAD), deadB, "the triggering trade serves the cursor token");
        assertEq(tokenC.balanceOf(DEAD), deadC, "and is billed for that one only");
        assertEq(tokenD.balanceOf(DEAD), deadD, "and is billed for that one only");
        assertEq(ladder.currentCursor(), 1, "the cursor advances one leg");

        // A slice came out of a pot that was only at the floor, which puts it
        // back under the trigger — so the round pauses here rather than
        // draining the reservoir in one transaction.
        assertLt(address(ladder).balance, ladder.TRIGGER_STEP(), "a floor-sized pot funds one leg, then disarms");
        vm.prank(dave);
        vm.expectRevert(ToshLadderTreasury.NotArmed.selector);
        ladder.pokeBuyback();
    }

    /// @notice A full reservoir spends 10 % per cycle, not a 1 ETH drip.
    ///
    /// @dev    A cycle is now three pokes rather than one, since legs run one at
    ///         a time — so the cycle is completed here with `pokeBuyback()`
    ///         rather than by hoping three legs ride a single trade.  The
    ///         property is unchanged and still measured on ETH that actually
    ///         left the reservoir.
    function test_piggyback_spendsTenPercentOnceThePotIsFull() public {
        (, ToshLaunchpadHook trigger) = _launchProject("FullPot", "FPT", alice, address(0));
        (ToshToken tokenB,) = _launchProject("FullB", "FPB", alice, address(0));
        (ToshToken tokenC,) = _launchProject("FullC", "FPC", alice, address(0));
        (ToshToken tokenD,) = _launchProject("FullD", "FPD", alice, address(0));

        _matureTwap();
        vm.startPrank(admin);
        ladder.addLadderToken(address(tokenB));
        ladder.addLadderToken(address(tokenC));
        ladder.addLadderToken(address(tokenD));
        vm.stopPrank();

        vm.deal(address(ladder), 50 ether);
        assertEq(ladder.nextSpendAmount(), 5 ether, "10% of 50 ETH");

        uint256 before = address(ladder).balance;

        // Leg one rides the trade; the remaining two are poked directly.
        _swapBuy(trigger, trader, 0.5 ether);
        vm.prank(dave);
        ladder.pokeBuyback();
        vm.prank(dave);
        ladder.pokeBuyback();

        // The 10% slice is the OFFER, and the `nextSpendAmount()` assertion
        // above is where that claim is made good.  What the legs then SPEND is
        // a different quantity, and it is not evidence about the offer.
        //
        // This assertion read `assertGt(spent, 1 ether)` until 2026-09-11 and
        // passed for one reason: these pools were listed straight after
        // `launch()`, so their TWAP read zero, so `_buybackSqrtFloor` fell
        // back to unbounded and each leg filled all the way down the curve.
        // `addLadderToken` now refuses a pool in that state, `_matureTwap()`
        // above ages them first, and the deviation band is live for all three
        // legs.  The old number was a measurement of the unbounded path, taken
        // by a test that never said so.
        //
        // Under the band the offer stops mattering at all.  Measured on a
        // single leg into a fresh ~0.9 ETH-deep genesis pool:
        //
        //     pot  1 ETH -> offer 1 ETH -> spent 100_329_788_532_604_040 wei
        //     pot 50 ETH -> offer 5 ETH -> spent 100_329_788_532_604_040 wei
        //
        // Equal to the wei, with the same burn.  A five-fold larger offer buys
        // nothing, because `MAX_BUYBACK_SQRT_DEVIATION_BPS` binds long before
        // the offer does.  "A full pot outspends the floor" is therefore not a
        // weaker claim than it was — it is the wrong claim.
        //
        // The correction term is what the swap ADDED to this balance, which is
        // the reservoir's 70 bps share and not the whole 100 bps skim — the
        // platform's 30 bps went to a different address. The number is the
        // same one this line has always carried, but it means the reservoir's
        // rate now rather than the tax rate.
        uint256 reservoirIn = (0.5 ether * _reservoirBps(trigger)) / 10_000;
        uint256 spent = before + reservoirIn - address(ladder).balance;
        // Three bounded legs, measured at 0.3009 ETH.  Tight on both sides on
        // purpose: losing the price bound again would push this far above the
        // upper limit, and legs quietly ceasing to fill would drop it below the
        // lower one.
        assertGt(spent, 0.29 ether, "three bounded legs must fill");
        assertLt(spent, 0.35 ether, "the band, not the offer, is what caps the spend");
        assertGt(tokenB.balanceOf(DEAD), 0);
        assertGt(tokenC.balanceOf(DEAD), 0);
        assertGt(tokenD.balanceOf(DEAD), 0);
    }

    function test_piggyback_staysIdleBelowTriggerStep() public {
        (, ToshLaunchpadHook trigger) = _launchProject("Idle", "IDL", alice, address(0));
        (ToshToken tokenB,) = _launchProject("IdleB", "IDB", alice, address(0));

        _matureTwap();
        vm.prank(admin);
        ladder.addLadderToken(address(tokenB));

        // Reservoir holds only launch fees + orphan referrals, well under the
        // trigger.
        assertLt(address(ladder).balance, ladder.TRIGGER_STEP());
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

        _matureTwap();
        vm.startPrank(admin);
        ladder.addLadderToken(address(tokenB));
        ladder.addLadderToken(address(tokenC));
        vm.stopPrank();

        // Break C's delivery leg only.
        vm.mockCallRevert(address(tokenC), abi.encodeWithSelector(IERC20.transfer.selector), "broken token");

        vm.deal(address(ladder), ladder.TRIGGER_STEP());
        uint256 deadBefore = tokenB.balanceOf(DEAD);

        // The swap must still succeed.
        _swapBuy(trigger, trader, 0.2 ether);

        assertGt(tokenB.balanceOf(DEAD), deadBefore, "the healthy leg still executes");
    }

    /// @notice The piggyback mutex has two layers and the suite only ever
    ///         reached one. This reaches the other.
    ///
    /// @dev    A 2026-09 sweep flagged the gap against itself: every
    ///         ladder token is a Tosh token, so each leg swaps through another
    ///         Tosh pool, whose hook reads `piggybackActive()` in `beforeSwap`
    ///         and goes passive BEFORE poking us. That outer layer returns
    ///         early, so `_runPiggyback`'s own `if (piggybackActive()) return;`
    ///         was never reached by any test.
    ///
    ///         It is defence in depth, not dead code, and the case it defends
    ///         is the dangerous one: a ladder entry whose pool re-enters the
    ///         treasury directly, where the outer layer does not exist at all.
    ///         §5.7 called that "not constructible from the current fixtures".
    ///         It is constructible by etching — the factory keys `registeredHooks`
    ///         by ADDRESS, not by code, so replacing a listed hook's code models
    ///         a hook that misbehaves without forging a registration. That is
    ///         also the honest threat model: `addLadderToken` is `onlyOwner` and
    ///         checks provenance, so the way an attacker-controlled callee gets
    ///         inside the loop is a listed hook going bad, not an unlisted token
    ///         getting listed.
    ///
    ///         Measured with the guard deleted, and again with it inverted:
    ///         the re-entrant call starts a second cycle from inside the first,
    ///         re-reads the cursor (unchanged, since the outer loop writes it
    ///         only at the end), and swaps the same pool again — which
    ///         re-enters `beforeSwap`, which re-enters again, until the nested
    ///         leg dies and `try/catch` swallows the whole thing as
    ///         `BuybackSkipped`. Nothing is bought, and the hostile hook's own
    ///         counter rolls back with the leg, which is why the first
    ///         assertion below is the one that trips.
    ///
    ///         So the guard is not merely tidy. Without it a single bad listing
    ///         turns every poke into a no-op for the token at the cursor, and
    ///         the round-robin never gets past it.
    function test_piggyback_innerMutexHoldsAgainstAReentrantLadderHook() public {
        (ToshToken tokenB, ToshLaunchpadHook hookB) = _launchProject("ReentB", "RNB", alice, address(0));
        (ToshToken tokenC,) = _launchProject("ReentC", "RNC", alice, address(0));

        _matureTwap();
        vm.startPrank(admin);
        ladder.addLadderToken(address(tokenB));
        ladder.addLadderToken(address(tokenC));
        vm.stopPrank();

        // B is at the cursor, so B's hook is the one that runs inside the leg.
        assertEq(ladder.currentCursor(), 0, "the first leg must be the token we made hostile");

        // Etched AFTER listing: `addLadderToken` reads the venue off the real
        // hook, and the point here is a hook that turns hostile once listed.
        ReentrantLadderHook hostile = new ReentrantLadderHook(ladder);
        vm.etch(address(hookB), address(hostile).code);

        vm.deal(address(ladder), ladder.TRIGGER_STEP());
        uint256 burnedBefore = tokenB.balanceOf(DEAD);

        vm.recordLogs();
        vm.prank(dave);
        ladder.pokeBuyback();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // 1. The attack happened, once, and the leg survived it. Without this
        //    the rest is vacuous — a test that proves a guard holds because
        //    nothing ever reached it is the hole this test exists to close.
        //
        //    This is also the assertion that trips when the guard is removed,
        //    and not for the reason you would guess: the runaway nesting kills
        //    the leg, `try/catch` swallows it, and the counter rolls back to 0
        //    with everything else the leg touched.
        uint256 attempts = uint256(vm.load(address(hookB), bytes32(_REENTRANT_HOOK_CALLS_SLOT)));
        assertEq(attempts, 1, "the hostile hook must have re-entered exactly once, and the leg must survive it");

        // 2. The buyback still delivered. A guard that holds by aborting the
        //    leg would satisfy every other assertion here.
        assertGt(tokenB.balanceOf(DEAD), burnedBefore, "the leg must still buy and burn under the attack");

        // 3. It bought nothing twice. One poke, one cycle, one accounting event.
        uint256 executed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == ToshLadderTreasury.PiggybackExecuted.selector) ++executed;
        }
        assertEq(executed, 1, "a re-entrant hook must not start a second cycle");

        // 4. The flag is not left raised, which would wedge every later poke.
        assertFalse(ladder.piggybackActive(), "the transient mutex must be clear on the way out");
        assertEq(ladder.currentCursor(), 1, "the cursor advances by exactly one leg");
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

        _matureTwap();
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

        _matureTwap();
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
        (uint160 spotSqrt,,,) = poolManager.getSlot0(victimHook.getPoolKey().toId());
        assertLt(spotSqrt, (uint256(twapSqrt) * 9000) / 10_000, "fixture must clear the 1000bps sqrt bound");

        vm.deal(address(ladder), ladder.TRIGGER_STEP());
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

        _matureTwap();
        vm.prank(admin);
        ladder.addLadderToken(address(healthy));

        vm.warp(block.timestamp + 1900);
        _nextBlock();
        assertGt(healthyHook.twapSqrtPriceX96(), 0, "fixture needs an established TWAP");

        vm.deal(address(ladder), ladder.TRIGGER_STEP());
        uint256 deadBefore = healthy.balanceOf(DEAD);

        _swapBuy(trigger, trader, 0.1 ether);

        assertGt(healthy.balanceOf(DEAD), deadBefore, "an honest pool must still be bought and burned");
        assertLt(address(ladder).balance, ladder.TRIGGER_STEP(), "the reservoir must actually spend");
    }

    /// @notice The three fields packed into `LadderState` still fit the constants
    ///         that bound them.
    ///
    /// @dev    The one check standing between a retune of `TIER_COUNT` or
    ///         `TIER_SIZE` and silent fund loss.  Packing writes those values
    ///         through `uint16`/`uint88`/`uint96` casts, and Solidity does not
    ///         check explicit downcasts — so a constant grown past its field
    ///         truncates rather than reverting, and the ladder would quietly
    ///         resell shelves it had already sold.
    ///
    ///         Asserted against the constants rather than against observed
    ///         values on purpose: the point is to fail at the moment somebody
    ///         edits a constant, not once a live ladder happens to climb high
    ///         enough to wrap.
    function test_ladderStateWidthsFitTheirConstants() public {
        (, ToshLaunchpadHook hook) = _launchProject("Widths", "WID", alice, address(0));

        assertLe(hook.TIER_COUNT(), type(uint16).max, "TIER_COUNT outgrew LadderState.tierIndex");
        assertLe(hook.TIER_SIZE(), type(uint88).max, "TIER_SIZE outgrew LadderState.tierSold");
        assertLe(hook.BONDING_MAX(), type(uint96).max, "BONDING_MAX outgrew LadderState.minted");

        // And that the three really do share one slot, which is the entire
        // reason for the casts above. Slot numbers are not asserted — those move
        // with any storage edit — only that the three do not disagree.
        assertEq(hook.currentTierIndex(), 0, "a fresh ladder starts on shelf zero");
        assertEq(hook.currentTierSold(), 0, "with nothing sold from it");
        assertEq(hook.phase2Minted(), 0, "and nothing minted");
    }

    /// @notice `afterSwap` skips the piggyback poke below the arming threshold,
    ///         using its own copy of the treasury's `TRIGGER_STEP`.  If the two
    ///         ever drift, the buyback either stops firing or starts paying for
    ///         a pointless call on every trade — both quiet failures.
    function test_piggybackTriggerMirrorsTheTreasury() public {
        (, ToshLaunchpadHook hook) = _launchProject("Mirror", "MIR", alice, address(0));
        assertEq(
            hook.PIGGYBACK_TRIGGER_STEP(),
            ladder.TRIGGER_STEP(),
            "the hook's poke gate must be the treasury's arming threshold"
        );
    }

    /// @notice The skip is an optimisation, not a behaviour change: a reservoir
    ///         at exactly the threshold must still fire.
    ///
    /// @dev    Guards the boundary specifically, because the hook uses `>=` and
    ///         the treasury's `_nextSpendAmount` uses `<` to return zero.  An
    ///         off-by-one either way would strand the reservoir one wei short
    ///         of every trigger, which no balance-agnostic test would catch.
    function test_piggybackFiresExactlyAtTheThreshold() public {
        (, ToshLaunchpadHook trigger) = _launchProject("TrigEx", "TGX", alice, address(0));
        (ToshToken healthy,) = _launchProject("HealthyEx", "HLX", alice, address(0));

        _matureTwap();
        vm.prank(admin);
        ladder.addLadderToken(address(healthy));

        vm.warp(block.timestamp + 1900);
        _nextBlock();

        vm.deal(address(ladder), ladder.TRIGGER_STEP());
        uint256 deadBefore = healthy.balanceOf(DEAD);

        _swapBuy(trigger, trader, 0.01 ether);

        assertGt(healthy.balanceOf(DEAD), deadBefore, "a reservoir at the threshold must still buy and burn");
    }

    /// @notice One wei short of the threshold, nothing is spent.
    ///
    /// @dev    The reservoir has to be funded to `threshold - inflow - 1`, not
    ///         to `threshold - 1`: this swap's own buy-side skim is `take`n to
    ///         the treasury during `beforeSwap`, so the balance the gate reads
    ///         in `afterSwap` already includes it.  Dealing `threshold - 1`
    ///         arms the buyback instead of leaving it idle, which is how the
    ///         first draft of this test failed.
    ///
    ///         ⚠ `inflow` is the RESERVOIR'S SHARE, not `TAX_BPS`.  Since the
    ///         platform's 30 bps was carved out of the skim, only 70 bps of the
    ///         input reaches this balance; using `TAX_BPS` here overshoots by
    ///         30 bps and lands the fixture 30 bps ABOVE the threshold rather
    ///         than one wei below it, silently converting this test into a
    ///         duplicate of `test_piggybackFiresExactlyAtTheThreshold`.
    function test_piggybackStaysIdleOneWeiBelowTheThreshold() public {
        (, ToshLaunchpadHook trigger) = _launchProject("IdleEx", "IDX", alice, address(0));
        (ToshToken healthy,) = _launchProject("HealthyId", "HLI", alice, address(0));

        _matureTwap();
        vm.prank(admin);
        ladder.addLadderToken(address(healthy));

        vm.warp(block.timestamp + 1900);
        _nextBlock();

        uint256 nativeIn = 0.01 ether;
        uint256 inflow = (nativeIn * _reservoirBps(trigger)) / 10_000;
        vm.deal(address(ladder), ladder.TRIGGER_STEP() - inflow - 1);

        uint256 deadBefore = healthy.balanceOf(DEAD);

        _swapBuy(trigger, trader, nativeIn);

        assertEq(
            address(ladder).balance, ladder.TRIGGER_STEP() - 1, "fixture must land the reservoir exactly one wei short"
        );
        assertEq(healthy.balanceOf(DEAD), deadBefore, "nothing may be burned one wei below the threshold");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Gas budgets
    //
    //  The `--gas-report` table cannot answer "what does a trade cost", because
    //  most of its rows are averaged over fuzz and invariant runs whose call
    //  distribution is randomised — two runs of the same code report different
    //  medians.  Each test here measures ONE call in a fixed scenario, so the
    //  number moves only when the code does.
    //
    //  What is measured is the gas the call itself burns: `gasleft()` deltas
    //  exclude the 21,000 transaction base and the calldata cost, so add those
    //  for a wallet-facing estimate.
    //
    //  The budgets sit about 15 % above the figures observed under `--isolate`,
    //  which is the higher of the two modes: without it Foundry keeps storage
    //  warm across the whole test and understates every one of these. Run with
    //  `--isolate` for the number that matches mainnet.
    //
    //  15 % is meant to absorb a compiler upgrade without absorbing a cold
    //  SSTORE (20,000) or an added external call. A budget at 2x the real
    //  figure, which is where these started, catches nothing.
    //
    //  Only exact-input swaps are covered here. Exact-output takes a different
    //  path through the tax — `beforeSwap` defers to `afterSwap` — and its
    //  correctness is pinned by `test_buyTax_exactOutputSkimsEthNotTokens` and
    //  its sell-side twin rather than by a budget.
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice What a creator pays to open a project.
    ///
    /// @dev    The launch UI quotes this figure before the creator signs
    ///         (PM-F8), so it is not merely a regression budget: it is the
    ///         number a wallet is told to expect. `CREATE_LAUNCH_GAS` in
    ///         `soat-frontend/src/app/lib/launchGas.ts` mirrors the measured
    ///         value, and drifting past this budget means the quote is wrong,
    ///         not just that the code got heavier.
    ///
    ///         Both clone deployments are inside this call — the hook proxy and
    ///         the bare token proxy — which is why it dominates `launch()`
    ///         despite doing no pool work.
    function test_gas_createLaunch() public {
        bytes32 salt = _pickSalt(projTreasury, creator);
        uint256 fee = factory.launchFee();

        vm.prank(creator);
        uint256 before = gasleft();
        factory.createLaunch{value: fee}(
            "GasCreate",
            "GCR",
            projTreasury,
            projTreasury,
            salt,
            fee,
            factory.defaultSoftCap(),
            factory.maxPogAllocationLimit(),
            24 hours
        );
        uint256 used = before - gasleft();

        emit log_named_uint("createLaunch", used);
        emit log_named_uint("was, before the EIP-1167 clone refactor", 5_016_031);
        assertLt(used, 614_000, "createLaunch path regressed");
    }

    /// @notice The creator's second and final bill: seeding the pool once
    ///         genesis has succeeded.
    ///
    /// @dev    Quoted alongside `createLaunch` in the launch UI, because the
    ///         two together are what opening a project actually costs and a
    ///         creator who budgets only for the first one is stranded holding a
    ///         funded genesis they cannot open.
    ///
    ///         ⚠ THE BUDGET WENT UP 82k IN THE INFINITY PORT, from 578,000 to
    ///           660,000, and the measured figure with it — 655,948 against the
    ///           V4 path's ~577k. This is not a regression to chase down; it is
    ///           what the port costs, and it is raised rather than silently
    ///           relaxed so the number stays a guard.
    ///
    ///           ⚠ MEASURE THIS UNDER `--isolate`, WHICH IS WHAT CI RUNS. An
    ///             earlier pass at this budget read 612,384 from a plain
    ///             `forge test` and set 620,000 from it; `--isolate` charges the
    ///             cold storage a real transaction pays and reads 655,948, so
    ///             that budget was green locally and would have failed CI. The
    ///             43k gap between the two modes is larger than the headroom any
    ///             of these budgets carry, so the mode is not a detail.
    ///
    ///           The 34k buys the Vault indirection. V4 settled inside the
    ///           contract that held the balances, so `unlock` → `modifyLiquidity`
    ///           → `settle` stayed in one callee. Infinity puts the Vault in
    ///           front: `vault.lock` calls back into the hook, the hook calls
    ///           `poolManager.modifyLiquidity`, the manager calls back into the
    ///           Vault to account the delta, and the hook then makes two more
    ///           round trips to `sync`/`settle` each currency. Every one of those
    ///           is an external call across a contract boundary that used to be
    ///           internal.
    ///
    ///           Worth knowing because it lands on the creator, once, on a chain
    ///           where gas is cheap: at 1 gwei on BSC the extra 34k is about
    ///           0.000034 BNB. It would matter on a chain where it did not.
    function test_gas_launch() public {
        (, ToshLaunchpadHook hook) = _createProject("GasLaunch", "GLN");
        _deposit(alice, hook, SOFT_CAP, address(0));
        vm.warp(hook.genesisDeadline() + 1);

        vm.prank(creator);
        uint256 before = gasleft();
        hook.launch();
        uint256 used = before - gasleft();

        emit log_named_uint("launch", used);
        emit log_named_uint("was, on Uniswap V4 before the Infinity port", 577_000);
        assertLt(used, 660_000, "launch path regressed");
    }

    /// @notice A buy through the pool: the full router-to-hook path a trader
    ///         actually pays for.
    ///
    /// @dev    This is the number that matters for "is trading expensive". It
    ///         covers v4's own swap accounting plus both of our hook callbacks,
    ///         and the hook's share of it is the only part we control.
    ///
    ///         The ceiling rose when the buy-side tax was split: the leg now
    ///         settles TWO payouts, the reservoir's 70 bps and the platform's
    ///         30 bps, where it used to settle one.  A second recipient is a
    ///         second cold account touched and a second value transfer, and
    ///         that is a permanent cost of the split rather than a regression
    ///         to hunt.  `--isolate` is what surfaces it; a plain `forge test`
    ///         shares warmth across the run and reads ~9k lower, so trust CI's
    ///         number over a local one.
    function test_gas_swapBuy() public {
        (, ToshLaunchpadHook hook) = _launchProject("GasSwap", "GSW", alice, address(0));
        _nextBlock();

        vm.prank(trader);
        uint256 before = gasleft();
        router.swap{value: 0.1 ether}(
            hook.getPoolKey(),
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(0.1 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            _swapSettings(),
            ""
        );
        uint256 used = before - gasleft();

        emit log_named_uint("swap buy, end to end", used);
        emit log_named_uint("ceiling, while the buy-side tax was a single payout", 228_000);
        assertLt(used, 253_000, "swap path regressed");
    }

    /// @notice The same buy again, one block later.
    ///
    /// @dev    Separated from the first swap on purpose.  The opening trade on a
    ///         fresh pool pays for slots nobody has touched yet — the oracle
    ///         accumulator, the TWAP checkpoints, the treasury's tax balance —
    ///         and that one-off cost is not what the tenth trader sees.  A
    ///         widening gap between this and `test_gas_swapBuy` means first-swap
    ///         initialisation is growing.
    function test_gas_swapBuy_warmPool() public {
        (, ToshLaunchpadHook hook) = _launchProject("GasSwap2", "GS2", alice, address(0));
        _nextBlock();
        _swapBuy(hook, trader, 0.1 ether);
        _nextBlock();

        vm.prank(trader);
        uint256 before = gasleft();
        router.swap{value: 0.1 ether}(
            hook.getPoolKey(),
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(0.1 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            _swapSettings(),
            ""
        );
        uint256 used = before - gasleft();

        emit log_named_uint("swap buy, warm pool", used);
        emit log_named_uint("was, on Uniswap V4 before the Infinity port", 192_000);

        // 195,949 under `--isolate`. The smallest rise of any budget in this file
        // — under 4k — and that is the informative part: the gap to
        // `test_gas_swapBuy`'s 252,726 barely moved, so the Vault's cost lands on
        // the warm path and the cold path alike rather than on first-swap
        // initialisation. The paragraph above says a widening gap means
        // initialisation is growing; it did not widen.
        assertLt(used, 200_000, "warm swap path regressed");
    }

    /// @notice A single-shelf Phase-2 mint — the ladder's own buy path, which
    ///         does not touch the pool at all.
    function test_gas_mintBondingCurve() public {
        (, ToshLaunchpadHook hook) = _launchProject("GasMint", "GMT", alice, address(0));
        _openLadder(hook, 0.01 ether);

        uint256 want = 1_000e18;
        uint256 cost = hook.quoteMint(want);

        vm.prank(bob);
        uint256 before = gasleft();
        hook.mintBondingCurve{value: cost}(want);
        uint256 used = before - gasleft();

        emit log_named_uint("mintBondingCurve, one shelf", used);
        emit log_named_uint("was, before LadderState was packed", 197_195);

        // 173.5k measured. The budget tracks the measurement rather than sitting
        // 30k above it, or packing the three shelf counters into one slot would
        // have been free to undo.
        assertLt(used, 182_000, "mint path regressed");
    }

    /// @notice What the piggyback costs the trader who triggers it, and that the
    ///         cost does not grow with the ladder.
    ///
    /// @dev    Legs used to run `min(ladderTokens.length, BATCH_SIZE)` per poke,
    ///         so this table read 342k / 460k / 579k and the worst case scaled
    ///         with how many tokens the owner had listed — a trader on a
    ///         three-token ladder was billed for three V4 swaps besides their
    ///         own. At one leg per poke the rows are flat, which is the property
    ///         asserted below: listing more tokens must never make a trade more
    ///         expensive.
    ///
    ///         Ladder gas does not scale with the ETH being spent — a leg is a
    ///         V4 swap whichever size it is — so raising the trigger threshold
    ///         would have made this rarer without making it smaller. That is why
    ///         the leg count, not the threshold, was the thing to change.
    function test_gas_piggybackCostPerLeg() public {
        uint256 unarmed = _measureArmedSwap(0);
        uint256 one = _measureArmedSwap(1);
        uint256 two = _measureArmedSwap(2);
        uint256 three = _measureArmedSwap(3);

        emit log_named_uint("unarmed swap", unarmed);
        emit log_named_uint("1 ladder token", one);
        emit log_named_uint("2 ladder tokens", two);
        emit log_named_uint("3 ladder tokens (BATCH_SIZE)", three);
        emit log_named_uint("was, at 3 legs per poke", 578_809);
        emit log_named_uint("was, on Uniswap V4 before the Infinity port", 420_000);

        // A second and third listing add bookkeeping, not legs. The flatness is
        // the property under test and it survived the port unchanged: 425,932 /
        // 445,847 / 445,869, so 20k of bookkeeping for the second listing and
        // 22 gas for the third.
        assertLt(three - one, 40_000, "peak cost must not scale with the ladder length");

        // 445,869 under `--isolate`, up ~26k on the V4 path. Same cause as every
        // other rise in this file: the leg is a swap, and a swap now settles
        // through the Vault. Raised to track the measurement rather than left
        // generous, so the flatness assertion above is not the only live guard.
        assertLt(three, 450_000, "armed swap regressed");
    }

    /// @notice A swap sized for an unarmed pool SURVIVES the reservoir arming:
    ///         the buyback stands down rather than taking the trade with it.
    ///
    /// @dev    A wallet estimates against the pool as it is, adds a buffer, and
    ///         signs.  If the reservoir crosses the trigger in the gap, the swap
    ///         suddenly needs ~137k more than was estimated.
    ///
    ///         Before the gas gate every row of this sweep read `trade DEAD`
    ///         below 350k, and `try/catch` did not help: the 63/64 rule leaves
    ///         the hook a sixty-fourth after the poke runs out, which does not
    ///         cover the rest of `afterSwap` plus V4 closing the unlock frame.
    ///         The trader paid for a revert on a trade that was never at fault.
    ///
    ///         Now the tight rows read `trade OK, buyback skipped`.  That the
    ///         two outcomes can differ at all is the property under test.
    function test_piggybackSkipsRatherThanKillingTheTrade() public {
        (, ToshLaunchpadHook trigger) = _launchProject("OOGTrig", "OOG", alice, address(0));
        (ToshToken healthy,) = _launchProject("OOGHealthy", "OGH", alice, address(0));

        _matureTwap();
        vm.prank(admin);
        ladder.addLadderToken(address(healthy));

        vm.warp(block.timestamp + 1900);
        _nextBlock();

        vm.deal(address(ladder), 10 ether);
        uint256 deadBefore = healthy.balanceOf(DEAD);
        uint256 traderTokensBefore = IERC20(address(trigger.projectToken())).balanceOf(trader);

        bytes memory callData = abi.encodeCall(
            CLPoolManagerRouter.swap,
            (
                trigger.getPoolKey(),
                ICLPoolManager.SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(0.01 ether),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
                }),
                _swapSettings(),
                ""
            )
        );

        // What the same trade costs with the reservoir empty — the number a
        // wallet would be quoted before the arming.  Measured, because it is
        // ~25 % lower under plain `forge test` than under `--isolate`, and a
        // sweep of absolute limits therefore means different things in the two
        // modes.  An earlier version hardcoded 250k..500k and asserted which
        // rows ran, which passed under `--isolate` and failed plain.
        uint256 snap = vm.snapshotState();
        vm.deal(address(ladder), 0);
        vm.prank(trader);
        uint256 probe = gasleft();
        (bool okBase,) = address(router).call{value: 0.01 ether, gas: 2_000_000}(callData);
        uint256 unarmed = probe - gasleft();
        assertTrue(okBase, "baseline swap must succeed");
        vm.revertToState(snap);

        emit log_named_uint("unarmed estimate", unarmed);

        // Buffers a wallet plausibly attaches to that quote, then one that is
        // unmistakably generous.
        uint256[5] memory pct = [uint256(115), 130, 150, 200, 400];

        for (uint256 i; i < pct.length; ++i) {
            uint256 inner = vm.snapshotState();
            uint256 limit = (unarmed * pct[i]) / 100;

            vm.prank(trader);
            (bool ok,) = address(router).call{value: 0.01 ether, gas: limit}(callData);

            bool traded = IERC20(address(trigger.projectToken())).balanceOf(trader) > traderTokensBefore;
            bool burned = healthy.balanceOf(DEAD) > deadBefore;

            emit log_named_string(
                string.concat(
                    "+",
                    vm.toString(pct[i] - 100),
                    "% (",
                    vm.toString(limit),
                    ") -> trade ",
                    traded ? "OK" : "DEAD",
                    ", buyback"
                ),
                burned ? "ran" : "skipped"
            );

            assertEq(ok, traded, "a reverted call must not have moved tokens");
            // The property: the trade settles on every budget, whether or not
            // the buyback comes along. Which budgets engage the gate is a
            // calibration question, and it belongs to the two tests below —
            // asserting it here would only re-pin absolute gas figures.
            assertTrue(traded, "the trade must settle at every one of these budgets");

            if (i == 0) {
                assertFalse(burned, "the tightest plausible budget must stand the buyback down");
            }
            if (i == pct.length - 1) {
                assertTrue(burned, "a generous budget must still carry the buyback");
            }

            vm.revertToState(inner);
        }
    }

    /// @notice The trade that TIPS the reservoir over the trigger — the one that
    ///         could not have known — settles on its own estimate.
    ///
    /// @dev    This is the case that made the gate necessary rather than nice.
    ///         The buy tax is `take`n to the treasury in `beforeSwap`, so a swap
    ///         can begin with the reservoir below the threshold and reach
    ///         `afterSwap` with it above.  The trade billed for a cycle was
    ///         therefore not "one signed in an unlucky window" but specifically
    ///         the marginal trade at every trigger, deterministically, every
    ///         cycle — and its wallet had estimated against an unarmed pool.
    ///
    ///         With the gate it skips instead, and the ETH waits for a swap that
    ///         budgeted for a buyback or for `pokeBuyback()`.
    function test_piggybackSparesTheTradeThatTipsIt() public {
        (, ToshLaunchpadHook trigger) = _launchProject("TipTrig", "TIP", alice, address(0));
        (ToshToken healthy,) = _launchProject("TipHealthy", "TPH", alice, address(0));

        _matureTwap();
        vm.prank(admin);
        ladder.addLadderToken(address(healthy));

        vm.warp(block.timestamp + 1900);
        _nextBlock();

        // One wei short of arming: this swap's own reservoir inflow is what
        // tips it.  That inflow is 70 bps, not `TAX_BPS` — the platform's
        // 30 bps is `take`n to a different address and never touches this
        // balance, so budgeting against the whole tax would leave the reservoir
        // 30 bps past the trigger before the swap even starts.
        uint256 nativeIn = 0.01 ether;
        uint256 inflow = (nativeIn * _reservoirBps(trigger)) / 10_000;
        vm.deal(address(ladder), ladder.TRIGGER_STEP() - inflow);

        uint256 deadBefore = healthy.balanceOf(DEAD);

        bytes memory callData = abi.encodeCall(
            CLPoolManagerRouter.swap,
            (
                trigger.getPoolKey(),
                ICLPoolManager.SwapParams({
                    zeroForOne: true, amountSpecified: -int256(nativeIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
                }),
                _swapSettings(),
                ""
            )
        );

        // What a wallet would have estimated: the same trade against a reservoir
        // that is not about to arm.  Measured rather than hardcoded, because the
        // figure differs by ~20 % between plain and `--isolate` runs and a magic
        // number would pass in one mode and fail in the other.
        uint256 snap = vm.snapshotState();
        vm.deal(address(ladder), 0);
        vm.prank(trader);
        uint256 before = gasleft();
        (bool okUnarmed,) = address(router).call{value: nativeIn, gas: 2_000_000}(callData);
        uint256 estimate = before - gasleft();
        assertTrue(okUnarmed, "baseline swap must succeed");
        vm.revertToState(snap);

        // Sign it with a 15 % buffer on that estimate, which is the tight end of
        // what a wallet attaches.
        vm.prank(trader);
        (bool okTight,) = address(router).call{value: nativeIn, gas: (estimate * 115) / 100}(callData);
        assertTrue(okTight, "the tipping trade must settle on its own estimate");
        assertEq(healthy.balanceOf(DEAD), deadBefore, "and must not have been billed for a buyback");
        // The ETH is not lost, only deferred.
        assertGe(address(ladder).balance, ladder.TRIGGER_STEP(), "the reservoir stays armed for the next poke");
        vm.revertToState(snap);

        // The same trade with room carries the cycle instead.
        vm.prank(trader);
        (bool okFunded,) = address(router).call{value: nativeIn, gas: estimate * 4}(callData);
        assertTrue(okFunded, "with headroom it goes through");
        assertGt(healthy.balanceOf(DEAD), deadBefore, "and picks up the buyback");
    }

    /// @notice The gate does not starve the buyback: a swap estimated against an
    ///         ARMED reservoir clears `PIGGYBACK_MIN_GAS` on an ordinary wallet
    ///         buffer and carries the cycle.
    ///
    /// @dev    The necessary complement to the two tests above.  They show the
    ///         gate declining when the budget is short, which a
    ///         `PIGGYBACK_MIN_GAS` of `type(uint256).max` would also do — and
    ///         that would quietly reduce the whole mechanism to `pokeBuyback()`,
    ///         with the reservoir never riding a trade again.
    ///
    ///         The estimate is taken the way a wallet takes it: simulate the
    ///         exact call against current state, which here already includes the
    ///         armed reservoir, then add 15 %.  So this pins that the ordinary
    ///         path still works, not merely that the failure path is safe.
    function test_piggybackStillRidesAProperlyEstimatedSwap() public {
        (, ToshLaunchpadHook trigger) = _launchProject("RideTrig", "RID", alice, address(0));
        (ToshToken healthy, ToshLaunchpadHook healthyHook) = _launchProject("RideHealthy", "RDH", alice, address(0));

        _matureTwap();
        vm.prank(admin);
        ladder.addLadderToken(address(healthy));

        vm.warp(block.timestamp + 1900);
        _nextBlock();

        vm.deal(address(ladder), 10 ether);
        uint256 deadBefore = healthy.balanceOf(DEAD);

        bytes memory callData = abi.encodeCall(
            CLPoolManagerRouter.swap,
            (
                trigger.getPoolKey(),
                ICLPoolManager.SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(0.01 ether),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
                }),
                _swapSettings(),
                ""
            )
        );

        // Both measurements below are taken against COLD storage, on purpose.
        //
        // Without this the two run modes disagree by ~50k on what a leg costs —
        // plain `forge test` carries warm slots between calls inside a test and
        // reports ~100k, `--isolate` charges them and reports ~149k — and the
        // bounds at the bottom compare that figure against a constant that does
        // not move with the mode. An earlier revision called those bounds
        // "mode-independent"; they were not, and the first constant that sat
        // near the cold floor broke the warm run.
        //
        // A real transaction starts cold, and the on-chain measurement this is
        // reconciled against (156,153 on 46630, §F.7) was a real transaction.
        // So cold is the accounting that corresponds to something, and
        // `vm.cool` is how both modes are made to report it.
        address[4] memory legPath = [address(healthy), address(healthyHook), address(ladder), address(poolManager)];

        // eth_estimateGas against the armed pool: the buyback is in the quote.
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < legPath.length; ++i) {
            vm.cool(legPath[i]);
        }
        vm.prank(trader);
        uint256 before = gasleft();
        (bool okSim,) = address(router).call{value: 0.01 ether, gas: 2_000_000}(callData);
        uint256 estimate = before - gasleft();
        assertTrue(okSim, "the simulation itself must succeed");
        assertGt(healthy.balanceOf(DEAD), deadBefore, "the simulated call must include a buyback");
        vm.revertToState(snap);

        emit log_named_uint("armed estimate", estimate);

        // The same trade with the reservoir empty.  The difference between the
        // two quotes is what one buy leg costs, measured in whichever gas
        // accounting this run is using.
        uint256 unarmedSnap = vm.snapshotState();
        vm.deal(address(ladder), 0);
        for (uint256 i; i < legPath.length; ++i) {
            vm.cool(legPath[i]);
        }
        vm.prank(trader);
        uint256 probe = gasleft();
        (bool okBase,) = address(router).call{value: 0.01 ether, gas: 2_000_000}(callData);
        uint256 unarmed = probe - gasleft();
        assertTrue(okBase, "baseline swap must succeed");
        vm.revertToState(unarmedSnap);

        uint256 legCost = estimate - unarmed;
        emit log_named_uint("one leg", legCost);

        // Find the buffer the gate demands on top of an honest quote.  Some
        // buffer is structurally unavoidable: `PIGGYBACK_TAIL_RESERVE` is by
        // definition larger than the tail it protects, so the gate always wants
        // slightly more headroom than the quote contains.
        uint256 required = type(uint256).max;
        for (uint256 pct = 105; pct <= 200; pct += 5) {
            uint256 inner = vm.snapshotState();

            vm.prank(trader);
            (bool ok,) = address(router).call{value: 0.01 ether, gas: (estimate * pct) / 100}(callData);
            bool burned = healthy.balanceOf(DEAD) > deadBefore;

            assertTrue(ok, "an honestly estimated swap must go through at any buffer");
            vm.revertToState(inner);

            if (burned) {
                required = pct - 100;
                break;
            }
        }

        emit log_named_uint("buffer the gate demands, %", required);

        // Logged, deliberately not bounded. The paragraph below explains why a
        // percentage is not comparable across gas accountings, and then an
        // `assertLt(required, 50)` sat here anyway — surviving only because the
        // constant it happened to be measuring cleared both modes. Raising
        // `PIGGYBACK_MIN_GAS` to its measured floor moved plain-mode from 45 %
        // to 55 % and it failed, in the mode that keeps storage warm and so
        // resembles no transaction anyone will ever send.
        //
        // What remains is the part that does not depend on the accounting: the
        // sweep has to find SOME buffer that produces a real burn. That is the
        // liveness property the percentage was standing in for — a gate set to
        // `type(uint256).max` fails here, which was the original worry — while
        // the two structural bounds below say how tightly the gate is placed.
        assertTrue(
            required != type(uint256).max,
            "no buffer up to 200% engaged the buyback: the gate has retired the mechanism"
        );

        // The hard check is structural rather than a percentage, because the
        // percentage is not comparable across gas accountings: `--isolate`
        // charges cold storage and measures 10 % here, while plain `forge test`
        // keeps everything warm, which shrinks the quote without shrinking this
        // absolute constant and measures 20 %.  Asserting a percentage would
        // pin one mode and break the other, as an earlier version did.
        //
        // What IS comparable is the rule the constant is built from — a tail
        // reserve plus one leg — since both sides are then measured in the same
        // accounting.  Any excess over that sum is exactly the extra headroom a
        // wallet has to attach beyond an honest quote, so this bounds the thing
        // the percentage was trying to say, in a mode-independent way.
        //
        // `PIGGYBACK_MIN_GAS = 260_000` overshot this by 61k under plain
        // accounting, which is the regression that prompted the check.
        //
        // ⚠ THIS BOUND AND THE ONE BELOW NOW BIND FROM OPPOSITE MODES, which is
        //   the thing to know before touching the constant. The Infinity port
        //   made a leg dearer, and it did so by different amounts in the two
        //   accountings — 164,880 cold, 150,580 warm. So the floor below is set
        //   by `--isolate` and the ceiling here by plain mode, leaving a window
        //   of [264,880, 290,580] that any admissible value has to sit inside.
        //   270,000 does. A value chosen to clear the cold floor comfortably
        //   would breach this ceiling, and the failure would show up in whichever
        //   mode was not the one it was measured in.
        assertLe(
            trigger.PIGGYBACK_MIN_GAS(),
            trigger.PIGGYBACK_TAIL_RESERVE() + legCost + 40_000,
            "PIGGYBACK_MIN_GAS demands more than a tail reserve plus one leg"
        );

        // And the same rule from below, which is the half that was missing.
        //
        // The bound above stops the constant drifting so high that the gate
        // retires the mechanism. Nothing stopped it sitting too LOW, and it did:
        // at 230,000 the gate admitted a poke, forwarded `230_000 - 100_000` and
        // handed one leg 130k to do 149k of work. The leg ran out, `try/catch`
        // swallowed it, and the trade survived — so no test failed and no user
        // saw anything except a slightly larger bill. The only trace is a
        // `PiggybackPokeFailed` nobody was watching for.
        //
        // The waste is bounded and the buyback is recoverable through
        // `pokeBuyback()`, so this is an efficiency bug rather than a custody
        // one. It is worth a hard assertion anyway, because the band it creates
        // is invisible from every direction: the swap succeeds, the buyback is
        // merely absent, and absence is what this mechanism looks like when it
        // is working normally on an unarmed reservoir.
        //
        // ⚠ AND IT CAUGHT THE INFINITY PORT, which is the reason to say so here
        //   rather than leave the paragraph reading like history. The leg went
        //   from 148,986 to 164,880 while the constant stayed at 260,000, which
        //   put it 4,880 under the floor — the same silent band described above,
        //   arrived at from the other direction: nobody lowered the gate, the
        //   work underneath it got dearer. Every other test in this suite passed.
        //
        // Measured on Robinhood 46630 at 156,153 for the same leg on Uniswap V4,
        // 4.8 % above what the local `--isolate` run computed then. That premium
        // was ArbOS accounting and does not carry to BSC, so the local cold
        // figure is the one this now compares against — pending an on-chain
        // re-measurement once 97 is live.
        assertGe(
            trigger.PIGGYBACK_MIN_GAS(),
            trigger.PIGGYBACK_TAIL_RESERVE() + legCost,
            "PIGGYBACK_MIN_GAS admits a poke it cannot fund: the leg will run out of gas"
        );
    }

    /// @notice `pokeBuyback()` deploys the reservoir with no swap to ride.
    ///
    /// @dev    The liveness backstop for the gas gate.  Without this, a market
    ///         where every trade runs a tight limit would leave the reservoir
    ///         armed forever: `autoPiggybackBuyback` is `onlyHook` and
    ///         `executeBuyAndBurn` is `onlySelf`, so there was no other door in.
    function test_pokeBuyback_deploysWithoutASwap() public {
        (ToshToken healthy,) = _launchProject("PokeHealthy", "PKH", alice, address(0));

        _matureTwap();
        vm.prank(admin);
        ladder.addLadderToken(address(healthy));

        vm.warp(block.timestamp + 1900);
        _nextBlock();

        vm.deal(address(ladder), 10 ether);
        uint256 deadBefore = healthy.balanceOf(DEAD);
        uint256 reservoirBefore = address(ladder).balance;

        // Permissionless: an address with no role and no stake in the platform.
        vm.prank(dave);
        ladder.pokeBuyback();

        assertGt(healthy.balanceOf(DEAD), deadBefore, "tokens bought and burned");
        assertLt(address(ladder).balance, reservoirBefore, "the reservoir actually spent");
    }

    /// @notice A treasury buyback is a swap, so it must shut the same-block
    ///         mint lockout exactly like any other swap.
    ///
    /// @dev    This is the branch the rest of the lockout suite cannot reach.
    ///         `test_mintBondingCurve_revertsInASwapBlock`, `:1018`, `:1247` and
    ///         `ToshV5Attack.t.sol:169` all drive the pool with `_swapSell`,
    ///         which enters `afterSwap` as the router — the one sender that has
    ///         always been stamped. `afterSwap` returns early for
    ///         `sender == ladderTreasury`, and that early return skipped the
    ///         stamp along with the tax it was written to skip. So the suite
    ///         read as though the lockout was thoroughly pinned while the
    ///         uncovered branch was open.
    ///
    ///         It matters because `pokeBuyback()` is permissionless and has no
    ///         cooldown, and every call performs a real swap on the target
    ///         pool. Unstamped, any address could move spot repeatedly inside
    ///         one block and then mint against the raised
    ///         `_safeReferencePrice()` ceiling in that same block — measured at
    ///         5.15x spot and `maxMintable` going 0 -> 100_800e18 — which is
    ///         precisely what `SameBlockMintForbidden` exists to prevent.
    function test_pokeBuyback_shutsTheSameBlockMintLockout() public {
        (ToshToken healthy, ToshLaunchpadHook healthyHook) = _launchProject("PokeLockout", "PKL", alice, address(0));

        _matureTwap();
        vm.prank(admin);
        ladder.addLadderToken(address(healthy));

        vm.warp(block.timestamp + 1900);
        _nextBlock();

        vm.deal(address(ladder), 10 ether);

        // A block with no swap in it: the lockout is open, by construction.
        _nextBlock();
        assertLt(healthyHook.lastSwapBlock(), vm.getBlockNumber(), "fixture: lockout already shut");

        uint256 deadBefore = healthy.balanceOf(DEAD);

        vm.prank(dave);
        ladder.pokeBuyback();

        // Guard against a vacuous pass: if the leg had skipped, no swap would
        // have happened and there would be nothing to stamp.
        assertGt(healthy.balanceOf(DEAD), deadBefore, "fixture: the buyback leg did not fill");

        assertEq(healthyHook.lastSwapBlock(), vm.getBlockNumber(), "a buyback swap left the mint lockout open");
        assertEq(healthyHook.maxMintable(), 0, "shelf is still mintable in a swap block");
    }

    /// @notice An unarmed reservoir tells the caller so instead of silently
    ///         doing nothing.
    function test_pokeBuyback_revertsWhenUnarmed() public {
        (ToshToken healthy,) = _launchProject("PokeIdle", "PKI", alice, address(0));

        _matureTwap();
        vm.prank(admin);
        ladder.addLadderToken(address(healthy));

        vm.deal(address(ladder), ladder.TRIGGER_STEP() - 1);

        vm.prank(dave);
        vm.expectRevert(ToshLadderTreasury.NotArmed.selector);
        ladder.pokeBuyback();
    }

    /// @notice An armed reservoir with nothing listed is also unarmed, in the
    ///         only sense that matters.
    function test_pokeBuyback_revertsWithAnEmptyLadder() public {
        vm.deal(address(ladder), 10 ether);

        vm.prank(dave);
        vm.expectRevert(ToshLadderTreasury.NotArmed.selector);
        ladder.pokeBuyback();
    }

    /// @notice `lockAcquired` is reachable only through the Vault.
    ///
    /// @dev    The Vault calls back only the address that called `lock`, so the
    ///         guard is belt-and-braces — but it is the one function on the
    ///         treasury that would otherwise run a buyback for an arbitrary
    ///         caller.
    ///
    ///         The guard moved with the frame in the Infinity port: it used to
    ///         name the pool manager, because V4's manager both held the balances
    ///         and opened the frame. Infinity split those, and `lock` went with
    ///         the balances.
    function test_lockAcquired_rejectsEveryoneButTheVault() public {
        vm.prank(dave);
        vm.expectRevert(ToshLadderTreasury.OnlyVault.selector);
        ladder.lockAcquired("");

        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.OnlyVault.selector);
        ladder.lockAcquired("");
    }

    /// @notice Legs run one per poke, so the same three pools are served across
    ///         three trades rather than billing one trader for all of them.
    ///
    /// @dev    Each pool must still receive `spend / BATCH_SIZE`, unchanged from
    ///         when a single poke ran the whole batch — that is what keeps the
    ///         peak-cost fix free of a slippage cost.
    function test_piggybackRunsOneLegPerPokeAndStillCoversTheLadder() public {
        (ToshToken a,) = _launchProject("LegA", "LGA", alice, address(0));
        (ToshToken b,) = _launchProject("LegB", "LGB", alice, address(0));
        (ToshToken c,) = _launchProject("LegC", "LGC", alice, address(0));

        _matureTwap();
        vm.startPrank(admin);
        ladder.addLadderToken(address(a));
        ladder.addLadderToken(address(b));
        ladder.addLadderToken(address(c));
        vm.stopPrank();

        vm.warp(block.timestamp + 1900);
        _nextBlock();

        assertEq(ladder.LEGS_PER_POKE(), 1, "one leg per poke");

        vm.deal(address(ladder), 10 ether);

        // One poke, one burn.
        vm.prank(dave);
        ladder.pokeBuyback();
        assertGt(a.balanceOf(DEAD), 0, "first poke serves the cursor token");
        assertEq(b.balanceOf(DEAD), 0, "and only that one");
        assertEq(c.balanceOf(DEAD), 0, "and only that one");
        assertEq(ladder.currentCursor(), 1, "cursor advances by one leg");

        vm.prank(dave);
        ladder.pokeBuyback();
        assertGt(b.balanceOf(DEAD), 0, "second poke serves the next");

        vm.prank(dave);
        ladder.pokeBuyback();
        assertGt(c.balanceOf(DEAD), 0, "third poke completes the round");
        assertEq(ladder.currentCursor(), 0, "and wraps");
    }

    /// @dev Launch a trigger pool plus `ladderCount` listed ladder pools, arm the
    ///      reservoir, and return the gas the triggering swap burns.
    function _measureArmedSwap(uint256 ladderCount) internal returns (uint256) {
        uint256 snap = vm.snapshotState();

        (, ToshLaunchpadHook trigger) = _launchProject("PeakTrig", "PKT", alice, address(0));

        ToshToken[] memory pools = new ToshToken[](ladderCount);
        for (uint256 i; i < ladderCount; ++i) {
            // The two `string.concat`s are hoisted rather than passed inline.
            // Inline, this call site is the one expression in the suite that
            // `forge coverage --ir-minimum` cannot stack-allocate, and it takes
            // the whole coverage build down with it (`scripts/coverage.ps1`).
            string memory nm = string.concat("Peak", vm.toString(i));
            string memory sym = string.concat("PK", vm.toString(i));
            (ToshToken t,) = _launchProject(nm, sym, alice, address(0));
            pools[i] = t;
        }

        // Every ladder pool needs an established TWAP, or `_buybackSqrtFloor`
        // falls back to unbounded and skips work a live pool would do.
        //
        // Two things were wrong here, and they hid each other.  `vm.warp(
        // block.timestamp + 1900)` warped the clock BACKWARD to 1901 from
        // 172_803 (see `_warpBy`), which made `twapSqrtPriceX96()` revert on
        // an underflow, which `_buybackSqrtFloor` absorbs as "unbounded" — so
        // this helper measured the unbounded path while its own comment
        // claimed otherwise.  `_warpBy` reads the clock through a cheatcode.
        //
        // The listings also had to move below the warp.  Since 2026-09-11
        // `addLadderToken` refuses a pool whose TWAP reads zero, so listing
        // inside the launch loop above now reverts `TwapNotMature` on the
        // first iteration.  One warp still covers every pool, because they
        // were all launched before it.  What this measures is the swap, so
        // the reordering does not move the number.
        _warpBy(1900);
        _nextBlock();

        for (uint256 i; i < ladderCount; ++i) {
            vm.prank(admin);
            ladder.addLadderToken(address(pools[i]));
        }

        vm.deal(address(ladder), 10 ether);

        vm.prank(trader);
        uint256 before = gasleft();
        router.swap{value: 0.01 ether}(
            trigger.getPoolKey(),
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(0.01 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            _swapSettings(),
            ""
        );
        uint256 used = before - gasleft();

        vm.revertToState(snap);
        return used;
    }

    /// @notice A genesis deposit through the factory, including the PoG quota
    ///         bookkeeping and the referral accrual.
    function test_gas_deposit() public {
        (, ToshLaunchpadHook hook) = _createProject("GasDep", "GDP");
        _ensurePoG(bob);

        vm.prank(bob);
        uint256 before = gasleft();
        factory.deposit{value: 0.1 ether}(address(hook), address(0));
        uint256 used = before - gasleft();

        emit log_named_uint("deposit", used);
        assertLt(used, 211_000, "deposit path regressed");
    }

    /// @dev CLPoolManagerRouter refunds unspent `msg.value` to the caller after an
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
/// @notice A recipient that costs real gas to pay, standing in for a Gnosis
///         Safe as `PLATFORM_TREASURY`.
///
/// @dev    A Safe's `receive()` emits `SafeReceived`; measured on 46630, a
///         plain send to a 1.4.1 Safe cost 29,944 gas total. The exact figure
///         is not what matters and is not reproduced here — what matters is
///         being decisively above the 2300-gas stipend, which the storage write
///         guarantees. `receive` is `payable` and does not revert, which is the
///         other half of what production's recipient must satisfy.
contract SafeCostReceiver {
    event Got(address indexed from, uint256 amount);

    uint256 public total;

    receive() external payable {
        total += msg.value;
        emit Got(msg.sender, msg.value);
    }
}

/// @notice A recipient that refuses ETH, to pin down what that costs the
///         protocol. See `test_buyTax_revertingPlatformTreasuryBricksEveryBuy`.
contract RevertingReceiver {
    receive() external payable {
        revert("I will not take your money");
    }
}

/// @notice A listed hook that has gone bad: it calls the treasury back from
///         inside the buyback leg it is being paid by.
///
/// @dev    Etched over a real, listed hook's address. The factory keys
///         `registeredHooks` by address rather than by code, so swapping the
///         code past `onlyHook` is what a compromised or malicious listing
///         looks like from the treasury's side.
///
///         The V4 return types are spelled as their underlying primitives —
///         `int256` for `BeforeSwapDelta`, `int256` for `BalanceDelta`. Those
///         are user-defined value types, so the canonical signature (and hence
///         the selector, and hence what the PoolManager decodes) is identical,
///         and the mock needs no v4 type imports to stay ABI-compatible.
contract ReentrantLadderHook {
    ToshLadderTreasury internal immutable TREASURY;

    constructor(ToshLadderTreasury treasury) {
        TREASURY = treasury;
    }

    /// @dev The hostile call. `beforeSwap` runs inside `_buyAndBurn`'s
    ///      `poolManager.swap`, which runs inside `_runPiggyback`'s loop, which
    ///      runs with the transient mutex raised — so this is the re-entry the
    ///      inner guard exists for.
    function beforeSwap(address, PoolKey calldata, ICLPoolManager.SwapParams calldata, bytes calldata)
        external
        returns (bytes4, int256, uint24)
    {
        // Hoisted: inline assembly takes direct number constants only, and this
        // one is derived from a keccak256.
        uint256 slot = _REENTRANT_HOOK_CALLS_SLOT;
        assembly ("memory-safe") {
            sstore(slot, add(sload(slot), 1))
        }
        TREASURY.autoPiggybackBuyback();
        return (ReentrantLadderHook.beforeSwap.selector, int256(0), uint24(0));
    }

    function afterSwap(address, PoolKey calldata, ICLPoolManager.SwapParams calldata, int256, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        return (ReentrantLadderHook.afterSwap.selector, int128(0));
    }

    /// @dev `_buybackSqrtFloor` reads this before the swap. Zero means "no
    ///      reference yet", which sends the leg down the already-documented
    ///      unbounded path rather than reverting it — keeping this test about
    ///      the mutex and nothing else.
    function twapSqrtPriceX96() external pure returns (uint160) {
        return 0;
    }
}

contract FreeRider {
    receive() external payable {}

    function mint(ToshLaunchpadHook hook, uint256 amount, uint256 cost) external returns (uint256) {
        return hook.mintBondingCurve{value: cost}(amount);
    }

    /// @dev Settings are spelled out rather than shared with
    ///      `ToshV5Test._swapSettings()`: this is a separate contract, so the
    ///      helper is not in scope. Same two choices — withdraw real tokens,
    ///      settle by transfer.
    function sell(CLPoolManagerRouter router, PoolKey calldata key, uint256 tokensIn) external {
        IERC20(Currency.unwrap(key.currency1)).approve(address(router), type(uint256).max);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: false, amountSpecified: -int256(tokensIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1
            }),
            CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true}),
            ""
        );
    }
}
