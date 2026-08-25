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
///   4. ASYMMETRIC IN-FLIGHT TAX & DIRECT BURN.  A 0.7 % skim is taken off the
///      INPUT of every swap, routed by direction rather than by which currency
///      happened to be `amountSpecified`:
///
///        BUY  (ETH in)   → 0.7 % ETH   → ToshLadderTreasury  (buyback fuel)
///        SELL (token in) → 0.7 % TOKEN → 0xdead              (burned in place)
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
///   5. OPEN LP + A 1 % FRICTION BUDGET, SPLIT.  v4.x reverted every
///      `removeLiquidity` to keep the genesis position locked, which also
///      trapped anyone else who provided liquidity — so nobody did, and the
///      1 % pool fee it charged accrued to a position no one could ever
///      collect from.  Stacked on the 1 % tax, traders paid 2 % and half of it
///      was destroyed on arrival.
///
///      v5.0 opens the pool to third-party LPs and splits one 1 % budget:
///
///        0.3 %  POOL_FEE  → LPs, settled natively by V4 (no code of ours)
///        0.7 %  hook tax  → buyback reservoir / burn
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

    /// @notice The window this launch actually chose, frozen at construction.
    uint256 public immutable genesisDuration;

    // ─── Economics ────────────────────────────────────────────────────────────

    /// @notice Referral commission carved from every genesis deposit (10 %).
    uint256 public constant REFERRAL_BPS = 1000;

    /// @notice Platform cut of Phase-2 shelf proceeds (1 %), routed to the
    ///         buyback reservoir; the remaining 99 % goes to `projectAdmin`.
    uint256 public constant PLATFORM_TAX_BPS = 100;

    /// @notice Asymmetric in-flight tax skimmed off the INPUT of every pool
    ///         swap (0.70 %).  Buys (ETH in) fund the treasury; sells (token
    ///         in) burn.  Exact-input settles in `beforeSwap`; exact-output
    ///         settles in `afterSwap` so a router cannot starve the reservoir
    ///         by asking for an exact token amount out.
    ///
    /// @dev    Sized as the remainder of a 1.00 % friction budget after the
    ///         0.30 % `POOL_FEE` that now goes to third-party LPs: 0.30 + 0.70
    ///         = 1.00, so traders see exactly the same cost as v4.x while LPs
    ///         finally get paid for the risk they carry.
    uint256 public constant TAX_BPS = 70;

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
    ///         rather than a full ring buffer, so the realised window floats in
    ///         [TWAP_WINDOW, 2 × TWAP_WINDOW).
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

    // ══════════════════════════════════════════════════════════════════════════
    //  Immutables
    // ══════════════════════════════════════════════════════════════════════════

    IPoolManager public immutable poolManager;
    address public immutable factory;
    address public immutable creator;

    /// @notice The project's declared multisig, recorded at launch.
    ///
    /// @dev    ⚠ THIS ADDRESS NEVER RECEIVES FUNDS.  Nothing in this contract,
    ///         the factory, or the treasury transfers to it.  Project revenue —
    ///         99 % of every shelf sale — is paid to `projectAdmin`, which is a
    ///         separate, rotatable address.
    ///
    ///         It survives for two reasons only: it is a field of the CREATE2
    ///         constructor tuple and therefore part of the hook's mined
    ///         address, and it is on-chain, immutable, human-readable evidence
    ///         of which multisig a project claimed at launch.  Removing it
    ///         would invalidate every previously mined salt.
    ///
    ///         If you are looking for where the money goes, see `projectAdmin`
    ///         and `ladderTreasury`.
    address public immutable projectTreasury;

    /// @notice Platform buyback reservoir; receives the 0.7 % buy-side dark tax
    ///         and any orphaned referral commission.
    address payable public immutable ladderTreasury;

    /// @notice Minimum ETH that must be raised by `genesisDeadline`.
    ///         Snapshotted from `ToshFactory.defaultSoftCap` at deploy time.
    uint256 public immutable softCap;

    /// @notice Maximum ETH any single wallet may put into THIS project.
    ///
    /// @dev    Snapshotted from `ToshFactory.maxPogAllocationLimit` at deploy
    ///         time, deliberately as an immutable rather than a live read.
    ///         The platform owner can retune the dial at any moment, and a
    ///         raise or cut landing mid-genesis would silently rewrite the
    ///         terms a project was funded under.  Freezing it at creation
    ///         means a change only ever governs projects launched after it —
    ///         rounds already in flight keep the cap their depositors signed
    ///         up to.
    uint256 public immutable perWalletCap;

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

    /// @notice Index of the shelf currently on sale. `== TIER_COUNT` once the
    ///         entire ladder is cleared.
    ///
    /// @dev    Shelf PRICES are not stored.  With 4000 rungs a materialised
    ///         ladder would cost millions of gas at launch, and a cached
    ///         "current price" advanced by repeated multiplication would drift
    ///         away from the closed form after 4000 truncating steps.  Prices
    ///         are instead derived on demand by `tierPriceAt()`, which is the
    ///         single source of truth for both the mint path and every view.
    uint256 public currentTierIndex;

    /// @notice Tokens already sold from the active shelf.
    uint256 public currentTierSold;

    /// @notice Cumulative Phase-2 issuance across all shelves.
    uint256 public phase2Minted;

    // ─── Swap-derived state ───────────────────────────────────────────────────

    /// @notice Block of the most recent pool swap.  Shelf mints are forbidden in
    ///         the same block, which isolates them from flash-loan price spikes.
    uint256 public lastSwapBlock;

    /// @dev Hook-local geometric-mean oracle.  Uniswap V4 core ships no
    ///      observation buffer (unlike V3), so the hook accumulates
    ///      `tick × elapsed` itself on every `afterSwap`.
    int56 public tickCumulative;
    uint32 public lastObservationTs;
    int24 public lastTick;

    /// @dev Rolling TWAP checkpoints. `_prev` is the reference point the TWAP
    ///      is measured from; it rolls forward once `_cur` ages past TWAP_WINDOW.
    int56 internal _prevCheckpointCumulative;
    uint32 internal _prevCheckpointTs;
    int56 internal _curCheckpointCumulative;
    uint32 internal _curCheckpointTs;

    // ─── Pool internals ───────────────────────────────────────────────────────

    PoolKey internal _poolKey;

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

    /// @notice Emitted when an ETH-side skim funds the platform buyback reservoir.
    event BuyTaxToTreasury(uint256 ethAmount);

    /// @notice Emitted when a token-side skim is burned in place at 0xdead.
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

    constructor(
        address _poolManager,
        address _factory,
        address _projectTreasury,
        address _creator,
        address _projectAdmin,
        address _ladderTreasury,
        uint256 _softCap,
        uint256 _perWalletCap,
        uint256 _genesisDuration
    ) {
        require(_poolManager != address(0), "zero poolManager");
        require(_factory != address(0), "zero factory");
        require(_projectTreasury != address(0), "zero treasury");
        require(_creator != address(0), "zero creator");
        require(_ladderTreasury != address(0), "zero ladderTreasury");
        if (_projectAdmin == address(0)) revert InvalidAdmin();
        require(_softCap > 0, "zero softCap");
        require(_perWalletCap > 0, "zero perWalletCap");
        if (
            _genesisDuration != DURATION_FAST && _genesisDuration != DURATION_STANDARD
                && _genesisDuration != DURATION_SLOW
        ) revert InvalidDuration();

        poolManager = IPoolManager(_poolManager);
        factory = _factory;
        projectTreasury = _projectTreasury;
        creator = _creator;
        projectAdmin = _projectAdmin;
        ladderTreasury = payable(_ladderTreasury);
        softCap = _softCap;
        perWalletCap = _perWalletCap;
        genesisDuration = _genesisDuration;
        genesisDeadline = block.timestamp + _genesisDuration;

        emit ProjectAdminChanged(address(0), _projectAdmin);
    }

    /// @dev Accepts ETH from the factory's genesis gateway and from any V4
    ///      `take` that settles native currency to this hook.
    receive() external payable {}

    // ══════════════════════════════════════════════════════════════════════════
    //  Modifiers
    // ══════════════════════════════════════════════════════════════════════════

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    modifier initialized() {
        if (!tokenInitialized) revert NotInitialized();
        _;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Factory initialisation & admin rotation
    // ══════════════════════════════════════════════════════════════════════════

    function initializeToken(address token_) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (tokenInitialized) revert AlreadyInitialized();
        require(token_ != address(0), "zero token");
        projectToken = ToshToken(token_);
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
        if (ethDeposited[user] + amount > perWalletCap) revert PerWalletCapExceeded();

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
        bool softCapFailed = block.timestamp > genesisDeadline && totalEthDeposited < softCap;
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

        bool softCapFailed = totalEthDeposited < softCap;
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
        if (msg.sender != creator) revert OnlyCreator();
        if (block.timestamp < genesisDeadline) revert GenesisActive();
        if (launched) revert AlreadyLaunched();
        if (totalEthDeposited < softCap) revert SoftCapNotMet();
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
        // ETH is address(0) and therefore always currency0.
        Currency c0 = CurrencyLibrary.ADDRESS_ZERO;
        Currency c1 = Currency.wrap(address(projectToken));

        uint160 sqrtPriceX96 = _toSqrtPriceX96(lpEth, GENESIS_LP_SUPPLY);

        PoolKey memory key = PoolKey({
            currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: IHooks(address(this))
        });
        _poolKey = key;

        poolManager.initialize(key, sqrtPriceX96);

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
        lastSwapBlock = block.number;

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
        if (block.number <= lastSwapBlock) revert SameBlockMintForbidden();

        uint256 tierIndex = currentTierIndex;
        if (tierIndex >= TIER_COUNT) revert LadderExhausted();

        // ── Guards 2 + 3: anti-spike reference and 105 % ceiling ──────────────
        // Hoisted out of the loop: no leg can move it (see the note above).
        uint256 ceiling = (_safeReferencePrice() * PRICE_CEILING_BPS) / BPS_DENOMINATOR;

        uint256 sold = currentTierSold;
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
        currentTierIndex = tierIndex;
        currentTierSold = sold;
        phase2Minted += tokenAmount;

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

        uint256 tierIndex = currentTierIndex;
        if (tierIndex >= TIER_COUNT) revert LadderExhausted();

        uint256 ceiling = (_safeReferencePrice() * PRICE_CEILING_BPS) / BPS_DENOMINATOR;

        uint256 sold = currentTierSold;
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
        if (block.number <= lastSwapBlock) return 0;
        if (IToshFactoryHalt(factory).ladderMintingHalted(address(this))) return 0;

        uint256 tierIndex = currentTierIndex;
        if (tierIndex >= TIER_COUNT) return 0;

        uint256 ceiling = (_safeReferencePrice() * PRICE_CEILING_BPS) / BPS_DENOMINATOR;
        uint256 sold = currentTierSold;

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

    /// @notice ASYMMETRIC IN-FLIGHT TAX — 0.7 % of every swap's INPUT, routed
    ///         by direction so the buyback flywheel cannot be starved.
    ///
    /// ── The rule ────────────────────────────────────────────────────────────
    ///
    ///     BUY  (ETH → token) : 0.7 % of the ETH input  → ToshLadderTreasury
    ///     SELL (token → ETH) : 0.7 % of the token input → 0xdead
    ///
    ///   Stacked on the 0.3 % native pool fee this is a 1.00 % total toll.
    ///   The pool fee accrues to LPs via V4; this tax is the protocol's cut.
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
        // Stay passive while the treasury is executing its own buyback —
        // taxing it would recurse and skim the burn itself.
        if (sender == ladderTreasury || _piggybackActive()) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Exact-output: specified is the output.  Input tax lands in afterSwap.
        if (params.amountSpecified >= 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 tax = (uint256(-params.amountSpecified) * TAX_BPS) / BPS_DENOMINATOR;
        if (tax == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        _skimInputTax(key, params.zeroForOne, tax);
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
        if (sender == ladderTreasury || _piggybackActive()) {
            return (IHooks.afterSwap.selector, int128(0));
        }

        int128 hookUnspecified;
        if (params.amountSpecified > 0) {
            hookUnspecified = _skimUnspecifiedInput(key, params, delta);
        }

        // Same-block mint lockout + oracle observation.
        lastSwapBlock = block.number;
        _writeObservation();

        // Piggyback: if the reservoir has crossed 1 ETH, this swap carries the
        // platform's round-robin buyback. Self-policing — a no-op otherwise.
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
        try IToshLadderTreasury(ladderTreasury).autoPiggybackBuyback() {}
        catch {
            emit PiggybackPokeFailed(ladderTreasury);
        }

        return (IHooks.afterSwap.selector, hookUnspecified);
    }

    /// @dev Route `tax` of the input asset: ETH (a buy) to the reservoir,
    ///      tokens (a sell) to the fire.
    function _skimInputTax(PoolKey calldata key, bool ethIsInput, uint256 tax) internal {
        if (ethIsInput) {
            poolManager.take(key.currency0, ladderTreasury, tax);
            emit BuyTaxToTreasury(tax);
        } else {
            poolManager.take(key.currency1, DEAD_ADDRESS, tax);
            emit SellTaxBurned(tax);
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

        uint256 tax = (uint256(uint128(-inputDelta)) * TAX_BPS) / BPS_DENOMINATOR;
        if (tax == 0) return 0;

        _skimInputTax(key, ethIsInput, tax);
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
            _poolKey,
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
            poolManager.sync(_poolKey.currency1);
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

        (, int24 tickNow,,) = poolManager.getSlot0(_poolKey.toId());
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
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(_poolKey.toId());
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

        uint256 sold;
        if (index < currentTierIndex) {
            sold = TIER_SIZE; // fully cleared
        } else if (index == currentTierIndex) {
            sold = currentTierSold;
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

        for (uint256 i; i < n; ++i) {
            uint256 idx = start + i;
            uint256 sold;
            if (idx < currentTierIndex) sold = TIER_SIZE;
            else if (idx == currentTierIndex) sold = currentTierSold;

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
        if (currentTierIndex >= TIER_COUNT) return 0;
        return TIER_SIZE - currentTierSold;
    }

    /// @notice Phase-2 tokens still unissued across the whole ladder.
    function bondingRemaining() external view returns (uint256) {
        if (phase2Minted >= BONDING_MAX) return 0;
        return BONDING_MAX - phase2Minted;
    }

    /// @notice Price of the shelf currently on sale (ETH-wei per whole token).
    function currentBondingPrice() external view returns (uint256) {
        return tierPriceAt(currentTierIndex);
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
        tierIndex = currentTierIndex;
        tierPrice = tierPriceAt(tierIndex);
        remaining = tierIndex >= TIER_COUNT ? 0 : TIER_SIZE - currentTierSold;

        if (!launched) return (tierIndex, tierPrice, remaining, 0, 0, 0, false);

        spotPrice = _getSpotPrice();
        twapPrice = _getTWAPPrice();
        ceiling = (_safeReferencePrice() * PRICE_CEILING_BPS) / BPS_DENOMINATOR;
        unlocked = tierIndex < TIER_COUNT && tierPrice <= ceiling;
    }

    function getPoolKey() external view returns (PoolKey memory) {
        return _poolKey;
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
