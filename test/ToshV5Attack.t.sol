// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Vault} from "infinity-core/src/Vault.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";
import {IHooks} from "infinity-core/src/interfaces/IHooks.sol";
import {ICLHooks} from "infinity-core/src/pool-cl/interfaces/ICLHooks.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {IPoolManager} from "infinity-core/src/interfaces/IPoolManager.sol";
import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {CLPoolParametersHelper} from "infinity-core/src/pool-cl/libraries/CLPoolParametersHelper.sol";

import {ToshFactory} from "../src/ToshFactory.sol";
import {ToshLaunchpadHook} from "../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../src/ToshLadderTreasury.sol";
import {ToshToken} from "../src/ToshToken.sol";
import {HookAddress} from "../src/libraries/HookAddress.sol";
import {MockQuoteAsset} from "./utils/MockQuoteAsset.sol";

/// @notice RED-TEAM PROBES — adversarial exploration of the v5.0 "Scheme B"
///         (8.4 M genesis / 12.6 M ladder) configuration.
///
/// @dev    These are deliberately written as PROBES, not as invariant tests:
///         each one drives the system into an adversarial corner and asserts
///         what the code ACTUALLY does, so a future change that alters the
///         answer breaks the build and forces a conscious decision.
contract ToshV5AttackTest is Test {
    using MessageHashUtils for bytes32;
    using PoolIdLibrary for PoolKey;
    using CLPoolParametersHelper for bytes32;

    /// @dev Infinity names these the opposite of V4 and means the opposite by
    ///      them: V4 took `{takeClaims: false, settleUsingBurn: false}` where
    ///      this takes `{withdrawTokens: true, settleUsingTransfer: true}`. Both
    ///      say the same thing — hand over real tokens, settle by transferring
    ///      them. Reasoned out once in test/ToshV5.t.sol.
    function _swapSettings() internal pure returns (CLPoolManagerRouter.SwapTestSettings memory) {
        return CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true});
    }

    address internal admin = makeAddr("admin");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal attacker = makeAddr("attacker");
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
    uint256 internal constant POG_CAP = 10_000e8;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        pogSigner = vm.addr(pogSignerPk);

        // Vault first, and the manager registered with it before it may move any

        // balance. See test/ToshV5.t.sol for the full argument.

        vault = new Vault();

        poolManager = new CLPoolManager(IVault(address(vault)));

        vault.registerApp(address(poolManager));

        router = new CLPoolManagerRouter(IVault(address(vault)), ICLPoolManager(address(poolManager)));

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

        // Native for gas only.
        vm.deal(creator, 1000 ether);
        vm.deal(alice, 1000 ether);
        vm.deal(attacker, 10_000 ether);

        _endow(creator);
        _endow(alice);
        // The attacker gets more than anyone else, which is the point: several
        // tests here turn on whether a well-funded adversary can force an
        // outcome, and "they ran out of money" is never the answer being sought.
        _endow(attacker);
    }

    /// @dev Mint a quote balance and approve the factory and the router. See
    ///      `ToshV5Test._endow` for why the swap allowance names the router and
    ///      not the Vault.
    function _endow(address who) internal {
        quote.mint(who, 1_000_000e8);
        vm.startPrank(who);
        quote.approve(address(factory), type(uint256).max);
        quote.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Approve a freshly created hook for everyone `setUp` endowed.
    ///
    ///      `_endow` cannot cover per-project hooks: they do not exist until a test
    ///      creates one, and `mintBondingCurve` pulls from the buyer directly rather
    ///      than through the factory. Called from `_launchProject`, so every probe
    ///      that reaches the ladder has the allowance its native-settlement
    ///      ancestor never needed. See `ToshV5Test._approveHook` for why approving
    ///      eagerly does not weaken the refusal tests.
    function _approveHook(ToshLaunchpadHook hook) internal {
        address[3] memory actors = [creator, alice, attacker];
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            quote.approve(address(hook), type(uint256).max);
        }
    }

    /// @dev Set an exact quote balance, the way `vm.deal` set an exact native one.
    ///      Needed because the buyback reservoir's arming threshold is a token
    ///      balance now, and several tests here land it deliberately one base unit
    ///      either side of `TRIGGER_STEP`.
    function _setQuote(address who, uint256 amount) internal {
        uint256 held = quote.balanceOf(who);
        if (held > amount) {
            quote.burn(who, held - amount);
        } else if (held < amount) {
            quote.mint(who, amount - held);
        }
    }

    // ─── Harness ──────────────────────────────────────────────────────────────

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

    /// @dev Create + fund + launch, WITHOUT warping past the launch block, so
    ///      probes can inspect the state of the very block the pool opens in.
    function _launchProject(uint256 raise) internal returns (ToshToken token, ToshLaunchpadHook hook) {
        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (address t, address h) = factory.createLaunch{value: fee}(
            "Probe", "PRB", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
        token = ToshToken(t);
        hook = ToshLaunchpadHook(payable(h));
        _approveHook(hook);

        if (factory.pogQuota(alice) == 0) _registerPoG(alice, POG_CAP);
        vm.prank(alice);
        factory.deposit(address(hook), address(0), raise);

        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        hook.launch();
    }

    function _nextBlock() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev Buy `nativeIn` worth of token through the real V4 router (exact input).
    function _buy(ToshLaunchpadHook hook, address who, uint256 nativeIn) internal {
        PoolKey memory key = hook.getPoolKey();
        vm.prank(who);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(nativeIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
            }),
            _swapSettings(),
            ""
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE A — is Phase 2 really "SHUT" in the launch block?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // ORIGINAL FINDING.  The SHELF_PREMIUM_BPS natspec claimed:
    //
    //   "at launch `spot == p0` exactly, which sits ON the boundary rather than
    //    inside it, so Phase 2 opens SHUT"
    //
    // The gate is `if (tierPrice > ceiling) revert`, a STRICT comparison, and
    // both `shelfP0` and `ceiling` are `(x * 10500) / 10000` of the same `p0`.
    // Sitting ON the boundary therefore PASSED, and at a 10 ETH raise it did:
    // shelf 0 (3 150 tokens) was mintable in the launch block.
    //
    // FIX.  `launch()` now stamps `lastSwapBlock`, closing the launch block
    // outright regardless of which side of `p0` the truncated spot lands on.
    function test_probeA_shelfZeroInLaunchBlock() public {
        (, ToshLaunchpadHook hook) = _launchProject(1000e8);

        (,,, uint256 spot,, uint256 ceiling,) = hook.tierStatus();

        // The boundary condition that used to let it through is still there —
        // the fix does not pretend the arithmetic changed.
        assertEq(hook.tierPriceAt(0), ceiling, "shelf 0 still sits exactly ON the ceiling");
        assertGe(spot, hook.p0(), "and at this raise spot rounds up, not down");

        assertEq(hook.lastSwapBlock(), block.number, "launch stamps the block");
        assertEq(hook.maxMintable(), 0, "so the view reports nothing available");

        uint256 quoted = hook.quoteMint(1e18);
        vm.prank(attacker);
        vm.expectRevert(ToshLaunchpadHook.SameBlockMintForbidden.selector);
        hook.mintBondingCurve(1e18, quoted);

        // ...and it opens normally one block later, once the market qualifies.
        _nextBlock();
        assertEq(hook.maxMintable(), hook.TIER_SIZE(), "next block, shelf 0 is on sale as designed");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE A2 — the launch block shuts the SHELF, not the POOL
    // ══════════════════════════════════════════════════════════════════════════
    //
    // PROBE A pins `SameBlockMintForbidden` and is easy to over-read as "nothing
    // can be bought in the launch block". It says nothing about the pool, and the
    // pool is where the inventory is: genesis LP is 3,780,000 tokens — 18 % of
    // supply — seeded at `p0`, against a first shelf of 3,150. The shelf is ~1,200x
    // smaller than the float sitting in the book beside it.
    //
    // `beforeSwap` has no allowlist, no cooldown and no per-transaction cap, and
    // `nonReentrant` on `launch()` does not serialise a later swap in the same
    // TRANSACTION: `launch()` returns, the guard unlocks, and the creator — who
    // is the only address that can call `launch()`, and who therefore chooses the
    // block — can swap immediately after it. A searcher can backrun instead; BSC
    // blocks are ~0.75s.
    //
    // ⚠ THIS IS DELIBERATE AND THE TEST EXISTS TO SAY SO. Confirmed as intended
    //   on 2026-09-21: first-block pool flow is open, the creator may bundle, and
    //   searchers will backrun. It is written down here rather than left as an
    //   absence, because an absence reads as an oversight to the next person and
    //   because the shelf's defences make it easy to assume the pool shares them.
    //
    //   What bounds it is price, not permission. The sniper pays at least `p0`
    //   plus the 1 % hook tax plus the 0.3 % pool fee, and `p0` is the genesis
    //   price — so this is a privileged first look at the float, NOT a discount
    //   against the depositors who funded it. That is the property worth pinning,
    //   and it is what would break if the pool were ever seeded below `p0`.
    function test_probeA2_launchBlockPoolFlowIsOpenByDesign() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(10_000e8);

        // Same block as `launch()`, established the way PROBE A establishes it.
        assertEq(hook.lastSwapBlock(), block.number, "still in the launch block");

        // The shelf is shut — the contrast this probe exists to draw.
        uint256 quoted = hook.quoteMint(1e18);
        vm.prank(attacker);
        vm.expectRevert(ToshLaunchpadHook.SameBlockMintForbidden.selector);
        hook.mintBondingCurve(1e18, quoted);

        // The pool is not. 900 BEM is ~10 % of the genesis book at this raise,
        // which is ~285x the entire first shelf, and it needs no waiting and no
        // qualification.
        uint256 spend = 900e8;
        assertEq(token.balanceOf(attacker), 0, "attacker starts with nothing");
        _buy(hook, attacker, spend);

        uint256 bought = token.balanceOf(attacker);
        assertGt(bought, 0, "the launch-block pool buy is permitted");
        assertGt(bought, hook.TIER_SIZE() * 100, "and is not capped anywhere near a shelf");

        // Price is the bound, so assert on price. Average paid, in the same 1e18
        // quote-per-token scale as `p0`, must not undercut the genesis price.
        uint256 avgPaid = (spend * 1e18) / bought;
        assertGe(avgPaid, hook.p0(), "a launch-block sniper does not beat the genesis price");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE B — how fast can the TWAP be re-anchored to a pumped price?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // The hook keeps TWO checkpoints and rolls `_prev <- _cur` whenever a swap
    // lands `>= TWAP_WINDOW` after `_cur`.  An attacker who controls WHEN that
    // roll happens can collapse the averaging window down to the minimum.
    function test_probeB_twapReanchorSpeed() public {
        (, ToshLaunchpadHook hook) = _launchProject(10_000e8);

        uint256 t0 = block.timestamp;
        console2.log("p0", hook.p0());

        // 1. Pump hard.
        _nextBlock();
        _buy(hook, attacker, 20_000e8);
        (,,, uint256 spotAfterPump,, uint256 ceilAfterPump,) = hook.tierStatus();
        console2.log("spot after pump ", spotAfterPump);
        console2.log("ceil after pump ", ceilAfterPump);
        console2.log("maxMintable now ", hook.maxMintable());

        // 2. Hold for exactly one TWAP_WINDOW, then poke with a dust swap so the
        //    checkpoint rolls to the pumped era.
        uint32 w = hook.TWAP_WINDOW();
        vm.warp(t0 + w);
        _nextBlock();
        _buy(hook, attacker, 1 wei);

        vm.warp(t0 + 2 * uint256(w) + 1);
        _nextBlock();
        _buy(hook, attacker, 1 wei);

        vm.warp(t0 + 2 * uint256(w) + 2);
        _nextBlock();
        (,,, uint256 spot2, uint256 twap2, uint256 ceil2,) = hook.tierStatus();
        console2.log("--- two windows after launch, one after the pump ---");
        console2.log("TWAP_WINDOW", uint256(w));
        console2.log("spot ", spot2);
        console2.log("twap ", twap2);
        console2.log("ceil ", ceil2);
        console2.log("maxMintable", hook.maxMintable());

        // The depth of the oracle IS TWAP_WINDOW: hold a price for one and the
        // average converges on it.  Raising the constant raises the price of
        // the hold; it does not change the shape.  Pinned so a future edit to
        // TWAP_WINDOW has to restate what it bought.
        assertApproxEqRel(twap2, spot2, 0.001e18, "one held window re-anchors the TWAP onto spot");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE B′ — the OTHER end of the window: what happens when nobody trades?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // PROBE B above measures how far the averaging window can be COLLAPSED. It
    // cannot see this case, and the reason is worth stating: its fixture hand-
    // feeds a dust swap at `t0 + w` and another at `t0 + 2w + 1`, which is
    // exactly the trading pattern that keeps the window inside its documented
    // `[TWAP_WINDOW, 2 x TWAP_WINDOW)` bracket. Remove those two swaps and the
    // same fixture produces a multi-day window. So the suite pinned the lower
    // bound and left the upper one unasserted.
    //
    // The upper bound is not enforced by the clock. `_writeObservation` rolls
    // the checkpoint only when a SWAP arrives, so on a pool that goes quiet
    // `span = now - _prevCheckpointTs` grows without limit — measured at
    // 608_400 s (7.04 days) on a weekly-traded pool.
    //
    // The harm is in the treasury. `_buybackSqrtFloor` anchors every leg at
    // `0.9 x twapSqrt`, so a fossilised high average puts the floor ABOVE spot,
    // V4 rejects the leg with `PriceLimitAlreadyExceeded`, and the treasury
    // skips. Measured before the fix: a floor 4.81x above spot, decaying only
    // through the `lastTick` extrapolation term, with the first fill on DAY
    // 105. The token that gets starved this way is by definition the thinly
    // traded one — precisely the one the buyback exists to support.
    //
    // The fix is not to clamp `span`: `delta` spans the full period, so
    // dividing it by a truncated span would report an average that never
    // happened. It is that a pool with NO trade in a full window has a
    // trivially known average — the price was flat at `lastTick` for the whole
    // window, so that IS the TWAP.
    function test_probeB2_quietPoolTwapDoesNotFossilise() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(10_000e8);
        PoolKey memory key = hook.getPoolKey();
        uint256 t0 = block.timestamp;

        // A long, HIGH-priced history, laid down by sparse trading so the
        // stale checkpoint ends up a week behind rather than 30 minutes.
        _nextBlock();
        _buy(hook, attacker, 20_000e8);

        vm.warp(t0 + 7 days);
        _nextBlock();
        _buy(hook, attacker, 1 wei);

        // The drawdown, then silence.
        vm.warp(t0 + 14 days);
        _nextBlock();
        _dumpAll(hook, token);

        vm.warp(t0 + 14 days + 2000);
        _nextBlock();

        (uint160 spotSqrt,,,) = poolManager.getSlot0(key.toId());
        uint160 twapSqrt = hook.twapSqrtPriceX96();

        console2.log("quiet for (s)   ", uint256(2000));
        console2.log("spot sqrt       ", uint256(spotSqrt));
        console2.log("twap sqrt       ", uint256(twapSqrt));
        console2.log("twap as % of spot", (uint256(twapSqrt) * 100) / uint256(spotSqrt));

        // Nothing has traded for longer than a full window, so the trailing
        // window is flat by construction and the average is the spot price.
        assertApproxEqRel(
            uint256(twapSqrt),
            uint256(spotSqrt),
            0.001e18,
            "a pool that has not traded for a full window reports a fossilised average"
        );

        // The consequence, asserted directly: the floor must not lock the
        // reservoir out of a token just because that token is quiet.
        uint256 burned = _armAndPoke(token);
        assertGt(burned, 0, "the buyback skipped a quiet pool because its TWAP had fossilised");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE C — what does the ladder release at 2x, against WHICH float?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // The Scheme-B docs report the 2x release as a share of GENESIS_SUPPLY
    // (8.4 M).  But 3.78 M of that is locked inside the genesis LP position,
    // which no code path can remove.  Measure both denominators.
    function test_probeC_releaseDenominators() public view {
        uint256 GEN = 8_400_000e18;
        uint256 CLAIM = 4_620_000e18;
        uint256 LP = 3_780_000e18;
        uint256 TIER_SIZE = 3_150e18;

        // Shelves unlocked at a price multiple R: STEP^i <= R.
        uint256 unlockedAtTwoX = _shelvesUnlockedAt(2e18);
        uint256 released = unlockedAtTwoX * TIER_SIZE;

        console2.log("shelves unlocked at 2x", unlockedAtTwoX);
        console2.log("tokens released       ", released);
        console2.log("bps of GENESIS_SUPPLY ", (released * 10_000) / GEN);
        console2.log("bps of CLAIM float    ", (released * 10_000) / CLAIM);
        console2.log("bps of claim+released ", (released * 10_000) / (CLAIM + released));
        console2.log("LP locked (not float) ", LP);

        // The gap between the headline figure and the honest one is the finding,
        // so pin the gap rather than either number on its own.  13.7 % is what
        // the Scheme-B write-up quoted; 24.9 % is what the market is asked to
        // absorb, because the 3.78 M LP side never trades.
        assertEq((released * 10_000) / GEN, 1368, "headline: 13.7 % of GENESIS_SUPPLY");
        assertEq((released * 10_000) / CLAIM, 2488, "honest: 24.9 % of the tradeable float");
        assertEq(CLAIM + LP, GEN, "the two denominators differ by exactly the locked LP");
        assertGt(
            (released * 10_000) / CLAIM,
            (released * 10_000) / GEN,
            "any restatement must keep reporting the float denominator too"
        );
    }

    /// @dev Count of shelves whose price multiple `STEP^i` is <= `multiple`,
    ///      i.e. indices 0..n-1 (shelf 0 is always unlocked, STEP^0 == 1).
    function _shelvesUnlockedAt(uint256 multipleE18) internal pure returns (uint256 n) {
        uint256 STEP = 1_001_902_508_266_805_824;
        uint256 acc = 1e18;
        n = 1;
        while (n < 4000) {
            uint256 next = (acc * STEP) / 1e18;
            if (next > multipleE18) break;
            acc = next;
            ++n;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE G — atomically sandwich the treasury's piggyback buyback
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `autoPiggybackBuyback` fires from EVERY Tosh hook's `afterSwap`, so the
    // attacker chooses the moment it runs simply by swapping.  The buyback's
    // only protection is `_buybackSqrtFloor` = 0.9 x twapSqrt, which permits the
    // pool to sit ~23 % above TWAP in price terms before a leg stops filling.
    //
    // The spend is `max(1 ETH, 10 % of the reservoir)`, and a leg is always
    // that divided by BATCH_SIZE=3 — by the CONSTANT, not by how many tokens
    // happen to be listed, so a one-token ladder is handed a third of the
    // cheque rather than all of it.  (This probe measures it: a 100 ETH
    // reservoir sizes a 10 ETH cycle and spends 3.34 ETH on its single listed
    // pool.)
    //
    // What that leaves is a prize that still grows without limit.  0.33 ETH is
    // the per-leg FLOOR — what a reservoir between 1 and 10 ETH offers, where
    // the 1 ETH minimum is doing the sizing — and past 10 ETH the leg is
    // `balance / 30` and climbs with the pot.  The natspec's "0.33 ETH they
    // are trying to skim" is therefore the bottom of the range, not a bound on
    // it, and it understates a full treasury by whatever multiple that
    // treasury has grown by: 10x at the 100 ETH modelled here.
    //
    // ⚠ THIS PROBE USED TO MEASURE THE WRONG SIZE AND ASSERT NOTHING, which is
    //   two separate faults and the first one is the reason the second was never
    //   noticed. It pumped a flat 4,000 BEM at a leg of ~333 — TWELVE TIMES the
    //   prize — which is far enough past the floor that the band binds, the leg
    //   barely fills, and the round trip's own 1.3% friction on an oversized
    //   position swamps whatever was skimmed. A sandwich is sized to its
    //   victim; measuring one that is not tells you about the band, not about
    //   the attack. `test_buyback_refusesToFillIntoAManipulatedPrice` already
    //   covers the out-of-band shove, so the oversized case was the only one
    //   with two tests and the in-band case the only one with none.
    //
    //   So the pump is now DERIVED from `nextSpendAmount() / BATCH_SIZE` and
    //   swept around it. Deriving it is the point: a probe that hard-codes the
    //   prize stops tracking it the moment `SPEND_BPS`, `BATCH_SIZE` or
    //   `TRIGGER_STEP` moves, which is exactly how this one drifted.
    //
    //   And it asserts. The assertion is on the WORST size found, not on a
    //   chosen one, because an attacker sweeps too and the safe claim is about
    //   the maximum rather than about a sample.
    function test_probeG_sandwichThePiggyback() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(10_000e8);

        // Mature the TWAP so the buyback floor is live rather than unbounded.
        _nextBlock();
        _buy(hook, alice, 100e8);
        vm.warp(block.timestamp + 3601);
        _nextBlock();
        _buy(hook, alice, 1 wei);
        _nextBlock();

        vm.prank(admin);
        ladder.addLadderToken(address(token));

        // Fund the reservoir.  100 ETH is a modest figure for a platform that
        // routes every launch fee, every 1 % shelf cut and the 70 bps reservoir
        // share of every buy tax into a contract with no withdraw path.
        _setQuote(address(ladder), 10_000e8);

        // The prize, read off the contract rather than assumed. `LEGS_PER_POKE`
        // is 1, so one poke spends exactly this much on exactly this pool.
        uint256 leg = ladder.nextSpendAmount() / ladder.BATCH_SIZE();

        // ⚠ THE OFFER IS NOT THE LEG ANY MORE. `nextSpendAmount() / BATCH_SIZE`
        //   is sized off the RESERVOIR; `legCeiling` is `MAX_LEG_DEPTH_BPS` of
        //   this pool's depth, and `_buyAndBurn` takes whichever is smaller. Read
        //   off the contract rather than recomputed here, because a probe that
        //   models the prize instead of asking for it is how this one came to
        //   sweep a 4,000 BEM pump at a 333 BEM prize.
        uint256 ceiling = ladder.legCeiling(address(token));
        uint256 prize = leg < ceiling ? leg : ceiling;

        console2.log("reservoir           ", quote.balanceOf(address(ladder)));
        console2.log("spend this cycle    ", ladder.nextSpendAmount());
        console2.log("offer per pool      ", leg);
        console2.log("depth ceiling       ", ceiling);
        console2.log("one leg (the prize) ", prize);
        console2.log("listed tokens       ", ladder.ladderTokenCount());
        assertLt(prize, leg, "the depth cap is not binding at this raise, so this probe tests nothing new");

        // Around the real prize. The last entry keeps the old 4,000 BEM reading so
        // the dead zone stays visible and the regression this probe used to have
        // stays legible.
        uint256[5] memory pumps = [prize, prize * 2, prize * 4, prize * 15, 4000e8];

        int256 worstEdge = type(int256).min;
        int256 worstNet = type(int256).min;
        uint256 worstAt;

        for (uint256 i; i < pumps.length; ++i) {
            (int256 edge, int256 net) = _measureSandwichEdge(hook, token, pumps[i]);
            console2.log("--- pump / edge / net ---");
            console2.log("  pump            ", pumps[i]);
            console2.log("  edge (gross)    ");
            console2.logInt(edge);
            console2.log("  net P&L         ");
            console2.logInt(net);
            if (edge > worstEdge) worstEdge = edge;
            if (net > worstNet) {
                worstNet = net;
                worstAt = pumps[i];
            }
        }

        console2.log("=== worst across the sweep ===");
        console2.log("  at pump         ", worstAt);
        console2.log("  gross edge      ");
        console2.logInt(worstEdge);
        console2.log("  net P&L         ");
        console2.logInt(worstNet);

        // ⚠ ASSERT ON THE NET, NOT ON THE EDGE, and the distinction is the whole
        //   correctness of this probe. `edge` is the ARMED arm minus the EMPTIED
        //   arm, so the attacker's own friction — 0.3 % pool fee and 1 % hook tax,
        //   twice — cancels between them. That makes `edge` the buyback's gross
        //   contribution to someone already holding the position, and it is
        //   positive for any non-zero leg: a market buy landing between somebody's
        //   entry and exit always helps them. `edge == 0` is therefore not a
        //   property this design can have, and an earlier version of this file
        //   asserted a ceiling on it precisely because zero looked unreachable.
        //
        //   What the protocol actually needs is that MANUFACTURING the position
        //   costs more than the buyback pays for it, and that is `net` — the
        //   attacker's realised P&L with the reservoir armed, friction included.
        //   Negative means the sandwich loses money, which is the claim.
        assertLt(worstNet, 0, "sandwiching the buyback is profitable at some pump size");

        // ── How this looked before `MAX_LEG_DEPTH_BPS`, and why ─────────────
        //
        // Same raise, 9,000 BEM pooled, but the leg was the full 333.33 BEM —
        // 3.7 % of the book:
        //
        //     pump      x leg   gross edge   return on pumped capital
        //     166.67     0.5     +11.75      7.1 %
        //     333.33     1.0     +22.89      6.9 %
        //     666.67     2.0     +43.49      6.5 %
        //   1,333.33     4.0       0         0   %
        //   4,000       12.0       0         0   %
        //
        // Note that the RETURN is flat at ~7 % across a 4x sweep and only the
        // absolute figure moves. That is the tell: gross gain is
        // `(leg / depth) × pump` and friction is `1.3 % × pump`, so `pump`
        // cancels and the trade pays if and only if `leg / depth` exceeds
        // friction. At 3.7 % it did, by 3x, at every size. The cliff past 4x the
        // leg is the TWAP band binding — and the old probe's flat 4,000 BEM pump
        // sat in exactly that dead zone, which is how a live, repeatable ~7 %
        // sandwich was reported as a clean zero.
        //
        // That ratio is why neither dial that was tried first could work. The
        // band bounds the price at the END of the leg, measured from TWAP, so it
        // has to stay wide enough for the leg's own impact on the thinnest listed
        // book and cannot distinguish a sandwich from an honest fill. A `minOut`
        // bounds the AVERAGE paid, which does distinguish them, but not as one
        // constant: here the honest shortfall is ~1.8 %, and at the
        // `MIN_SOFT_CAP_PROD` floor — 90 BEM pooled, a 30.93 BEM leg, 34 % of the
        // book — it is ~25 %. No single tolerance admits the second while
        // refusing a 7 % skim.
        //
        // Capping `leg / depth` is what makes the ratio a constant instead of a
        // function of the raise, and then nothing else has to be tuned per pool.
        // `MAX_LEG_DEPTH_BPS = 50` puts it ~2.6x below break-even; the leg here
        // drops from 333 BEM to 45, gross edge from 43.49 to 6.28, and since
        // friction on the same pump is ~8.7 BEM the net turns negative.
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE O — does JIT liquidity turn the new depth cap into a lever?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // This probe exists because of `MAX_LEG_DEPTH_BPS`, not despite it. The cap
    // reads `getLiquidity()` at poke time, and `beforeAddLiquidity` is a `pure`
    // no-op, so anyone may add in-range liquidity in the same block. Which means
    // the quantity the cap is derived from is ATTACKER-SUPPLIED:
    //
    //   1. add in-range JIT liquidity  → `getLiquidity()` rises
    //   2. `legCeiling()` rises with it → the leg the treasury will spend rises
    //   3. `pokeBuyback()` — the leg now swaps mostly against THEIR liquidity
    //   4. remove the position, collecting the 0.3 % LP fee on the whole leg
    //
    // Every step is atomic in one bundle, so they carry no inventory risk and no
    // price risk. Fixing the sandwich by sizing the leg to depth therefore has an
    // obvious way to be self-defeating, and "the ratio is capped so the sandwich
    // cannot pay" says nothing about this route: the JIT LP is not trying to move
    // the price at all, they are trying to be the counterparty.
    //
    // So the question is not whether they can do it — they can, and the cap makes
    // the prize scale with what they contribute. It is whether it EXTRACTS
    // anything, and from whom.
    function test_probeO_jitLiquidityAroundTheBuybackLeg() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(10_000e8);
        PoolKey memory key = hook.getPoolKey();

        // ⚠ THE BASELINE IS TAKEN BEFORE THE INVENTORY IS BOUGHT. Acquiring token
        //   to be an LP with is part of the cost of this strategy, not a setup step
        //   the probe should hand over for free — measuring from after the purchase
        //   reports the recovery of that spend as profit, which is how this test
        //   first claimed a ~497 BEM edge that did not exist.
        uint256 quoteBefore = quote.balanceOf(attacker);

        // ⚠ THE INVENTORY IS BOUGHT BEFORE THE TWAP MATURES, AND THE ORDER IS THE
        //   WHOLE SETUP. A buy is `zeroForOne`, which drives sqrt price DOWN, and
        //   `_buybackSqrtFloor` is a LOWER bound anchored to the TWAP. Buy after the
        //   TWAP has settled and spot lands below the floor, the swap's price limit
        //   is then invalid on its own side, and every leg reverts into
        //   `BuybackSkipped` — the first version of this probe did exactly that,
        //   measured a zero burn, and would have reported the route as closed when
        //   what it had actually done was disarm the buyback it meant to attack.
        //
        //   A searcher does not make that mistake: they accumulate first and let the
        //   oracle settle on the price they moved it to, so that at poke time the
        //   buyback is armed and their JIT position never has to touch spot.
        //
        //   Generous on purpose, too. They need enough token to build a position that
        //   DOMINATES the book, because a JIT position the size of a rounding error
        //   raises the ceiling by nothing and makes the assertions below vacuous.
        //   They pay the 1 % tax on the way in like anyone else.
        _buy(hook, attacker, 5_000e8);
        uint256 tokenHeld = token.balanceOf(attacker);
        assertGt(tokenHeld, 0, "attacker needs inventory to be an LP");

        _nextBlock();
        _buy(hook, alice, 100e8);
        vm.warp(block.timestamp + 3601);
        _nextBlock();
        _buy(hook, alice, 1 wei);
        _nextBlock();

        vm.prank(admin);
        ladder.addLadderToken(address(token));
        _setQuote(address(ladder), 10_000e8);

        uint256 offer = ladder.nextSpendAmount() / ladder.BATCH_SIZE();
        console2.log("offer per pool        ", offer);
        console2.log("ceiling, no JIT       ", ladder.legCeiling(address(token)));
        console2.log("attacker token held   ", tokenHeld);

        // ⚠ THE CONTROL ARM MUST DIFFER ONLY IN THE JIT POSITION, and getting this
        //   wrong is the easiest way to mis-read this probe. The first version
        //   controlled on the RESERVOIR — armed versus emptied — and reported the
        //   buyback contributing +193.91 BEM. True, and not an answer to anything:
        //   the buyback is a bid, so ANYONE holding inventory gains when it fires,
        //   and that comparison cannot separate "JIT defeated the depth cap" from
        //   "the treasury bought and somebody sold".
        //
        //   The question this probe exists for is narrower. The cap reads
        //   attacker-supplied liquidity, so: does adding it, and only adding it, pay?
        //   Both arms below are armed, hold the same inventory and eat the same
        //   exogenous price moves. One adds the JIT position.
        uint256 snap = vm.snapshotState();
        (int256 withJit, uint256 burnedWithJit, uint256 ceilingWithJit, uint256 spentWithJit) =
            _jitRoundTrip(hook, token, key, quoteBefore, true);
        vm.revertToState(snap);

        snap = vm.snapshotState();
        (int256 withoutJit, uint256 burnedPlain, uint256 ceilingPlain, uint256 spentPlain) =
            _jitRoundTrip(hook, token, key, quoteBefore, false);
        vm.revertToState(snap);

        // ⚠ THE ATTACKER'S GAIN IS NOT THE PROTOCOL'S LOSS, and only one of the two
        //   decides whether this is worth another contract change. What the treasury
        //   cares about is tokens burned per BEM spent: it is buying deflation, and a
        //   larger leg that burns proportionally as much is not a loss at all.
        uint256 rateWithJit = spentWithJit == 0 ? 0 : burnedWithJit / spentWithJit;
        uint256 ratePlain = spentPlain == 0 ? 0 : burnedPlain / spentPlain;
        console2.log("spent, with JIT       ", spentWithJit);
        console2.log("spent, no JIT         ", spentPlain);
        console2.log("burn rate, with JIT   ", rateWithJit);
        console2.log("burn rate, no JIT     ", ratePlain);

        int256 jitAdvantage = withJit - withoutJit;

        console2.log("ceiling, with JIT     ", ceilingWithJit);
        console2.log("ceiling, no JIT       ", ceilingPlain);
        console2.log("burned, with JIT      ", burnedWithJit);
        console2.log("burned, no JIT        ", burnedPlain);
        console2.log("=== same bundle, JIT or not ===");
        console2.log("  P&L with JIT      ");
        console2.logInt(withJit);
        console2.log("  P&L without JIT   ");
        console2.logInt(withoutJit);
        console2.log("  what JIT bought   ");
        console2.logInt(jitAdvantage);

        // The lever on the CEILING is real — a dominant JIT position restores the leg
        // from 0.5 % of depth back to nearly the full uncapped offer, 5x here.
        // Asserted so that if it ever stops holding, this probe fails loudly instead
        // of quietly passing while measuring a position that changed nothing.
        assertGt(ceilingWithJit, ceilingPlain, "JIT must raise the ceiling, or this probe is vacuous");
        assertGt(burnedWithJit, burnedPlain, "a raised ceiling must mean a larger leg");

        // ⚠ THE INVARIANT IS THE BURN RATE, NOT THE ATTACKER'S P&L, and arriving at
        //   that took three wrong control arms, so the reasoning is worth keeping.
        //
        //   The ceiling lever works and the treasury is unharmed by it, because the
        //   two things it moves cancel exactly. Raising `getLiquidity()` raises the
        //   leg, and raises the DEPTH that leg swaps through by the same factor,
        //   because it is the same liquidity. Price impact is `leg / depth`, which
        //   `MAX_LEG_DEPTH_BPS` pins at 0.5 % regardless of who supplied the depth or
        //   when. Measured: 1_714_050_693_515 tokens per BEM with the JIT position
        //   against 1_713_626_299_190 without — 0.025 % apart, on a leg 5x larger.
        //   The treasury buys deflation, and it bought it at the same price.
        //
        //   That the cap is a RATIO is what makes this hold, and it is not an
        //   accident of this configuration. A cap written as an absolute figure, or
        //   one reading a stored depth rather than live liquidity, would both be
        //   levers here — the second is the tempting "fix" for JIT and would be
        //   strictly worse, because a stale depth against a live leg breaks the
        //   cancellation that is doing the work.
        //
        //   The attacker's own P&L is logged and deliberately NOT asserted. Measured
        //   +144.79 BEM with the position against −8.42 BEM without, and that gap is
        //   not extraction from the buyback: `modifyLiquidity` is not a swap, so it
        //   pays neither the 1 % hook tax nor slippage, which makes a position a
        //   cheaper way to liquidate the large inventory this probe hands them than
        //   dumping it through the book. That routing edge exists for any holder at
        //   any time, with or without a treasury, and asserting on it would pin this
        //   probe to the size of the inventory the setup happens to grant.
        assertApproxEqRel(rateWithJit, ratePlain, 0.01e18, "JIT-supplied depth must not change what a BEM buys");

        // Logged for the record, and the sign is the interesting part rather than the
        // magnitude — see above for why it is not a finding.
        assertTrue(jitAdvantage != 0, "arms must differ, or the useJit flag is not wired through");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE N — what happens when the price is driven onto the rim?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // The genesis position spans TICK_LOWER..TICK_UPPER (-887200..887200) and
    // `TickMath` tops out 72 ticks further at ±887272. Push spot to the edge of
    // the position and the pool's ACTIVE liquidity becomes zero: there is nothing
    // left to trade against on that side. Several things then read a pool that is
    // in a state none of them were written against:
    //
    //   • `_legDepthCeiling` divides by `sqrtPriceX96` and reads `getLiquidity()`
    //   • `_buybackSqrtFloor` derives a floor that may sit the wrong side of spot
    //   • `_twapSqrtPriceX96` clamps `avgTick` to MIN_TICK/MAX_TICK
    //   • `_getSpotPrice` converts a Q64.96 at the extreme of its range
    //
    // The thing that must not happen is a stuck or drained reservoir. `pokeBuyback`
    // walks every ladder token, so a pool parked on the rim by anyone — and parking
    // it is permissionless — must not brick the poke for the innocent pools behind
    // it, and must not let the leg's BEM leave without tokens coming back.
    function test_probeN_priceDrivenOntoTheRim() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(10_000e8);
        PoolKey memory key = hook.getPoolKey();

        _nextBlock();
        _buy(hook, alice, 100e8);
        vm.warp(block.timestamp + 3601);
        _nextBlock();
        _buy(hook, alice, 1 wei);
        _nextBlock();

        vm.prank(admin);
        ladder.addLadderToken(address(token));
        _setQuote(address(ladder), 10_000e8);

        uint256 ceilingBefore = ladder.legCeiling(address(token));

        // Dealt rather than bought, deliberately. How someone comes to hold enough
        // supply to drain the quote side is a separate question — a whale, a
        // multi-block accumulation, a creator allocation — and making the probe buy
        // it would cap the size at what the reservoir can fund and never reach the
        // rim at all. What is under test is the pool's behaviour AT the edge.
        deal(address(token), attacker, 1e30);

        // ⚠ EXACT OUTPUT, NOT EXACT INPUT, and the reason is a finding worth
        //   recording on its own. An exact-INPUT sell of 1e30 cannot fully fill: the
        //   pool runs out of quote and stops at the price limit with most of the
        //   input unconsumed. The hook's skim is sized off the SPECIFIED amount
        //   rather than the filled one, so it then tries to take 1 % of 1e30 = 1e28
        //   from a vault holding 3.738e24 and the whole swap reverts with
        //   `ERC20InsufficientBalance` wrapped in `HookCallFailed`.
        //
        //   That revert is safe — nothing moves, no funds are lost, and a router
        //   quoting against real reserves would never send it — so it is not a
        //   vulnerability. But it does mean an oversized exact-input sell is
        //   unfillable rather than partially filled, which is worth knowing and is
        //   why this probe asks for a bounded output instead.
        // Walked up in halving bites rather than taken in one, because the quote side
        // is finite and the last bite that fits is not known in advance: ask for more
        // than remains and the swap is unfillable for the reason above. Each
        // successful bite extracts what is left of the quote reserve and drives spot
        // further toward the rim; the loop stops when no bite fits.
        uint256 bite = 8_500e8;
        vm.startPrank(attacker);
        token.approve(address(router), type(uint256).max);
        for (uint256 i; i < 64 && bite > 1e6; ++i) {
            try router.swap(
                key,
                ICLPoolManager.SwapParams({
                    zeroForOne: false, amountSpecified: int256(bite), sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1
                }),
                _swapSettings(),
                ""
            ) {}
            catch {
                bite /= 2;
            }
        }
        vm.stopPrank();

        (uint160 rimSqrt, int24 rimTick,,) = poolManager.getSlot0(PoolIdLibrary.toId(key));
        console2.log("rim sqrtPriceX96      ", rimSqrt);
        console2.log("rim tick              ");
        console2.logInt(rimTick);
        console2.log("liquidity at the rim  ", poolManager.getLiquidity(PoolIdLibrary.toId(key)));
        // ⚠ `getLiquidity()` DOES NOT FALL TO ZERO ON THE WAY OUT, which was the
        //   assumption this probe started from and it was wrong. The genesis position
        //   is FULL RANGE, and a single full-range position has the same liquidity at
        //   every tick inside it — measured identical before and after the walk. So
        //   there is no tick short of TICK_UPPER itself where the pool runs out of
        //   depth, and reaching TICK_UPPER means extracting the entire quote reserve,
        //   which the finite reserve makes unreachable in practice.
        //
        //   What actually degrades is the RATIO. `_legDepthCeiling` is
        //   `L << 96 / sqrtP`, and sqrtP grows without bound toward the rim, so the
        //   ceiling collapses smoothly toward zero and floors to exactly zero well
        //   before the boundary. That is the behaviour the treasury meets in practice
        //   and it is what this probe pins, rather than a tick literal that cannot be
        //   hit.
        uint256 ceilingAtRim = ladder.legCeiling(address(token));
        uint256 offerAtRim = ladder.nextSpendAmount() / ladder.BATCH_SIZE();
        console2.log("legCeiling, mid-range ", ceilingBefore);
        console2.log("legCeiling at the rim ", ceilingAtRim);
        console2.log("offer per pool        ", offerAtRim);

        // Vacuity guard: the walk has to have moved the price far enough that the
        // ceiling genuinely collapsed, or none of the assertions below are about a
        // boundary at all.
        assertGt(rimTick, 340_000, "the walk must drive spot far out of range");
        assertLt(ceilingAtRim, ceilingBefore / 10, "the ceiling must collapse, or this probe is vacuous");

        // Every view the treasury and the front end depend on must still answer at
        // the edge rather than revert, because a reverting view is indistinguishable
        // from a bricked pool to everything reading it.
        hook.twapSqrtPriceX96();
        hook.getPoolKey();

        // THE ASSERTION THAT MATTERS, and it is not the one this probe was written to
        // make. The leg does not decline at the boundary — it FILLS, at the collapsed
        // ceiling. Measured: 19,837 base units, which is 0.0002 BEM against an offer
        // of 333, and exactly `legCeiling` to the unit.
        //
        // Which is the correct behaviour and worth stating plainly, because "refuses
        // to trade" would have been worse. A pool this far out of range is selling
        // its token for almost nothing; the treasury is a buyer of deflation, so it
        // should take that trade. What it must not do is take it at SIZE, because
        // then anyone able to shove a pool toward the rim could aim the whole
        // reservoir at a pool of their choosing at a price they set. The depth ratio
        // is what prevents that, and it is still holding out here where the inputs
        // are extreme enough to overflow a less careful expression.
        uint256 reservoirBefore = quote.balanceOf(address(ladder));
        uint256 burnedBefore = token.balanceOf(DEAD);

        vm.prank(alice);
        ladder.pokeBuyback();

        uint256 spentAtRim = reservoirBefore - quote.balanceOf(address(ladder));
        console2.log("reservoir before poke ", reservoirBefore);
        console2.log("spent at the rim      ", spentAtRim);
        console2.log("burned by the poke    ", token.balanceOf(DEAD) - burnedBefore);

        assertLe(spentAtRim, ceilingAtRim, "the leg spent more than the depth ceiling allows");
        assertLt(spentAtRim, offerAtRim / 1000, "a rim pool drew real size out of the reservoir");
        assertGt(token.balanceOf(DEAD), burnedBefore, "the leg should still buy cheap supply, not decline");

        // And the pool must come back. The rim is not an absorbing state: liquidity
        // is still there, just all on one side, so a trade in the other direction
        // walks the price back into the position and re-arms the buyback.
        //
        // ⚠ 10 BEM AND NOT 500, FOR A REASON THAT IS ITS OWN SMALL FINDING. With the
        //   quote side drained the vault holds 0.348 BEM of it, and the hook's 70 bps
        //   reservoir share is `take`n during the swap — before the router settles the
        //   buyer's input. A 500 BEM buy therefore asks the vault to hand over 3.5 BEM
        //   it does not have and reverts `ERC20InsufficientBalance` inside
        //   `HookCallFailed`, so the first recovery buy has to be small enough that
        //   its own skim fits in the residue.
        //
        //   This is mostly an artefact of a single-pool fixture: in production the
        //   Infinity vault is shared across every pool using this quote asset, so its
        //   aggregate balance is nowhere near one drained pool's. The coupling is real
        //   even so — the skim draws on the vault's balance at swap time, not on the
        //   buyer's settled input — and the size that unsticks a fully drained pool
        //   scales with what the vault happens to be holding, not with the trade.
        _nextBlock();
        _buy(hook, alice, 10e8);
        (, int24 backTick,,) = poolManager.getSlot0(PoolIdLibrary.toId(key));
        console2.log("tick after recovery   ");
        console2.logInt(backTick);
        assertLt(backTick, rimTick, "a buy at the rim must walk the price back inside the position");
        assertGt(poolManager.getLiquidity(PoolIdLibrary.toId(key)), 0, "liquidity must be active again");
    }

    /// @dev One arm of probe O: JIT in, poke, JIT out, flatten. Returns the
    ///      attacker's P&L against `quoteBefore`, what the leg burned, and the
    ///      ceiling the position bought — so the caller can difference two arms
    ///      without either of them leaking state into the other.
    function _jitRoundTrip(
        ToshLaunchpadHook hook,
        ToshToken token,
        PoolKey memory key,
        uint256 quoteBefore,
        bool useJit
    ) internal returns (int256 pnl, uint256 burned, uint256 ceilingAtPoke, uint256 spent) {
        uint256 burnedBefore = token.balanceOf(DEAD);
        uint256 reservoirBefore = quote.balanceOf(address(ladder));
        uint128 liqBefore = poolManager.getLiquidity(PoolIdLibrary.toId(key));

        // In range and centred on spot, because out-of-range liquidity is not
        // counted by `getLiquidity()` and would raise no ceiling at all.
        (, int24 tickNow,,) = poolManager.getSlot0(PoolIdLibrary.toId(key));
        int24 lower = ((tickNow - 2000) / hook.TICK_SPACING()) * hook.TICK_SPACING();
        int24 upper = ((tickNow + 2000) / hook.TICK_SPACING()) * hook.TICK_SPACING();

        // Sized as a multiple of the book rather than as a literal, so the position
        // stays dominant if the raise in this probe ever changes.
        //
        // Four, not more, and the reason is a finding in itself: the multiple is
        // bounded by the inventory they can fund. 20x wants 5.03e24 token against
        // the 1.31e24 that 5,000 BEM bought, and buying the rest means moving the
        // price against themselves and paying 1 % on every unit. The lever is
        // self-limiting before any protocol guard is involved.
        int256 jitLiquidity = useJit ? int256(uint256(liqBefore)) * 4 : int256(0);

        vm.startPrank(attacker);
        token.approve(address(router), type(uint256).max);
        if (useJit) {
            router.modifyPosition(
                key,
                ICLPoolManager.ModifyLiquidityParams({
                    tickLower: lower, tickUpper: upper, liquidityDelta: jitLiquidity, salt: bytes32(0)
                }),
                ""
            );
        }
        vm.stopPrank();

        ceilingAtPoke = ladder.legCeiling(address(token));

        // Poked by a third party, not by the attacker: `pokeBuyback` is
        // permissionless, so whether they trigger it themselves or wait for the
        // block's first Tosh swap to trigger it is a detail of their bundle, not a
        // constraint on the strategy.
        //
        // Skipped when unarmed, because that is the control arm and `pokeBuyback`
        // reverts `NotArmed()` on an empty reservoir. Skipping is the faithful
        // control: same bundle, same JIT position, same exogenous price moves, no
        // buyback to be the counterparty to.
        if (ladder.nextSpendAmount() > 0) {
            vm.prank(alice);
            ladder.pokeBuyback();
        }

        burned = token.balanceOf(DEAD) - burnedBefore;

        // Read immediately after the poke, before the attacker's exit swap pays tax
        // back into this same balance and muddles the figure.
        uint256 reservoirNow = quote.balanceOf(address(ladder));
        spent = reservoirBefore > reservoirNow ? reservoirBefore - reservoirNow : 0;

        // Pull the position and the fees with it, then sell the token side back so
        // the P&L is denominated in one asset. Selling is what a real bundle does
        // — inventory left over is not profit — and it pays the tax again.
        vm.startPrank(attacker);
        if (useJit) {
            router.modifyPosition(
                key,
                ICLPoolManager.ModifyLiquidityParams({
                    tickLower: lower, tickUpper: upper, liquidityDelta: -jitLiquidity, salt: bytes32(0)
                }),
                ""
            );
        }
        uint256 held = token.balanceOf(attacker);
        if (held > 0) {
            router.swap(
                key,
                ICLPoolManager.SwapParams({
                    zeroForOne: false, amountSpecified: -int256(held), sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1
                }),
                _swapSettings(),
                ""
            );
        }
        vm.stopPrank();

        pnl = int256(quote.balanceOf(attacker)) - int256(quoteBefore);
    }

    /// @dev One control/attack pair at a single pump size, each arm run from a
    ///      clean snapshot so the sizes in a sweep cannot contaminate each other
    ///      through the pool price, the reservoir or the burn total.
    ///
    ///      Returns BOTH figures, because they answer different questions and
    ///      conflating them is the mistake this helper used to invite:
    ///
    ///        · `edge` — armed arm minus emptied arm. The attacker's own friction
    ///          is identical in both and cancels, so this is the buyback's GROSS
    ///          contribution to a position someone already holds. Useful for
    ///          seeing how much the leg moved the price, and always positive for
    ///          any non-zero leg, so useless as a safety property.
    ///
    ///        · `net` — the armed arm on its own, friction included. This is what
    ///          the attacker actually walks away with, and the only one of the two
    ///          that can distinguish "the buyback helped them" from "the trade was
    ///          worth doing".
    ///
    ///      Emptying the reservoir is a sound control here because the tax the
    ///      pump itself pays cannot re-arm it — 70 bps of even the largest pump
    ///      in the sweep is well under `TRIGGER_STEP`.
    function _measureSandwichEdge(ToshLaunchpadHook hook, ToshToken token, uint256 pumpSize)
        internal
        returns (int256 edge, int256 net)
    {
        uint256 armedReservoir = quote.balanceOf(address(ladder));

        uint256 snap = vm.snapshotState();
        _setQuote(address(ladder), 0);
        int256 controlPnl = _roundTrip(hook, token, pumpSize);
        vm.revertToState(snap);

        snap = vm.snapshotState();
        _setQuote(address(ladder), armedReservoir);
        net = _roundTrip(hook, token, pumpSize);
        vm.revertToState(snap);

        edge = net - controlPnl;
    }

    /// @dev Buy `nativeIn` of the token then immediately sell the entire position
    ///      back, in the same block.  Returns the attacker's ETH P&L.
    function _roundTrip(ToshLaunchpadHook hook, ToshToken token, uint256 nativeIn) internal returns (int256) {
        uint256 ethBefore = quote.balanceOf(attacker);
        PoolKey memory key = hook.getPoolKey();

        console2.log("  reservoir at entry ", quote.balanceOf(address(ladder)));
        console2.log("  attacker eth       ", ethBefore);
        console2.log("  attacker tok       ", token.balanceOf(attacker));

        _buy(hook, attacker, nativeIn);

        console2.log("  reservoir post-buy ", quote.balanceOf(address(ladder)));
        uint256 bought = token.balanceOf(attacker);
        console2.log("  bought             ", bought);

        vm.startPrank(attacker);
        token.approve(address(router), type(uint256).max);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: false, amountSpecified: -int256(bought), sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1
            }),
            _swapSettings(),
            ""
        );
        vm.stopPrank();

        console2.log("  reservoir post-sell", quote.balanceOf(address(ladder)));
        console2.log("  attacker eth after ", quote.balanceOf(attacker));

        return int256(quote.balanceOf(attacker)) - int256(ethBefore);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE G′ — where exactly does the band PROBE G measures stop?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // PROBE G reports an edge and asserts nothing, which is the right shape for
    // a probe whose answer is a number.  What it leaves unheld is the WIDTH of
    // the band, and the coverage elsewhere does not close that:
    // `test_buyback_refusesToFillIntoAManipulatedPrice` @ `test/ToshV5.t.sol`
    // does catch a deleted `sqrtPriceLimitX96` argument, but it clears the
    // bound by shoving 120 ETH through the pool — far enough past the floor to
    // still clear one five times wider.  Retuning
    // `MAX_BUYBACK_SQRT_DEVIATION_BPS` from 1000 to 5000 leaves that test
    // green.  Established by mutation, not by reading it.
    //
    // So bracket the band from both sides rather than overshooting it: park the
    // pool at a deviation the constant must ALLOW, then at one it must REFUSE.
    // Both targets are written as absolute fractions of the TWAP on purpose —
    // deriving them from `MAX_BUYBACK_SQRT_DEVIATION_BPS` would move the goal
    // posts along with the constant and reopen exactly the hole this closes.
    function test_probeG2_bandEdgeSitsWhereTheConstantSaysItDoes() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(10_000e8);

        // Same TWAP-maturing dance as PROBE G: one real trade, a full window,
        // then a dust trade to roll the observation forward.
        _nextBlock();
        _buy(hook, alice, 100e8);
        vm.warp(block.timestamp + 3601);
        _nextBlock();
        _buy(hook, alice, 1 wei);
        _nextBlock();

        uint160 twapSqrt = hook.twapSqrtPriceX96();
        assertGt(twapSqrt, 0, "fixture needs a matured TWAP, or the floor disables itself by design");

        uint256 snap = vm.snapshotState();

        // ── 500 bps of sqrt deviation: half the permitted travel ─────────────
        _parkAt(hook, (uint256(twapSqrt) * 9500) / 10_000);
        uint256 filled = _armAndPoke(token);
        console2.log("burned at  500 bps (inside) ", filled);
        assertGt(filled, 0, "a pool inside the band must still be bought and burned");
        assertLt(quote.balanceOf(address(ladder)), 10_000e8, "and the reservoir must actually spend");

        vm.revertToState(snap);

        // ── 1200 bps: past the floor, yet nowhere near a 5000 bps one ────────
        _parkAt(hook, (uint256(twapSqrt) * 8800) / 10_000);
        uint256 refused = _armAndPoke(token);
        console2.log("burned at 1200 bps (outside)", refused);
        assertEq(refused, 0, "a pool past the band must not be bought into at all");
        assertEq(quote.balanceOf(address(ladder)), 10_000e8, "and the unspent ETH must stay in the reservoir");
    }

    /// @dev Park the pool at EXACTLY `targetSqrt` by handing V4 a swap it cannot
    ///      finish: an oversized exact input bounded by the target, which fills
    ///      until the price touches the limit and then stops there.  Sizing a
    ///      plain buy to land on a chosen deviation would mean solving the
    ///      curve for it; letting the limit do the work is exact, and being
    ///      exact is the whole point of a bracket.
    ///
    ///      A pump this size pays well over 1 ETH of buy tax into the reservoir
    ///      during its own `beforeSwap`, so its `afterSwap` arrives with the
    ///      engine armed.  That is why the token is not listed until after this
    ///      returns: an unlisted ladder makes `_runPiggyback` return on
    ///      `total == 0`, and the pool stays exactly where the limit left it.
    ///      Listing first cost ~120 bps of unrequested extra travel — a leg
    ///      firing from the pump itself, before the poke under test ever ran.
    function _parkAt(ToshLaunchpadHook hook, uint256 targetSqrt) internal {
        PoolKey memory key = hook.getPoolKey();
        uint256 offered = 500_000e8;
        vm.deal(attacker, offered + 1 ether);

        vm.prank(attacker);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(offered), sqrtPriceLimitX96: uint160(targetSqrt)
            }),
            _swapSettings(),
            ""
        );

        (uint160 spot,,,) = poolManager.getSlot0(key.toId());
        assertEq(uint256(spot), targetSqrt, "the limit must park the pool exactly on the requested deviation");
    }

    /// @dev List the parked pool, hand the reservoir a known 100 ETH — rather
    ///      than whatever the pump's tax happened to leave — and fire one poke.
    ///
    ///      The poke comes from `pokeBuyback` rather than from a trigger swap
    ///      because it opens its own unlock frame, so nothing moves the very
    ///      price under test on the way in.  A leg the floor rejects reverts
    ///      into `BuybackSkipped` instead of bubbling up, so the poke succeeds
    ///      either way and the burn is the only signal worth reading.
    function _armAndPoke(ToshToken token) internal returns (uint256) {
        vm.prank(admin);
        ladder.addLadderToken(address(token));
        _setQuote(address(ladder), 10_000e8);

        uint256 before = token.balanceOf(DEAD);
        _nextBlock();
        vm.prank(attacker);
        ladder.pokeBuyback();
        return token.balanceOf(DEAD) - before;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE G″ — for the first 1800 s of a pool's life the band is not there
    // ══════════════════════════════════════════════════════════════════════════
    //
    // ── CLOSED IN SOURCE, 2026-09-11 ─────────────────────────────────────────
    //
    // The argument below was accepted rather than answered.  `addLadderToken`
    // now reads `twapSqrtPriceX96()` itself and reverts `TwapNotMature` unless
    // it answers non-zero, so the state arm A used to drive cannot be entered
    // through the only door that reaches it. SECURITY.md records the residual
    // this replaced.
    //
    // What arm A used to measure, kept because it is the reason the gate exists
    // and not a historical curiosity: one pool parked 1500 bps out, the full
    // 3.33 ETH leg clearing at a deviation the band forbids, 0.93 ETH of it
    // recovered by whoever parked the price, repeatable per block because
    // `pokeBuyback` has no cooldown.  Arm A now pins the refusal instead, at
    // the same park, so the gate is shown landing on the attack rather than
    // beside it.
    //
    // TWO LIMITS, so the gate is not read as more than it is.
    //
    // `_buybackSqrtFloor` still answers a REVERTING `twapSqrtPriceX96()` with
    // "unbounded", and the gate only proves the getter answered once, at
    // listing time.  On chain that door is not practically reachable:
    // `nowTs - _prevCheckpointTs` cannot underflow where time only moves
    // forward, and nothing else in the getter reverts.  That is why it is left
    // as the audit left it.  It is reachable in TESTS, and was reached —
    // `_warpBy` in `ToshV5.t.sol` documents the backward warp that did it, and
    // the three tests that had been measuring an unbounded buyback as a result.
    //
    // This comment used to say the gate would arrive with the next deployment
    // rather than with the commit that wrote it, because
    // `ToshFactory.ladderTreasury` is `immutable` and is baked into the hook
    // implementation every launch clones — so the treasury at
    // 0x99aD248dD15498957B864Fd79917F0E103Aa78F7 could never be given it.  The
    // next deployment happened on 2026-09-12, for an unrelated reason, and the
    // live treasury 0x255722226720914eF5B2CD54647f21f584BD4Ea2 carries the gate.
    // The operational rule and `STATE-07` are still what hold the SECOND door,
    // which the gate does not reach: it fires once at listing, and this branch
    // runs on every leg after.
    //
    // ─────────────────────────────────────────────────────────────────────────
    //
    // This probe RECORDED AN EXPOSURE.  It was not here to bless the fallback it
    // measured, and the numbers below are the argument that closed it.
    //
    // `_buybackSqrtFloor` has two ways to end up returning `MIN_SQRT_PRICE + 1`
    // — no bound at all — and its natspec defends them with one sentence:
    // refusing to buy "would be the worse failure: the reservoir would stall
    // permanently on any pool whose hook predates this interface."
    //
    // That sentence is true of the `catch` branch, where a hook does not answer
    // `twapSqrtPriceX96()` at all and never will.  It is NOT true of the
    // `twapSqrt == 0` branch this probe drives.  Reading
    // `_twapSqrtPriceX96`: the answer is 0 exactly while
    // `block.timestamp - _prevCheckpointTs < TWAP_WINDOW`, both checkpoints are
    // stamped at `launch()`, and `_prevCheckpointTs` only ever rolls onto a
    // `_curCheckpointTs` that was already a full window old.  So the immature
    // state is one-shot and clock-bound: the 1800 s after launch, never
    // re-enterable, and — because the accumulator extrapolates from `lastTick`
    // — it closes on the clock alone, with no swap required to close it.
    // "Stall permanently" is therefore the wrong cost for this branch.  The
    // real cost of refusing is that one freshly launched token's first buybacks
    // are deferred by up to half an hour, using the `BuybackSkipped` path that
    // already exists and already leaves the ETH in the reservoir for the next
    // cycle.
    //
    // What is bought with that half hour is the removal of the only
    // anti-sandwich control the buyback has, on the pool least able to absorb
    // it: a pool whose liquidity is whatever the genesis raise seeded and whose
    // price a small pump moves a long way.  The two arms below are the same
    // pool, parked at the same deviation, with the same reservoir and the same
    // attacker actions.  The only difference is whether 1801 seconds have
    // passed — and that flips the leg from "refused outright" to "fills the
    // whole cheque".
    //
    // Scope, stated rather than implied: arm A pins that the leg is not bounded
    // by anything anchored to the TWAP, and not bounded by spot either at the
    // one deviation a spot anchor forbids outright (zero travel).  A bound
    // anchored to spot but looser than the leg's OWN travel — logged below, and
    // small on a pool this deep — would still slip past.  Left there
    // deliberately: such a bound moves with the very quantity a sandwicher
    // displaces, so it is not the control being defended, and pretending to
    // catch it would mean sizing the fixture around the mutation instead of
    // around the attack.
    function test_probeG3_immatureTwapIsRefusedAtListing() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(10_000e8);
        PoolKey memory key = hook.getPoolKey();
        (uint160 openingSqrt,,,) = poolManager.getSlot0(key.toId());
        uint256 launchTs = block.timestamp;

        // 1500 bps below the opening sqrt price: half again as far out as
        // `MAX_BUYBACK_SQRT_DEVIATION_BPS` permits, so a live band has to refuse
        // it.  An absolute fraction rather than one derived from the constant,
        // for the reason PROBE G′ gives — a derived target moves with the
        // constant and stops testing it.
        uint256 target = (uint256(openingSqrt) * 8500) / 10_000;
        uint256 leg = (10_000e8 * ladder.SPEND_BPS()) / 10_000 / ladder.BATCH_SIZE();

        uint256 snap = vm.snapshotState();

        // ── Arm A: inside the launch window there is no TWAP, so no listing ──
        assertEq(hook.twapSqrtPriceX96(), 0, "premise: a pool in its first window has no TWAP to anchor to");

        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TwapNotMature.selector);
        ladder.addLadderToken(address(token));
        assertEq(ladder.ladderTokenCount(), 0, "nothing may be listed out of the immature window");

        // Parking the price first changes nothing, and that is the point.  The
        // gate is not a judgement about whether the price looks honest at
        // listing time; it refuses because there is no reading to judge it
        // against.  This is the exact state arm A used to spend the cheque in.
        _parkAt(hook, target);
        assertEq(hook.twapSqrtPriceX96(), 0, "a swap does not mature the window, only the clock does");

        vm.prank(admin);
        vm.expectRevert(ToshLadderTreasury.TwapNotMature.selector);
        ladder.addLadderToken(address(token));

        // The reservoir is not empty here — the 5000 ETH pump paid tax into it
        // on the way past — so the refusal has to be shown to bite on the
        // spending side too, not just on the bookkeeping.  With nothing listed
        // there is nowhere for that ETH to go, and the poke says so.
        assertGt(quote.balanceOf(address(ladder)), 0, "the pump did fund the reservoir");
        vm.prank(attacker);
        vm.expectRevert(ToshLadderTreasury.NotArmed.selector);
        ladder.pokeBuyback();

        vm.revertToState(snap);

        // ── Arm B: the identical park, 1801 seconds later ────────────────────
        vm.warp(launchTs + hook.TWAP_WINDOW() + 1);
        _nextBlock();
        uint160 twapSqrt = hook.twapSqrtPriceX96();
        assertGt(twapSqrt, 0, "the window closes on the clock alone, with no swap needed to mature it");
        assertLt(target, (uint256(twapSqrt) * 9000) / 10_000, "and the park must sit outside the live band");
        _parkAt(hook, target);
        uint256 burnedB = _armAndPoke(token);
        uint256 spentB = 10_000e8 - quote.balanceOf(address(ladder));
        uint256 proceedsB = _dumpAll(hook, token);

        console2.log("leg offered                 ", leg);
        console2.log("arm B (TWAP live) eth spent ", spentB);
        console2.log("arm B (TWAP live) burned    ", burnedB);
        console2.log("attacker dump, arm B        ", proceedsB);

        // Past the window the listing is accepted, and the band is then what
        // refuses the deviation — so the two controls are shown to be
        // independent.  The gate decides WHETHER a pool is eligible at all; the
        // band decides what may be paid on any given leg.  Neither substitutes
        // for the other, which is why arm A does not simply assert on spend.
        assertEq(spentB, 0, "with a TWAP the identical deviation is refused outright");
        assertEq(burnedB, 0, "so nothing is bought and nothing is burned");
    }

    /// @dev Sell the attacker's whole position back and return the ETH it
    ///      fetched.  The reservoir is emptied first: the dump's own `afterSwap`
    ///      would otherwise fire a SECOND leg, bounded in one arm and unbounded
    ///      in the other, and that difference would be mixed into the figure
    ///      under measurement.  What is being measured is what the first leg
    ///      handed back.
    function _dumpAll(ToshLaunchpadHook hook, ToshToken token) internal returns (uint256) {
        _setQuote(address(ladder), 0);

        uint256 bal = token.balanceOf(attacker);
        uint256 ethBefore = quote.balanceOf(attacker);

        // Read before the prank: an argument that is itself an external call
        // is evaluated first and would consume it. See _swapBuy.
        PoolKey memory key = hook.getPoolKey();
        vm.startPrank(attacker);
        token.approve(address(router), type(uint256).max);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: false, amountSpecified: -int256(bal), sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1
            }),
            _swapSettings(),
            ""
        );
        vm.stopPrank();

        return quote.balanceOf(attacker) - ethBefore;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE H — an untaxed parallel venue for the same token
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `beforeInitialize` stops anyone opening a pool THAT USES THIS HOOK.  It
    // says nothing about a HOOKLESS pool over the same ERC-20, which V4 lets
    // anybody create.  Such a pool pays no 1 % tax, feeds no oracle, and
    // funds no buyback.
    function test_probeH_hooklessParallelPool() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(10_000e8);
        _nextBlock();
        _buy(hook, alice, 2000e8);

        // The one hand-built PoolKey in the suite, and it gained two members in
        // the Infinity port. `poolManager` is now named IN the key — the manager
        // rejects a key that names a different one — and `tickSpacing` moved out
        // of its own field into the packed `parameters` word alongside the hook
        // permission bitmap.
        //
        // `parameters` carries the tick spacing and nothing else here, which is
        // exactly right for a hookless pool: with no hook there are no callbacks
        // to register, so the permission bits are all zero.
        PoolKey memory rogue = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            // `IHooks`, not `ICLHooks`: Infinity's PoolKey is shared by the CL
            // and Bin managers, so the field is typed to the interface they have
            // in common. The CL-specific callbacks live in `ICLHooks`, which the
            // manager casts to after reading the key.
            hooks: IHooks(address(0)),
            poolManager: IPoolManager(address(poolManager)),
            fee: 3000,
            parameters: bytes32(0).setTickSpacing(60)
        });

        uint256 treasuryBefore = quote.balanceOf(address(ladder));

        // A stranger can open it.  `beforeInitialize` is never consulted,
        // because V4 only calls a hook for pools that name that hook.
        vm.prank(attacker);
        poolManager.initialize(rogue, TickMath.getSqrtRatioAtTick(0));
        console2.log("rogue hookless ETH/token pool initialised by a stranger");

        assertEq(quote.balanceOf(address(ladder)), treasuryBefore, "the rogue venue funds no buyback");

        // ACCEPTED, NOT FIXED — and the assertions below say so out loud.
        //
        // There is no contract-level defence: the token is a plain ERC-20 with
        // no transfer hook, so any fee tier, any hook (or none), any seeder.
        // What the protocol keeps instead is DEPTH — the genesis LP position is
        // locked in the official pool forever — and depth is what makes
        // `_safeReferencePrice` worth reading, since it is single-venue.
        //
        // If this ever stops holding, the exposure is not the lost 1 %: it is
        // that the anti-spike gate is measured against a book that has thinned.
        assertEq(uint256(uint160(address(rogue.hooks))), 0, "the rogue pool is genuinely hookless, by construction");
        // The VAULT holds it, not the pool manager. Depth is measured by where
        // the tokens physically are, and in Infinity that is the Vault — the
        // manager keeps only the accounting.
        assertGt(
            token.balanceOf(address(vault)), 0, "the official pool still holds the permanently locked genesis liquidity"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE I — token left stranded in the hook after seeding the LP
    // ══════════════════════════════════════════════════════════════════════════
    function test_probeI_strandedGenesisTokens() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(10_000e8);

        uint256 held = token.balanceOf(address(hook));
        uint256 claimSide = hook.GENESIS_CLAIM_SUPPLY();
        console2.log("hook token balance ", held);
        console2.log("GENESIS_CLAIM_SUPPLY", claimSide);
        console2.log("stranded above claim side", held > claimSide ? held - claimSide : 0);
        console2.log("in pool            ", token.balanceOf(address(poolManager)));

        // Now drain the claim side and see what can never leave.
        vm.prank(alice);
        hook.claimGenesis();
        uint256 stranded = token.balanceOf(address(hook));
        console2.log("hook balance after sole depositor claims", stranded);

        // ACCEPTED, NOT FIXED — but note WHERE the dust comes from, because the
        // obvious guess is wrong.  It is not the pro-rata claim rounding down:
        // the sole depositor receives the claim pool to the wei.  It is the LP
        // seed, where V4's liquidity math accepts marginally less than
        // `GENESIS_LP_SUPPLY`, and the remainder stays in the hook.
        //
        // There is no rescue path, on purpose — a rescue path is a withdrawal
        // path wearing a different name, which is the same trade the treasury
        // makes by having no `sweep`.  Bounded rather than merely observed, so
        // "dust" cannot quietly grow into a number worth caring about: 186
        // wei-tokens against a 4.62 M pool is about 1 part in 2.5e22.
        assertEq(token.balanceOf(alice), claimSide, "the sole depositor gets the entire claim pool, to the wei");
        assertLt(stranded, 1e12, "so the residue is LP-seed remainder, and must stay in the dust regime");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE M — "the ladder opens locked" is a 1-wei coin flip, not a property
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `test_ladderOpensLockedAtLaunch` asserts `maxMintable() == 0` in the launch
    // block and passes — but it only ever runs one raise size (SOFT_CAP, 1 ETH).
    //
    // The gate is `tierPrice > ceiling`, strict.  `shelfP0` and `ceiling` are the
    // SAME expression `(x * 10500) / 10000` applied to `p0` and to
    // `min(spot, p0)`.  So the launch block is locked if and only if the
    // round-tripped `spot` lands strictly BELOW `p0`, which is decided by
    // truncation inside `_toSqrtPriceX96` / `_sqrtPriceToNativePerToken` and varies
    // with the raise.  Sweep it.
    function test_probeM_launchBlockLockIsRaiseDependent() public {
        uint256 unlockedCount;
        uint256 n;

        for (uint256 i = 1; i <= 24; ++i) {
            uint256 raise = i * 100e8;
            uint256 snap = vm.snapshotState();

            (, ToshLaunchpadHook hook) = _launchProject(raise);
            uint256 p0 = hook.p0();
            (,,, uint256 spot,,,) = hook.tierStatus();
            uint256 openTokens = hook.maxMintable();

            if (openTokens > 0) {
                ++unlockedCount;
                console2.log("raise ETH / OPEN / tokens mintable in launch block:", i, openTokens);
            } else {
                console2.log("raise ETH / locked:", i);
            }
            console2.log("   p0 / spot:", p0, spot);
            ++n;

            vm.revertToState(snap);
        }

        console2.log("raises swept              ", n);
        console2.log("launch blocks that OPENED ", unlockedCount);
        console2.log("launch blocks that LOCKED ", n - unlockedCount);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE J — the self-referral guard is one EOA deep
    // ══════════════════════════════════════════════════════════════════════════
    //
    // ORIGINAL FINDING.  `_recordReferral` refused `referrer == user` and the
    // natspec claimed this stopped "anyone farming their own 10 %".  A second
    // address the same person controls is not `user`, so the 10 % came straight
    // back — to a wallet with no quota, no deposit and no history.
    //
    // FIX 1.  A referrer must hold PoG quota, which puts a throwaway wallet
    // behind the same oracle attestation a depositor needs.  Not a wall; a per
    // sybil cost the signer can price off-chain.
    //
    // FIX 2 (two-slot referrals).  Binding per project would have made this
    // attack N times better at no extra cost — the same throwaway collecting on
    // every project instead of once per wallet, lifetime.  So the 8 % project
    // leg additionally requires the referrer to hold a deposit IN THAT PROJECT,
    // and only the 2 % lifetime leg is reachable without one.
    //
    // What that leaves, measured below: an attested but unstaked throwaway
    // recovers 2 % rather than 10 %, and recovering the full 10 % costs a stake
    // in every project it wants to farm.  The throwaway's stake is not burned —
    // it earns genesis tokens like any other deposit — so this is capital tied
    // up, not capital lost.  Still a price, still not a wall.
    function test_probeJ_referralSelfFarmViaSecondWallet() public {
        address sybil = makeAddr("sybil"); // attacker's own second EOA, never attested

        bytes32 salt = _pickSalt();
        uint256 fee = factory.launchFee();
        uint256 agreedSoftCap = factory.defaultSoftCap();
        uint256 agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (, address h) = factory.createLaunch{value: fee}(
            "Farm", "FRM", projTreasury, projTreasury, salt, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
        ToshLaunchpadHook hook = ToshLaunchpadHook(payable(h));

        _registerPoG(attacker, POG_CAP);
        vm.prank(attacker);
        factory.deposit(address(hook), sybil, 1000e8);

        // The deposit still succeeds — a rejected binding must never brick one.
        assertEq(hook.nativeDeposited(attacker), 1000e8, "deposit is unaffected");
        assertEq(factory.globalReferrers(attacker), address(0), "unattested referrer does not bind");
        assertEq(hook.referralAccrued(sybil), 0, "and accrues nothing");
        assertEq(hook.orphanReferral(), 100e8, "the 10 % falls through to buyback fuel");

        vm.warp(hook.genesisDeadline() + 1);
        vm.prank(creator);
        hook.launch();

        vm.prank(sybil);
        vm.expectRevert(ToshLaunchpadHook.NoReferralReward.selector);
        hook.claimReferralReward();

        // An ATTESTED referrer is still paid — the programme itself still works.
        address realRef = makeAddr("realReferrer");
        _registerPoG(realRef, POG_CAP);
        _registerPoG(alice, POG_CAP);

        bytes32 salt2 = _pickSalt();
        agreedSoftCap = factory.defaultSoftCap();
        agreedWalletCap = factory.maxPogAllocationLimit();
        vm.prank(creator);
        (, address h2) = factory.createLaunch{value: fee}(
            "Farm2", "FR2", projTreasury, projTreasury, salt2, fee, agreedSoftCap, agreedWalletCap, 24 hours
        );
        ToshLaunchpadHook hook2 = ToshLaunchpadHook(payable(h2));

        vm.prank(alice);
        factory.deposit(address(hook2), realRef, 1000e8);
        assertEq(hook2.referralAccrued(realRef), 20e8, "an attested but unstaked referrer earns the 2 % leg");
        assertEq(hook2.orphanReferral(), 80e8, "the 8 % project leg orphans for want of a stake");

        // The whole 10 % is still reachable — it just costs a stake in this
        // project, which is the gate's entire purpose. `realRef` stakes hook2,
        // and the next referee to arrive on their link pays both legs.
        address referee2 = makeAddr("referee2");
        // Both deposit, so both need a quote balance and a factory allowance. This
        // was two `vm.deal` calls, which funded them for a `msg.value` deposit that
        // no longer exists; the native deal stays only because they still pay gas.
        _endow(realRef);
        _endow(referee2);
        vm.deal(realRef, 10 ether);
        vm.deal(referee2, 100 ether);

        vm.prank(realRef);
        factory.deposit(address(hook2), address(0), 100e8);

        _registerPoG(referee2, POG_CAP);
        vm.prank(referee2);
        factory.deposit(address(hook2), realRef, 1000e8);

        assertEq(
            hook2.referralAccrued(realRef),
            120e8,
            "0.2 from alice's lifetime leg, then 0.8 + 0.2 from a referee who arrived after the stake"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE K — setMaxPogAllocationLimit(0) bricks createLaunch entirely
    // ══════════════════════════════════════════════════════════════════════════
    //
    // ORIGINAL FINDING.  The dial is snapshotted into the hook's constructor,
    // which does `require(_perWalletCap > 0)`, so at 0 the CREATE2 construction
    // reverted and `createLaunch` died with `DeployFailed` for every creator —
    // from a setter documented as governing "new projects only".
    //
    // FIX.  The setter refuses zero outright, so the failure surfaces at the
    // governance call instead of at every creator's transaction.
    function test_probeK_zeroPogLimitBricksCreateLaunch() public {
        vm.prank(admin);
        vm.expectRevert(ToshFactory.InvalidPogLimit.selector);
        factory.setMaxPogAllocationLimit(0);

        assertEq(factory.maxPogAllocationLimit(), POG_CAP, "dial is unchanged");

        // 1 wei is still accepted: this is a zero guard, not a policy floor.
        vm.prank(admin);
        factory.setMaxPogAllocationLimit(1);
        assertEq(factory.maxPogAllocationLimit(), 1);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE L — who does the "one-way valve" actually pay?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // ORIGINAL FINDING.  The treasury cannot send ETH anywhere but into a buy
    // whose output burns — but the OWNER alone decides WHICH market absorbs it,
    // and `removeLadderToken` narrows the list to one.  `perToken` was
    // `spend / count`, so a one-token ladder pointed the FULL 10 % cheque at a
    // single pool, and any address can fire the poke with a dust swap.
    //
    // FIX.  `perToken` is now `spend / BATCH_SIZE`, so a narrow list buys a
    // narrow trickle instead of the same cheque concentrated.  The sqrt floor
    // already rate-limited the drain per window; this removes the concentration
    // bonus for narrowing the list at all.
    function test_probeL_ownerDirectsEntireReservoirAtOneMarket() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(10_000e8);
        _nextBlock();
        _buy(hook, alice, 100e8);
        vm.warp(block.timestamp + 3601);
        _nextBlock();
        _buy(hook, alice, 1 wei);
        _nextBlock();

        vm.prank(admin);
        ladder.addLadderToken(address(token));

        _setQuote(address(ladder), 10_000e8);

        uint256 poolEthBefore = address(poolManager).balance;
        uint256 burnedBefore = token.balanceOf(DEAD);

        // Anybody can fire the poke.  One dust swap per poke, all in one block.
        uint256 pokes;
        while (quote.balanceOf(address(ladder)) >= 100e8 && pokes < 60) {
            _buy(hook, attacker, 1000);
            ++pokes;
        }

        console2.log("pokes fired                  ", pokes);
        console2.log("reservoir left               ", quote.balanceOf(address(ladder)));
        console2.log("ETH pushed into the one pool ", address(poolManager).balance - poolEthBefore);
        console2.log("tokens burned                ", token.balanceOf(DEAD) - burnedBefore);
        (,,, uint256 spot,,,) = hook.tierStatus();
        console2.log("spot after the forced buying ", spot);

        // Unlimited pokes still cannot empty the reservoir into the chosen pool.
        //
        // Be precise about WHICH guard is doing the work here: at this pool
        // depth it is `_buybackSqrtFloor`, which refuses to walk the pool more
        // than ~10 % in sqrt terms above its TWAP, so once the first few legs
        // have moved the price the rest of the pokes fill nothing until the
        // window rolls.  Dividing `perToken` by BATCH_SIZE sits behind that as
        // defence in depth — it shrinks the cheque a narrow list is handed, and
        // it is what bites in a pool deep enough for the floor not to.
        assertGt(quote.balanceOf(address(ladder)), 8500e8, "a one-token ladder cannot be drained on demand");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE D — can the 1.0 % in-flight tax be rounded away with dust swaps?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `tax = input * 100 / 10_000` floors, and `beforeSwap` returns early when it
    // lands on zero.  Any input below 100 wei therefore trades untaxed.
    //
    // The band NARROWED when the rate went 70 → 100 bps: it used to run to
    // 142 wei, and a higher rate reaches its first whole wei of tax sooner.
    // Raising a rate cannot widen a floor-division dead zone, so this direction
    // is the only one available — but it is worth pinning rather than assuming,
    // because the split introduced a SECOND, wider boundary above it.
    function test_probeD_dustSwapEvadesTax() public {
        (, ToshLaunchpadHook hook) = _launchProject(1000e8);
        _nextBlock();

        uint256 treasuryBefore = quote.balanceOf(address(ladder));
        uint256 platformBefore = quote.balanceOf(platformTreasury);

        // 99 wei * 100 / 10_000 == 0
        for (uint256 i; i < 20; ++i) {
            _buy(hook, attacker, 99);
        }

        console2.log("treasury delta after 20 dust buys", quote.balanceOf(address(ladder)) - treasuryBefore);
        console2.log("tax on 99 wei ", uint256(99 * 100) / 10_000);
        console2.log("tax on 100 wei", uint256(100 * 100) / 10_000);

        // ACCEPTED, NOT FIXED.  The evasion is real and it is worthless: to move
        // 1 ETH untaxed you would need ~1e16 swaps of 99 wei, each paying full
        // calldata and pool-accounting gas, to avoid 0.01 ETH of tax.  The
        // rounding runs in the trader's favour by one wei-scale unit, which is
        // the same direction every other rounding in this codebase runs.
        //
        // What is worth pinning is the THRESHOLD, so a future change to TAX_BPS
        // or to the early-return cannot silently widen the untaxed band.
        assertEq(uint256(99 * 100) / 10_000, 0, "99 wei is the largest untaxed input");
        assertEq(uint256(100 * 100) / 10_000, 1, "100 wei is the smallest taxed one");
        assertEq(quote.balanceOf(address(ladder)), treasuryBefore, "so 20 dust buys yield the treasury nothing");
        assertEq(quote.balanceOf(platformTreasury), platformBefore, "and the platform nothing either");
    }

    // ── PROBE D, second boundary: the platform cut's own floor ────────────────
    //
    // The buy leg now splits its skim, and the platform's 30 bps floors to zero
    // over a band THREE TIMES WIDER than the one above: `input * 30 / 10_000` is
    // 0 for every input below 334 wei, while `tax` itself is already non-zero
    // from 100 wei up.  Between those two figures the swap IS taxed and the
    // platform is paid nothing.
    //
    // That gap is not a leak, and the point of this probe is to show why.  The
    // reservoir's share is computed as `tax - platformCut`, not as its own
    // multiplication, so every wei the platform's floor division drops stays
    // inside the credit the hook already claimed and is `take`n to the buyback
    // instead.  Conservation is what the pool's solvency depends on — both call
    // sites hand V4 a hook delta of exactly `tax`, so a split that summed to
    // less would revert `CurrencyNotSettled` and a split that summed to more
    // would draw currency the hook was never credited.
    //
    // So there is nothing to evade here: shrinking your trade below 334 wei
    // does not reduce what you pay, it only redirects the platform's third of
    // it into the buyback.  Which is the strictly worse outcome for anyone
    // trying to game it, and the reason the dust bias was pointed this way.
    function test_probeD_platformCutFloorsToZeroBelowThreeThirtyFour() public {
        (, ToshLaunchpadHook hook) = _launchProject(1000e8);
        _nextBlock();

        // The documented worked example: 110 wei is taxed one wei, and that
        // whole wei goes to the reservoir because 110 * 30 / 10_000 floors to 0.
        // A naive `110 * 70 / 10_000` would also floor to 0 — the pair would
        // settle nothing against a credit of 1, and the swap would revert.
        assertEq(uint256(110 * 100) / 10_000, 1, "110 wei owes one wei of tax");
        assertEq(uint256(110 * 30) / 10_000, 0, "which the platform's rate cannot see");
        assertEq(uint256(110 * 70) / 10_000, 0, "and neither could a naive reservoir rate");

        _assertBuySplitConserves(hook, 110, 1, 0);

        // Walk the platform boundary itself.  333 wei: tax 3, platform 0.
        // 334 wei: tax 3, platform 1.  Neither reverts.
        assertEq(uint256(333 * 30) / 10_000, 0, "333 wei is the largest input the platform sees nothing from");
        assertEq(uint256(334 * 30) / 10_000, 1, "334 wei is the smallest it does");

        _assertBuySplitConserves(hook, 333, 3, 0);
        _assertBuySplitConserves(hook, 334, 3, 1);

        // And nothing in the whole band from the first taxed wei to well past
        // the platform boundary reverts or mis-settles.
        for (uint256 input = 100; input <= 400; ++input) {
            uint256 tax = (input * 100) / 10_000;
            uint256 expectedPlatform = (input * 30) / 10_000;
            _assertBuySplitConserves(hook, input, tax, expectedPlatform);
        }
    }

    /// @dev Execute one dust buy and assert the split both conserves `tax` and
    ///      lands the expected amount on each side.
    function _assertBuySplitConserves(
        ToshLaunchpadHook hook,
        uint256 input,
        uint256 expectedTax,
        uint256 expectedPlatform
    ) internal {
        uint256 ladderBefore = quote.balanceOf(address(ladder));
        uint256 platformBefore = quote.balanceOf(platformTreasury);

        _buy(hook, attacker, input);

        uint256 reservoirCut = quote.balanceOf(address(ladder)) - ladderBefore;
        uint256 platformCut = quote.balanceOf(platformTreasury) - platformBefore;

        assertEq(platformCut, expectedPlatform, "platform cut at this input");
        assertEq(reservoirCut, expectedTax - expectedPlatform, "reservoir takes the remainder, dust included");
        assertEq(reservoirCut + platformCut, expectedTax, "the two cuts must sum to the credited tax");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE E — shelf-mint rounding: how many tokens per wei of underpayment?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `legCost = tierPrice * take / 1e18` floors in the buyer's favour.  Measure
    // the largest order that costs exactly 1 wei.
    function test_probeE_mintRoundingEdge() public {
        (, ToshLaunchpadHook hook) = _launchProject(1000e8);
        _nextBlock();

        uint256 price = hook.tierPriceAt(0);
        console2.log("tierPriceAt(0) wei/token", price);

        // Largest `take` with (price * take) / 1e18 == 1.
        uint256 take = (2 * 1e18) / price - 1;
        uint256 cost = (price * take) / 1e18;
        console2.log("take (wei-tokens)", take);
        console2.log("cost (wei)       ", cost);

        vm.prank(attacker);
        uint256 charged = hook.mintBondingCurve(take, cost);
        assertEq(charged, cost, "charged == quoted");
        console2.log("tokens bought for 1 wei", take);
        console2.log("full ladder at this rate needs N txs", 12_600_000e18 / take);

        // ACCEPTED, NOT FIXED.  One wei buys ~0.0000000000008 of a token here,
        // and the ladder cannot be walked this way: `mintBondingCurve` advances
        // the cursor by exactly what it sells, so draining 12.6 M at this
        // granularity needs the transaction count logged above — a number with
        // no physical meaning.  Rounding in the buyer's favour by one wei-unit
        // per leg is the deliberate direction; the alternative (ceil) would let
        // a quote come back below what the mint then charges.
        //
        // The invariant that actually matters is that nothing is EVER free.
        assertGt(cost, 0, "a positive request always costs at least 1 wei");
        assertEq(hook.phase2Minted(), take, "and the cursor advances by exactly what was sold");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROBE F — can a dumper freeze the ladder (deny project revenue)?
    // ══════════════════════════════════════════════════════════════════════════
    //
    // The reference is `min(spot, TWAP)` with LIVE spot.  A dump crashes spot
    // instantly, and spot only recovers when somebody arbitrages it back.
    function test_probeF_spotCrashFreezesLadder() public {
        (ToshToken token, ToshLaunchpadHook hook) = _launchProject(10_000e8);

        // Let the market rally so a good chunk of ladder is unlocked.
        _nextBlock();
        _buy(hook, alice, 30_000e8);
        vm.warp(block.timestamp + 3601);
        _nextBlock();
        _buy(hook, alice, 1 wei);
        _nextBlock();

        uint256 unlockedAfterRally = hook.maxMintable();
        console2.log("maxMintable after rally", unlockedAfterRally);
        assertGt(unlockedAfterRally, 0, "fixture needs an open ladder to then freeze");

        // Attacker dumps whatever they hold to crash spot.
        uint256 bal = token.balanceOf(alice);
        PoolKey memory key = hook.getPoolKey();
        vm.startPrank(alice);
        token.approve(address(router), type(uint256).max);
        router.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: false, amountSpecified: -int256(bal), sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1
            }),
            _swapSettings(),
            ""
        );
        vm.stopPrank();

        _nextBlock();
        (,,, uint256 spot, uint256 twap,,) = hook.tierStatus();
        console2.log("spot after dump ", spot);
        console2.log("twap after dump ", twap);
        console2.log("maxMintable now ", hook.maxMintable());

        // ACCEPTED, NOT FIXED — and this is the gate working, not failing.
        //
        // The reference is `min(spot, TWAP)` with LIVE spot precisely so that a
        // collapsing market shuts the ladder instantly rather than a window
        // later.  The mirror image is that anyone willing to sell into their own
        // dump can throttle project revenue for as long as they can hold the
        // price down — which costs them the spread every time, and ends the
        // moment an arbitrageur takes the other side.
        //
        // Using max() instead would make the ladder unfreezable and also make it
        // mintable straight into a crash.  That is the worse trade.
        assertLt(hook.maxMintable(), unlockedAfterRally, "a crashed spot must throttle the ladder");
        assertLe(spot, twap, "spot leads the TWAP down, so min() follows spot");
    }
}
