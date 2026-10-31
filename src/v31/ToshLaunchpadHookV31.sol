// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ──────────────────────────────────────────────────────────────────────────────
// PancakeSwap Infinity core
//
// `IPoolManager` is imported for one purpose only: `PoolKey.poolManager` is
// typed as it, and Infinity requires every key to name the manager that owns
// the pool. `CLPoolManager` validates that field and reverts
// `PoolManagerMismatch` on a key naming another manager, which is what stops a
// concentrated-liquidity key being pointed at the bin manager.
// ──────────────────────────────────────────────────────────────────────────────
import {IHooks} from "infinity-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "infinity-core/src/interfaces/IPoolManager.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ILockCallback} from "infinity-core/src/interfaces/ILockCallback.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "infinity-core/src/types/BeforeSwapDelta.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {FullMath} from "infinity-core/src/pool-cl/libraries/FullMath.sol";
import {SafeCast} from "infinity-core/src/libraries/SafeCast.sol";
import {CLPoolParametersHelper} from "infinity-core/src/pool-cl/libraries/CLPoolParametersHelper.sol";

// ──────────────────────────────────────────────────────────────────────────────
// PancakeSwap Infinity concentrated-liquidity pool
//
// The permission OFFSETS are the replacement for Uniswap V4's address bits.
// V4 read a hook's permissions out of the low bits of its own address, which is
// why this contract used to need a mined CREATE2 salt. Infinity reads them from
// a bitmap the hook declares in `getHooksRegistrationBitmap()` and the pool key
// repeats in `parameters`, and refuses the pool if the two disagree — so the
// miner is gone. See docs/PANCAKESWAP_INFINITY.md §3.3.
// ──────────────────────────────────────────────────────────────────────────────
import {
    ICLHooks,
    HOOKS_BEFORE_INITIALIZE_OFFSET,
    HOOKS_BEFORE_ADD_LIQUIDITY_OFFSET,
    HOOKS_BEFORE_SWAP_OFFSET,
    HOOKS_AFTER_SWAP_OFFSET,
    HOOKS_BEFORE_SWAP_RETURNS_DELTA_OFFSET,
    HOOKS_AFTER_SWAP_RETURNS_DELTA_OFFSET
} from "infinity-core/src/pool-cl/interfaces/ICLHooks.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";

// ──────────────────────────────────────────────────────────────────────────────
// PancakeSwap Infinity periphery
//
// Arithmetically identical to the v4-periphery copy this replaced: the vectors
// in test/ToshV5LpMathVectors.t.sol are asserted against both, so the genesis
// position mints the same liquidity it always did.
// ──────────────────────────────────────────────────────────────────────────────
import {LiquidityAmounts} from "infinity-periphery/src/pool-cl/libraries/LiquidityAmounts.sol";

// ──────────────────────────────────────────────────────────────────────────────
// OpenZeppelin
// ──────────────────────────────────────────────────────────────────────────────
import {ReentrancyGuard} from "../../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";

// ──────────────────────────────────────────────────────────────────────────────
// Local
// ──────────────────────────────────────────────────────────────────────────────
import {ToshTokenV31 as ToshToken} from "./ToshTokenV31.sol";
import {ToshCloneLib} from "../libraries/ToshCloneLib.sol";
import {GenesisCurveV3} from "../v3/libraries/GenesisCurveV3.sol";
import {AgentIdLib} from "../libraries/AgentIdLib.sol";
import {L2CurveV31} from "./libraries/L2CurveV31.sol";

/// @title  ToshLaunchpadHookV31
/// @notice PancakeSwap Infinity hook powering a single v3.1 Tosh launch.
///
/// ── v3.1 ────────────────────────────────────────────────────────────────────
///
///   Genesis (L1), the pool, the swap tax and the piggyback buyback are v3's,
///   unchanged. Phase 2 is replaced outright:
///
///     • ONE CONTINUOUS CURVE instead of 10 000 shelves. The shelf holds
///       `L2_SUPPLY × raised / hardCap` tokens (730 M on a sold-out raise)
///       and its price runs from p0 to 247 × p0 across them:
///
///           curve(x) = p0 · 247^(x / S) = p0 · e^(k·x),   k = ln 247 / S
///
///       Minting ends when the shelf is sold. There is no per-call tier loop.
///
///     • A DUTCH AUCTION on top. While nobody mints, the price falls 0.1 % per
///       whole minute, with no floor, and the next mint starts from the
///       decayed price — the decay is permanent. Seconds covered by the
///       factory's ladder halt do not count toward it.
///
///     • AN IDLE BURN beside it. Every whole 10 minutes without a mint burns
///       S / 1008 of the unminted shelf to 0xdEaD, so an idle week burns all
///       of it. A mint restarts the clock; halted seconds do not count; a
///       due burn is settled by the next mint or by anyone through
///       `settleL2Burn`. What is left to mint is S − minted − burned.
///
///     • A mint paying C at price p receives (1/k) · ln(1 + kC/p) tokens and
///       leaves the price at p + kC. If the shelf holds less than C buys, the
///       mint takes the remainder and is charged only its cost.
///
///     • ONE MINT per Agent ID and per wallet per project, of at most
///       `min(shelfCapPerAgent, raised / 10)` quote, booked by the factory.
///
///     • Minted tokens go to `mintVesting`, which releases them linearly over 8
///       hours, one step per minute.
///
///     • No price gate against the pool and no same-block lock: the curve
///       reads no oracle, so there is nothing for a swap to manipulate.
///
///   USDT only: genesis no longer takes native BNB.
///
///   Proceeds split as before: 80 % to `autoLp`, 19 % to the project's
///   revenue vault, 1 % to `ladderTreasury`, which in v3.1 is the TOSH buyback.
///

