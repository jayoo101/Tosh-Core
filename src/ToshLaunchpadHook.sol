// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ──────────────────────────────────────────────────────────────────────────────
// Uniswap V4 core
// ──────────────────────────────────────────────────────────────────────────────
import {IHooks} from "../lib/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "../lib/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "../lib/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "../lib/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "../lib/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "../lib/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "../lib/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "../lib/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "../lib/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "../lib/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "../lib/v4-core/src/libraries/FullMath.sol";
import {SafeCast} from "../lib/v4-core/src/libraries/SafeCast.sol";
import {StateLibrary} from "../lib/v4-core/src/libraries/StateLibrary.sol";

// ──────────────────────────────────────────────────────────────────────────────
// Uniswap V4 periphery
// ──────────────────────────────────────────────────────────────────────────────
import {LiquidityAmounts} from "../lib/v4-periphery/src/libraries/LiquidityAmounts.sol";

// ──────────────────────────────────────────────────────────────────────────────
// OpenZeppelin
// ──────────────────────────────────────────────────────────────────────────────
import {ReentrancyGuard} from "../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

// ──────────────────────────────────────────────────────────────────────────────
// Local
// ──────────────────────────────────────────────────────────────────────────────
import {ToshToken} from "./ToshToken.sol";
import {ToshCloneLib} from "./libraries/ToshCloneLib.sol";