/// ── Required hook permissions ───────────────────────────────────────────────
///   BEFORE_INITIALIZE            offset 0    pool-init front-run defence
///   BEFORE_ADD_LIQUIDITY         offset 2    gates who may provide liquidity
///   BEFORE_SWAP                  offset 6    exact-input tax (specified = input)
///   AFTER_SWAP                   offset 7    oracle + piggyback + exact-output tax
///   BEFORE_SWAP_RETURNS_DELTA    offset 10   skim the specified (input) side
///   AFTER_SWAP_RETURNS_DELTA     offset 11   skim the unspecified (input) side
///
///   Declared in `getHooksRegistrationBitmap()` and repeated in
///   `PoolKey.parameters`; `CLPoolManager.initialize` refuses the pool if the
///   two disagree.
///
///   These are OFFSETS into a bitmap, not bits of this contract's address. Under
///   Uniswap V4 the same permission set was the mask 0x20CC and had to be ground
///   into the address with a mined CREATE2 salt. PancakeSwap Infinity asks the
///   contract instead, so the numbering above is Infinity's and bears no
///   relation to V4's — do not carry the old hex over.
///
///   Exact-output cannot be taxed in `beforeSwap`: the input is unspecified
///   and its size is only known after the swap.  Returning a delta from
///   `afterSwap` is what charges that input, so the flag is load-bearing.
///
///   BEFORE_REMOVE_LIQUIDITY is absent so third-party LPs can withdraw freely;
///   see `beforeRemoveLiquidity` for why the genesis position stays locked
///   regardless.
///
contract ToshLaunchpadHookV31 is ICLHooks, ILockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using SafeERC20 for IERC20;
    // Writes TICK_SPACING into the pool key's `parameters` word alongside the
    // permission bitmap. Infinity has no `tickSpacing` field on PoolKey.
    using CLPoolParametersHelper for bytes32;

    // ══════════════════════════════════════════════════════════════════════════
    //  Constants
    // ══════════════════════════════════════════════════════════════════════════

    // ─── Supply ───────────────────────────────────────────────────────────────

    /// @notice Tokens minted at `launch()`: the genesis block, 270 M or about
    ///         13 % of supply in v3 (180 M sold, up to 90 M into the pool).
    ///
    /// @dev    v3 shrinks genesis to a third and lets the ladder carry the
    ///         rest. The v2 reasoning below is about holding early inflation
    ///         down by enlarging genesis; v3 trades some of that back for a
    ///         smaller opening float and leans on the wider ladder span
    ///         instead (see `TIER_STEP_E18`).
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
    uint256 public constant GENESIS_SUPPLY = 270_000_000e18;

    /// @notice The genesis split, and the whole reason depositors open at a
    ///         profit.
    ///
    /// @dev    A 55 / 45 split of the 8.4 M genesis block is what manufactures
    ///         the depositors' 10 % opening premium.  Writing `R` for the raise
    ///         and noting that `REFERRAL_BPS` carves a flat 10 % off every
    ///         deposit — commission when a referrer exists, orphan sweep to the
    ///         platform when one does not — the pool is always seeded with
    ///         `lpNative = 0.9 · R`.  So:
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
    ///
    /// @dev    v2: the 55 / 45 claim / LP split above is gone with the claim.
    ///         Genesis is now `SALE_SUPPLY` sold on the curve, up to half of it
    ///         into the pool, and the unsold remainder burned.
    uint256 public constant SALE_SUPPLY = GenesisCurveV3.SALE_SUPPLY;

    /// @notice A sale this close to `SALE_SUPPLY` counts as sold out.
    uint256 public constant DUST = 1e15;

    /// @notice Share of each genesis payment accrued to the project fund.
    uint256 public constant FUND_BPS = 2000;

    /// @notice L2 tokens on a sold-out raise. A partial raise sells
    ///         `L2_SUPPLY × raised / hardCap`; see `l2Supply`.
    ///         270 M genesis + 730 M L2 = `ToshTokenV31.MAX_SUPPLY`.
    uint256 public constant L2_SUPPLY = 730_000_000e18;

    /// @notice ln(247) in 1e18 fixed point. The curve ends at 247 × p0, so
    ///         this over `l2Supply` is its growth rate k. Decay and mint
    ///         arithmetic live in `L2CurveV31`, shared with the lens.
    uint256 public constant LN_SPAN_WAD = L2CurveV31.LN_SPAN_WAD;

    /// @notice One mint may spend at most this share of the raise (10 %),
    ///         and never more than the factory's `shelfCapPerAgent`.
    uint256 public constant L2_QUOTA_BPS = 1000;

    uint256 internal constant ONE_E18 = 1e18;

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

    /// @notice How long after `launchStart()` only the project controller may
    ///         launch. After it anyone may, with no expiry.
    uint256 public constant ADMIN_LAUNCH_WINDOW = 48 hours;

    /// @notice The window this launch actually chose, frozen at deployment.
    /// @dev    A clone immutable arg — see the per-project block below.  Only
    ///         the *duration* can live there: `genesisDeadline` is
    ///         `block.timestamp + duration`, which the creator cannot predict
    ///         while mining a salt off-chain, so it has to be storage.
    function genesisDuration() public view returns (uint256) {
        return ToshCloneLib.argGenesisDuration();
    }

    // ─── Economics ────────────────────────────────────────────────────────────

    /// @notice Platform cut of Phase-2 shelf proceeds (1 %), routed to the
    ///         buyback reservoir. v3: `LP_SHARE_BPS` goes to `autoLp` and the
    ///         remaining 19 % to `projectAdmin`.
    uint256 public constant PLATFORM_TAX_BPS = 100;

    /// @notice Share of every shelf payment sent to `autoLp`, which buys the
    ///         project token with part of it in this pool and adds the rest
    ///         as permanently locked full-range liquidity.
    uint256 public constant LP_SHARE_BPS = 8000;

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
    /// @dev    Stacked on the 0.20 % `POOL_FEE` that goes to LPs, a trader's
    ///         total friction is 1.20 %.  See `PROJECT_SWAP_TAX_BPS` for how
    ///         the buy leg divides it.
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

    /// @notice The project's share of `TAX_BPS` on the buy leg: 0.60 % of the
    ///         quote input, paid to `projectAdmin`.  The other 0.40 % goes to
    ///         the buyback reservoir.
    ///
    /// @dev    CARVED OUT OF, NOT ADDED ON TOP.  `TAX_BPS` is the whole toll a
    ///         trader pays; this is how the buy leg divides it.
    ///
    /// @dev    BUY LEG ONLY.  The sell leg's input is the project's own token,
    ///         and paying anyone in it would only hand them something to sell
    ///         back into this pool.  The full 1 % of a sell is burned instead.
    ///
    /// @dev    v2 sent 70 bps to the reservoir and 30 bps to
    ///         `platformFeeRecipient`.  In v3 the platform's share of trading
    ///         is the genesis position's pool fees instead; see
    ///         `collectGenesisFees`.
    uint256 public constant PROJECT_SWAP_TAX_BPS = 60;

    uint256 internal constant BPS_DENOMINATOR = 10_000;

    // ─── Oracle ───────────────────────────────────────────────────────────────

    /// @notice Target TWAP window. Phase 2 no longer reads the pool at all;
    ///         the TWAP is kept for `autoLp` and the buyback, which bound their
    ///         own swaps against it. See v3 for the manipulation-depth notes.
    uint32 public constant TWAP_WINDOW = 1800;

    // ─── Pool ─────────────────────────────────────────────────────────────────

    /// @notice V4 static swap fee, 0.20 % — paid entirely to liquidity
    ///         providers by V4's native accounting.
    ///
    /// @dev    v3 lowers it from 0.30 %.  The paragraphs below are from v5,
    ///         when the hook tax was 0.70 %.
    ///
    ///         Together with the 0.70 % hook tax this holds total trader
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
    uint24 public constant POOL_FEE = 2000; // 0.20 %

    /// @dev Uniswap pairs a 0.30 % tier with a tick spacing of 60 by convention.  This
    ///      pool keeps 200 so that TICK_LOWER/UPPER stay aligned and the
    ///      genesis range is unchanged; the cost is that third-party LPs can
    ///      only place range bounds on a ~2 % grid, which is coarse but
    ///      workable for a freshly launched token.
    int24 public constant TICK_SPACING = 200;

    int24 internal constant TICK_LOWER = -887200;
    int24 internal constant TICK_UPPER = 887200;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint8 internal constant ACTION_ADD_LIQUIDITY = 1;
    uint8 internal constant ACTION_COLLECT_FEES = 2;

    /// @notice Mirror of `ToshLadderTreasury.TRIGGER_STEP`, the reservoir balance
    ///         that arms a piggyback buyback.
    ///
    /// @dev    Held here so `afterSwap` can decide whether the poke is worth
    ///         making without paying for a call to find out — see the comment at
    ///         the call site.  Copied from the treasury once, in the constructor,
    ///         so the two cannot drift; clones delegate to this implementation
    ///         and read the same value.
    uint256 public immutable PIGGYBACK_TRIGGER_STEP;

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
    ///         **RE-TAKEN FOR PANCAKESWAP INFINITY, and it moved.**  The
    ///         paragraph above says the floor is a measurement that has to be
    ///         re-taken per chain; the port changed the AMM as well as the chain,
    ///         and the leg got dearer.  Measured cold under `--isolate`, one leg
    ///         is **164,880** gas against 148,986 on Uniswap V4 — the same Vault
    ///         indirection that cost `launch()` 34k, paid again here.  The floor
    ///         is `100_000 + 164_880 = 264_880`, and 270,000 is the next round
    ///         number above it, which is the same rule the previous value used.
    ///
    ///         ⚠ 260,000 WAS BELOW THIS FLOOR, which is the exact failure the
    ///           correction above was written about — a gate that admits a poke,
    ///           forwards 160k and hands one leg less than the 164,880 it needs,
    ///           then swallows the revert.  It sat there for the duration of the
    ///           port and only the lower-bound assertion caught it.  The value
    ///           was correct when it was written and was invalidated by a change
    ///           somewhere else entirely, which is the argument for that
    ///           assertion existing rather than for anyone having been careless.
    ///
    ///         The old Robinhood measurement is worth keeping as history because
    ///         it is what the shape of this constant was argued from: one leg on
    ///         46630 against the live V4 singleton cost 156,153 gas, 4.8 % above
    ///         the local `--isolate` figure, and that 4.8 % is what said ArbOS
    ///         accounting did not diverge widely from Ethereum's.  BSC needs no
    ///         such adjustment — it is a plain EVM chain with no L2 gas model —
    ///         so the local cold measurement stands on its own here, and the
    ///         on-chain re-measurement to confirm it is owed once 97 is live.
    ///
    ///         Sized against the DEAREST leg, not the steady state.  The first
    ///         buyback of a newly listed token pays ~17k to take that token's
    ///         `0xdEaD` balance slot from zero; sizing to the steady state would
    ///         put the first poke of every new listing back in the waste band.
    ///
    ///         What it costs a wallet: the engage test reads 10 % under
    ///         `--isolate` and 20 % plain, against 15 %/45 % before the port.
    ///         Both improved, because the quote this is compared against grew
    ///         with the leg while the constant grew less than proportionally.
    ///
    ///         Three tests hold the three edges.
    ///         `test_piggybackStillRidesAProperlyEstimatedSwap` pins the engage
    ///         side and asserts BOTH bounds — it is the lower bound that caught
    ///         the port, and the upper bound that constrains this to 290,580
    ///         rather than anything comfortably clear of the floor: the two gas
    ///         accountings disagree about the leg, so the value has to satisfy
    ///         the isolated floor and the plain ceiling at once.
    ///         `test_piggybackSkipsRatherThanKillingTheTrade` pins the skip side.
    uint256 public constant PIGGYBACK_MIN_GAS = 270_000;

    // ══════════════════════════════════════════════════════════════════════════
    //  Immutables
    // ══════════════════════════════════════════════════════════════════════════

    // ─── Platform-global (one copy, shared by every project) ──────────────────
    //
    // These are identical for every launch, so they stay ordinary immutables on
    // the implementation. Under DELEGATECALL they resolve to constants PUSHed
    // from the implementation's code, which is why they cost zero bytes per
    // project and are just as cheap to read as before.

    /// @notice The concentrated-liquidity pool manager: pool state, swaps and
    ///         liquidity. It calls this contract's callbacks and nothing else
    ///         may.
    ICLPoolManager public immutable poolManager;

    /// @notice Where the money is. Infinity splits Uniswap V4's PoolManager in
    ///         two: the manager owns pool STATE, the Vault owns BALANCES and the
    ///         lock. So `take`, `settle`, `sync` and `mint` are the Vault's, and
    ///         the lock this contract takes to seed genesis liquidity is the
    ///         Vault's lock rather than the manager's.
    ///
    ///         Both are immutable and both are checked: the manager is the only
    ///         permitted callback caller, and the Vault the only permitted
    ///         `lockAcquired` caller. Conflating them would let either contract
    ///         drive the other's entry point.
    IVault public immutable vault;

    address public immutable factory;

    /// @notice The ERC20 every value flow here is denominated in: genesis
    ///         deposits, refunds, shelf payments, the buy-side tax, the
    ///         buyback reservoir, and the pool's own quote side.
    ///
    /// @dev    IMMUTABLE FOR THE SAME REASON AS `platformFeeRecipient` below,
    ///         and the lever is larger. A settable quote asset would let the
    ///         platform owner change what a raise is denominated in AFTER
    ///         depositors had paid into it — every unclaimed refund and the
    ///         whole genesis position would be re-denominated under them.
    ///         Changing it therefore needs a new hook implementation AND a new
    ///         factory, the bar `poolManager` is already held to.
    ///
    ///         Implementation-level, not one of the five per-project clone
    ///         arguments, so it stays out of the 131-byte clone initcode and
    ///         `hookInitcodeHash` keeps its current five-argument shape. It is
    ///         also read inside `beforeSwap` via `_key()`, where an external
    ///         call to the factory for it would be paid on every swap.
    ///
    ///         IT IS ALSO `currency0` OF EVERY POOL, which is load-bearing far
    ///         beyond this declaration. Native settlement got that for free —
    ///         `address(0)` sorts below every token. An ERC20 does not, so the
    ///         factory grinds each project token's CREATE2 salt until the token
    ///         address exceeds this one. See `ToshFactoryV31.createLaunch` and
    ///         `ToshCloneLib.deployBareCloneAbove`.
    IERC20 public immutable quoteAsset;

    /// @dev The quote asset's decimals, asserted in the constructor rather than
    ///      assumed, because the ladder's usable range was computed against it.
    ///      WBNB has 18, so `p0 = lpQuote * 1e18 / GENESIS_LP_SUPPLY` lands in
    ///      the billions for any raise worth a pool and adjacent shelves never
    ///      round onto the same price. Under BEM's 8 they did below ~21 BEM of
    ///      raise; docs/BEM_QUOTE_ASSET.md 2.1 has the table from that era.
    uint8 internal constant QUOTE_DECIMALS = 18;

    /// @notice Platform buyback reservoir; receives the reservoir's 40 bps
    ///         share of the buy-side dark tax and the shelf cut.
    address payable public immutable ladderTreasury;

    /// @notice Market-wide `ToshAutoLp`: receives `LP_SHARE_BPS` of every
    ///         shelf payment. Its swaps are taxed like any other, but never
    ///         carry the piggyback buyback (see `afterSwap`).
    address public immutable autoLp;

    /// @notice Platform-wide `ToshMintVesting`: every L2 mint is minted there
    ///         and released to the buyer over 8 hours.
    address public immutable mintVesting;

    /// @notice The platform's revenue address. v3: receives the quote side of
    ///         the genesis position's pool fees (see `collectGenesisFees`) and
    ///         orphaned referral commission at `launch`; no share of the swap
    ///         tax.
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

    /// @notice The Binance Agent ID registry genesis eligibility is read from.
    address public immutable agentRegistry;

    /// @notice Smallest genesis buy, in quote units (0.01 BNB / 5 USDT).
    uint256 public immutable minBuy;

    /// @notice v3.1 is USDT only. Kept so the factory's wiring check and
    ///         existing readers see the same getter.
    bool public constant acceptsNative = false;

    /// @dev This implementation's own address, captured at construction. Under
    ///      DELEGATECALL `address(this)` is the clone, so `address(this) ==
    ///      _self` means nobody proxied us and the per-project config below is
    ///      meaningless. See `onlyClone`.
    address private immutable _self;

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

    /// @notice The developer the platform listed this project for, recorded at
    ///         launch. The same address first received the project's Circuit NFT.
    ///
    /// @dev    ⚠ THIS ADDRESS NEVER RECEIVES FUNDS.  Nothing in this contract,
    ///         the factory, or the treasury transfers to it.  Project revenue —
    ///         19 % of every shelf sale — is paid to `projectAdmin`, the Circuit
    ///         revenue vault, which follows the NFT rather than this address.
    ///
    ///         It survives because it is part of the clone's immutable args and
    ///         therefore of the hook's address: on-chain, unalterable evidence
    ///         of who the project was originally listed for.
    ///
    ///         If you are looking for where the money goes, see `projectAdmin`
    ///         and `ladderTreasury`.
    function projectTreasury() public view returns (address) {
        return ToshCloneLib.argProjectTreasury();
    }

    /// @notice Most quote asset this project's genesis round may take in total.
    ///         `deposit` refuses any deposit that would carry
    ///         `totalNativeDeposited` past it.
    ///
    /// @dev    A CEILING, NOT A FLOOR. The clone slot it reads used to hold a
    ///         "soft cap" that nothing enforced; the slot was repurposed rather
    ///         than a new one added, so the clone layout did not move.
    ///
    ///         The only floor is still `ladderViable()`, which is a property of
    ///         the shelf arithmetic. A round can stop anywhere below this value
    ///         and launch, provided the ladder it would seed is viable.
    ///         `ToshFactoryV31.MIN_HARD_CAP` keeps the ceiling far enough above
    ///         that floor that a launchable round is not a near-full one.
    function hardCap() public view returns (uint256) {
        return ToshCloneLib.argHardCap();
    }

    /// @notice Maximum ETH any single wallet may put into THIS project.
    ///
    /// @dev    Snapshotted from `ToshFactoryV31.maxPogAllocationLimit` at deploy
    ///         time, deliberately frozen rather than read live.  The platform
    ///         owner can retune the dial at any moment, and a raise or cut
    ///         landing mid-genesis would silently rewrite the terms a project
    ///         was funded under.  Freezing it at creation means a change only
    ///         ever governs projects launched after it — rounds already in
    ///         flight keep the cap their depositors signed up to.
    ///
    /// @dev    v2: the same clone slot, read as the most quote one Agent ID may
    ///         spend in this genesis. Chosen by the project within platform
    ///         bounds at creation and frozen with the clone.
    function perAgentCap() public view returns (uint256) {
        return ToshCloneLib.argPerWalletCap();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Mutable state
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Receives the 19 % Phase-2 cut: the project's Circuit revenue
    ///         vault, written once by `initializeToken` and never again.
    ///
    /// @dev    There is deliberately no setter. The revenue right travels with
    ///         the Circuit NFT that controls the vault, so a rotatable payee
    ///         would let a holder redirect future proceeds and then sell an
    ///         NFT whose vault no longer receives anything.
    address public projectAdmin;

    ToshToken public projectToken;
    bool public tokenInitialized;

    uint256 public genesisDeadline;
    bool public launched;
    // ─── Genesis accounting (quote-asset units) ──────────────────────────────

    /// @notice Tokens sold on the genesis curve.
    uint256 public genesisSold;

    /// @notice Quote paid for them.
    uint256 public raised;

    /// @notice When the sale sold out, or zero.
    uint256 public soldOutAt;

    /// @notice 20 % share accrued and not yet withdrawn to `projectFund`.
    uint256 public fundAccrued;

    /// @notice 20 % share already paid out.
    uint256 public fundWithdrawn;

    /// @notice 80 % share, the pool's quote side at launch.
    uint256 public lpReserve;

    /// @notice Recipient of `withdrawFund`, changeable by the project controller.
    address public projectFund;

    /// @notice Quote spent per Agent ID, keyed by `keccak256(handle)`.
    mapping(bytes32 => uint256) public agentSpent;

    /// @notice Quote spent per buying wallet. The cap is booked against the
    ///         larger of this and `agentSpent`, so a wallet that moves to a
    ///         different Agent ID does not start a fresh allowance.
    mapping(address => uint256) public walletSpent;

    // ─── Phase 2 shelf ────────────────────────────────────────────────────────

    /// @notice The pool's opening price, quote wei per whole token, derived at
    ///         launch from the genesis raise. The shelf curve starts here.
    uint256 public p0;

    /// @notice Tokens this project's L2 curve holds: `L2_SUPPLY × raised /
    ///         hardCap`, fixed at launch. Zero before launch.
    uint256 public l2Supply;

    /// @dev The curve position in one slot. `price` is where the last mint
    ///      left the curve (p0 at launch), before any decay; `at` is when.
    ///      price stays near 247 · p0, far inside uint128, and minted is at
    ///      most 7.3e26, inside uint96.
    struct CurveState {
        uint128 price;
        uint96 minted;
        uint32 at;
    }

    CurveState internal _curve;

    /// @dev The idle burn and the halt clock in one slot. `haltedAt` is the
    ///      factory's `ladderHaltedSeconds` for this hook when `_curve.at` was
    ///      written, so halted time can be taken out of the idle clock;
    ///      `burned` is tokens burned off the shelf so far; `periods` is how
    ///      many 10-minute periods since the last mint have been burned for.
    struct BurnState {
        uint128 haltedAt;
        uint96 burned;
        uint32 periods;
    }

    BurnState internal _burn;

    // ─── Swap-derived state ───────────────────────────────────────────────────

    /// @dev Hook-local geometric-mean oracle.  Uniswap V4 core ships no
    ///      observation buffer (unlike V3), so the hook accumulates
    ///      `tick × elapsed` itself on every `afterSwap`.
    ///
    ///      `_lastSwapBlock` shares this slot deliberately.  Both it and
    ///      `lastTick` are written by every single swap, and as two separate
    ///      slots that was two cold SSTOREs (~5k each) where one suffices.
    ///      uint48 holds 2.8e14 blocks.  The figure this comment used to quote —
    ///      107 million years — assumed 12 s blocks, and `block.number` now
    ///      returns the settlement chain's own height, which on Robinhood Chain
    ///      ticks every 100 ms.  That is 120x faster and still ~890,000 years,
    ///      so the narrowing remains far from a real ceiling; the old premise
    ///      simply no longer describes where this deploys.  Slot use is
    ///      7 + 4 + 3 + 6 + 3 = 23 of 32 bytes.
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
    event GenesisBuy(address indexed buyer, bytes32 indexed agentKey, uint256 paid, uint256 tokens, uint256 soldAfter);
    event SoldOut(uint256 timestamp);
    event Launched(
        uint256 raised,
        uint256 lpQuote,
        uint256 lpTokens,
        uint256 burned,
        uint128 lpLiquidity,
        uint160 sqrtPriceX96,
        uint256 p0
    );
    event ProjectFundChanged(address indexed previousFund, address indexed newFund);
    event FundWithdrawn(address indexed to, uint256 amount);
    /// @notice One L2 mint. `price` is where it left the curve and `minted`
    ///         the running total.
    event L2Burned(uint256 amount, uint256 burned);
    event L2Minted(address indexed buyer, uint256 paid, uint256 tokens, uint256 price, uint256 minted);

    /// @notice Emitted when a quote-side skim funds the platform buyback
    ///         reservoir.  Carries the reservoir's share only (40 bps of the
    ///         input), NOT the whole `TAX_BPS` skim — the project's 60 bps is
    ///         reported separately by `ProjectSwapTaxPaid` in the same swap,
    ///         and the two sum to the skim.
    ///
    /// @dev    The name predates the split and is kept so existing indexers and
    ///         the `monitoring/alerts.json` rules do not silently stop
    ///         matching.  What changed is the amount, not the meaning: this was
    ///         always "what the reservoir received".
    event BuyTaxToTreasury(uint256 nativeAmount);

    /// @notice Emitted when a buy's quote-side skim pays the project's share
    ///         to `projectAdmin`.
    ///
    /// @dev    Buys only.  A sell emits `SellTaxBurned` alone, because the sell
    ///         leg is not split — see `PROJECT_SWAP_TAX_BPS`.
    event ProjectSwapTaxPaid(address indexed recipient, uint256 amount);

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
    error OnlyVault();
    error OnlyFactory();
    error NotInitialized();
    error AlreadyInitialized();
    error GenesisActive();
    error GenesisExpired();
    error AlreadyLaunched();
    error NotLaunched();
    error ZeroAmount();
    error UnauthorizedInitialization();
    error UnknownAction();
    error InvalidAdmin();
    error ZeroAddress();
    error WrongQuoteDecimals();

    // ─── v2 genesis ───────────────────────────────────────────────────────────

    /// @notice The caller is not a code-less transaction origin.
    error NotAWallet();
    error GenesisPaused();
    /// @notice The caller holds no Agent ID that resolves back to it.
    error NoAgentId();
    /// @notice This Agent ID has spent its whole allowance in this genesis.
    error AgentCapReached();
    /// @notice Under `minBuy`, and neither closing the sale nor the buyer's
    ///         last allowance.
    error BelowMinBuy();
    /// @notice Fewer tokens than `minTokens` would arrive.
    error BelowMinTokens();
    error GenesisSoldOut();
    error OnlyProjectController();
    error NothingRaised();
    /// @notice Inside the exclusive window only the project controller may
    ///         launch. See `publicLaunchAt()`.
    error AdminLaunchWindow();

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

    /// @notice The whole L2 supply has been minted.
    error L2SoldOut();

    /// @notice `pay` is above this project's per-mint limit; see `l2Quota`.
    error AboveL2Quota();

    error RangeNotFull();

    // ══════════════════════════════════════════════════════════════════════════
    //  Constructor
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Deployed ONCE per platform, not once per project. Every launch is a
    ///      clone of this instance, so the only arguments here are the ones
    ///      shared by all of them; per-project values arrive as clone immutable
    ///      args and are validated in `initializeToken`.
    ///
    ///      This instance is never usable as a hook itself — see `onlyClone`.
    ///      `_vault` is passed rather than derived. `CLPoolManager` does expose
    ///      a public `vault()` — it inherits one from `ProtocolFees` — but
    ///      `ICLPoolManager` does not declare it, so reading it here would mean
    ///      hand-rolling an interface for a getter this repository cannot pin
    ///      to the vendored source. Passing both and asserting the relationship
    ///      in the fork suite keeps the claim measured against the live pair
    ///      instead of asserted by a local declaration.
    constructor(
        address _poolManager,
        address _vault,
        address _factory,
        address _ladderTreasury,
        address _platformFeeRecipient,
        address _quoteAsset,
        address _agentRegistry,
        uint256 _minBuy,
        address _autoLp,
        address _mintVesting
    ) {
        // Custom errors rather than one revert string per argument: the hook
        // sits close to the EIP-170 limit.
        if (
            _poolManager == address(0) || _vault == address(0) || _factory == address(0)
                || _ladderTreasury == address(0) || _platformFeeRecipient == address(0) || _quoteAsset == address(0)
                || _agentRegistry == address(0) || _minBuy == 0 || _autoLp == address(0) || _mintVesting == address(0)
        ) revert ZeroAddress();
        // Asserted, not assumed: `ToshFactoryV31.MIN_HARD_CAP` and the ladder's usable
        // range were both computed against 18 decimals. A quote asset with any
        // other precision silently moves where the shelf ladder degenerates,
        // and a deploy is the worst place to discover that.
        if (IERC20Metadata(_quoteAsset).decimals() != QUOTE_DECIMALS) revert WrongQuoteDecimals();

        poolManager = ICLPoolManager(_poolManager);
        vault = IVault(_vault);
        factory = _factory;
        ladderTreasury = payable(_ladderTreasury);
        autoLp = _autoLp;
        mintVesting = _mintVesting;
        PIGGYBACK_TRIGGER_STEP = IToshLadderTreasuryV31(_ladderTreasury).TRIGGER_STEP();
        platformFeeRecipient = payable(_platformFeeRecipient);
        quoteAsset = IERC20(_quoteAsset);
        agentRegistry = _agentRegistry;
        minBuy = _minBuy;
        _self = address(this);
    }

    /// @dev DELETED WITH THE NATIVE QUOTE ASSET, and the deletion is the safer
    ///      option rather than the tidier one.
    ///
    ///      It existed to accept the genesis gateway's `msg.value` and any Vault
    ///      `take` that settled native currency here. Both now move BEM, which
    ///      needs no `receive()`, so keeping one would only accept BNB that no
    ///      code path can pay out — `_payQuote` moves the quote asset and there
    ///      is no native withdrawal anywhere in this contract. A payable fallback
    ///      would therefore be a one-way door: it would take someone's BNB and
    ///      burn it, silently, with a successful transaction receipt.
    ///
    ///      Without it, such a send reverts. The sender keeps their BNB and finds
    ///      out immediately. That is the whole argument.
    ///
    ///      ⚠ CONSEQUENCE FOR TOOLING: this contract is no longer `payable`, so
    ///        `payable(hook)` casts and `ToshLaunchpadHookV31(payable(...))` wrappers
    ///        elsewhere are now merely harmless rather than required. They are
    ///        left in place — removing them is a wide, mechanical diff across the
    ///        factory and the test suite for no behavioural gain — but do not read
    ///        one as evidence this contract takes native value.

    // ══════════════════════════════════════════════════════════════════════════
    //  Modifiers
    // ══════════════════════════════════════════════════════════════════════════

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    /// @dev The lock callback's guard, and deliberately NOT `onlyPoolManager`.
    ///
    ///      Infinity splits V4's PoolManager into a manager that owns pool state
    ///      and a Vault that owns balances and the lock. `lockAcquired` is
    ///      re-entered by the VAULT, so guarding it with the manager's address
    ///      would reject every legitimate call — and guarding it with either
    ///      address would let the manager, which this contract calls into on
    ///      every swap, drive the settlement path as well.
    modifier onlyVault() {
        if (msg.sender != address(vault)) revert OnlyVault();
        _;
    }

    /// @dev Refuses execution on the shared implementation.
    ///
    ///      This is mandatory, not belt-and-braces. The clone args sit at fixed
    ///      offsets into the *caller's* code, and on the implementation those
    ///      offsets land inside its own ~19 KB of real bytecode — not out of
    ///      bounds, so EXTCODECOPY does not zero-fill. `hardCap()` called on the
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
    //  Factory initialisation
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
    ///           • `projectAdmin`   — the project's Circuit revenue vault, which
    ///                                the factory deploys in the same call.
    ///
    ///         `projectAdmin` is not committed to by the hook's address, and it
    ///         does not need to be: this is its only writer, and the only caller
    ///         is the factory, in the transaction that creates the vault.
    ///
    ///         `onlyClone` is load-bearing, not belt-and-braces. This is the only
    ///         writer of `tokenInitialized`, and every value-bearing path is
    ///         gated on it, so refusing to run here is what makes the bare
    ///         implementation inert. See `onlyClone` and
    ///         `test_implementationIsInertAsItself`.
    ///
    /// @param token_        The project's ERC-20, already pointed at this hook.
    /// @param projectAdmin_ Permanent recipient of the 19 % Phase-2 cut.
    /// @param projectFund_  First recipient of the 20 % genesis share.
    function initializeToken(address token_, address projectAdmin_, address projectFund_) external onlyClone {
        if (msg.sender != factory) revert OnlyFactory();
        if (tokenInitialized) revert AlreadyInitialized();
        if (token_ == address(0)) revert ZeroAddress();
        if (projectAdmin_ == address(0)) revert InvalidAdmin();
        // Same trap as `setProjectFund`: paying the hook parks the 20 % as a
        // balance `launch()` then treats as surplus and sends to the platform.
        if (projectFund_ == address(0) || projectFund_ == address(this)) revert ZeroAddress();

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
        if (ToshCloneLib.argCreator() == address(0)) revert ZeroAddress();
        if (ToshCloneLib.argProjectTreasury() == address(0)) revert ZeroAddress();
        if (ToshCloneLib.argHardCap() == 0) revert ZeroAddress();
        if (ToshCloneLib.argPerWalletCap() == 0) revert ZeroAddress();

        projectToken = ToshToken(token_);
        projectAdmin = projectAdmin_;
        projectFund = projectFund_;
        genesisDeadline = block.timestamp + duration;
        tokenInitialized = true;

        emit TokenInitialized(token_);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PHASE 1 — GENESIS (v2: Agent ID allowance, linear curve, instant delivery)
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Buy genesis tokens off the curve. Tokens are minted to the
    ///         buyer immediately; there is no claim and no refund.
    ///
    /// @dev    Eligibility is a Binance Agent ID resolved on-chain, with the
    ///         allowance booked against the name rather than the address (see
    ///         `AgentIdLib`). The buyer must be the transaction's origin, so a
    ///         contract or constructor cannot buy on someone's behalf and then
    ///         hold tokens the pre-launch transfer rules keep in wallets. An
    ///         EIP-7702 account qualifies: its delegate runs only on its own
    ///         signature (see `ToshToken`).
    ///
    ///         The spend is `min(maxPay, remaining allowance, cost to sell
    ///         out)`, and the buyer pays exactly the curve cost of what they
    ///         receive — never more than `maxPay`.
    ///
    ///         20 % of every payment accrues to the project fund and 80 % to
    ///         the LP reserve. Accrued rather than pushed, so no recipient can
    ///         make a buy fail.
    ///
    /// @param  maxPay    Most quote asset to spend.
    /// @param  minTokens Slippage bound: revert if fewer tokens would arrive.
    function buyGenesis(uint256 maxPay, uint256 minTokens)
        external
        initialized
        nonReentrant
        returns (uint256 tokens, uint256 cost)
    {
        if (launched) revert AlreadyLaunched();
        if (block.timestamp >= genesisDeadline) revert GenesisExpired();
        if (soldOutAt != 0) revert GenesisSoldOut();
        if (msg.sender != tx.origin) revert NotAWallet();
        if (IToshFactoryHaltV31(factory).genesisBlocked(address(this), msg.sender)) revert GenesisPaused();

        bytes32 agentKey = AgentIdLib.agentKeyOf(agentRegistry, msg.sender);
        if (agentKey == bytes32(0)) revert NoAgentId();

        uint256 spent = agentSpent[agentKey];
        uint256 spentByWallet = walletSpent[msg.sender];
        if (spentByWallet > spent) spent = spentByWallet;
        uint256 cap = perAgentCap();
        if (spent >= cap) revert AgentCapReached();
        uint256 budget = maxPay;
        if (budget > cap - spent) budget = cap - spent;

        uint256 soldBefore = genesisSold;
        uint256 h = hardCap();
        uint256 toSellOut = GenesisCurveV3.costOf(h, soldBefore, SALE_SUPPLY - soldBefore);
        // Below the minimum only when this buy closes the sale or uses up the
        // buyer's whole remaining allowance: neither can be repeated as dust.
        if (budget < minBuy && budget < toSellOut && budget != cap - spent) revert BelowMinBuy();

        (tokens, cost) = GenesisCurveV3.tokensFor(h, soldBefore, budget);
        if (tokens == 0) revert ZeroAmount();
        if (tokens < minTokens) revert BelowMinTokens();

        // ── Effects ──────────────────────────────────────────────────────────
        uint256 soldAfter = soldBefore + tokens;
        genesisSold = soldAfter;
        raised += cost;
        agentSpent[agentKey] = spent + cost;
        walletSpent[msg.sender] = spent + cost;

        uint256 fund = (cost * FUND_BPS) / BPS_DENOMINATOR;
        fundAccrued += fund;
        lpReserve += cost - fund;

        // A remainder below DUST is not worth a transaction and would leave the
        // sale open forever; it is treated as sold and burned at launch.
        if (SALE_SUPPLY - soldAfter < DUST) {
            soldOutAt = block.timestamp;
            emit SoldOut(block.timestamp);
        }

        // ── Interactions ─────────────────────────────────────────────────────
        quoteAsset.safeTransferFrom(msg.sender, address(this), cost);

        projectToken.mint(msg.sender, tokens);
        projectToken.registerFor(msg.sender);

        emit GenesisBuy(msg.sender, agentKey, cost, tokens, soldAfter);
    }

    /// @notice Price of the next genesis token, quote wei per whole token.
    ///         Frozen at 1.5P once sold out. The bid book's price floor.
    function currentGenesisPrice() public view returns (uint256) {
        return GenesisCurveV3.priceAt(hardCap(), genesisSold);
    }

    /// @notice When the launch clock starts: sell-out if it sold out,
    ///         otherwise the genesis deadline.
    function launchStart() public view returns (uint256) {
        uint256 s = soldOutAt;
        return s != 0 ? s : genesisDeadline;
    }

    /// @notice Current holder of the project's Circuit NFT — the party that
    ///         launches during the exclusive window and controls the fund.
    function projectController() public view returns (address) {
        return ICircuitVaultHolderV31(projectAdmin).holder();
    }

    // ─── Project fund ─────────────────────────────────────────────────────────

    /// @notice Where `withdrawFund` pays the accrued 20 %.
    function setProjectFund(address newFund) external {
        if (msg.sender != projectController()) revert OnlyProjectController();
        _setProjectFund(newFund);
    }

    /// @notice Pay everything accrued so far to `projectFund`.
    function withdrawFund() external nonReentrant {
        if (msg.sender != projectController()) revert OnlyProjectController();
        if (fundAccrued == 0) revert ZeroAmount();
        _payFund();
    }

    /// @notice Pay `fundAccrued` to the current `projectFund` and point the
    ///         fund at `newFund`. The factory calls this from a Circuit transfer
    ///         so a sale settles the 20 % genesis share the same way it
    ///         settles the revenue vault: the seller is paid, the buyer starts
    ///         with a fund address they control.
    function settleProjectFund(address newFund) external {
        if (msg.sender != factory) revert OnlyFactory();
        _payFund();
        _setProjectFund(newFund);
    }

    function _setProjectFund(address newFund) private {
        // Paid to the hook, the fund would read as surplus at `launch()`.
        if (newFund == address(0) || newFund == address(this)) revert ZeroAddress();
        emit ProjectFundChanged(projectFund, newFund);
        projectFund = newFund;
    }

    function _payFund() private {
        uint256 amount = fundAccrued;
        if (amount == 0) return;
        fundAccrued = 0;
        fundWithdrawn += amount;
        address to = projectFund;
        _payQuote(to, amount);
        emit FundWithdrawn(to, amount);
    }

    // ─── Launch ───────────────────────────────────────────────────────────────

    /// @notice Open the pool: seed it with the LP reserve at 2P, burn the unsold
    ///         genesis supply, lift the token's transfer restrictions and open
    ///         the shelf ladder.
    ///
    /// @dev    REACHABLE BY CONSTRUCTION. Once anything has been raised and the
    ///         sale has sold out or closed, the only gate is who may call: the
    ///         project controller for `ADMIN_LAUNCH_WINDOW`, then anyone, with
    ///         no expiry. Nothing here reads the factory's pause, blacklist or
    ///         ladder halt, the project fund, or the Agent ID registry, and the
    ///         controller lookup is skipped entirely once the window is over.
    ///
    ///         The opening price does not depend on how much sold. The pool is
    ///         seeded with exactly `lpReserve` and `L = lpReserve / 2P` tokens,
    ///         so p0 = 2P for any raise; a sold-out round has L = 90M. Quote
    ///         sent here from outside never reaches the pool — it is paid to the
    ///         platform with the rounding remainder — so a donation cannot move
    ///         the opening price.
    ///
    ///         `openTrading()` runs first so the token is a plain ERC-20 by the
    ///         time any of it moves; the pool's side is minted straight into
    ///         the Vault, and the unsold remainder straight to 0xdead, so
    ///         sold + L + burned = GENESIS_SUPPLY exactly.
    function launch() external initialized nonReentrant {
        if (launched) revert AlreadyLaunched();
        uint256 totalRaised = raised;
        if (totalRaised == 0) revert NothingRaised();
        uint256 start = launchStart();
        if (block.timestamp < start) revert GenesisActive();
        if (block.timestamp < start + ADMIN_LAUNCH_WINDOW && msg.sender != projectController()) {
            revert AdminLaunchWindow();
        }

        launched = true;
        projectToken.openTrading();

        uint256 lpQuote = lpReserve;
        uint256 soldTotal = genesisSold;
        uint256 lpTokens = FullMath.mulDiv(lpQuote, GenesisCurveV3.N, 2 * hardCap());
        if (lpTokens > GENESIS_SUPPLY - soldTotal) lpTokens = GENESIS_SUPPLY - soldTotal;

        uint256 openPrice = (lpQuote * ONE_E18) / lpTokens;
        p0 = openPrice;
        // A sold-out raise can land a few wei over the cap; the supply cannot.
        uint256 cap = hardCap();
        l2Supply = FullMath.mulDiv(L2_SUPPLY, totalRaised < cap ? totalRaised : cap, cap);
        // forge-lint: disable-next-line(unsafe-typecast) — see `CurveState`
        _curve = CurveState({price: uint128(openPrice), minted: 0, at: uint32(block.timestamp)});
        // forge-lint: disable-next-line(unsafe-typecast) — seconds, see `BurnState`
        _burn = BurnState({
            haltedAt: uint128(IToshFactoryHaltV31(factory).ladderHaltedSeconds(address(this))), burned: 0, periods: 0
        });

        uint160 sqrtPriceX96 = _toSqrtPriceX96(lpQuote, lpTokens);
        poolManager.initialize(_key(), sqrtPriceX96);

        (uint128 liquidity, uint256 quoteIn, uint256 tokensIn) = abi.decode(
            vault.lock(abi.encode(ACTION_ADD_LIQUIDITY, sqrtPriceX96, lpQuote, lpTokens)), (uint128, uint256, uint256)
        );

        uint256 burned = GENESIS_SUPPLY - soldTotal - tokensIn;
        if (burned != 0) projectToken.mint(DEAD_ADDRESS, burned);

        int24 openingTick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        lastTick = openingTick;
        lastObservationTs = uint32(block.timestamp);
        _prevCheckpointTs = uint32(block.timestamp);
        _curCheckpointTs = uint32(block.timestamp);

        // `ToshAutoLp.flush` waits for a block nothing has swapped in.
        _lastSwapBlock = uint48(block.number);

        // Everything held beyond the unwithdrawn fund is owed to nobody: the
        // seed's rounding remainder plus anything sent here from outside.
        uint256 surplus = quoteAsset.balanceOf(address(this)) - fundAccrued;
        if (surplus != 0) _payQuote(platformFeeRecipient, surplus);

        emit Launched(totalRaised, quoteIn, tokensIn, burned, liquidity, sqrtPriceX96, p0);
    }

    /// @notice Sweep the pool fees the genesis position has earned.  Permissionless.
    ///
    /// @dev    The genesis position is owned by this hook and can never be
    ///         withdrawn, so without this its 0.20 % pool fee would accrue in the
    ///         Vault forever: fees are only paid out on a `modifyLiquidity` by the
    ///         owner, and the hook used to have exactly one — the initial add.
    ///
    ///         The sweep is a zero-delta `modifyLiquidity` on the same position,
    ///         which pays out the fees and moves no principal.  Liquidity cannot
    ///         change: the delta is the literal `0`, not a parameter.  A zero
    ///         delta takes Infinity's remove branch, and this hook registers no
    ///         remove callbacks, so nothing of ours re-enters.
    ///
    ///         The destinations are fixed and the caller chooses nothing, which is
    ///         why nobody needs to be trusted to call it: v3 sends the quote leg
    ///         to `platformFeeRecipient` and burns the token leg.  `CircuitNFT`
    ///         still calls it (try/catch) on every transfer, which now only
    ///         sweeps the platform's fees early; anyone may call it.
    ///
    ///         No `nonReentrant`: it writes no storage of ours, and the Vault
    ///         refuses a second `lock` while this one is open.
    function collectGenesisFees() external {
        if (!launched) revert NotLaunched();
        vault.lock(abi.encode(ACTION_COLLECT_FEES));
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PHASE 2 — CONTINUOUS SHELF CURVE WITH DUTCH DECAY
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Mint off the L2 curve: spend up to `pay` quote at the current
    ///         (decayed) price, after settling any idle burn that is due. The
    ///         tokens vest to the caller over 8 hours through `mintVesting`.
    ///
    /// @dev    Once per Agent ID and per wallet on this project. The factory
    ///         books it, and refuses it while the ladder is halted, without an
    ///         Agent ID, on a second mint, or above `shelfCapPerAgent`. `pay`
    ///         is also held to `l2Quota()` here.
    ///
    ///         The quote is pulled straight from the buyer to each recipient,
    ///         so this contract never holds an L2 payment and there is no
    ///         change to refund: when the curve holds less than `pay` buys,
    ///         only the remainder's cost is pulled. `ToshHookLensV31.quoteL2`
    ///         returns exactly what this would mint and charge.
    ///
    /// @param  pay       Most quote to spend.
    /// @param  minTokens Slippage bound: revert if fewer tokens would vest.
    function mintL2(uint256 pay, uint256 minTokens)
        external
        initialized
        nonReentrant
        returns (uint256 tokens, uint256 cost)
    {
        if (!launched) revert NotLaunched();
        if (pay < minBuy) revert BelowMinBuy();
        if (pay > l2Quota()) revert AboveL2Quota();
        (uint256 left, uint256 burn) = _settleBurn();
        if (left == 0) revert L2SoldOut();
        uint256 supply = l2Supply;
        IToshFactoryHaltV31 f = IToshFactoryHaltV31(factory);

        uint256 price;
        (tokens, cost, price) = f.l2Quote(l2Price(), supply - left, supply, pay);
        if (tokens == 0) revert ZeroAmount();
        if (tokens < minTokens) revert BelowMinTokens();

        // EFFECTS
        uint256 minted = _curve.minted + tokens;
        // forge-lint: disable-next-line(unsafe-typecast) — see `CurveState`
        _curve = CurveState({price: uint128(price), minted: uint96(minted), at: uint32(block.timestamp)});
        // forge-lint: disable-next-line(unsafe-typecast) — seconds, see `BurnState`
        _burn = BurnState({haltedAt: uint128(f.ladderHaltedSeconds(address(this))), burned: _burn.burned, periods: 0});

        // INTERACTIONS
        f.bookShelfMint(msg.sender, cost);
        if (burn != 0) projectToken.mint(DEAD_ADDRESS, burn);

        uint256 platformCut = (cost * PLATFORM_TAX_BPS) / BPS_DENOMINATOR;
        uint256 lpCut = (cost * LP_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 projectCut = cost - platformCut - lpCut;
        if (platformCut > 0) quoteAsset.safeTransferFrom(msg.sender, ladderTreasury, platformCut);
        if (projectCut > 0) quoteAsset.safeTransferFrom(msg.sender, projectAdmin, projectCut);
        if (lpCut > 0) quoteAsset.safeTransferFrom(msg.sender, autoLp, lpCut);

        projectToken.mint(mintVesting, tokens);
        IToshMintVestingV31(mintVesting).lock(msg.sender, tokens);

        emit L2Minted(msg.sender, cost, tokens, price, minted);

        // Last: the buy it may run swaps through this hook's callbacks, and it
        // never reverts on a market condition.
        if (lpCut > 0) IToshAutoLpV31(autoLp).deposit(lpCut);
    }

    /// @notice Burn whatever idle burn is due. Permissionless; `mintL2` does
    ///         the same first.
    function settleL2Burn() external {
        (, uint256 burn) = _settleBurn();
        if (burn != 0) projectToken.mint(DEAD_ADDRESS, burn);
    }

    /// @notice The curve price right now, quote wei per whole token: the last
    ///         mint's price less 0.1 % per whole minute since, not counting
    ///         seconds the factory's ladder halt covered. Never below 1 wei.
    function l2Price() public view returns (uint256) {
        if (!launched) return 0;
        return L2CurveV31.decayed(_curve.price, _idle());
    }

    /// @notice Tokens still mintable once any due idle burn is settled:
    ///         `l2Supply − minted − burned`.
    function l2Remaining() external view returns (uint256 left) {
        (,, left) = _burnDue();
    }

    /// @dev Seconds since the last mint (or launch), less halted seconds.
    function _idle() private view returns (uint256) {
        uint256 busy =
            uint256(_curve.at) + IToshFactoryHaltV31(factory).ladderHaltedSeconds(address(this)) - _burn.haltedAt;
        return busy < block.timestamp ? block.timestamp - busy : 0;
    }

    /// @dev The idle burn due now, the period count it brings the slot to, and
    ///      what the shelf holds after it.
    function _burnDue() private view returns (uint256 due, uint256 periods, uint256 left) {
        BurnState memory b = _burn;
        uint256 supply = l2Supply;
        left = supply - _curve.minted - b.burned;
        periods = _idle() / L2CurveV31.BURN_INTERVAL;
        if (periods > b.periods) {
            due = (periods - b.periods) * (supply / L2CurveV31.BURN_PERIODS);
            if (due > left) due = left;
            left -= due;
        }
    }

    /// @dev Book the due idle burn; returns what the shelf holds after it and
    ///      how much the caller must mint to 0xdEaD. Before launch the shelf
    ///      is empty and nothing is due.
    function _settleBurn() private returns (uint256 left, uint256 due) {
        uint256 periods;
        (due, periods, left) = _burnDue();
        if (due == 0) return (left, 0);
        BurnState storage b = _burn;
        // forge-lint: disable-next-line(unsafe-typecast) — ≤ l2Supply, see `CurveState`
        b.burned += uint96(due);
        // forge-lint: disable-next-line(unsafe-typecast) — 10-minute periods
        b.periods = uint32(periods);
        emit L2Burned(due, b.burned);
    }

    /// @notice Most quote one mint may spend on this project before the
    ///         factory's `shelfCapPerAgent`: `max(raised / 10, minBuy)`.
    function l2Quota() public view returns (uint256 quota) {
        quota = (raised * L2_QUOTA_BPS) / BPS_DENOMINATOR;
        if (quota < minBuy) quota = minBuy;
    }

    /// @notice The stored curve position: tokens minted so far, and when and
    ///         where the last mint (or launch) left the price before decay.
    function l2State() external view returns (uint256 minted, uint256 lastMintAt, uint256 lastPrice) {
        CurveState memory c = _curve;
        return (c.minted, c.at, c.price);
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
    ///      The TWAP `autoLp` and the buyback lean on is SINGLE-VENUE: it reads
    ///      this pool and only this pool. The genesis position is permanently
    ///      locked here, which is what keeps this pool the deep one.
    function beforeInitialize(address sender, PoolKey calldata, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != address(this)) revert UnauthorizedInitialization();
        return ICLHooks.beforeInitialize.selector;
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
    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        ICLPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4) {
        return ICLHooks.beforeRemoveLiquidity.selector;
    }

    /// @notice ASYMMETRIC IN-FLIGHT TAX — 1.0 % of every swap's INPUT, routed
    ///         by direction so the buyback flywheel cannot be starved.
    ///
    /// ── The rule ────────────────────────────────────────────────────────────
    ///
    ///     BUY  (quote → token) : 0.6 % of the quote input → projectAdmin
    ///                          + 0.4 % of the quote input → ToshLadderTreasury
    ///     SELL (token → quote) : 1.0 % of the token input → 0xdead
    ///
    ///   Stacked on the 0.2 % native pool fee this is a 1.20 % total toll.
    ///   The pool fee accrues to LPs via V4; this tax is the protocol's cut.
    ///
    ///   The asymmetry in the rule above is the split, not the rate: both legs
    ///   charge the same 1.0 %.  Only the buy leg divides it, because only the
    ///   buy leg's input is the quote asset — see `PROJECT_SWAP_TAX_BPS`.
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
    function beforeSwap(address sender, PoolKey calldata key, ICLPoolManager.SwapParams calldata params, bytes calldata)
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
            return (ICLHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Stay passive while the treasury is executing its own buyback —
        // taxing it would recurse and skim the burn itself.
        if (sender == ladderTreasury || _piggybackActive()) {
            return (ICLHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 input = uint256(-params.amountSpecified);
        uint256 tax = (input * TAX_BPS) / BPS_DENOMINATOR;
        if (tax == 0) {
            return (ICLHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        _skimInputTax(key, params.zeroForOne, input, tax);
        return (ICLHooks.beforeSwap.selector, toBeforeSwapDelta(SafeCast.toInt128(tax), 0), 0);
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
        ICLPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        // Swap stamp (read by `ToshAutoLp.flush`) + oracle observation.
        //
        // ABOVE the treasury exemption below: these two lines are what make a
        // swap VISIBLE to the TWAP, and the exemption exists only to stop us
        // taxing our own buyback and recursing into it.
        //
        // Neither line can recurse. The stamp is a plain SSTORE, and
        // `_writeObservation` only reads `slot0`. The piggyback poke further
        // down is the reentrant part, and it stays below the exemption.
        //
        // Sampling here rather than after `_skimUnspecifiedInput` is
        // price-neutral: the skim settles deltas through `poolManager.take`,
        // which moves no price, so `lastTick` reads the same either way.
        _lastSwapBlock = uint48(block.number);
        _writeObservation();

        // Stay passive while the treasury is executing its own buyback —
        // taxing it would recurse and skim the burn itself.
        if (sender == ladderTreasury || _piggybackActive()) {
            return (ICLHooks.afterSwap.selector, int128(0));
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
        // NOTE THE ARM CHECK IS NO LONGER `BALANCE`, and the cheap-read argument
        // above is weaker as a result. `ladderTreasury.balance` was an opcode on
        // a warm account, 100 gas. The reservoir is an ERC20 balance now, so this
        // is a CALL into the quote asset plus its SLOAD — roughly 2,700 cold,
        // ~2,200 warm on a pool the swap has already touched. Still cheaper than
        // the call chain it avoids (a CALL into the treasury, another into the
        // manager for `isUnlocked`, and a cold `ladderTokens.length`), so the
        // conclusion holds; the margin is a few thousand gas rather than two
        // orders of magnitude.
        // v3: not on `autoLp`'s buys. They run inside a shelf mint, whose gas
        // the buyer estimated without a buyback leg, and inside `autoLp`'s own
        // Vault frame. The tax above still applies to them.
        uint256 avail = gasleft();
        if (
            sender != autoLp && quoteAsset.balanceOf(ladderTreasury) >= PIGGYBACK_TRIGGER_STEP
                && avail >= PIGGYBACK_MIN_GAS
        ) {
            try IToshLadderTreasuryV31(ladderTreasury).autoPiggybackBuyback{gas: avail - PIGGYBACK_TAIL_RESERVE}() {}
            catch {
                emit PiggybackPokeFailed(ladderTreasury);
            }
        }

        return (ICLHooks.afterSwap.selector, hookUnspecified);
    }

    /// @dev Route `tax` of the input asset: quote (a buy) splits between the
    ///      project and the reservoir; tokens (a sell) all go to the fire.
    ///
    ///      `input` is the gross input the rate was applied to, passed in so
    ///      the project's share is computed from the SAME base as `tax`
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
    ///      Which is why the reservoir's share is `tax - projectCut` and not
    ///      its own multiplication.  Two independent floor divisions of the
    ///      same base do not have to sum back to a third:
    ///
    ///          input = 110 wei
    ///          tax          = 110 · 100 / 10_000 = 1   (floor of 1.1)
    ///          projectCut   = 110 ·  60 / 10_000 = 0   (floor of 0.66)
    ///          40 bps direct= 110 ·  40 / 10_000 = 0   (floor of 0.44)
    ///
    ///      so the naive pair would settle 0 against a credit of 1.  By
    ///      subtraction the reservoir takes 1, and the wei that rounding
    ///      would have dropped lands in the reservoir rather than nowhere.
    ///      The bias is deliberate and one-directional: dust favours the
    ///      buyback, never the project.
    ///
    ///      The subtraction cannot underflow.  `floor(a·60/d) ≤ floor(a·100/d)`
    ///      holds for every non-negative `a` because the numerator is strictly
    ///      smaller, so `projectCut ≤ tax` always.  Either share can floor to
    ///      zero on a dust input (at 167 wei both round to 1), so both are
    ///      guarded.
    function _skimInputTax(PoolKey calldata key, bool nativeIsInput, uint256 input, uint256 tax) internal {
        if (!nativeIsInput) {
            // Sell leg: not split — see `PROJECT_SWAP_TAX_BPS`.
            vault.take(key.currency1, DEAD_ADDRESS, tax);
            emit SellTaxBurned(tax);
            return;
        }

        uint256 projectCut = (input * PROJECT_SWAP_TAX_BPS) / BPS_DENOMINATOR;
        uint256 reservoirCut = tax - projectCut;

        if (reservoirCut > 0) {
            vault.take(key.currency0, ladderTreasury, reservoirCut);
            emit BuyTaxToTreasury(reservoirCut);
        }
        if (projectCut > 0) {
            vault.take(key.currency0, projectAdmin, projectCut);
            emit ProjectSwapTaxPaid(projectAdmin, projectCut);
        }
    }

    /// @dev Exact-output input tax.  Specified is the output; unspecified is
    ///      the input and is negative on `delta` (owed to the pool).
    function _skimUnspecifiedInput(PoolKey calldata key, ICLPoolManager.SwapParams calldata params, BalanceDelta delta)
        internal
        returns (int128 hookUnspecified)
    {
        // specified is currency0 iff exactInput == zeroForOne.  Exact-output
        // flips that, so unspecified is currency0 (ETH) on a buy and
        // currency1 (token) on a sell.
        bool nativeIsInput = params.zeroForOne;
        int128 inputDelta = nativeIsInput ? delta.amount0() : delta.amount1();
        if (inputDelta >= 0) return 0;

        uint256 input = uint256(uint128(-inputDelta));
        uint256 tax = (input * TAX_BPS) / BPS_DENOMINATOR;
        if (tax == 0) return 0;

        _skimInputTax(key, nativeIsInput, input, tax);
        return SafeCast.toInt128(tax);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  IHooks — inactive callbacks
    // ══════════════════════════════════════════════════════════════════════════

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        return ICLHooks.afterInitialize.selector;
    }

    /// @dev Full range only. A narrow position is a limit order: one-sided
    ///      liquidity that buyers or sellers cross converts at the pool price
    ///      without ever passing through `beforeSwap`, so it trades untaxed.
    function beforeAddLiquidity(
        address,
        PoolKey calldata,
        ICLPoolManager.ModifyLiquidityParams calldata params,
        bytes calldata
    ) external pure returns (bytes4) {
        if (params.tickLower != TICK_LOWER || params.tickUpper != TICK_UPPER) revert RangeNotFull();
        return ICLHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ICLPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (ICLHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ICLPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (ICLHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return ICLHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return ICLHooks.afterDonate.selector;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  ILockCallback
    // ══════════════════════════════════════════════════════════════════════════

    function lockAcquired(bytes calldata data) external onlyVault returns (bytes memory) {
        uint8 action = abi.decode(data, (uint8));

        if (action == ACTION_ADD_LIQUIDITY) {
            (, uint160 sqrtPriceX96, uint256 lpQuote, uint256 lpTokens) =
                abi.decode(data, (uint8, uint160, uint256, uint256));
            return _addInitialLiquidity(sqrtPriceX96, lpQuote, lpTokens);
        }
        if (action == ACTION_COLLECT_FEES) {
            _collectGenesisFees();
            return "";
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
    ///
    ///      Two fields here are Infinity's rather than V4's. `poolManager` has
    ///      to be named in the key — the manager validates it and reverts
    ///      `PoolManagerMismatch` otherwise — and `tickSpacing` is no longer a
    ///      field at all: it is packed into `parameters` next to the permission
    ///      bitmap. Both are derived, so neither adds an SLOAD to the count
    ///      above.
    function _key() internal view returns (PoolKey memory) {
        // `currency0` is the QUOTE ASSET and `currency1` is the project token,
        // and that assignment is an assertion about addresses rather than a
        // choice. Infinity requires `currency0 < currency1` and rejects the pool
        // otherwise, so writing them in this order only works because the
        // factory ground the token's CREATE2 salt until it exceeded the quote
        // asset. If that grind is ever removed, `initialize` here starts
        // reverting for roughly a third of launches — which is the good failure.
        // The bad one is code that sorts the pair at runtime and then reads
        // `amount0` as the quote leg regardless, which is what the ~90 sites
        // downstream of this function do. Keep the grind; do not sort here.
        return PoolKey({
            currency0: Currency.wrap(address(quoteAsset)),
            currency1: Currency.wrap(address(projectToken)),
            hooks: IHooks(address(this)),
            poolManager: IPoolManager(address(poolManager)),
            fee: POOL_FEE,
            parameters: bytes32(uint256(getHooksRegistrationBitmap())).setTickSpacing(TICK_SPACING)
        });
    }

    /// @notice Which callbacks Infinity should invoke on this hook, and the
    ///         replacement for Uniswap V4's mined address.
    ///
    /// @dev    V4 encoded permissions in the low bits of the hook's own address,
    ///         so deploying one meant grinding a CREATE2 salt until the address
    ///         carried the right mask — 0x20CC here, via `HookAddress`. Infinity
    ///         reads this function instead, and `initialize` compares it against
    ///         the same bitmap repeated in `PoolKey.parameters`, refusing the
    ///         pool if they disagree. So the permission set is still pinned to
    ///         the key, but by equality rather than by address arithmetic, and
    ///         there is nothing left to mine.
    ///
    ///         The set is unchanged from the V4 mask, and each entry is load-
    ///         bearing for the same reason it was there:
    ///
    ///           BEFORE_INITIALIZE          only this hook may open its pool
    ///           BEFORE_ADD_LIQUIDITY       gates who may provide liquidity
    ///           BEFORE_SWAP                takes the exact-input tax
    ///           AFTER_SWAP                 stamps the block, feeds the oracle
    ///           BEFORE_SWAP_RETURNS_DELTA  lets beforeSwap move the input
    ///           AFTER_SWAP_RETURNS_DELTA   lets afterSwap charge exact-output
    ///
    ///         BEFORE_REMOVE_LIQUIDITY stays absent, exactly as it was absent
    ///         from the V4 mask, so third-party LPs withdraw freely; see
    ///         `beforeRemoveLiquidity` for why the genesis position is locked
    ///         structurally rather than by a revert.
    ///         Declared `public` rather than `external` so `_key()` can read it
    ///         without a self-call: the key has to repeat the bitmap, and the
    ///         two must come from one expression or they can drift apart.
    ///
    ///         WHAT BOUNDS THE SHIFTS, since `forge lint` asks and the answer is
    ///         not visible from here. Each `HOOKS_*_OFFSET` is a `uint8` constant
    ///         in Infinity's `ICLHooks`, and the largest of the fourteen is 13
    ///         (`AFTER_REMOVE_LIQUIDIY_RETURNS_DELTA`). A `uint16` has bits 0-15,
    ///         so every shift Infinity defines fits with two bits to spare and no
    ///         combination of them can truncate.
    ///
    ///         The shifted operand is written `uint16(1)` rather than a bare `1`
    ///         for that reason. A literal takes its type from context, which here
    ///         is an outer `uint16(...)` cast — so the arithmetic was already
    ///         correct, and correct for a reason a reader has to work out. Naming
    ///         the width at the shift makes the bound local: if Infinity ever
    ///         defines an offset above 15, this stops compiling silently-correct
    ///         code and starts truncating visibly at a named type.
    function getHooksRegistrationBitmap() public pure override returns (uint16) {
        return (uint16(1) << HOOKS_BEFORE_INITIALIZE_OFFSET) | (uint16(1) << HOOKS_BEFORE_ADD_LIQUIDITY_OFFSET)
            | (uint16(1) << HOOKS_BEFORE_SWAP_OFFSET) | (uint16(1) << HOOKS_AFTER_SWAP_OFFSET)
            | (uint16(1) << HOOKS_BEFORE_SWAP_RETURNS_DELTA_OFFSET)
            | (uint16(1) << HOOKS_AFTER_SWAP_RETURNS_DELTA_OFFSET);
    }

    /// @dev Settle the full-range genesis position from `lpQuote` quote and at
    ///      most `lpTokens` tokens. Returns the liquidity and what each side
    ///      actually took, which `launch()` needs to size the burn.
    ///
    ///      v2 mints the token side directly into the Vault rather than to the
    ///      hook and across: the token is held by nobody before the pool owns
    ///      it, and whatever the position does not take is simply never minted.
    function _addInitialLiquidity(uint160 sqrtPriceX96, uint256 lpQuote, uint256 lpTokens)
        internal
        returns (bytes memory)
    {
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(TICK_LOWER),
            TickMath.getSqrtRatioAtTick(TICK_UPPER),
            lpQuote,
            lpTokens
        );

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            _key(),
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        uint256 quoteOwed;
        uint256 tokensOwed;

        // currency0 == the quote asset
        //
        // Now settled exactly like currency1 below, which is the visible payoff
        // of the move off native: the two legs used to take different code paths
        // — `settle{value:}` against an implicit amount, versus
        // sync/transfer/settle against a measured one — and now they differ only
        // in which token and which delta.
        if (d0 < 0) {
            quoteOwed = uint256(uint128(-d0));
            vault.sync(Currency.wrap(address(quoteAsset)));
            SafeERC20.safeTransfer(quoteAsset, address(vault), quoteOwed);
            vault.settle();
        }
        // currency1 == project token
        //
        // The transfer goes to the VAULT, not the pool manager. This is the one
        // place the Infinity port could not be mechanical: `sync`/`settle` moved
        // to the Vault, and so did the address that has to physically receive
        // the tokens. Sending them to the manager instead leaves `settle()`
        // measuring a balance that never changed, so it credits nothing and the
        // frame closes with `CurrencyNotSettled()`.
        if (d1 < 0) {
            tokensOwed = uint256(uint128(-d1));
            vault.sync(Currency.wrap(address(projectToken)));
            projectToken.mint(address(vault), tokensOwed);
            vault.settle();
        }

        return abi.encode(liquidity, quoteOwed, tokensOwed);
    }

    /// @dev With a zero liquidity delta the returned delta is the fee delta
    ///      alone, so both legs are credits (>= 0) and `take` is the whole
    ///      settlement.
    ///
    ///      No event of its own: the two `take`s are Transfers out of the Vault
    ///      to `platformFeeRecipient` and 0xdead.  The hook has no bytecode to spare —
    ///      see the constructor.
    function _collectGenesisFees() internal {
        PoolKey memory key = _key();
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: 0, salt: bytes32(0)
            }),
            ""
        );

        uint256 quoteFees = uint256(uint128(delta.amount0()));
        uint256 tokenFees = uint256(uint128(delta.amount1()));
        if (quoteFees > 0) vault.take(key.currency0, platformFeeRecipient, quoteFees);
        if (tokenFees > 0) vault.take(key.currency1, DEAD_ADDRESS, tokenFees);
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

    /// @dev The TWAP in its native Q64.96 sqrt form. Returns 0 until a FULL
    ///      window has elapsed, so no consumer is handed a one-second
    ///      "average" a single swap could set.
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
            return TickMath.getSqrtRatioAtTick(lastTick);
        }

        int56 cumNow = tickCumulative + int56(lastTick) * int56(uint56(nowTs - lastObservationTs));
        int56 delta = cumNow - _prevCheckpointCumulative;

        int24 avgTick = int24(delta / int56(uint56(span)));

        // Round toward negative infinity, matching Uniswap V3's OracleLibrary,
        // so the TWAP is never biased upward by truncation.
        if (delta < 0 && (delta % int56(uint56(span)) != 0)) avgTick--;

        if (avgTick < TickMath.MIN_TICK) avgTick = TickMath.MIN_TICK;
        if (avgTick > TickMath.MAX_TICK) avgTick = TickMath.MAX_TICK;

        return TickMath.getSqrtRatioAtTick(avgTick);
    }

    function _piggybackActive() internal view returns (bool) {
        return IToshLadderTreasuryV31(ladderTreasury).piggybackActive();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Math helpers
    // ══════════════════════════════════════════════════════════════════════════

    function _toSqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        if (amount0 == 0) revert ZeroAmount();
        uint256 sqrtA1 = _sqrt(amount1);
        uint256 sqrtA0 = _sqrt(amount0);
        uint256 result = (sqrtA1 << 96) / sqrtA0;
        return SafeCast.toUint160(result);
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

    /// @dev The single exit for quote asset leaving this contract: refunds,
    ///      referral claims, orphaned commission, and both legs of the shelf
    ///      payment split.
    ///
    ///      REENTRANCY GOT SIMPLER HERE, not harder, and that is worth recording
    ///      because the opposite is the usual result of moving to ERC20. The
    ///      native version was a bare `call` with all remaining gas to an
    ///      arbitrary address, so every caller had to be ordered
    ///      effects-before-interactions on the assumption the recipient would
    ///      re-enter — `refund()` zeroes `nativeDeposited` before paying for
    ///      exactly that reason. `safeTransfer` on a fixed, known token calls
    ///      only that token, and BEM's transfer runs no recipient hook.
    ///
    ///      The orderings stay as they are. They are correct either way, they
    ///      cost nothing, and they are the only thing standing between this
    ///      contract and a re-entrancy bug if the quote asset is ever a token
    ///      with callbacks. Do not "simplify" them on the strength of this note.
    function _payQuote(address to, uint256 amount) internal {
        SafeERC20.safeTransfer(quoteAsset, to, amount);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Views
    // ══════════════════════════════════════════════════════════════════════════

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
    ///         The unit is whatever `block.number` returns — the settlement
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
}

// ─── Minimal external interfaces ──────────────────────────────────────────────

/// @dev `CircuitRevenueVault.holder()`: the current owner of the Circuit NFT.
interface ICircuitVaultHolderV31 {
    function holder() external view returns (address);
}

interface IToshAutoLpV31 {
    function deposit(uint256 amount) external;
}

interface IToshLadderTreasuryV31 {
    function autoPiggybackBuyback() external;
    function piggybackActive() external view returns (bool);
    function TRIGGER_STEP() external view returns (uint256);
}

/// @dev Minimal factory view for the ladder halt.  Declared here rather than
///      importing ToshFactoryV31 because the factory already imports this file to
///      deploy hooks, and a direct import would close that cycle.
interface IToshFactoryHaltV31 {
    function ladderMintingHalted(address hook) external view returns (bool);
    function genesisBlocked(address hook, address user) external view returns (bool);
    function bookShelfMint(address buyer, uint256 cost) external;
    function ladderHaltedSeconds(address hook) external view returns (uint256);
    function l2Quote(uint256 price, uint256 minted, uint256 supply, uint256 pay)
        external
        pure
        returns (uint256 tokens, uint256 cost, uint256 priceAfter);
}

interface IToshMintVestingV31 {
    function lock(address account, uint256 amount) external;
}