/// @title  ToshLaunchpadHook (v5.0 — ETH-native, tiered shelves, piggyback burn)
/// @notice Uniswap V4 Hook powering a single Tosh project launch.
///
/// ── What changed in v5.0 ────────────────────────────────────────────────────
///
///   1. 100 % ETH-NATIVE.  SATO is gone from every value flow.  The V4 pair is
///      `ETH / projectToken`; because `address(0)` sorts below every ERC-20,
///      ETH is ALWAYS `currency0` — the v4.x `satoIsCurrency0` branching is
///      deleted along with it.
///
///   2. GLOBAL REFERRALS.  10 % of each genesis deposit is carved off as
///      referral commission.  Referred deposits credit the referrer (claimable
///      post-launch); un-referred deposits send their 10 % to the platform
///      ladder treasury as buyback ammunition rather than becoming dead ETH.
///
///   3. DISCRETE TIER SHELVES replace the v4.x `tan(z)` Taylor bonding curve.
///      Phase 2 is a monotonic ramp of `TIER_COUNT` (4000) fixed-price shelves
///      spanning 2000× from the opening price, each gated behind a market-price
///      ceiling so the project cannot mint its way down into the pool and
///      drain it.
///
///   4. ASYMMETRIC IN-FLIGHT TAX & DIRECT BURN.  A 1.0 % skim is taken off the
///      INPUT of every swap, routed by direction rather than by which currency
///      happened to be `amountSpecified`:
///
///        BUY  (ETH in)   → 0.7 % ETH   → ToshLadderTreasury  (buyback fuel)
///                        + 0.3 % ETH   → platformFeeRecipient (platform revenue)
///        SELL (token in) → 1.0 % TOKEN → 0xdead              (burned in place)
///
///      Only the buy leg is split, and only because only the buy leg's input is
///      ETH — see `PLATFORM_SWAP_FEE_BPS`.
///
///      Exact-input settles that skim in `beforeSwap` (specified IS the input).
///      Exact-output settles it in `afterSwap` against the unspecified input,
///      so a router that asks for "N tokens out" cannot starve the buyback
///      reservoir by flipping the specified currency.  The sell leg needs no
///      reservoir at all — dumped tokens are destroyed on contact.  The buy
///      leg accumulates ETH which `afterSwap` then piggybacks into a
///      round-robin ladder buyback whenever the reservoir crosses 1 ETH.
///
///      The v4.x `harvestAndBurn` entry point and its off-chain MEV-defence bot
///      are deleted — the flywheel is now fully on-chain and self-driving.
///
///   5. OPEN LP + A FRICTION BUDGET, SPLIT.  v4.x reverted every
///      `removeLiquidity` to keep the genesis position locked, which also
///      trapped anyone else who provided liquidity — so nobody did, and the
///      1 % pool fee it charged accrued to a position no one could ever
///      collect from.  Stacked on the 1 % tax, traders paid 2 % and half of it
///      was destroyed on arrival.
///
///      v5.0 opens the pool to third-party LPs and splits the budget:
///
///        0.3 %  POOL_FEE  → LPs, settled natively by V4 (no code of ours)
///        1.0 %  hook tax  → buyback reservoir / burn / platform
///
///      That started as a flat 1 % all-in (0.3 + 0.7).  Carving the platform's
///      maintenance cut out of the hook tax raised the total toll to 1.3 % —
///      still well below v4.x's 2 %, and the pool fee half is no longer dead
///      weight.  See `PLATFORM_SWAP_FEE_BPS` for what that bought and cost.
///
///      The genesis position stays locked without any callback: V4 keys
///      positions to their creator, it belongs to this hook, and this hook has
///      no code path that removes liquidity.  `BEFORE_REMOVE_LIQUIDITY` was
///      therefore dropped from the address mask (0x22C8 → 0x20C8).  v5.0 then
///      added `AFTER_SWAP_RETURNS_DELTA` (0x20C8 → 0x20CC) so exact-output
///      buys still fund the treasury instead of burning the output token.
///
/// ── Lifecycle ───────────────────────────────────────────────────────────────
///
///   Phase 1 — Genesis (24 h)
///     • Qualified wallets deposit native ETH through ToshFactory.
///     • Success path `launch()`:
///         – 90 % of raised ETH + 3.78 M tokens seed a full-range V4 position,
///           locked by ownership: the position belongs to this hook, and the
///           hook has no code path that removes it.  Third-party LPs use
///           their own positions and may enter or exit freely.
///         – 10 % is reserved for referral commission / treasury.
///         – P0 = lpEth / GENESIS_LP_SUPPLY is the pool's opening price.  The
///           45 / 55 genesis split makes that exactly 1.10 × what depositors
///           paid, so genesis opens at a 10 % premium by construction.
///         – Shelf 0 then sits a further 5 % above P0, i.e. 1.155 × the
///           depositors' cost, so Phase 2 never undercuts them.
///     • Failure path `refund()` — soft-cap miss OR 7-day zombie timeout.
///
///   Phase 2 — Tier shelves (open to all, mint-only)
///     • `claimGenesis()`         : pro-rata 4.62 M claim side.
///     • `claimReferralReward()`  : referrers withdraw accrued ETH.
///     • `mintBondingCurve()`     : buy from the active shelf at its fixed
///                                  price, subject to the anti-spike gate.
///
/// ── Required hook address flags (v5.0) ──────────────────────────────────────
///   BEFORE_INITIALIZE            = 1 << 13 = 0x2000   pool-init front-run defence
///   BEFORE_SWAP                  = 1 << 7  = 0x0080   exact-input tax (specified = input)
///   AFTER_SWAP                   = 1 << 6  = 0x0040   oracle + piggyback + exact-output tax
///   BEFORE_SWAP_RETURNS_DELTA    = 1 << 3  = 0x0008   skim the specified (input) side
///   AFTER_SWAP_RETURNS_DELTA     = 1 << 2  = 0x0004   skim the unspecified (input) side
///   Mask: 0x20CC  (mine via HookMiner / CREATE2)
///
///   Exact-output cannot be taxed in `beforeSwap`: the input is unspecified
///   and its size is only known after the swap.  Returning a delta from
///   `afterSwap` is what charges that input, so the flag is load-bearing.
///
///   BEFORE_REMOVE_LIQUIDITY is absent so third-party LPs can withdraw freely;
///   see `beforeRemoveLiquidity` for why the genesis position stays locked
///   regardless.
///
contract ToshLaunchpadHook is IHooks, IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════════════════
    //  Constants
    // ══════════════════════════════════════════════════════════════════════════

    // ─── Supply ───────────────────────────────────────────────────────────────

    /// @notice Tokens minted at `launch()`: the genesis block, 40 % of supply.
    ///
    /// @dev    40 / 60 against the ladder rather than the 20 / 80 v5.0 shipped
    ///         with.  The split is the primary control on early inflation, and
    ///         it is a far stronger one than the ladder's own geometry: equal
    ///         shelves release `log(R)/log(SPAN)` of Phase 2 regardless of how
    ///         large Phase 2 is, so the only way to shrink the absolute number
    ///         of tokens the market has to absorb on the way up is to shrink
    ///         the ladder itself and hand the difference to genesis, where it
    ///         is already priced in and already circulating.  Doubling genesis
    ///         from 4.2 M to 8.4 M cuts the 2× release from 36.5 % of the
    ///         genesis float to 13.7 %.
    uint256 public constant GENESIS_SUPPLY = 8_400_000e18;

    /// @notice The genesis split, and the whole reason depositors open at a
    ///         profit.
    ///
    /// @dev    A 55 / 45 split of the 8.4 M genesis block is what manufactures
    ///         the depositors' 10 % opening premium.  Writing `R` for the raise
    ///         and noting that `REFERRAL_BPS` carves a flat 10 % off every
    ///         deposit — commission when a referrer exists, orphan sweep to the
    ///         treasury when one does not — the pool is always seeded with
    ///         `lpEth = 0.9 · R`.  So:
    ///
    ///             depositor cost   P_raise = R / 4_620_000
    ///             pool open        p0      = 0.9 · R / 3_780_000
    ///
    ///             p0 / P_raise = (0.9 / 3.78) · 4.62 = 1.10   exactly
    ///
    ///         The 10 % is therefore structural, not a parameter anyone tunes:
    ///         it falls out of the RATIO 55 : 45 against the referral rate, not
    ///         out of the absolute numbers, which is why resizing the genesis
    ///         block leaves it untouched.  Move the ratio or the referral rate
    ///         and the premium moves with it, so
    ///         `test_genesisPremium_isExactlyTenPercent` pins the relationship
    ///         rather than the individual numbers.
    uint256 public constant GENESIS_CLAIM_SUPPLY = 4_620_000e18; // 55 %
    uint256 public constant GENESIS_LP_SUPPLY = 3_780_000e18; // 45 %

    /// @notice Number of discrete price shelves in Phase 2.
    uint256 public constant TIER_COUNT = 4000;

    /// @notice Token quota per shelf.  4000 × 3 150 = 12 600 000, which keeps
    ///         the total-supply arithmetic intact (8.4 M + 12.6 M = 21 M).
    uint256 public constant TIER_SIZE = 3_150e18;

    /// @notice Total Phase-2 issuance once every shelf is cleared.
    uint256 public constant BONDING_MAX = TIER_COUNT * TIER_SIZE;

    /// @dev Geometric shelf step in 1e18 fixed point: price(i) = shelfP0 · STEP^i.
    ///
    ///      STEP = 2000^(1/(TIER_COUNT-1)) = exp(ln 2000 / 3999) ≈ 1.001902508,
    ///      i.e. +0.19025 % per shelf, taking the ladder from p0 to ≈ p0 × 2000
    ///      across its 4000 rungs.  The step and the rung count are coupled:
    ///      the span is the chosen invariant and the step is re-derived to hit
    ///      it, so neither may be edited alone.
    ///
    ///      ×2000 rather than ×1000 because the release schedule of equal-size
    ///      shelves is `log(R)/log(SPAN)` — the market has to reach `SPAN^x` to
    ///      unlock fraction `x` of the ladder.  Widening the span is the only
    ///      lever on that curve that does not touch the 8.4 M / 12.6 M supply
    ///      split, and it buys roughly a tenth off every point on it.  The
    ///      split itself does the heavy lifting; the span is the trim.
    ///
    ///      Fitted so `_powE18(STEP, 3999) ≈ 2000e18` (floor mulDiv), not by
    ///      rounding a floating `exp`.  ×2000 keeps `p0 · STEP^3999` far
    ///      inside uint256 — the top rung leaves ~202 bits of headroom on a
    ///      typical raise — whereas a naive ×1.2-per-rung step over thousands
    ///      of rungs would overflow long before the ladder emptied.
    uint256 internal constant TIER_STEP_E18 = 1_001_902_508_266_805_824;

    uint256 internal constant ONE_E18 = 1e18;

    /// @notice Most shelves a single `mintBondingCurve` call may sweep.
    ///
    /// @dev    A gas bound, NOT a security bound.  Shelf mints never touch the
    ///         pool, so `min(spot, TWAP)` is constant for the whole call and
    ///         the 105 % ceiling caps how far the ladder can travel regardless
    ///         of how the order is chopped up — a buyer who hits this limit can
    ///         simply send a second transaction in the same block and reach the
    ///         identical end state.  The cap exists only so one call cannot be
    ///         made to loop hundreds of times (each leg recomputes
    ///         `tierPriceAt`, which is O(log i)) and run out of gas.
    ///
    ///         Sized against the gate rather than picked round: a market that
    ///         has caught up to the cursor opens `ln(1.05) / ln(STEP) ≈ 25.7`
    ///         shelves, so 32 legs let the 105 % ceiling be the thing that
    ///         stops a normal sweep.  At 16 the leg cap bound first and every
    ///         such buyer paid for a second transaction that changed nothing.
    uint256 public constant MAX_TIERS_PER_TX = 32;

    // ─── Genesis timing ───────────────────────────────────────────────────────

    /// @notice The three genesis window lengths a creator may pick from.
    ///
    /// @dev    A CLOSED SET rather than a free `uint256`, because the duration
    ///         is part of the constructor tuple and therefore part of the
    ///         CREATE2 initcode hash.  An open range would let a creator mine
    ///         a salt against a 1-second window (nobody can deposit, genesis
    ///         fails, refunds open immediately) or a 100-year one (deposits are
    ///         locked with no refund path until then).  Three coarse rungs keep
    ///         the choice meaningful for the market while leaving no room for
    ///         either degenerate end.
    uint256 public constant DURATION_FAST = 3 hours;
    uint256 public constant DURATION_STANDARD = 24 hours;
    uint256 public constant DURATION_SLOW = 72 hours;

    uint256 public constant LAUNCH_WINDOW = 7 days;

    /// @notice The window this launch actually chose, frozen at deployment.
    /// @dev    A clone immutable arg — see the per-project block below.  Only
    ///         the *duration* can live there: `genesisDeadline` is
    ///         `block.timestamp + duration`, which the creator cannot predict
    ///         while mining a salt off-chain, so it has to be storage.
    function genesisDuration() public view returns (uint256) {
        return ToshCloneLib.argGenesisDuration();
    }

    // ─── Economics ────────────────────────────────────────────────────────────

    /// @notice Referral commission carved from every genesis deposit (10 %).
    uint256 public constant REFERRAL_BPS = 1000;

    /// @notice Platform cut of Phase-2 shelf proceeds (1 %), routed to the
    ///         buyback reservoir; the remaining 99 % goes to `projectAdmin`.
    uint256 public constant PLATFORM_TAX_BPS = 100;

    /// @notice Asymmetric in-flight tax skimmed off the INPUT of every pool
    ///         swap (1.00 %).  Buys (ETH in) split between the buyback
    ///         reservoir and the platform fee recipient; sells (token in) burn
    ///         in full.  Exact-input settles in `beforeSwap`; exact-output
    ///         settles in `afterSwap` so a router cannot starve the reservoir
    ///         by asking for an exact token amount out.
    ///
    /// @dev    ⚠ NOT THE SAME 100 AS `PLATFORM_TAX_BPS`, which is also 100 and
    ///         sits thirty lines up.  That one is 1 % of Phase-2 SHELF PROCEEDS
    ///         and is denominated in the ETH a minter pays the bonding curve.
    ///         This one is 1 % of a SWAP INPUT.  The two never apply to the
    ///         same wei — shelf mints do not touch the pool — but the shared
    ///         literal is a reading hazard, so they are named apart on purpose
    ///         and `test_taxRates_areDistinctPathsDespiteSharedLiteral` pins
    ///         both against their own paths.
    ///
    /// @dev    Stacked on the 0.30 % `POOL_FEE` that goes to third-party LPs,
    ///         a trader's total friction is 1.30 %.  This was 0.70 % (a flat
    ///         1.00 % all-in) until the platform's own maintenance cut was
    ///         carved out; see `PLATFORM_SWAP_FEE_BPS` for what changed and
    ///         what it cost.
    ///
    /// @dev    THE TWO PATHS APPLY THIS RATE TO DIFFERENT BASES, ON PURPOSE.
    ///
    ///         Exact-input charges 100 bps of `amountSpecified` — the gross the
    ///         trader has already committed — so the tax is INCLUSIVE and works
    ///         out to exactly 100 bps of their outlay.
    ///
    ///         Exact-output charges 100 bps of the input the pool consumed,
    ///         which the trader then pays ON TOP.  That is EXCLUSIVE, so the
    ///         realised rate is 100 / 1.01 = 99.0 bps of total outlay.
    ///
    ///         One basis point apart, and left alone deliberately.  Closing it
    ///         means grossing up by `100 / (10_000 - 100)`, which buys 1 bps at
    ///         the cost of a division nobody reading `_skimUnspecifiedInput`
    ///         would expect and a rate constant that no longer means what it
    ///         says.  Recorded here so the asymmetry reads as a decision rather
    ///         than an oversight — it has been raised once already by a
    ///         reviewer who could not tell which it was.
    ///
    ///         The gap widened from 0.5 bps to 1 bps when the rate went 70 →
    ///         100, because it is second-order in the rate itself.  Still below
    ///         the threshold where it is worth the division.
    uint256 public constant TAX_BPS = 100;

    /// @notice The platform's maintenance cut, carved OUT OF `TAX_BPS` on the
    ///         buy leg only (0.30 % of the ETH input), paid to
    ///         `platformFeeRecipient`.
    ///
    /// @dev    CARVED OUT OF, NOT ADDED ON TOP.  `TAX_BPS` is the whole toll a
    ///         trader pays; this is how the buy leg divides it.  The reservoir
    ///         receives `TAX_BPS - PLATFORM_SWAP_FEE_BPS` = 70 bps, which is
    ///         exactly what it received before this split existed, so the
    ///         buyback engine's economics are untouched and every reservoir
    ///         assertion written against 70 bps of input still holds.
    ///
    /// @dev    BUY LEG ONLY, and that is the substantive half of the decision.
    ///         The sell leg's input is the project's own token, so splitting it
    ///         would pay the platform in whatever each project happens to have
    ///         issued — a growing bag of illiquid positions in the very tokens
    ///         it is supposed to be neutral about, which it would then have to
    ///         sell into those pools to realise.  Burning the full 1 % instead
    ///         keeps the sell leg deflationary and keeps the platform holding
    ///         nothing but ETH.
    ///
    /// @dev    This is the one place platform revenue does NOT end at
    ///         `ladderTreasury`, and it is a deliberate break with the v5.0
    ///         claim that all of it is committed to buyback-and-burn.  Three
    ///         other pipes (launch fees, the shelf cut, orphaned referral
    ///         commission) still route there in full.  The break is documented
    ///         as such in `PRD-v5.0.md` §2 rather than being quietly true.
    uint256 public constant PLATFORM_SWAP_FEE_BPS = 30;

    uint256 internal constant BPS_DENOMINATOR = 10_000;

    // ─── Anti-spike gate ──────────────────────────────────────────────────────

    /// @notice A shelf may only be minted while its price sits at or below
    ///         105 % of the anti-spike reference price.
    uint256 public constant PRICE_CEILING_BPS = 10_500;

    /// @notice Shelf 0 opens at this markup over the pool's opening price, so
    ///         the ladder starts one notch ABOVE the market instead of level
    ///         with it.
    ///
    /// @dev    Deliberately equal to `PRICE_CEILING_BPS`, which is what makes
    ///         the gate collapse into a clean invariant.  With
    ///         `price(i) = p0 · PREMIUM · STEP^i` and a ceiling of
    ///         `REF · PREMIUM`, the premium cancels on both sides:
    ///
    ///             shelf i unlocks  ⟺  REF ≥ p0 · STEP^i
    ///
    ///         where REF is `min(spot, TWAP)` once a full `TWAP_WINDOW` has
    ///         elapsed, and `min(spot, p0)` until then — a stub TWAP averaged
    ///         over a handful of seconds is not a TWAP.
    ///
    ///         So the ladder tracks the market one-for-one and charges a flat
    ///         5 % for minting fresh supply instead of buying it on the open
    ///         market.  Three consequences fall out of that:
    ///
    ///           • The opening exposure collapses.  Level with the market, the
    ///             ceiling left shelves 0..25 (109 200 tokens) mintable in the
    ///             launch block.  One notch above it, only shelf 0 can ever be
    ///             in range at the open, and even that is held back: `launch()`
    ///             stamps `lastSwapBlock`, so the launch block is closed
    ///             outright and Phase 2 lifts from the next block, only once
    ///             the market holds at or above the genesis price.
    ///
    ///             That lockout is load-bearing rather than belt-and-braces.
    ///             At launch `spot == p0` only up to sqrt truncation, and the
    ///             gate's `>` is strict, so shelf 0 sits precisely ON the
    ///             boundary and is admitted or refused depending on which side
    ///             of `p0` the round-tripped spot lands — a function of the
    ///             raise size, not of the design.  See `launch()`.
    ///
    ///           • Mint-and-dump is loss-making EVERYWHERE on the ladder, not
    ///             just at the open, because the buyer always pays 5 % over the
    ///             market they would have to sell back into.
    ///
    ///           • Stacked on the genesis split, shelf 0 costs
    ///             `1.05 × 1.10 = 1.155 ×` what a genesis depositor paid.  The
    ///             depositors' 10 % head start is therefore never undercut by
    ///             Phase-2 issuance.
    uint256 public constant SHELF_PREMIUM_BPS = 10_500;

    /// @notice Target TWAP window.  The hook keeps two rolling checkpoints
    ///         rather than a full ring buffer, so on a pool that trades at
    ///         least once per window the realised window floats in
    ///         [TWAP_WINDOW, 2 × TWAP_WINDOW).
    ///
    ///         That bracket used to be stated unconditionally, and it was not
    ///         true.  The checkpoint rolls when a SWAP arrives, never on the
    ///         clock, so `span` is bounded by the inter-trade interval —
    ///         measured at 608_400 s (7.04 days) on a weekly-traded pool, and
    ///         a pool that merely pauses for two windows already exceeds the
    ///         stated ceiling.  `_twapSqrtPriceX96` now short-circuits the
    ///         quiet case to `lastTick` (the exact average of a flat window),
    ///         which is what makes the bracket above hold wherever it is
    ///         meaningful.  `test_probeB2_quietPoolTwapDoesNotFossilise` pins
    ///         the quiet end; `test_probeB_twapReanchorSpeed` pins the busy one.
    ///
    /// @dev    THIS CONSTANT IS THE ORACLE'S ENTIRE MANIPULATION DEPTH — read
    ///         it as a price, not as a guarantee.
    ///
    ///         The checkpoint rolls on the first swap landing `>= TWAP_WINDOW`
    ///         after `_cur`, and anyone may supply that swap.  An attacker who
    ///         holds a pumped price and then pokes with dust at exactly the
    ///         right moment collapses the averaging window to its floor, and
    ///         the TWAP converges on the pumped level.  Measured at the old
    ///         600 s setting: a price held ~10 minutes moved the TWAP from p0
    ///         to within 0.001 % of the manipulated spot, which then opened the
    ///         full `MAX_TIERS_PER_TX` run.  No ring buffer changes that — with
    ///         two checkpoints the depth simply IS this number.
    ///
    ///         So the number is the lever.  1800 s puts the realised window in
    ///         [30 min, 60 min) and triples the hold an attacker has to fund,
    ///         while still letting an honestly rallying market open its ladder
    ///         within the hour.  It is not a wall: minting stays deliberately
    ///         unprofitable on its own terms (every shelf costs 105 % of the
    ///         reference), and this window is what makes reaching that
    ///         reference cost real time rather than one block.
    uint32 public constant TWAP_WINDOW = 1800;

    // ─── Pool ─────────────────────────────────────────────────────────────────

    /// @notice V4 static swap fee, 0.30 % — paid entirely to liquidity
    ///         providers by V4's native accounting.
    ///
    /// @dev    Together with the 0.70 % hook tax this holds total trader
    ///         friction at exactly 1.00 %, the same figure v4.x charged.  What
    ///         changed is where it goes: v4.x split it 1 % pool + 1 % tax for
    ///         2 % total, and the pool half was dead weight because the only
    ///         LP was the permanently locked genesis position.
    ///
    ///         Now that third-party LPs can enter and exit freely, the pool fee
    ///         has a real job — compensating them for impermanent loss — and it
    ///         needs no distribution code of ours at all.  V4 credits fees to
    ///         positions natively; LPs collect by calling `modifyLiquidity` on
    ///         their own position like any other V4 pool.
    uint24 public constant POOL_FEE = 3000; // 0.30 %

    /// @dev Uniswap pairs 0.30 % with a tick spacing of 60 by convention.  This
    ///      pool keeps 200 so that TICK_LOWER/UPPER stay aligned and the
    ///      genesis range is unchanged; the cost is that third-party LPs can
    ///      only place range bounds on a ~2 % grid, which is coarse but
    ///      workable for a freshly launched token.
    int24 public constant TICK_SPACING = 200;

    int24 internal constant TICK_LOWER = -887200;
    int24 internal constant TICK_UPPER = 887200;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint8 internal constant ACTION_ADD_LIQUIDITY = 1;

    /// @notice Mirror of `ToshLadderTreasury.TRIGGER_STEP`, the reservoir balance
    ///         that arms a piggyback buyback.
    ///
    /// @dev    Held here so `afterSwap` can decide whether the poke is worth
    ///         making without paying for a call to find out — see the comment at
    ///         the call site.  Mirroring a constant across two contracts is a
    ///         coupling, and the failure mode if it drifts is quiet (a buyback
    ///         that never fires, or a poke on every swap), so
    ///         `test_piggybackTriggerMirrorsTheTreasury` asserts the two are
    ///         equal.  Reading it from the treasury instead would cost the very
    ///         call this exists to avoid.
    uint256 public constant PIGGYBACK_TRIGGER_STEP = 1 ether;

    /// @notice Gas held back from the piggyback poke so the swap can always
    ///         finish.
    ///
    /// @dev    Everything after the poke — returning through `afterSwap`, V4
    ///         closing the unlock frame, the router settling and refunding —
    ///         measures ~70k.  This is that with room to spare, and it is
    ///         enforced by passing `{gas: avail - PIGGYBACK_TAIL_RESERVE}`
    ///         rather than by hoping: the poke physically cannot touch this
    ///         share, so a leg that costs far more than expected is skipped
    ///         instead of stranding the trade.
    uint256 public constant PIGGYBACK_TAIL_RESERVE = 100_000;

    /// @notice Gas that must remain at the poke for a buyback to be attempted.
    ///
    /// @dev    `PIGGYBACK_TAIL_RESERVE` plus one leg plus slack.  Below that sum
    ///         the poke can only burn gas to discover it cannot finish, so the
    ///         sum is a FLOOR and not a target — see the correction below.
    ///
    ///         Calibrating this is a one-sided bet in one direction only.  Gas-
    ///         dependent control flow does not survive `eth_estimateGas`
    ///         cleanly: a wallet simulates with a generous limit, so the
    ///         simulation takes the buyback branch and quotes ~333k, then signs
    ///         that plus a buffer — and by the time execution reaches the poke,
    ///         `gasleft()` is the limit MINUS the ~147k already spent getting
    ///         here.  So the limit needed to actually engage is `147k + this`,
    ///         not `this`.  Raising this therefore raises the buffer a wallet
    ///         must attach, and at 260k an earlier revision measured 22 % —
    ///         above what wallets attach, which quietly degraded the mechanism
    ///         to `pokeBuyback()` only.
    ///
    ///         **That reasoning was then carried past the floor, and the value
    ///         spent time at 230,000, which is below it.**  The argument for
    ///         erring low assumed the two failures were asymmetric: that too LOW
    ///         merely wastes a poke while too HIGH retires the mechanism.  Below
    ///         the floor they are the same failure.  A gate at 230,000 admits a
    ///         poke, forwards `230_000 - 100_000` and hands one leg 130k to do
    ///         149k of work; the leg runs out, `try/catch` swallows it, and no
    ///         buyback happens either way.  The only thing erring low bought was
    ///         the wasted 130k, and it bought it silently — the trade succeeds,
    ///         and a buyback that does not happen is indistinguishable from the
    ///         unarmed case that is the normal state of this branch.
    ///
    ///         So the floor is the target, not a bound to sit safely above.
    ///         Both directions away from it cost something real and the costs
    ///         are opposite, which is why "err low" was never the right shape of
    ///         advice.  Set BELOW the floor and the band between gate and floor
    ///         is pure waste — admitted pokes that cannot finish.  Set ABOVE it
    ///         and the band between floor and gate is lost buybacks — pokes
    ///         declined that would have completed.  Exactly at the floor, both
    ///         bands are empty.  Nothing but the floor is defensible, and the
    ///         floor is a measurement, so it has to be re-taken per chain.
    ///
    ///         **Now measured on the chain this ships to** rather than inferred
    ///         from Ethereum.  One leg on Robinhood 46630, against the live V4
    ///         singleton and a real launched pool, costs **156,153** gas — 4.8 %
    ///         above the 148,986 the same leg measures locally under `--isolate`.
    ///         The migration's stated worry was that ArbOS accounting would
    ///         diverge widely from Ethereum's; at 4.8 % it does not.  The floor
    ///         on 4663 is `100_000 + 156_153 = 256_153`, and this is the next
    ///         round number above it.
    ///
    ///         156,153 is the dearest of four samples and the right one to size
    ///         against: it is the first buyback of a newly listed token, which
    ///         pays ~17k to take that token's `0xdEaD` balance slot from zero.
    ///         Steady-state legs measured ~139k.  Sizing to the steady state
    ///         would put the first poke of every new listing back in the waste
    ///         band.  §F.7 of `docs/ROBINHOOD_MIGRATION.md` has all four samples
    ///         and the probe contract.
    ///
    ///         This costs a wallet ~5 points of buffer against the value it
    ///         replaces, and that is worth stating rather than burying: the
    ///         engage test reads 20 % where it read 15 % at 230,000.  Some of
    ///         those apparent engagements were real, so this is a genuine trade
    ///         and not a free correction.  It is still the right one — the 15 %
    ///         was measured in Ethereum's accounting, which this contract will
    ///         never execute in, and under the accounting it WILL execute in the
    ///         old value sat 26k below the floor.
    ///
    ///         Three tests hold the three edges.
    ///         `test_piggybackStillRidesAProperlyEstimatedSwap` pins the engage
    ///         side and now asserts BOTH bounds — it is the missing lower bound
    ///         that let this sit under the floor unnoticed.
    ///         `test_piggybackSkipsRatherThanKillingTheTrade` pins the skip side.
    uint256 public constant PIGGYBACK_MIN_GAS = 260_000;

    // ══════════════════════════════════════════════════════════════════════════
    //  Immutables
    // ══════════════════════════════════════════════════════════════════════════

    // ─── Platform-global (one copy, shared by every project) ──────────────────
    //
    // These are identical for every launch, so they stay ordinary immutables on
    // the implementation. Under DELEGATECALL they resolve to constants PUSHed
    // from the implementation's code, which is why they cost zero bytes per
    // project and are just as cheap to read as before.

    IPoolManager public immutable poolManager;
    address public immutable factory;

    /// @notice Platform buyback reservoir; receives the reservoir's 70 bps
    ///         share of the buy-side dark tax and any orphaned referral
    ///         commission.
    address payable public immutable ladderTreasury;

    /// @notice Receives `PLATFORM_SWAP_FEE_BPS` (30 bps) of every buy's ETH
    ///         input — the platform's maintenance and development cut.
    ///
    /// @dev    IMMUTABLE ON PURPOSE, and this is a re-litigated decision.
    ///         v4.x let the factory owner retarget Phase-2 fee routing through
    ///         a mutable `platformTreasury`; that was audit finding M-2, and
    ///         v5.0 closed it by making every revenue sink an immutable
    ///         constructor argument.  Reading a mutable factory field here
    ///         would reopen M-2 on a far bigger base — the factory owner could
    ///         redirect every buy on every project at will — so this sink is
    ///         shaped exactly like `ladderTreasury` instead.
    ///
    ///         Being an implementation-level immutable rather than a clone arg
    ///         means changing it needs a new hook implementation and a factory
    ///         repoint, and only affects launches created afterwards.  Existing
    ///         projects keep the recipient they launched with, which is the
    ///         property M-2 was about.
    ///
    /// @dev    MUST accept ETH unconditionally.  `poolManager.take` performs a
    ///         raw value transfer for the native currency, and this call is NOT
    ///         fault-isolated the way the piggyback poke is — a recipient that
    ///         reverts on receive bricks every buy on every pool.  An EOA or a
    ///         Safe is fine; a contract with a reverting or gas-hungry
    ///         `receive()` is not.  `ladderTreasury` carries the same
    ///         requirement, so this adds no new class of risk, only a second
    ///         address that has to satisfy it.
    address payable public immutable platformFeeRecipient;

    /// @dev This implementation's own address, captured at construction. Under
    ///      DELEGATECALL `address(this)` is the clone, so `address(this) ==
    ///      _self` means nobody proxied us and the per-project config below is
    ///      meaningless. See `onlyClone`.
    address private immutable _self;

    /// @dev Whether this deployment sits on an Arbitrum-family chain, decided
    ///      once at construction. See `_blockNumber` for what turns on it.
    bool private immutable _hasArbSys;

    // ══════════════════════════════════════════════════════════════════════════
    //  Per-project configuration — read from the clone's own bytecode
    // ══════════════════════════════════════════════════════════════════════════
    //
    // Each project's hook is a 121-byte EIP-1167 clone of this implementation
    // with these five fields appended to its runtime code (see
    // `ToshCloneLib`). They were `immutable` before, which meant CREATE2-ing
    // a fresh 19,586-byte copy of this entire contract per launch — 3,917,200
    // gas of code deposit, 78 % of what `createLaunch` cost.
    //
    // The guarantees are unchanged. These values still cannot be altered after
    // deployment, still live in code rather than storage, and are still part of
    // the CREATE2 initcode and therefore committed to by the hook's mined
    // address. The reads are warm EXTCODECOPYs at ~109 gas, on par with the
    // warm SLOAD they replace and cheaper than a cold one.
    //
    // They are functions rather than public variables purely as an
    // implementation detail: the ABI is byte-for-byte what `public immutable`
    // generated, so callers and indexers see no change.

    /// @notice Wallet that may call `launch()`.
    function creator() public view returns (address) {
        return ToshCloneLib.argCreator();
    }

    /// @notice The project's declared multisig, recorded at launch.
    ///
    /// @dev    ⚠ THIS ADDRESS NEVER RECEIVES FUNDS.  Nothing in this contract,
    ///         the factory, or the treasury transfers to it.  Project revenue —
    ///         99 % of every shelf sale — is paid to `projectAdmin`, which is a
    ///         separate, rotatable address.
    ///
    ///         It survives because it is part of the clone's immutable args and
    ///         therefore of the hook's mined address: on-chain, unalterable,
    ///         human-readable evidence of which multisig a project claimed at
    ///         launch.
    ///
    ///         If you are looking for where the money goes, see `projectAdmin`
    ///         and `ladderTreasury`.
    function projectTreasury() public view returns (address) {
        return ToshCloneLib.argProjectTreasury();
    }

    /// @notice Minimum ETH that must be raised by `genesisDeadline`.
    ///         Snapshotted from `ToshFactory.defaultSoftCap` at deploy time.
    function softCap() public view returns (uint256) {
        return ToshCloneLib.argSoftCap();
    }

    /// @notice Maximum ETH any single wallet may put into THIS project.
    ///
    /// @dev    Snapshotted from `ToshFactory.maxPogAllocationLimit` at deploy
    ///         time, deliberately frozen rather than read live.  The platform
    ///         owner can retune the dial at any moment, and a raise or cut
    ///         landing mid-genesis would silently rewrite the terms a project
    ///         was funded under.  Freezing it at creation means a change only
    ///         ever governs projects launched after it — rounds already in
    ///         flight keep the cap their depositors signed up to.
    function perWalletCap() public view returns (uint256) {
        return ToshCloneLib.argPerWalletCap();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Mutable state
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Receives the 99 % Phase-2 cut and may rotate itself.
    address public projectAdmin;

    ToshToken public projectToken;
    bool public tokenInitialized;

    uint256 public genesisDeadline;
    bool public launched;
    /// @notice Event-dedup flags, NOT the refund gate.
    ///
    /// @dev    Set lazily the first time `refund()` actually runs, so the
    ///         `GenesisFailed` / `ZombieRefund` events fire once.  Nothing
    ///         reads these as a condition — `refund()` and `canRefund()`
    ///         recompute `softCapFailed || zombieExpired` on every call.
    ///         Indexers and the UI must treat `canRefund()` as the authority;
    ///         these flags stay `false` until the first claimant shows up,
    ///         even when refunds are already available.
    bool public refundEnabled;
    bool public zombieRefundEnabled;

    // ─── Genesis accounting (all ETH-wei) ─────────────────────────────────────

    uint256 public totalEthDeposited;
    mapping(address => uint256) public ethDeposited;
    mapping(address => bool) public genesisShareClaimed;

    /// @notice Referral commission accrued per referrer, claimable post-launch.
    mapping(address => uint256) public referralAccrued;

    /// @notice Sum of `referralAccrued`, held back from the LP seed.
    uint256 public totalReferralReserved;

    /// @notice Commission from deposits that carried no referrer.  Forwarded to
    ///         `ladderTreasury` at launch so it can never become stuck ETH.
    uint256 public orphanReferral;

    /// @notice Total referral ETH already withdrawn.
    uint256 public totalReferralClaimed;

    // ─── Phase 2 shelves ──────────────────────────────────────────────────────

    /// @notice The pool's opening price — ETH-wei per whole token, derived at
    ///         launch from the genesis raise.  This is the price the genesis LP
    ///         is seeded at, NOT the price shelf 0 sells at.
    uint256 public p0;

    /// @notice Shelf 0's price: `p0` marked up by `SHELF_PREMIUM_BPS`.
    ///
    /// @dev    Kept as its own storage slot rather than recomputed from `p0` on
    ///         every read, because `tierPriceAt` is on the mint hot path and in
    ///         every view the UI polls.
    uint256 public shelfP0;

    /// @notice The whole Phase-2 ladder position, in one slot.
    ///
    /// @dev    These three were `uint256 public` fields in three slots until the
    ///         gas work.  `mintBondingCurve` writes all three together and reads
    ///         two of them together, so splitting them across slots bought
    ///         nothing and cost two extra SSTOREs on every shelf mint — the
    ///         single most expensive thing the contract does per buyer.
    ///
    ///         Widths are not estimates; each is bounded by a constant in this
    ///         file, and `test_ladderStateWidthsFitTheirConstants` fails the
    ///         build if a future retune of `TIER_COUNT` or `TIER_SIZE` outgrows
    ///         one of them.  That test is load-bearing: Solidity does not check
    ///         explicit downcasts, so an overgrown constant would truncate
    ///         silently rather than revert.
    ///
    ///           tierIndex  ≤ TIER_COUNT  = 4 000    (uint16  holds 65 535)
    ///           tierSold   < TIER_SIZE   = 3.15e21  (uint88  holds 3.09e26)
    ///           minted     ≤ BONDING_MAX = 1.26e25  (uint96  holds 7.92e28)
    ///
    ///         Shelf PRICES are still not stored.  With 4000 rungs a materialised
    ///         ladder would cost millions of gas at launch, and a cached
    ///         "current price" advanced by repeated multiplication would drift
    ///         away from the closed form after 4000 truncating steps.  Prices
    ///         are instead derived on demand by `tierPriceAt()`, which is the
    ///         single source of truth for both the mint path and every view.
    struct LadderState {
        /// @dev Shelf currently on sale. `== TIER_COUNT` once the ladder is cleared.
        uint16 tierIndex;
        /// @dev Tokens already sold from the active shelf.
        uint88 tierSold;
        /// @dev Cumulative Phase-2 issuance across all shelves.
        uint96 minted;
    }

    LadderState internal _ladderState;

    /// @notice Index of the shelf currently on sale. `== TIER_COUNT` once the
    ///         entire ladder is cleared.
    ///
    /// @dev    Hand-written rather than a `public` field so that packing the
    ///         three into `_ladderState` stayed invisible to the ABI, the
    ///         subgraph and the front end.
    function currentTierIndex() public view returns (uint256) {
        return _ladderState.tierIndex;
    }

    /// @notice Tokens already sold from the active shelf.
    function currentTierSold() public view returns (uint256) {
        return _ladderState.tierSold;
    }

    /// @notice Cumulative Phase-2 issuance across all shelves.
    function phase2Minted() public view returns (uint256) {
        return _ladderState.minted;
    }

    // ─── Swap-derived state ───────────────────────────────────────────────────

    /// @dev Hook-local geometric-mean oracle.  Uniswap V4 core ships no
    ///      observation buffer (unlike V3), so the hook accumulates
    ///      `tick × elapsed` itself on every `afterSwap`.
    ///
    ///      `_lastSwapBlock` shares this slot deliberately.  Both it and
    ///      `lastTick` are written by every single swap, and as two separate
    ///      slots that was two cold SSTOREs (~5k each) where one suffices.
    ///      uint48 holds 2.8e14 blocks.  The figure this comment used to quote —
    ///      107 million years — assumed 12 s blocks, and `_blockNumber()` now
    ///      returns the settlement chain's own height, which on Robinhood Chain
    ///      ticks every 100 ms.  That is 120x faster and still ~890,000 years,
    ///      so the narrowing remains far from a real ceiling; the old premise
    ///      simply no longer describes where this deploys.  Slot use is
    ///      7 + 4 + 3 + 6 = 20 of 32 bytes.
    int56 public tickCumulative;
    uint32 public lastObservationTs;
    int24 public lastTick;
    uint48 private _lastSwapBlock;

    /// @dev Rolling TWAP checkpoints. `_prev` is the reference point the TWAP
    ///      is measured from; it rolls forward once `_cur` ages past TWAP_WINDOW.
    int56 internal _prevCheckpointCumulative;
    uint32 internal _prevCheckpointTs;
    int56 internal _curCheckpointCumulative;
    uint32 internal _curCheckpointTs;

    // ─── Pool internals ───────────────────────────────────────────────────────
    //
    // There is no `_poolKey` storage variable.  Every one of its five fields is
    // either a compile-time constant or already known: ETH is `address(0)` and
    // therefore always currency0, the fee and tick spacing are constants, the
    // hook is `address(this)`, and currency1 is `projectToken`.  Storing the
    // key cost three fresh SSTOREs at launch and four cold SLOADs on every
    // price read, all to hold values the contract can restate for one SLOAD.
    // `_key()` restates it; see also the one-pool argument on `beforeInitialize`.

    // ══════════════════════════════════════════════════════════════════════════
    //  Events
    // ══════════════════════════════════════════════════════════════════════════

    event TokenInitialized(address indexed token);
    event Deposited(address indexed user, uint256 ethAmount, address indexed referrer);
    event Launched(uint256 totalEth, uint256 lpEth, uint128 lpLiquidity, uint160 sqrtPriceX96, uint256 p0);
    event GenesisFailed(uint256 totalEthRaised);
    event ZombieRefund(uint256 totalEthRaised);
    event Refunded(address indexed user, uint256 ethAmount);
    event GenesisShareClaimed(address indexed user, uint256 tokenAllocation);
    event ReferralAccrued(address indexed referrer, address indexed referee, uint256 amount);
    event ReferralClaimed(address indexed referrer, uint256 amount);
    event OrphanReferralForwarded(uint256 amount);
    event ProjectAdminChanged(address indexed previousAdmin, address indexed newAdmin);

    /// @notice Emitted per shelf purchase.
    event TierMinted(
        address indexed buyer, uint256 indexed tierIndex, uint256 tierPrice, uint256 tokensOut, uint256 ethIn
    );

    /// @notice Emitted when a shelf sells out and the ladder advances.
    event TierAdvanced(uint256 indexed newTierIndex, uint256 newTierPrice);

    /// @notice Emitted when an ETH-side skim funds the platform buyback
    ///         reservoir.  Carries the reservoir's share only (70 bps of the
    ///         input), NOT the whole `TAX_BPS` skim — the platform's 30 bps is
    ///         reported separately by `PlatformSwapFeePaid` in the same swap,
    ///         and the two sum to the skim.
    ///
    /// @dev    The name predates the split and is kept so existing indexers and
    ///         the `monitoring/alerts.json` rules do not silently stop
    ///         matching.  What changed is the amount, not the meaning: this was
    ///         always "what the reservoir received".
    event BuyTaxToTreasury(uint256 ethAmount);

    /// @notice Emitted when a buy's ETH-side skim pays the platform's
    ///         maintenance cut to `platformFeeRecipient`.
    ///
    /// @dev    Buys only.  A sell emits `SellTaxBurned` alone, because the sell
    ///         leg is not split — see `PLATFORM_SWAP_FEE_BPS`.
    event PlatformSwapFeePaid(address indexed recipient, uint256 ethAmount);

    /// @notice Emitted when a token-side skim is burned in place at 0xdead.
    ///         Carries the FULL `TAX_BPS` skim; the sell leg is not split.
    event SellTaxBurned(uint256 tokenAmount);

    /// @notice Emitted when the `afterSwap` buyback poke reverted and was
    ///         swallowed so the swap could still settle.  Persistent emissions
    ///         mean the treasury no longer recognises this hook.
    event PiggybackPokeFailed(address indexed treasury);

    // ══════════════════════════════════════════════════════════════════════════
    //  Errors
    // ══════════════════════════════════════════════════════════════════════════

    error OnlyPoolManager();
    error OnlyFactory();
    error OnlyCreator();
    error NotInitialized();
    error AlreadyInitialized();
    error GenesisActive();
    error GenesisExpired();
    error AlreadyLaunched();
    error NotLaunched();
    error AlreadyClaimed();
    error NoDeposit();
    error ZeroAmount();
    error UnauthorizedInitialization();
    error UnknownAction();
    error SoftCapNotMet();
    error LaunchWindowExpired();
    error InvalidAdmin();

    /// @notice Something tried to execute this contract as itself rather than
    ///         through a project clone.
    ///
    /// @dev    Not defence-in-depth: the per-project config is read by offset out
    ///         of `address(this)`'s code, and on the implementation those offsets
    ///         land inside its own ~19 KB runtime, so they return garbage rather
    ///         than zero.  See `onlyClone`.
    error NotAClone();

    /// @notice The genesis window is not one of `DURATION_FAST` /
    ///         `DURATION_STANDARD` / `DURATION_SLOW`.
    error InvalidDuration();
    error Unauthorized();
    error EthTransferFailed();

    /// @notice Every shelf has been cleared — Phase 2 issuance is complete.
    error LadderExhausted();

    /// @notice Request runs past the end of the ladder (`tierIndex >= TIER_COUNT`).
    ///         Read `maxMintable()` (or `bondingRemaining()` once the cursor is
    ///         on the last shelf) and shrink the order.
    error ExceedsTierRemaining();

    /// @notice The order would sweep more than `MAX_TIERS_PER_TX` shelves.
    ///         Read `maxMintable()` and split the order across transactions;
    ///         the end state is identical either way.
    error SpanTooManyShelves();

    /// @notice A swap touched this pool in the current block.  Shelf mints must
    ///         wait one block so a flash-loan spike cannot fake the price gate.
    error SameBlockMintForbidden();

    /// @notice The platform has suspended shelf minting, either for this project
    ///         or globally.  Trading, LP, genesis claims, referral claims and
    ///         refunds are all unaffected, and the halt lapses on its own.
    ///         See `ToshFactory.haltLadderMinting`.
    error LadderMintingHalted();

    /// @notice The active shelf costs more than 105 % of `min(spot, TWAP)`.
    ///         The secondary market has to catch up before this shelf unlocks.
    error TierPriceAboveCeiling();

    /// @notice `msg.value` did not cover the quoted shelf cost.
    error InsufficientPayment();

    /// @notice No referral commission accrued to the caller.
    error NoReferralReward();

    /// @notice This wallet's total stake in this project would exceed the
    ///         per-wallet cap snapshotted when the project was created.
    error PerWalletCapExceeded();

    // ══════════════════════════════════════════════════════════════════════════
    //  Constructor
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Deployed ONCE per platform, not once per project. Every launch is a
    ///      clone of this instance, so the only arguments here are the ones
    ///      shared by all of them; per-project values arrive as clone immutable
    ///      args and are validated in `initializeToken`.
    ///
    ///      This instance is never usable as a hook itself — see `onlyClone`.
    constructor(address _poolManager, address _factory, address _ladderTreasury, address _platformFeeRecipient) {
        require(_poolManager != address(0), "zero poolManager");
        require(_factory != address(0), "zero factory");
        require(_ladderTreasury != address(0), "zero ladderTreasury");
        require(_platformFeeRecipient != address(0), "zero platformFeeRecipient");

        poolManager = IPoolManager(_poolManager);
        factory = _factory;
        ladderTreasury = payable(_ladderTreasury);
        platformFeeRecipient = payable(_platformFeeRecipient);
        _self = address(this);
        _hasArbSys = ARB_SYS.code.length != 0;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Block height
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev The ArbSys precompile, present on every Arbitrum and Orbit chain.
    address private constant ARB_SYS = 0x0000000000000000000000000000000000000064;

    /// @notice This chain's own block height.
    ///
    /// @dev    NOT `block.number`, and the difference is the whole point.
    ///
    ///         On Arbitrum and its Orbit chains — Robinhood Chain among them —
    ///         `block.number` returns the height of the first non-Arbitrum
    ///         ancestor, i.e. Ethereum L1. Measured on chain 4663: a contract
    ///         reads ~25.8 M while the chain itself is at ~47.1 M, and the value
    ///         advances once per ~10.7 s against a 100 ms block time. One
    ///         `block.number` therefore spans roughly 107 real blocks.
    ///
    ///         `_lastSwapBlock` is the only consumer, and on that arithmetic the
    ///         same-block lockout stops being "one block" and becomes a ~10.7 s
    ///         pool-wide freeze on minting. Two things follow, and the second is
    ///         worse than the first: any pool busy enough to see a swap every ten
    ///         seconds has its ladder permanently shut with nobody attacking it,
    ///         and — because gas here is negligible and sequencing is FCFS with
    ///         no mempool — one dust swap per window closes it deliberately for
    ///         almost nothing. Atomicity is what the guard actually defends, and
    ///         atomicity exists per block, so the chain's own height is both
    ///         necessary and sufficient.
    ///
    ///         It also repairs the reading half. `lastSwapBlock()` is compared
    ///         against `useBlockNumber()` in the buy panel, and that RPC returns
    ///         the L2 head — so on an unfixed deployment the panel compares 25.8 M
    ///         against 47.1 M, concludes the lockout is open for every block of
    ///         its duration, and invites a transaction that must revert.
    ///
    ///         The probe is `extcodesize`, not a chain id: Arbitrum registers its
    ///         precompiles with a single `0xfe` byte, so the check is positive
    ///         there and negative on any plain EVM, which keeps one binary correct
    ///         on both Robinhood and the devnet the tests run against. It is read
    ///         once in the constructor rather than per call, which keeps a cold
    ///         2600-gas `EXTCODESIZE` off the swap path; the precompile call that
    ///         remains measured ~1k gas.
    ///
    ///         Consequence worth stating plainly: on anvil this resolves to
    ///         `block.number`, so the Arbitrum branch is dead code to every test
    ///         that does not `vm.etch` a mock at `ARB_SYS` before the
    ///         implementation is deployed. `ToshV5ArbSys.t.sol` is what covers it.
    function _blockNumber() internal view returns (uint256) {
        if (_hasArbSys) return IArbSys(ARB_SYS).arbBlockNumber();
        return block.number;
    }

    /// @dev Accepts ETH from the factory's genesis gateway and from any V4
    ///      `take` that settles native currency to this hook.
    ///
    ///      `onlyClone` here is not a security boundary — the implementation has
    ///      no path that pays ETH out to anyone — it just stops value being
    ///      burned by a mistaken send to the shared implementation, which no
    ///      code path could ever return.
    receive() external payable onlyClone {}

    // ══════════════════════════════════════════════════════════════════════════
    //  Modifiers
    // ══════════════════════════════════════════════════════════════════════════

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    /// @dev Refuses execution on the shared implementation.
    ///
    ///      This is mandatory, not belt-and-braces. The clone args sit at fixed
    ///      offsets into the *caller's* code, and on the implementation those
    ///      offsets land inside its own ~19 KB of real bytecode — not out of
    ///      bounds, so EXTCODECOPY does not zero-fill. `softCap()` called on the
    ///      bare implementation returns a garbage value in the 1e38 range: not a
    ///      real config, but emphatically not zero either, so a `> 0` check
    ///      would wave it straight through.
    ///
    ///      Guarding `initialize` is what makes the rest unreachable, since it
    ///      is the only writer of `tokenInitialized` and every value-bearing
    ///      path is gated on that. `test_implementationIsInertAsItself` pins the
    ///      whole chain so this reasoning cannot rot silently.
    modifier onlyClone() {
        if (address(this) == _self) revert NotAClone();
        _;
    }

    modifier initialized() {
        if (!tokenInitialized) revert NotInitialized();
        _;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Factory initialisation & admin rotation
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice One-shot initialiser, called by the factory inside `createLaunch`.
    ///
    /// @dev    This carries what a constructor used to. A clone runs no
    ///         constructor, so the three things that cannot be immutable args
    ///         have to be set here:
    ///
    ///           • `projectToken`   — deployed after the hook (its address is not
    ///                                knowable while the salt is being mined).
    ///           • `genesisDeadline` — `block.timestamp + genesisDuration()`, and
    ///                                the creator cannot predict the mining block.
    ///           • `projectAdmin`   — rotatable by design, see below.
    ///
    ///         `projectAdmin` was a constructor argument before and so was
    ///         committed to by the hook's mined address. It no longer is, and
    ///         nothing is lost: `changeProjectAdmin` always let the holder rotate
    ///         it, so the address only ever pinned the *initial* value. The
    ///         creator still chooses it — it is the argument they passed to
    ///         `createLaunch`, applied in the same transaction. The value that
    ///         genuinely must be tamper-evident, `projectTreasury`, stays an
    ///         immutable arg and stays in the address.
    ///
    ///         `onlyClone` is load-bearing, not belt-and-braces. This is the only
    ///         writer of `tokenInitialized`, and every value-bearing path is
    ///         gated on it, so refusing to run here is what makes the bare
    ///         implementation inert. See `onlyClone` and
    ///         `test_implementationIsInertAsItself`.
    ///
    /// @param token_        The project's ERC-20, already pointed at this hook.
    /// @param projectAdmin_ Initial recipient of the 99 % Phase-2 cut.
    function initializeToken(address token_, address projectAdmin_) external onlyClone {
        if (msg.sender != factory) revert OnlyFactory();
        if (tokenInitialized) revert AlreadyInitialized();
        require(token_ != address(0), "zero token");
        if (projectAdmin_ == address(0)) revert InvalidAdmin();

        // Validated here rather than in the factory because the value is read
        // out of this clone's own bytecode: checking the factory's argument
        // would attest to what it *meant* to bake in, not to what the mined
        // address actually commits to.  A duration outside the three rungs
        // means the salt was mined against a config this contract will not
        // honour, so the launch is rejected before it can take a deposit.
        uint256 duration = genesisDuration();
        if (duration != DURATION_FAST && duration != DURATION_STANDARD && duration != DURATION_SLOW) {
            revert InvalidDuration();
        }

        // Every zero-check the constructor used to run, re-run here against the
        // values actually baked into this clone.  The point is not that the
        // factory might pass junk — it validates its own inputs — but that these
        // now arrive as bytes at fixed offsets in our own code.  An offset bug is
        // the one new failure mode this design introduces, and a degenerate
        // config is exactly what one would look like, so the values are checked
        // where they are read rather than where they were written.
        require(ToshCloneLib.argCreator() != address(0), "zero creator");
        require(ToshCloneLib.argProjectTreasury() != address(0), "zero treasury");
        require(ToshCloneLib.argSoftCap() != 0, "zero softCap");
        require(ToshCloneLib.argPerWalletCap() != 0, "zero perWalletCap");

        projectToken = ToshToken(token_);
        projectAdmin = projectAdmin_;
        genesisDeadline = block.timestamp + duration;
        tokenInitialized = true;

        emit TokenInitialized(token_);
    }

    /// @notice Hand the `projectAdmin` role to a new wallet / multisig.
    function changeProjectAdmin(address newAdmin) external {
        if (msg.sender != projectAdmin) revert Unauthorized();
        if (newAdmin == address(0)) revert InvalidAdmin();

        address oldAdmin = projectAdmin;
        projectAdmin = newAdmin;
        emit ProjectAdminChanged(oldAdmin, newAdmin);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PHASE 1 — GENESIS
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Record a native-ETH genesis deposit.  The ETH arrives with this
    ///         call; all eligibility checks (blacklist / PoG / cooldown) and the
    ///         global referral resolution happen in ToshFactory.
    ///
    /// @param user     Beneficiary of the deposit.
    /// @param referrer Globally-bound referrer, or `address(0)` if the user has
    ///                 none.  Resolved by the factory registry, never by the
    ///                 caller, so it cannot be spoofed per-project.
    function deposit(address user, address referrer) external payable {
        if (msg.sender != factory) revert OnlyFactory();
        if (!tokenInitialized) revert NotInitialized();
        if (block.timestamp >= genesisDeadline) revert GenesisExpired();
        if (msg.value == 0) revert ZeroAmount();

        uint256 amount = msg.value;

        // Per-project cap, enforced against the snapshot taken at creation so
        // a later platform-wide retune cannot move the goalposts on a round
        // that is already open.
        if (ethDeposited[user] + amount > perWalletCap()) revert PerWalletCapExceeded();

        ethDeposited[user] += amount;
        totalEthDeposited += amount;

        // Carve the referral commission up-front so `launch()` can seed the LP
        // with exactly the non-commission remainder.
        uint256 commission = (amount * REFERRAL_BPS) / BPS_DENOMINATOR;
        if (referrer != address(0)) {
            referralAccrued[referrer] += commission;
            totalReferralReserved += commission;
            emit ReferralAccrued(referrer, user, commission);
        } else {
            // No referrer: the commission becomes platform buyback ammunition
            // rather than ETH nobody can ever claim.
            orphanReferral += commission;
        }

        emit Deposited(user, amount, referrer);
    }

    /// @notice True when depositors may reclaim their ETH.
    function canRefund() public view returns (bool) {
        if (launched) return false;
        bool softCapFailed = block.timestamp > genesisDeadline && totalEthDeposited < softCap();
        bool zombieExpired = block.timestamp > genesisDeadline + LAUNCH_WINDOW;
        return softCapFailed || zombieExpired;
    }

    /// @notice Reclaim the full deposit when the refund path is open.
    /// @dev    Refunds return 100 % of the deposit; the 10 % commission carve is
    ///         only realised at `launch()`, so a failed genesis owes nothing to
    ///         referrers and `referralAccrued` is simply never claimable.
    function refund() external nonReentrant {
        require(!launched, "Already launched");
        require(block.timestamp > genesisDeadline, "Genesis not ended yet");

        bool softCapFailed = totalEthDeposited < softCap();
        bool zombieExpired = block.timestamp > genesisDeadline + LAUNCH_WINDOW;
        require(softCapFailed || zombieExpired, "Refund not available");

        uint256 dep = ethDeposited[msg.sender];
        if (dep == 0) revert NoDeposit();

        // EFFECTS before INTERACTIONS.
        ethDeposited[msg.sender] = 0;

        if (softCapFailed && !refundEnabled) {
            refundEnabled = true;
            emit GenesisFailed(totalEthDeposited);
        }
        if (zombieExpired && !zombieRefundEnabled) {
            zombieRefundEnabled = true;
            emit ZombieRefund(totalEthDeposited);
        }

        _sendEth(msg.sender, dep);
        emit Refunded(msg.sender, dep);
    }

    /// @notice Finalise genesis: seed the ETH/token V4 pool, lock the LP, and
    ///         open the Phase-2 ladder.
    ///
    ///   1. Enforce the soft cap and the 7-day launch window.
    ///   2. Split the raise: 90 % → LP, 10 % → referral commission pool.
    ///   3. Forward orphaned commission to the ladder treasury.
    ///   4. Mint 8.4 M tokens; 3.78 M into the LP, 4.62 M held for claims.
    ///   5. P0 = lpEth / GENESIS_LP_SUPPLY, which is the pool's opening
    ///      price and tier 0's shelf price — genesis buyers pay no premium.
    function launch() external initialized nonReentrant {
        if (msg.sender != creator()) revert OnlyCreator();
        if (block.timestamp < genesisDeadline) revert GenesisActive();
        if (launched) revert AlreadyLaunched();
        if (totalEthDeposited < softCap()) revert SoftCapNotMet();
        if (totalEthDeposited == 0) revert ZeroAmount();
        if (block.timestamp > genesisDeadline + LAUNCH_WINDOW) revert LaunchWindowExpired();

        launched = true;

        // v4.x snapshotted `platformTreasury` here so a later factory-owner
        // change could not retarget Phase-2 fee routing mid-launch (the M-2
        // fix).  v5.0 needs no snapshot: all platform revenue flows to
        // `ladderTreasury`, which is an immutable constructor argument, so the
        // retargeting vector does not exist at the bytecode level.

        // ── 1. Split the raise ────────────────────────────────────────────────
        uint256 commissionPool = totalReferralReserved + orphanReferral;
        uint256 lpEth = totalEthDeposited - commissionPool;
        require(lpEth > 0, "no LP eth");

        // ── 2. Derive the pool anchor and the ladder base ─────────────────────
        p0 = (lpEth * 1e18) / GENESIS_LP_SUPPLY;
        require(p0 > 0, "p0=0");
        shelfP0 = (p0 * SHELF_PREMIUM_BPS) / BPS_DENOMINATOR;

        // ── 3. Mint the genesis allocation to this hook ───────────────────────
        projectToken.mint(address(this), GENESIS_SUPPLY);

        // ── 4. Build the ETH/token pool ───────────────────────────────────────
        uint160 sqrtPriceX96 = _toSqrtPriceX96(lpEth, GENESIS_LP_SUPPLY);

        poolManager.initialize(_key(), sqrtPriceX96);

        bytes memory result = poolManager.unlock(abi.encode(ACTION_ADD_LIQUIDITY, sqrtPriceX96, lpEth));
        uint128 liquidity = abi.decode(result, (uint128));

        // ── 5. Seed the oracle at the opening tick ────────────────────────────
        int24 openingTick = TickMath.getTickAtSqrtPrice(sqrtPriceX96);
        lastTick = openingTick;
        lastObservationTs = uint32(block.timestamp);
        _prevCheckpointTs = uint32(block.timestamp);
        _curCheckpointTs = uint32(block.timestamp);

        // Reuse the same-block swap lockout to hold Phase 2 shut for the launch
        // block itself.
        //
        // The gate is `tierPrice > ceiling`, and `shelfP0` and `ceiling` are the
        // SAME expression — `(x * 10500) / 10000` — applied to `p0` and to
        // `min(spot, p0)`.  At launch those two inputs are the same number up to
        // the truncation in `_toSqrtPriceX96` / `_sqrtPriceToEthPerToken`, so
        // shelf 0 lands EXACTLY ON the boundary and the strict `>` lets it
        // through whenever the round-tripped spot happens to land at or above
        // `p0`.  Which side it lands on is a function of the raise size: a sweep
        // of 1..24 ETH opens the launch block at 10 ETH and locks it at the
        // other 23.  `test_ladderOpensLockedAtLaunch` passed only because it
        // exercised a single raise.
        //
        // Nothing was being stolen — a launch-block buyer pays 1.155x what a
        // depositor paid — but "Phase 2 opens shut" was being asserted by a
        // rounding coin flip rather than by the code.  One block of lockout
        // makes it deterministic for every raise, costs a buyer nothing they
        // cannot recover in the next block, and needs no change to the pricing
        // algebra (which correctly says shelf i unlocks at REF >= p0 * STEP^i).
        _lastSwapBlock = uint48(_blockNumber());

        // ── 6. Flush orphaned commission to the buyback reservoir ─────────────
        if (orphanReferral > 0) {
            uint256 orphan = orphanReferral;
            orphanReferral = 0;
            _sendEth(ladderTreasury, orphan);
            emit OrphanReferralForwarded(orphan);
        }

        emit Launched(totalEthDeposited, lpEth, liquidity, sqrtPriceX96, p0);
    }

    /// @notice Claim the pro-rata share of the 4.62 M genesis claim allocation.
    function claimGenesis() external nonReentrant {
        if (!launched) revert NotLaunched();
        if (genesisShareClaimed[msg.sender]) revert AlreadyClaimed();
        uint256 dep = ethDeposited[msg.sender];
        if (dep == 0) revert NoDeposit();

        uint256 allocation = (GENESIS_CLAIM_SUPPLY * dep) / totalEthDeposited;

        genesisShareClaimed[msg.sender] = true;

        IERC20(address(projectToken)).safeTransfer(msg.sender, allocation);
        emit GenesisShareClaimed(msg.sender, allocation);
    }

    /// @notice Withdraw accrued referral commission.
    ///
    /// @dev    Commission is credited pro-rata at deposit time (10 % of each
    ///         referee's contribution) and unlocked in full once the project
    ///         launches.  It is deliberately NOT time-vested: the amount is
    ///         already proportional to what each referee actually brought in,
    ///         and a launched project has no mechanism to claw it back.
    function claimReferralReward() external nonReentrant {
        if (!launched) revert NotLaunched();

        uint256 amount = referralAccrued[msg.sender];
        if (amount == 0) revert NoReferralReward();

        referralAccrued[msg.sender] = 0;
        totalReferralClaimed += amount;

        _sendEth(msg.sender, amount);
        emit ReferralClaimed(msg.sender, amount);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PHASE 2 — DISCRETE TIER SHELVES
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Buy `tokenAmount` tokens off the ladder, filling the active
    ///         shelf at its fixed price and rolling into the next shelf as
    ///         each one clears.
    ///
    /// ── Anti-drain gate ─────────────────────────────────────────────────────
    ///
    ///   The failure mode this defends against: a project admin with limited
    ///   capital mints cheap tokens from a low shelf and dumps them into the
    ///   pool, extracting the genesis ETH.  Three compounding guards close it:
    ///
    ///     1. SAME-BLOCK LOCKOUT.  Any swap on this pool sets `lastSwapBlock`.
    ///        Minting in that same block reverts, so a flash-loaned pump cannot
    ///        be observed by the price gate before it unwinds.
    ///
    ///     2. min(SPOT, SLOW).  Once a full `TWAP_WINDOW` has elapsed the
    ///        slow leg is the rolling geometric TWAP, so pumping spot cannot
    ///        lift the reference and dumping spot only tightens it.  Until
    ///        then the slow leg is `p0`: a 2-second "TWAP" is spot in all but
    ///        name, and falling back to it would let a two-block pump mint
    ///        against a fabricated ceiling.
    ///
    ///     3. 105 % CEILING.  The shelf must cost no more than 1.05 × that
    ///        reference.  A shelf therefore only unlocks after the secondary
    ///        market has genuinely, durably risen to meet it — the ladder is
    ///        pulled up by real demand rather than pushed up by the issuer.
    ///
    /// ── Why the order may span shelves ──────────────────────────────────────
    ///
    ///   A shelf mint issues tokens straight from the token contract and routes
    ///   the ETH to `projectAdmin` / `ladderTreasury`.  It never swaps, so it
    ///   cannot move `spot`, and the TWAP is a function of past swaps only.
    ///   The anti-spike reference is therefore CONSTANT across the whole call,
    ///   which makes re-checking the ceiling on every leg exactly equivalent to
    ///   checking it once against the highest shelf touched.  Sweeping N
    ///   shelves in one call reaches the same end state, at the same total
    ///   cost, as N single-shelf calls in the same block — so the split was
    ///   never a safety property, only a gas tax on the buyer.
    ///
    /// @param tokenAmount Tokens to buy.  May span several shelves; capped by
    ///                    `maxMintable()`, which folds in both the 105 %
    ///                    ceiling and `MAX_TIERS_PER_TX`.
    /// @return ethCharged ETH actually spent; any excess `msg.value` is refunded.
    function mintBondingCurve(uint256 tokenAmount)
        external
        payable
        initialized
        nonReentrant
        returns (uint256 ethCharged)
    {
        if (!launched) revert NotLaunched();
        if (tokenAmount == 0) revert ZeroAmount();

        // ── Guard 0: platform ladder halt ─────────────────────────────────────
        // The only platform brake that reaches a launched project, and it
        // reaches nothing else here: swaps, LP, `claimGenesis`,
        // `claimReferralReward` and `refund` all stay open, so a halt can cost a
        // buyer an opportunity but never a balance.  It also expires on its own
        // (`MAX_HALT_DURATION`), which is what keeps it a break-glass brake
        // rather than a permanent veto.  See `ToshFactory.haltLadderMinting`.
        if (IToshFactoryHalt(factory).ladderMintingHalted(address(this))) revert LadderMintingHalted();

        // ── Guard 1: same-block lockout ───────────────────────────────────────
        if (_blockNumber() <= _lastSwapBlock) revert SameBlockMintForbidden();

        // One SLOAD for the whole position. Read as a struct rather than through
        // the three getters, which would be three reads of the same slot.
        LadderState memory st = _ladderState;

        uint256 tierIndex = st.tierIndex;
        if (tierIndex >= TIER_COUNT) revert LadderExhausted();

        // ── Guards 2 + 3: anti-spike reference and 105 % ceiling ──────────────
        // Hoisted out of the loop: no leg can move it (see the note above).
        uint256 ceiling = (_safeReferencePrice() * PRICE_CEILING_BPS) / BPS_DENOMINATOR;

        uint256 sold = st.tierSold;
        uint256 filled;
        uint256 cost;
        uint256 legs;

        while (filled < tokenAmount) {
            if (tierIndex >= TIER_COUNT) revert ExceedsTierRemaining();
            if (++legs > MAX_TIERS_PER_TX) revert SpanTooManyShelves();

            uint256 tierPrice = tierPriceAt(tierIndex);
            if (tierPrice > ceiling) revert TierPriceAboveCeiling();

            uint256 room = TIER_SIZE - sold;
            uint256 take = tokenAmount - filled;
            if (take > room) take = room;

            // Floored per leg, matching the single-shelf arithmetic this
            // replaces.  Worst-case truncation is 1 wei per leg in the buyer's
            // favour, bounded by MAX_TIERS_PER_TX.
            uint256 legCost = (tierPrice * take) / 1e18;

            cost += legCost;
            filled += take;
            sold += take;

            emit TierMinted(msg.sender, tierIndex, tierPrice, take, legCost);

            if (sold == TIER_SIZE) {
                sold = 0;
                unchecked {
                    ++tierIndex;
                }
                if (tierIndex < TIER_COUNT) emit TierAdvanced(tierIndex, tierPriceAt(tierIndex));
            }
        }

        if (cost == 0) revert ZeroAmount();
        if (msg.value < cost) revert InsufficientPayment();

        // EFFECTS
        //
        // One SSTORE for all three. The casts are safe by the bounds proved on
        // `LadderState`: `tierIndex` is fenced by the `TIER_COUNT` checks above,
        // `sold` by the rollover that resets it at `TIER_SIZE`, and the running
        // total by the same `TIER_COUNT` fence, which caps lifetime issuance at
        // `BONDING_MAX`.
        _ladderState = LadderState({
            tierIndex: uint16(tierIndex), tierSold: uint88(sold), minted: uint96(uint256(st.minted) + tokenAmount)
        });

        // INTERACTIONS
        // Pipe 4 of the treasury's funding matrix: the platform's 1 % cut of
        // every shelf mint is buyback fuel, not platform profit.
        uint256 platformCut = (cost * PLATFORM_TAX_BPS) / BPS_DENOMINATOR;
        uint256 projectCut = cost - platformCut;

        if (platformCut > 0) _sendEth(ladderTreasury, platformCut);
        if (projectCut > 0) _sendEth(projectAdmin, projectCut);

        projectToken.mint(msg.sender, tokenAmount);

        uint256 change = msg.value - cost;
        if (change > 0) _sendEth(msg.sender, change);

        ethCharged = cost;
    }

    /// @notice Quote the ETH cost of buying `tokenAmount`, sweeping as many
    ///         shelves as the order needs.
    ///
    /// @dev    Mirrors every `mintBondingCurve` check and reproduces its
    ///         per-leg arithmetic leg for leg, so a successful quote is always
    ///         a mint the contract will accept in the next block, at exactly
    ///         this price.  The duplication is deliberate — a shared helper
    ///         would have to either allocate a per-leg array or be walked twice
    ///         to emit events.  `testFuzz_QuoteMatchesMintAcrossSpans` pins the
    ///         two loops together.
    function quoteMint(uint256 tokenAmount) external view returns (uint256 ethCost) {
        if (tokenAmount == 0) return 0;

        LadderState memory st = _ladderState;

        uint256 tierIndex = st.tierIndex;
        if (tierIndex >= TIER_COUNT) revert LadderExhausted();

        uint256 ceiling = (_safeReferencePrice() * PRICE_CEILING_BPS) / BPS_DENOMINATOR;

        uint256 sold = st.tierSold;
        uint256 filled;
        uint256 legs;

        while (filled < tokenAmount) {
            if (tierIndex >= TIER_COUNT) revert ExceedsTierRemaining();
            if (++legs > MAX_TIERS_PER_TX) revert SpanTooManyShelves();

            uint256 tierPrice = tierPriceAt(tierIndex);
            if (tierPrice > ceiling) revert TierPriceAboveCeiling();

            uint256 room = TIER_SIZE - sold;
            uint256 take = tokenAmount - filled;
            if (take > room) take = room;

            ethCost += (tierPrice * take) / 1e18;
            filled += take;
            sold += take;

            if (sold == TIER_SIZE) {
                sold = 0;
                unchecked {
                    ++tierIndex;
                }
            }
        }

        if (ethCost == 0) revert ZeroAmount();
    }

    /// @notice Largest order `mintBondingCurve` will accept right now.
    ///
    /// @dev    Folds together every quantity limit the buyer can hit: the
    ///         active shelf's leftovers, every subsequent shelf still under the
    ///         105 % ceiling, the end of the ladder, `MAX_TIERS_PER_TX`, and the
    ///         same-block lockout.  The UI sizes its "max" button off this
    ///         instead of guessing `TIER_SIZE`.  Returns 0 while the gate is
    ///         shut.
    ///
    ///         RIGHT NOW, not next block — which is why the lockout belongs
    ///         here and deliberately does NOT belong in `quoteMint`.  A quote is
    ///         a promise about the price a mint will pay when it lands, and the
    ///         lockout says nothing about price; a "max" button that offers a
    ///         size the very next call rejects is just a failed transaction.
    ///         `launch()` stamps `lastSwapBlock`, so this reads 0 for the whole
    ///         launch block too.
    function maxMintable() public view returns (uint256 tokens) {
        if (!launched) return 0;
        if (_blockNumber() <= _lastSwapBlock) return 0;
        if (IToshFactoryHalt(factory).ladderMintingHalted(address(this))) return 0;

        LadderState memory st = _ladderState;

        uint256 tierIndex = st.tierIndex;
        if (tierIndex >= TIER_COUNT) return 0;

        uint256 ceiling = (_safeReferencePrice() * PRICE_CEILING_BPS) / BPS_DENOMINATOR;
        uint256 sold = st.tierSold;

        for (uint256 legs; legs < MAX_TIERS_PER_TX && tierIndex < TIER_COUNT; ++legs) {
            if (tierPriceAt(tierIndex) > ceiling) break;
            tokens += TIER_SIZE - sold;
            sold = 0;
            unchecked {
                ++tierIndex;
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  IHooks — active callbacks
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Pool-init front-run defence: no pool BOUND TO THIS HOOK may be
    ///      created except from inside this hook's own `launch()`.
    ///
    ///      ⚠ SCOPE.  V4 only consults a hook for pools that name it, so this
    ///      says nothing about the project token trading elsewhere.  Anyone may
    ///      open a hookless ETH/token pool — or one under a different hook — at
    ///      any fee tier, seed it, and trade there paying no 0.7 % skim, feeding
    ///      no observation into the oracle below, and funding no buyback.  The
    ///      token is a plain ERC-20 with no transfer hook, so there is no
    ///      contract-level way to prevent that and none is attempted.
    ///
    ///      The consequence worth holding in mind is not the lost tax, it is
    ///      that `_safeReferencePrice` is SINGLE-VENUE.  It reads this pool and
    ///      only this pool.  Liquidity that migrates to a rival venue thins the
    ///      book the anti-spike gate is measured against, which lowers the cost
    ///      of moving it.  The genesis position is permanently locked here,
    ///      which is what keeps this pool the deep one, and that — not this
    ///      callback — is what makes the reference meaningful.
    function beforeInitialize(address sender, PoolKey calldata, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != address(this)) revert UnauthorizedInitialization();
        return IHooks.beforeInitialize.selector;
    }

    /// @notice Third-party LPs may withdraw at will — this is an unflagged
    ///         pass-through, and V4 never even calls it.
    ///
    /// @dev    v4.x reverted here to keep the genesis LP locked, which also
    ///         trapped every other LP in the pool.  The revert was never what
    ///         protected the genesis position, though: V4 keys each position to
    ///         the address that called `modifyLiquidity`
    ///         (`Pool.ModifyLiquidityParams.owner = msg.sender`), the genesis
    ///         position belongs to this hook, and this hook exposes no code
    ///         path that removes liquidity — `unlockCallback` only ever handles
    ///         `ACTION_ADD_LIQUIDITY`, with a strictly positive delta.  Nobody
    ///         else can address that position at all.
    ///
    ///         So the lock is structural, and `BEFORE_REMOVE_LIQUIDITY` was
    ///         dropped from the address mask (0x22C8 → 0x20C8, and 0x20CC once
    ///         `AFTER_SWAP_RETURNS_DELTA` landed) rather than softened into a
    ///         conditional revert.  This override survives only to satisfy
    ///         `IHooks`.
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    /// @notice ASYMMETRIC IN-FLIGHT TAX — 1.0 % of every swap's INPUT, routed
    ///         by direction so the buyback flywheel cannot be starved.
    ///
    /// ── The rule ────────────────────────────────────────────────────────────
    ///
    ///     BUY  (ETH → token) : 0.7 % of the ETH input  → ToshLadderTreasury
    ///                        + 0.3 % of the ETH input  → platformFeeRecipient
    ///     SELL (token → ETH) : 1.0 % of the token input → 0xdead
    ///
    ///   Stacked on the 0.3 % native pool fee this is a 1.30 % total toll.
    ///   The pool fee accrues to LPs via V4; this tax is the protocol's cut.
    ///
    ///   The asymmetry in the rule above is the split, not the rate: both legs
    ///   charge the same 1.0 %.  Only the buy leg divides it, because only the
    ///   buy leg's input is ETH — see `PLATFORM_SWAP_FEE_BPS`.
    ///
    /// ── Why two callbacks ───────────────────────────────────────────────────
    ///
    ///   `beforeSwap` can only move the SPECIFIED currency.  Specified equals
    ///   the input on exact-input swaps, so those settle here in one shot.
    ///
    ///   On exact-output swaps specified is the OUTPUT.  Taxing it would burn
    ///   tokens on a buy and send ETH to the treasury on a sell — the opposite
    ///   of the rule above, and a trivial aggregator evasion: ask for "N tokens
    ///   out" and the reservoir never fills.  Exact-output therefore returns
    ///   ZERO_DELTA here; `afterSwap` (flagged `AFTER_SWAP_RETURNS_DELTA`)
    ///   charges the unspecified INPUT once its size is known from the delta.
    ///
    /// ── V4 mechanics (exact-input) ──────────────────────────────────────────
    ///
    ///   A positive `deltaSpecified` credits the hook and is folded in as
    ///   `amountToSwap = amountSpecified + hookDeltaSpecified`:
    ///     • exact input  (-N): pool trades N − tax, trader still pays N.
    ///   The hook's credit is drained immediately via `take`.
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        // Exact-output: specified is the output.  Input tax lands in afterSwap.
        //
        // Checked before the piggyback guard, which is an external call: this
        // branch returns ZERO_DELTA either way, so asking the treasury whether
        // a buyback is in flight cannot change the answer.  `afterSwap` still
        // asks, which is where an exact-output swap's tax is actually decided.
        if (params.amountSpecified >= 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Stay passive while the treasury is executing its own buyback —
        // taxing it would recurse and skim the burn itself.
        if (sender == ladderTreasury || _piggybackActive()) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 input = uint256(-params.amountSpecified);
        uint256 tax = (input * TAX_BPS) / BPS_DENOMINATOR;
        if (tax == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        _skimInputTax(key, params.zeroForOne, input, tax);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(SafeCast.toInt128(tax), 0), 0);
    }

    /// @notice Stamps the swap block, advances the price oracle, pokes the
    ///         buyback engine, and — on exact-output swaps — skims the input.
    ///
    /// @dev    The returned `int128` is the unspecified-currency delta.  Positive
    ///         means the hook is owed that amount (the swapper pays it).  Exact-
    ///         input paths return 0 because their tax already settled in
    ///         `beforeSwap`.
    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        // Same-block mint lockout + oracle observation.
        //
        // ABOVE the treasury exemption below, and that placement is the whole
        // point. These two lines are what make a swap VISIBLE; the exemption
        // exists only to stop us taxing our own buyback and recursing into it.
        // Skipping the tax is right, skipping the stamp was not: `pokeBuyback()`
        // is permissionless, has no cooldown, and every call performs a real
        // swap on this pool. With the stamp inside the exemption, any address
        // could move spot repeatedly within one block while the hook recorded
        // nothing — then mint against the raised `_safeReferencePrice()`
        // ceiling in that same block, which is exactly what
        // `SameBlockMintForbidden` exists to forbid. Measured before the fix:
        // spot x5.15 in a single block and `maxMintable` 0 -> 100_800e18.
        //
        // Neither line can recurse. The stamp is a plain SSTORE, and
        // `_writeObservation` only reads `slot0`. The piggyback poke further
        // down is the reentrant part, and it stays below the exemption.
        //
        // Sampling here rather than after `_skimUnspecifiedInput` is
        // price-neutral: the skim settles deltas through `poolManager.take`,
        // which moves no price, so `lastTick` reads the same either way.
        _lastSwapBlock = uint48(_blockNumber());
        _writeObservation();

        // Stay passive while the treasury is executing its own buyback —
        // taxing it would recurse and skim the burn itself.
        if (sender == ladderTreasury || _piggybackActive()) {
            return (IHooks.afterSwap.selector, int128(0));
        }

        int128 hookUnspecified;
        if (params.amountSpecified > 0) {
            hookUnspecified = _skimUnspecifiedInput(key, params, delta);
        }

        // Piggyback: if the reservoir has crossed 1 ETH, this swap carries the
        // platform's round-robin buyback. Self-policing — a no-op otherwise.
        //
        // The balance check is the treasury's own arming condition, asked here
        // where it is cheap. `_nextSpendAmount()` returns 0 for a balance below
        // `TRIGGER_STEP` and the poke returns without doing anything, so this
        // skips no cycle that would have run — it only stops paying for the
        // call that discovers there is nothing to do, which is the common case
        // on a quiet pool. BALANCE on a warm account is 100 gas against a few
        // thousand for the call chain (a CALL into the treasury, another into
        // the manager for `isUnlocked`, and a cold `ladderTokens.length`).
        //
        // The mirrored threshold is the price of doing this, and
        // `test_piggybackTriggerMirrorsTheTreasury` is what keeps it honest.
        //
        // Fault-isolated. The buyback is a courtesy this swap performs for the
        // platform; it is never a precondition of the swap itself, so nothing
        // the treasury does may brick trading. Without this guard a treasury
        // that does not recognise us — an unwired `setFactory`, or a hook from
        // a second factory that the one-shot binding can never register —
        // reverts `onlyHook` on EVERY swap, which would strand the genesis
        // liquidity in this contract permanently with no recovery path.
        // A caught revert also rolls back that frame's V4 deltas and its
        // transient piggyback flag, so the swap resumes on clean accounting.
        // The gas gate is the other half, and it is a correctness condition
        // rather than an optimisation.
        //
        // The buy tax reaches the treasury during `beforeSwap`, so a swap can
        // begin with the reservoir unarmed and reach this line with it armed —
        // which means the trade that TIPS the reservoir over the trigger is the
        // trade billed for the buyback, and it is precisely the one whose gas
        // was estimated against an unarmed pool. Measured, a leg needs ~125k and
        // the tail after this point ~70k, against an estimate that budgeted for
        // neither. Without a gate that trade runs out of gas and reverts, and
        // `try/catch` does not save it: the 63/64 rule leaves this frame a
        // sixty-fourth, which does not cover the tail.
        //
        // So: skip unless there is room for a leg AND the tail, and cap what the
        // poke may consume so the tail's share cannot be eaten however expensive
        // a leg turns out to be. A skipped cycle costs nothing — the ETH stays
        // in the reservoir, and `pokeBuyback()` can deploy it with no swap at
        // all.
        uint256 avail = gasleft();
        if (ladderTreasury.balance >= PIGGYBACK_TRIGGER_STEP && avail >= PIGGYBACK_MIN_GAS) {
            try IToshLadderTreasury(ladderTreasury).autoPiggybackBuyback{gas: avail - PIGGYBACK_TAIL_RESERVE}() {}
            catch {
                emit PiggybackPokeFailed(ladderTreasury);
            }
        }

        return (IHooks.afterSwap.selector, hookUnspecified);
    }

    /// @dev Route `tax` of the input asset: ETH (a buy) splits between the
    ///      reservoir and the platform; tokens (a sell) all go to the fire.
    ///
    ///      `input` is the gross input the rate was applied to, passed in so
    ///      the platform's share is computed from the SAME base as `tax`
    ///      rather than as a percentage of a percentage.
    ///
    ///      ── The conservation requirement ────────────────────────────────
    ///
    ///      Both call sites hand V4 a hook delta of exactly `tax`, so the sum
    ///      of what this function `take`s MUST equal `tax` to the wei.  Take
    ///      less and the swap reverts `CurrencyNotSettled` with the remainder
    ///      stranded; take more and the hook is drawing on currency it was
    ///      never credited.  Either way it is not a rounding blemish, it is a
    ///      pool that cannot be traded.
    ///
    ///      Which is why the reservoir's share is `tax - platformCut` and not
    ///      its own multiplication.  Two independent floor divisions of the
    ///      same base do not have to sum back to a third:
    ///
    ///          input = 110 wei
    ///          tax          = 110 · 100 / 10_000 = 1   (floor of 1.1)
    ///          platformCut  = 110 ·  30 / 10_000 = 0   (floor of 0.33)
    ///          70 bps direct= 110 ·  70 / 10_000 = 0   (floor of 0.77)
    ///
    ///      so the naive pair would settle 0 against a credit of 1.  By
    ///      subtraction the reservoir takes 1, and the wei that rounding
    ///      would have dropped lands in the reservoir rather than nowhere.
    ///      The bias is deliberate and one-directional: dust favours the
    ///      buyback, never the platform.
    ///
    ///      The subtraction cannot underflow.  `floor(a·30/d) ≤ floor(a·100/d)`
    ///      holds for every non-negative `a` because the numerator is strictly
    ///      smaller, so `platformCut ≤ tax` always.
    function _skimInputTax(PoolKey calldata key, bool ethIsInput, uint256 input, uint256 tax) internal {
        if (!ethIsInput) {
            // Sell leg: not split. The platform takes no share of a project's
            // own token — see `PLATFORM_SWAP_FEE_BPS`.
            poolManager.take(key.currency1, DEAD_ADDRESS, tax);
            emit SellTaxBurned(tax);
            return;
        }

        uint256 platformCut = (input * PLATFORM_SWAP_FEE_BPS) / BPS_DENOMINATOR;
        uint256 reservoirCut = tax - platformCut;

        // `reservoirCut` needs no zero guard, in two cases. Below 334 wei of
        // input `platformCut` floors to 0, so `reservoirCut == tax`, which the
        // caller already established is non-zero. At or above 334 wei
        // `tax >= 3` and `platformCut < 0.4 * tax`, so the difference is at
        // least 2. Either way it is positive.
        //
        // `platformCut` does need the guard — it is 0 for that entire first
        // case, and a zero-value `take` would spend gas and emit a fee event
        // reporting nothing.
        poolManager.take(key.currency0, ladderTreasury, reservoirCut);
        emit BuyTaxToTreasury(reservoirCut);

        if (platformCut > 0) {
            poolManager.take(key.currency0, platformFeeRecipient, platformCut);
            emit PlatformSwapFeePaid(platformFeeRecipient, platformCut);
        }
    }

    /// @dev Exact-output input tax.  Specified is the output; unspecified is
    ///      the input and is negative on `delta` (owed to the pool).
    function _skimUnspecifiedInput(PoolKey calldata key, SwapParams calldata params, BalanceDelta delta)
        internal
        returns (int128 hookUnspecified)
    {
        // specified is currency0 iff exactInput == zeroForOne.  Exact-output
        // flips that, so unspecified is currency0 (ETH) on a buy and
        // currency1 (token) on a sell.
        bool ethIsInput = params.zeroForOne;
        int128 inputDelta = ethIsInput ? delta.amount0() : delta.amount1();
        if (inputDelta >= 0) return 0;

        uint256 input = uint256(uint128(-inputDelta));
        uint256 tax = (input * TAX_BPS) / BPS_DENOMINATOR;
        if (tax == 0) return 0;

        _skimInputTax(key, ethIsInput, input, tax);
        return SafeCast.toInt128(tax);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  IHooks — inactive callbacks
    // ══════════════════════════════════════════════════════════════════════════

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IHooks.afterDonate.selector;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  IUnlockCallback
    // ══════════════════════════════════════════════════════════════════════════

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        uint8 action = abi.decode(data, (uint8));

        if (action == ACTION_ADD_LIQUIDITY) {
            (, uint160 sqrtPriceX96, uint256 lpEth) = abi.decode(data, (uint8, uint160, uint256));
            return _addInitialLiquidity(sqrtPriceX96, lpEth);
        }
        revert UnknownAction();
    }

    /// @dev The one pool this hook serves, restated rather than stored.
    ///
    ///      Four of the five fields are fixed for every project: ETH is
    ///      `address(0)` and so always sorts into currency0, `POOL_FEE` and
    ///      `TICK_SPACING` are constants, and the hook is this contract.  Only
    ///      currency1 varies, and it is `projectToken` — already in storage
    ///      because the mint path needs it.
    ///
    ///      So the key costs one SLOAD to rebuild instead of the four cold ones
    ///      it took to read, and the three SSTOREs at launch go away entirely.
    ///      `beforeInitialize` is what makes this sound: it permits exactly one
    ///      pool per hook, so there is never a second key this could confuse.
    function _key() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(address(projectToken)),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    /// @dev Settle the full-range genesis position: `lpEth` native ETH plus
    ///      GENESIS_LP_SUPPLY tokens.
    function _addInitialLiquidity(uint160 sqrtPriceX96, uint256 lpEth) internal returns (bytes memory) {
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(TICK_LOWER),
            TickMath.getSqrtPriceAtTick(TICK_UPPER),
            lpEth,
            GENESIS_LP_SUPPLY
        );

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _key(),
            ModifyLiquidityParams({
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();

        // currency0 == native ETH
        if (d0 < 0) {
            uint256 owed = uint256(uint128(-d0));
            poolManager.sync(CurrencyLibrary.ADDRESS_ZERO);
            poolManager.settle{value: owed}();
        }
        // currency1 == project token
        if (d1 < 0) {
            uint256 owed = uint256(uint128(-d1));
            poolManager.sync(Currency.wrap(address(projectToken)));
            IERC20(address(projectToken)).safeTransfer(address(poolManager), owed);
            poolManager.settle();
        }

        return abi.encode(liquidity);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Dark tax + oracle internals
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Advance the geometric-mean accumulator and roll the TWAP window.
    function _writeObservation() internal {
        uint32 nowTs = uint32(block.timestamp);
        uint32 elapsed = nowTs - lastObservationTs;

        if (elapsed > 0) {
            tickCumulative += int56(lastTick) * int56(uint56(elapsed));
            lastObservationTs = nowTs;

            // Roll the reference checkpoint forward once the newer one has
            // aged past the target window.  Two checkpoints (rather than a
            // full ring buffer) keep the per-swap cost at a single cold SSTORE
            // per window instead of one on every trade.
            if (nowTs - _curCheckpointTs >= TWAP_WINDOW) {
                _prevCheckpointTs = _curCheckpointTs;
                _prevCheckpointCumulative = _curCheckpointCumulative;
                _curCheckpointTs = nowTs;
                _curCheckpointCumulative = tickCumulative;
            }
        }

        (, int24 tickNow,,) = poolManager.getSlot0(_key().toId());
        lastTick = tickNow;
    }

    /// @dev Anti-spike reference.  Once a full `TWAP_WINDOW` has elapsed this
    ///      is `min(spot, TWAP)`.  Until then the averaging window is either
    ///      empty (`span == 0` → TWAP returns 0) or a few-second stub a
    ///      two-block pump can fabricate, so the slow leg is `p0` instead:
    ///      `min(spot, p0)`.  Dumping below `p0` still tightens the gate.
    function _safeReferencePrice() internal view returns (uint256) {
        uint256 spot = _getSpotPrice();
        uint32 span = uint32(block.timestamp) - _prevCheckpointTs;
        uint256 slow = span < TWAP_WINDOW ? p0 : _getTWAPPrice();
        if (slow == 0) slow = p0;
        return spot < slow ? spot : slow;
    }

    /// @dev Live pool price in ETH-wei per whole token.
    function _getSpotPrice() internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(_key().toId());
        return _sqrtPriceToEthPerToken(sqrtPriceX96);
    }

    /// @dev Rolling geometric-mean price in ETH-wei per whole token.  Returns 0
    ///      when `span == 0` (the launch timestamp).  `_safeReferencePrice`
    ///      does not treat a short non-zero window as a TWAP either — it caps
    ///      against `p0` until `span >= TWAP_WINDOW`.
    function _getTWAPPrice() internal view returns (uint256) {
        // `_sqrtPriceToEthPerToken` maps 0 to 0, preserving the "no window yet"
        // signal the callers already branch on.
        return _sqrtPriceToEthPerToken(_twapSqrtPriceX96());
    }

    /// @dev The TWAP in its native Q64.96 sqrt form, before the lossy
    ///      conversion to ETH-per-token.  Returns 0 until a FULL window has
    ///      elapsed.
    ///
    ///      The maturity test used to be `span == 0`, which meant that one
    ///      second after launch this returned a one-second "average" — spot
    ///      wearing a TWAP's name.  `_safeReferencePrice` never trusted that
    ///      (it caps against `p0` until `span >= TWAP_WINDOW`), but the treasury
    ///      did: `_buybackSqrtFloor` anchors every buyback leg to this value and
    ///      treats 0 as "no reference yet, fill unbounded".  So the immature
    ///      stub was strictly worse than the fallback the treasury was written
    ///      for — it handed the anti-sandwich floor a number a single swap
    ///      could set.  Reporting 0 until the window matures makes both
    ///      consumers agree on when a TWAP exists.
    function _twapSqrtPriceX96() internal view returns (uint160) {
        uint32 nowTs = uint32(block.timestamp);
        uint32 span = nowTs - _prevCheckpointTs;
        if (span < TWAP_WINDOW) return 0;

        // A pool that has not traded for a full window has a known average.
        //
        // `_writeObservation` rolls the checkpoint when a SWAP arrives, not on
        // the clock, so `span` is bounded by the inter-trade interval and not
        // by `2 x TWAP_WINDOW` as the contract header once claimed. On a quiet
        // pool it grows without limit — measured at 608_400 s (7.04 days) on a
        // weekly-traded pool — and the average it reports is dominated by an
        // era the market has left behind. That fossilised value is what
        // `_buybackSqrtFloor` anchors each leg to, so the reservoir either
        // refuses to buy the token for months (measured: first fill on day 105)
        // or, after a drawdown, carries a band far wider than the one
        // `MAX_BUYBACK_SQRT_DEVIATION_BPS` names.
        //
        // Clamping `span` would not fix it and would make it dishonest:
        // `delta` accumulates over the WHOLE period, so dividing it by a
        // truncated span reports an average that never occurred. The real
        // observation is simpler. If no swap has landed for `TWAP_WINDOW`, the
        // price was flat at `lastTick` across the entire trailing window, so
        // `lastTick` is not an approximation of the average — it is the
        // average, exactly.
        //
        // This costs nothing in manipulation resistance. Reaching this branch
        // requires holding a price against arbitrage for a full window with no
        // other trade, which is the assumption every TWAP of this depth already
        // rests on, and it is the assumption PROBE B measures the price of.
        if (nowTs - lastObservationTs >= TWAP_WINDOW) {
            return TickMath.getSqrtPriceAtTick(lastTick);
        }

        int56 cumNow = tickCumulative + int56(lastTick) * int56(uint56(nowTs - lastObservationTs));
        int56 delta = cumNow - _prevCheckpointCumulative;

        int24 avgTick = int24(delta / int56(uint56(span)));

        // Round toward negative infinity, matching Uniswap V3's OracleLibrary,
        // so the TWAP is never biased upward by truncation.
        if (delta < 0 && (delta % int56(uint56(span)) != 0)) avgTick--;

        if (avgTick < TickMath.MIN_TICK) avgTick = TickMath.MIN_TICK;
        if (avgTick > TickMath.MAX_TICK) avgTick = TickMath.MAX_TICK;

        return TickMath.getSqrtPriceAtTick(avgTick);
    }

    /// @dev Convert a Q64.96 sqrt price into ETH-wei per whole (1e18) token.
    ///
    ///      With ETH as currency0: sqrtPriceX96 = sqrt(token/ETH) · 2^96, so
    ///          ethPerToken = 2^192 / sqrtPriceX96^2
    ///      Evaluated as two `mulDiv` steps because sqrtPriceX96^2 overflows
    ///      uint256 at the top of the tick range.
    function _sqrtPriceToEthPerToken(uint160 sqrtPriceX96) internal pure returns (uint256) {
        if (sqrtPriceX96 == 0) return 0;
        uint256 q96 = 1 << 96;
        uint256 inner = FullMath.mulDiv(q96, 1e18, sqrtPriceX96);
        return FullMath.mulDiv(inner, q96, sqrtPriceX96);
    }

    function _piggybackActive() internal view returns (bool) {
        return IToshLadderTreasury(ladderTreasury).piggybackActive();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Math helpers
    // ══════════════════════════════════════════════════════════════════════════

    function _toSqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        require(amount0 > 0, "zero amount0");
        uint256 sqrtA1 = _sqrt(amount1);
        uint256 sqrtA0 = _sqrt(amount0);
        uint256 result = (sqrtA1 << 96) / sqrtA0;
        require(result <= type(uint160).max, "sqrtPrice overflow");
        // forge-lint: disable-next-line(unsafe-typecast) — guarded by require above
        return uint160(result);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) >> 1;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) >> 1;
        }
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Views
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Shelf descriptor, matching the v5.0 spec's `Tier` shape.
    struct Tier {
        uint256 price;
        uint256 totalAmount;
        uint256 soldAmount;
    }

    /// @notice Price of shelf `index` in ETH-wei per whole token.
    ///
    /// @dev    Closed form `shelfP0 · STEP^index`, evaluated by exponentiation
    ///         by squaring so the cost is O(log index) — about 12 `mulDiv`
    ///         pairs at the top of a 4000-rung ladder, versus the 3999
    ///         sequential multiplications a naive walk would need.
    ///
    ///         Anchored on `shelfP0`, not `p0`: the ladder opens one 5 %
    ///         notch above the pool (see `SHELF_PREMIUM_BPS`).
    ///
    ///         This is the SINGLE source of truth for shelf pricing: the mint
    ///         hot path, `quoteMint`, and every view all route through it, so
    ///         the price a buyer is charged can never drift from the price the
    ///         UI quoted through differing rounding.
    function tierPriceAt(uint256 index) public view returns (uint256) {
        if (index >= TIER_COUNT) return 0;
        return FullMath.mulDiv(shelfP0, _powE18(TIER_STEP_E18, index), ONE_E18);
    }

    /// @dev 1e18-fixed-point exponentiation by squaring.
    function _powE18(uint256 baseE18, uint256 exp) internal pure returns (uint256 resultE18) {
        resultE18 = ONE_E18;
        uint256 b = baseE18;
        while (exp > 0) {
            if (exp & 1 == 1) resultE18 = FullMath.mulDiv(resultE18, b, ONE_E18);
            exp >>= 1;
            if (exp > 0) b = FullMath.mulDiv(b, b, ONE_E18);
        }
    }

    /// @notice Describe shelf `index`.
    ///
    /// @dev    Every shelf holds the same `TIER_SIZE` quota and its price is
    ///         closed-form, so the ladder is DERIVED on demand rather than
    ///         materialised into 4000 storage structs at launch (which would
    ///         cost millions of gas).  The struct shape is preserved for
    ///         ABI / front-end parity with the v5.0 spec.
    function getTier(uint256 index) public view returns (Tier memory tier) {
        require(index < TIER_COUNT, "tier out of range");

        LadderState memory st = _ladderState;

        uint256 sold;
        if (index < st.tierIndex) {
            sold = TIER_SIZE; // fully cleared
        } else if (index == st.tierIndex) {
            sold = st.tierSold;
        }

        tier = Tier({price: tierPriceAt(index), totalAmount: TIER_SIZE, soldAmount: sold});
    }

    /// @notice A window of the ladder, for the front-end shelf display.
    ///
    /// @dev    Paginated rather than all-at-once: a 4000-rung ladder is 12 000
    ///         words, which is far too large to return in a single call.  The
    ///         UI only ever renders a window around `currentTierIndex`.
    /// @param  start First shelf index to return.
    /// @param  count Maximum shelves to return; clamped to the ladder end.
    function getTiers(uint256 start, uint256 count) external view returns (Tier[] memory ladder) {
        if (start >= TIER_COUNT) return new Tier[](0);

        uint256 end = start + count;
        if (end > TIER_COUNT) end = TIER_COUNT;
        uint256 n = end - start;

        ladder = new Tier[](n);

        // Hoisted: this used to read two storage fields per rung, and the UI
        // asks for a window at a time.
        LadderState memory st = _ladderState;

        for (uint256 i; i < n; ++i) {
            uint256 idx = start + i;
            uint256 sold;
            if (idx < st.tierIndex) sold = TIER_SIZE;
            else if (idx == st.tierIndex) sold = st.tierSold;

            // Deliberately re-derives via `tierPriceAt` per rung instead of
            // walking the series forward: sequential multiplication would
            // accumulate different truncation than the closed form, and a
            // display price that disagrees with the charged price by even one
            // wei is a support ticket waiting to happen.
            ladder[i] = Tier({price: tierPriceAt(idx), totalAmount: TIER_SIZE, soldAmount: sold});
        }
    }

    function tierCount() external pure returns (uint256) {
        return TIER_COUNT;
    }

    /// @notice Tokens left on the active shelf.
    function tierRemaining() external view returns (uint256) {
        LadderState memory st = _ladderState;
        if (st.tierIndex >= TIER_COUNT) return 0;
        return TIER_SIZE - st.tierSold;
    }

    /// @notice Phase-2 tokens still unissued across the whole ladder.
    function bondingRemaining() external view returns (uint256) {
        uint256 minted = _ladderState.minted;
        if (minted >= BONDING_MAX) return 0;
        return BONDING_MAX - minted;
    }

    /// @notice Price of the shelf currently on sale (ETH-wei per whole token).
    function currentBondingPrice() external view returns (uint256) {
        return tierPriceAt(_ladderState.tierIndex);
    }

    /// @notice Everything the front-end needs to render the shelf gate.
    /// @return tierIndex   Active shelf.
    /// @return tierPrice   Its fixed price.
    /// @return remaining   Tokens left on it.
    /// @return spotPrice   Live pool price.
    /// @return twapPrice   Rolling geometric TWAP (0 before the first window).
    /// @return ceiling     105 % of the anti-spike reference (`min(spot, TWAP)`
    ///                     once the window is mature, `min(spot, p0)` until then).
    /// @return unlocked    Whether the shelf currently passes the price gate.
    function tierStatus()
        external
        view
        returns (
            uint256 tierIndex,
            uint256 tierPrice,
            uint256 remaining,
            uint256 spotPrice,
            uint256 twapPrice,
            uint256 ceiling,
            bool unlocked
        )
    {
        LadderState memory st = _ladderState;

        tierIndex = st.tierIndex;
        tierPrice = tierPriceAt(tierIndex);
        remaining = tierIndex >= TIER_COUNT ? 0 : TIER_SIZE - st.tierSold;

        if (!launched) return (tierIndex, tierPrice, remaining, 0, 0, 0, false);

        spotPrice = _getSpotPrice();
        twapPrice = _getTWAPPrice();
        ceiling = (_safeReferencePrice() * PRICE_CEILING_BPS) / BPS_DENOMINATOR;
        unlocked = tierIndex < TIER_COUNT && tierPrice <= ceiling;
    }

    function getPoolKey() external view returns (PoolKey memory) {
        return _key();
    }

    /// @notice Block number of the most recent swap on this pool, which is also
    ///         the block Phase 2 is shut for.
    ///
    /// @dev    "Most recent swap" means EVERY swap, including the treasury's own
    ///         buybacks. That was untrue for a while — `afterSwap` exempts the
    ///         treasury to avoid taxing itself, and the stamp sat inside the
    ///         exemption — which left this getter, the mint gate and the buy
    ///         panel all reporting an open lockout during a permissionless
    ///         price move. `test_pokeBuyback_shutsTheSameBlockMintLockout` is
    ///         what keeps the claim honest.
    ///
    /// @dev    Kept as a `uint256`-returning getter even though the backing slot
    ///         narrowed to `uint48`: the treasury, the tests and the buy panel
    ///         all read this, and there is nothing to gain from making them
    ///         handle a narrower type.
    ///
    ///         The unit is whatever `_blockNumber()` returns — the settlement
    ///         chain's own height, which is what `eth_blockNumber` reports. That
    ///         is the contract this getter owes the buy panel, which compares it
    ///         against exactly that RPC.
    function lastSwapBlock() public view returns (uint256) {
        return _lastSwapBlock;
    }

    /// @notice This pool's TWAP as a Q64.96 sqrt price, or 0 before the first
    ///         observation window has closed.
    ///
    /// @dev    Exposed for the platform buyback, which needs a reference that a
    ///         sandwicher cannot move inside one block.  Spot is exactly what
    ///         such an attacker manipulates, so bounding a buyback against spot
    ///         would ratify the manipulation rather than resist it.
    function twapSqrtPriceX96() external view returns (uint160) {
        return _twapSqrtPriceX96();
    }

    function hasClaimed(address user) external view returns (bool) {
        return genesisShareClaimed[user];
    }

    /// @notice Referral commission `referrer` can withdraw right now.
    function claimableReferral(address referrer) external view returns (uint256) {
        return launched ? referralAccrued[referrer] : 0;
    }

    // ─── v4.x compatibility shims ─────────────────────────────────────────────

    /// @notice Deprecated alias of `ethDeposited`, kept so existing indexers and
    ///         the factory's eligibility view keep compiling against v5.0.
    function satoDeposited(address user) external view returns (uint256) {
        return ethDeposited[user];
    }

    /// @notice Deprecated alias of `totalEthDeposited`.
    function totalSatoDeposited() external view returns (uint256) {
        return totalEthDeposited;
    }
}

// ─── Minimal external interfaces ──────────────────────────────────────────────

interface IToshLadderTreasury {
    function autoPiggybackBuyback() external;
    function piggybackActive() external view returns (bool);
}

/// @dev Minimal factory view for the ladder halt.  Declared here rather than
///      importing ToshFactory because the factory already imports this file to
///      deploy hooks, and a direct import would close that cycle.
interface IToshFactoryHalt {
    function ladderMintingHalted(address hook) external view returns (bool);
}

/// @dev The one ArbSys method this contract needs.  Declared locally rather than
///      pulled from a Nitro package: a two-line interface is not worth a
///      dependency, and `lib/**` is version-pinned by policy (SECURITY_AUDIT
///      §5.6), so adding one costs more than it saves.  See `_blockNumber`.
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}
