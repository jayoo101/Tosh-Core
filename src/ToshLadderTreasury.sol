// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// PancakeSwap Infinity. Two of the V4 imports this replaced do not have
// equivalents because they no longer have a job: `TransientStateLibrary` read
// the in-flight delta out of V4's transient storage by `extsload`, and the Vault
// exposes the same number as a plain `currencyDelta(settler, currency)` getter.
//
// Three more survived the port unreferenced and were removed on 2026-09-20 when
// Aderyn named them: `IHooks`, `IPoolManager` and `ILockCallback`. The last is
// the one that looks like a mistake and is not — this contract really does
// implement `lockAcquired`, but the Vault dispatches to it by selector, so
// declaring the interface buys nothing and importing it bought less.
//
// Removing them is not free here and the cost was measured rather than assumed,
// because metadata feeds CREATE2: it moves this contract's creation code in its
// last 43 bytes (the CBOR metadata blob) with the executable code byte-identical,
// and leaves `ToshLaunchpadHook` and `ToshFactory` untouched. So no hook address
// moves and no initcode hash needed republishing; what it did cost was a chain 97
// redeploy, to keep the deployed treasury byte-matching a fresh build.
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";

import {Ownable2Step} from "../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  ToshLadderTreasury (v5.0)
/// @notice Platform-wide dark-tax reservoir and round-robin buyback executor.
///
/// ── Purpose ─────────────────────────────────────────────────────────────────
///
///   v5.0 replaces the v4.x per-pool `harvestAndBurn` + off-chain harvest bot
///   with a fully on-chain, self-driving deflation engine:
///
///     1. ETH flows in through four pipes (all native ETH):
///          • the 0.7 % BUY-side in-flight tax from every Tosh pool,
///          • project launch fees from ToshFactory,
///          • orphaned referral commission (deposits with no referrer),
///          • the 1 % platform cut of every Phase-2 shelf mint.
///        The SELL-side tax never arrives here by design — those tokens are
///        burned in place by the hook, needing no reservoir at all.
///     2. Every swap's `afterSwap` pokes `autoPiggybackBuyback()`.
///     3. Whenever this contract's balance crosses `TRIGGER_STEP` (1 ETH), the
///        poking swap "gives a ride" (顺风车) to a buyback: `max(TRIGGER_STEP,
///        balance × SPEND_BPS / 10_000)` is split evenly across the next
///        `BATCH_SIZE` ladder tokens in round-robin order, market-bought
///        through Uniswap V4, and the proceeds are sent straight to
///        `DEAD_ADDRESS`.  The 10 % proportional spend means a full reservoir
///        does not sit idle waiting for dozens of 1-ETH drips; the 1 ETH
///        floor keeps a near-empty pot from wasting gas on dust legs.
///
/// ── Iron rule: one-way valve ────────────────────────────────────────────────
///
///   There is deliberately NO `withdraw`, NO `transfer`, NO `sweep`, NO
///   `rescue`, and NO `delegatecall` in this contract.  The ONLY code path that
///   moves ETH out is `_buyAndBurn`, whose output currency is hard-wired to
///   `DEAD_ADDRESS`.  Not the owner, not a hook, not the factory can take
///   custody of a single wei.
///
///   AUDIT GREP (must produce ZERO matches in this file):
///     • `function withdraw`         — absent by design
///     • `function sweep`            — absent by design
///     • `function rescue`           — absent by design
///     • `delegatecall`              — absent by design
///     • `.transfer(` / `.call{value` outside `_buyAndBurn` — absent by design
///
/// ── What the valve does NOT constrain ───────────────────────────────────────
///
///   The paragraph above is about CUSTODY, and it is easy to misread as a
///   statement about BENEFICIARIES.  It is not one.  The owner cannot take the
///   ETH, but the owner alone decides which markets absorb it, and buying
///   pressure that terminates in a burn is still buying pressure that lands in
///   somebody's order book.  An owner who lists one token and delists the rest
///   points the whole reservoir at a single price.
///
///   Two things bound that, and neither is the valve:
///
///     • `_buybackSqrtFloor` caps how far above a pool's TWAP any cycle will
///       fill, so concentration is rate-limited to roughly one deviation band
///       per TWAP window rather than being drainable on demand.
///     • `perToken` is divided by BATCH_SIZE, NOT by the number of listings, so
///       a one-token ladder deploys a third of the rate a full one does.  A
///       narrow list now buys a narrow trickle; it used to buy the same
///       cheque, concentrated.
///
///   What remains is a governance surface, not a code one: curation should sit
///   behind the same multisig and change-review as any other economic dial.
///
/// ── Execution context ───────────────────────────────────────────────────────
///
///   `autoPiggybackBuyback()` is invoked from a hook's `afterSwap`, i.e. while
///   the PoolManager is ALREADY unlocked by some third-party router.  We
///   therefore do NOT call `vault.lock()` (that would revert with
///   `AlreadyUnlocked`); we call `swap` / `settle` / `take` directly and the
///   resulting deltas are attributed to `address(this)` and zeroed out before
///   we return.
///
contract ToshLadderTreasury is Ownable2Step {
    using CurrencyLibrary for Currency;

    // ─── Constants ────────────────────────────────────────────────────────────

    /// @notice Balance threshold that arms a piggyback buyback, and the
    ///         minimum a cycle will spend.  A fuller reservoir spends
    ///         `SPEND_BPS` of its balance instead, so ammunition does not
    ///         pile up through quiet trading hours.
    ///
    /// @dev    Sized by intent rather than by a spot rate, because it is a
    ///         constant and a constant outlives the rate that set it.  The
    ///         question it answers is "how much ammunition is worth one shot,
    ///         net of the gas to fire it", and 92.8 BEM sits where 3.5 BNB sat,
    ///         which sat where 1 ETH sat when this was written.  A cheaper
    ///         trigger spends the reservoir on fees; a dearer one lets it idle.
    ///
    ///         ⚠ MUST EQUAL `ToshLaunchpadHook.PIGGYBACK_TRIGGER_STEP`. Both are
    ///           `constant` with no setter, in separately deployed contracts, so
    ///           nothing on-chain reconciles them. If the hook's copy is the
    ///           higher of the two, `afterSwap` stops poking at balances this
    ///           contract would have acted on and the buyback simply goes quiet —
    ///           a skipped poke emits nothing by design, so the symptom is
    ///           silence. `ToshV5Guards.t.sol` pins the pair.
    uint256 public constant TRIGGER_STEP = 92.8e8;

    /// @notice Fraction of the reservoir spent per piggyback cycle, in
    ///         basis points.  1000 = 10 %.  Floored at `TRIGGER_STEP`.
    uint256 public constant SPEND_BPS = 1000;

    /// @notice How many ways a cycle's spend is split — the SIZING divisor, not
    ///         the number of legs run per poke.
    ///
    /// @dev    These were the same number until the peak-cost work.  One poke
    ///         used to run three legs, which billed a single trader for three V4
    ///         swaps (~125k each, measured) on top of their own — 579k against
    ///         the 217k an untriggered swap costs.  Legs now run one per poke,
    ///         while `perToken` stays `spend / BATCH_SIZE` so each pool receives
    ///         exactly what it did before.
    ///
    ///         Keeping the divisor at 3 is what makes that free: shrinking it
    ///         instead would push three times the ETH through one genesis pool
    ///         per cycle, and on pools that thin the extra slippage buys fewer
    ///         tokens to burn — paying in execution quality for a gas saving.
    uint256 public constant BATCH_SIZE = 3;

    /// @notice Buy legs executed per poke.
    ///
    /// @dev    One, so the trader who triggers a cycle carries one V4 swap
    ///         rather than three.  The reservoir stays armed while it holds
    ///         `TRIGGER_STEP`, so the following swaps pick up the next legs and
    ///         the same three pools are served across three trades instead of
    ///         one — same ETH deployed, same per-pool size, a third of the peak.
    ///         The cursor advancing one leg at a time also spreads coverage more
    ///         evenly than advancing three at once.
    uint256 public constant LEGS_PER_POKE = 1;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice How far below the pool's TWAP a buyback leg may drive the sqrt
    ///         price before it stops filling.
    ///
    /// @dev    Stated in SQRT terms, so 1000 bps is roughly a 19 % move in
    ///         price, not 10 %.  Deliberately loose: the bound exists to make
    ///         sandwiching unprofitable, not to track the market closely, and a
    ///         tight bound would stall legitimate buybacks whenever a token
    ///         rallied hard inside a single TWAP window.  An attacker who wants
    ///         to evade it has to shift the price ~19 % and hold that through
    ///         the poke, paying the 0.3 % LP fee and the 0.7 % hook tax on both
    ///         legs of a position sized to move the pool that far.
    ///
    ///         Do not read the prize as fixed.  A leg is
    ///         `max(TRIGGER_STEP, balance × SPEND_BPS / 10_000) / BATCH_SIZE`,
    ///         so 0.33 ETH — the figure this comment used to quote as the sum
    ///         being skimmed — is only its FLOOR, reached while the reservoir
    ///         sits between 1 and 10 ETH and the minimum is doing the sizing.
    ///         Above that the leg is `balance / 30` and rises with the pot; a
    ///         100 ETH reservoir offers 3.34 ETH.  The two sides of the trade
    ///         also scale on different axes — evading the band costs in
    ///         proportion to POOL DEPTH, while the prize tracks the RESERVOIR —
    ///         so the margin is thinnest on a thin pool behind a full treasury.
    ///         This band is a rate limit on that exposure, not a proof it is
    ///         unprofitable: `test_probeG2_bandEdgeSitsWhereTheConstantSaysItDoes`
    ///         pins the width, and PROBE G measures what leaks through it.
    uint256 public constant MAX_BUYBACK_SQRT_DEVIATION_BPS = 1000;

    /// @dev Transient-storage slot holding the recursion guard.  A piggyback
    ///      buys through OTHER Tosh pools, whose hooks would otherwise tax the
    ///      buyback and re-trigger a nested piggyback.  Hooks read
    ///      `piggybackActive()` and go fully passive while it is set.
    ///      Transient (EIP-1153) because the flag is only meaningful within the
    ///      current transaction.
    uint256 private constant _PIGGYBACK_SLOT = 0x546f73685069676779626163b1000001;

    // ─── Immutables ───────────────────────────────────────────────────────────

    /// @notice Pool state and the swap entry point.
    ICLPoolManager public immutable poolManager;

    /// @notice Balances and the lock. Infinity splits V4's PoolManager in two,
    ///         so the buyback takes the VAULT's lock and settles against the
    ///         Vault, while the swap itself still goes to the manager.
    IVault public immutable vault;

    /// @notice The ERC20 this reservoir accumulates and spends — the same quote
    ///         asset the factory and every hook hold.
    ///
    /// @dev    Immutable for the reason every sink here is: the reservoir's only
    ///         exit is a buy-and-burn, and a settable spend currency would let
    ///         the owner point that exit at a token nobody deposited. Changing
    ///         it means a new treasury.
    ///
    ///         This is what the four revenue pipes now arrive as. Under native
    ///         settlement they arrived as `msg.value` and `receive()` was the
    ///         entry point; an ERC20 has no such hook, so a transfer in is
    ///         invisible to this contract and `TaxReceived` can no longer be
    ///         emitted on arrival. Accounting reads `balanceOf` instead — see
    ///         `reservoir()`.
    IERC20 public immutable quoteAsset;

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice ToshFactory, used to authenticate calling hooks.  Set once.
    address public factory;

    /// @notice Platform-curated tokens eligible for buyback-and-burn.
    address[] public ladderTokens;

    /// @notice Round-robin cursor into `ladderTokens`.
    uint256 public currentCursor;

    /// @dev token => V4 PoolKey of its ETH pair.
    mapping(address => PoolKey) internal _poolKeyOf;

    /// @dev token => (index in `ladderTokens`) + 1.  Zero means "not listed".
    mapping(address => uint256) internal _indexPlusOne;

    // ─── Events ───────────────────────────────────────────────────────────────

    event FactorySet(address indexed factory);
    event LadderTokenAdded(address indexed token, uint256 index);
    event LadderTokenRemoved(address indexed token, uint256 index);
    event TaxReceived(address indexed from, uint256 amount);

    /// @notice Emitted once per piggyback cycle.
    event PiggybackExecuted(uint256 nativeSpent, uint256 tokensServiced, uint256 newCursor);

    /// @notice Emitted per ladder token bought and burned.
    event BuybackBurned(address indexed token, uint256 nativeIn, uint256 tokensBurned);

    /// @notice Emitted when one leg of a batch reverts.  The cycle continues —
    ///         a single broken pool must never brick platform-wide trading.
    event BuybackSkipped(address indexed token, uint256 nativeIn);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error OnlyHook();
    error OnlySelf();
    error FactoryAlreadySet();
    error FactoryNotSet();
    error ZeroAddress();
    error TokenAlreadyListed();
    error TokenNotListed();
    error TokenNotLaunchedHere();
    /// @dev Launched by this platform, but its pool is not open yet.  Distinct
    ///      from `TokenNotLaunchedHere` so the owner can tell "wrong platform"
    ///      apart from "too early", which is a wait rather than a mistake.
    error PoolNotLaunched();
    /// @dev Launched, but its hook cannot yet name a TWAP — so `_buybackSqrtFloor`
    ///      would leave this token's buyback legs unbounded.  Like
    ///      `PoolNotLaunched` this is a wait, not a mistake: it clears on the
    ///      clock alone, within `TWAP_WINDOW` of `launch()`.
    error TwapNotMature();
    error InvalidPoolKey();
    /// @dev Was `OnlyPoolManager`. Renamed with the guard it belongs to: the
    ///      frame this rejects unauthorised entry into is the Vault's now.
    error OnlyVault();
    /// @dev `pokeBuyback` called with nothing to deploy.
    error NotArmed();
    error PiggybackInProgress();

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @dev `_vault` is passed rather than read off the manager for the same
    ///      reason as in `ToshLaunchpadHook`: `CLPoolManager` inherits a public
    ///      `vault()` from `ProtocolFees`, but `ICLPoolManager` does not declare
    ///      it, and hand-rolling an interface for a getter would put a claim
    ///      about the live pair into a local declaration instead of a test.
    constructor(address _poolManager, address _vault, address _owner, address _quoteAsset) Ownable(_owner) {
        if (_poolManager == address(0) || _vault == address(0) || _owner == address(0) || _quoteAsset == address(0)) {
            revert ZeroAddress();
        }
        poolManager = ICLPoolManager(_poolManager);
        vault = IVault(_vault);
        quoteAsset = IERC20(_quoteAsset);
    }

    // ─── Funding ──────────────────────────────────────────────────────────────

    /// @notice What this reservoir holds and can spend.
    ///
    /// @dev    THE FOUR REVENUE PIPES NO LONGER ANNOUNCE THEMSELVES, and that is
    ///         the one behavioural loss in moving off native settlement. The 1%
    ///         dark tax, launch fees, orphaned commission and donations used to
    ///         arrive as `msg.value` through `receive()`, which emitted
    ///         `TaxReceived` on every one. An ERC20 `transfer` runs no code here,
    ///         so arrivals are now silent and `TaxReceived` only fires where a
    ///         caller routes through `notifyTax`.
    ///
    ///         Consequence for anything watching: do not reconstruct the
    ///         reservoir by summing `TaxReceived`. It will undercount. Read this
    ///         getter, or diff it across blocks. `STATE-05`/`STATE-06` in
    ///         monitoring/alerts.json poll the balance for exactly this reason.
    ///
    ///         `balanceOf` rather than a counter because a counter would be a
    ///         second source of truth that a direct transfer could desynchronise
    ///         permanently, and this contract has no way to notice one.
    function reservoir() public view returns (uint256) {
        return quoteAsset.balanceOf(address(this));
    }

    /// @notice Optional receipt for a caller that has just funded this reservoir.
    ///
    /// @dev    Emits `TaxReceived` for an amount the caller claims to have just
    ///         transferred. NOT TRUSTED AND NOT TRUSTABLE: the transfer already
    ///         happened, this cannot verify it, and anyone may call this with any
    ///         figure. It exists so the hook's tax path keeps producing the event
    ///         indexers were built against, and it is unauthenticated because
    ///         gating it to hooks would mean an authentication read on every
    ///         swap's tax leg for a log line.
    ///
    ///         Treat the event as a hint about provenance, never as an amount.
    ///         `reservoir()` is the amount.
    function notifyTax(uint256 amount) external {
        emit TaxReceived(msg.sender, amount);
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyHook() {
        address f = factory;
        if (f == address(0) || !IToshFactoryRegistry(f).registeredHooks(msg.sender)) revert OnlyHook();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    // ─── Owner administration (ladder curation ONLY) ──────────────────────────

    /// @notice Bind the factory whose `registeredHooks` map authenticates
    ///         piggyback callers.  One-shot: the treasury is deployed before
    ///         the factory (the factory needs this address in its
    ///         constructor), so the link is completed post-deploy.
    function setFactory(address _factory) external onlyOwner {
        if (_factory == address(0)) revert ZeroAddress();
        if (factory != address(0)) revert FactoryAlreadySet();
        factory = _factory;
        emit FactorySet(_factory);
    }

    /// @notice List `token` on the buyback ladder.
    ///
    /// @dev    The venue is DERIVED, never supplied.  An earlier revision let
    ///         the owner pass an arbitrary `PoolKey` alongside the token and
    ///         checked only the currency ordering, which silently defeated the
    ///         one-way valve above: the owner could mint a worthless ERC-20,
    ///         pair it in a hookless pool they alone provided liquidity to,
    ///         list it, and let each 1 ETH buyback settle into their own
    ///         position — draining the entire reservoir one trigger at a time
    ///         while emitting nothing but ordinary `BuybackBurned` events.
    ///
    ///         Two facts now make the venue unforgeable.  `tokenToHook` proves
    ///         this platform launched the token, and the key is read back from
    ///         that hook, so the ETH can only ever be spent in the deep genesis
    ///         pool the hook itself polices.  Both depend on `factory`, which
    ///         is why its binding is one-shot: a re-pointable factory would
    ///         hand the answer to both questions back to the owner.
    ///
    ///         ── A POOL YOUNGER THAN `TWAP_WINDOW` IS REFUSED ───────────────
    ///
    ///         This was an OPERATIONAL rule until 2026-09-11 — written here,
    ///         breakable by anyone holding this key, with nothing on chain to
    ///         stop them.  It is now a check: `twapSqrtPriceX96()` must answer,
    ///         and must answer non-zero, or the listing reverts
    ///         `TwapNotMature`.  Both of `_buybackSqrtFloor`'s doors to
    ///         unbounded are closed, the reverting one included.
    ///
    ///         Read the rest of this box as the reason the check exists rather
    ///         than as a live hazard.  The hazard is real in any deployment
    ///         whose treasury predates this change — the live one does, because
    ///         `ToshFactory.ladderTreasury` is `immutable` and is baked into
    ///         the hook implementation every launch clones, so replacing the
    ///         treasury means replacing the platform.  There the rule is still
    ///         only a rule, `scripts/preflightLadderListing.mjs` is what checks
    ///         it before a signature, and `STATE-07` is what catches it after.
    ///
    ///         `_buybackSqrtFloor` anchors the anti-sandwich bound to the
    ///         hook's TWAP, and the hook reports 0 — meaning "no TWAP yet" —
    ///         for the first `TWAP_WINDOW` (1800 s) after `launch()`.  On 0 the
    ///         floor falls back to unbounded, so a token listed inside that
    ///         window has NO price bound on its buyback legs, on the pool whose
    ///         liquidity is thinnest.  Measured at
    ///         `test_probeG3_immatureTwapIsRefusedAtListing`: a pool
    ///         parked 1500 bps out gives up 0.93 ETH of a 3.33 ETH leg, where a
    ///         matured TWAP refuses the same deviation outright.  `pokeBuyback`
    ///         has no cooldown, so that is per block, not once.
    ///
    ///         Waiting costs nothing but the wait: the reservoir is not spent
    ///         while a token is unlisted, and the window closes on the clock
    ///         alone — `_prevCheckpointTs` only ever rolls onto a checkpoint
    ///         already a full window old, so it is one-shot and cannot be
    ///         re-entered.  `STATE-07` in `monitoring/alerts.json` is what
    ///         catches the rule being broken, by polling the same
    ///         `twapSqrtPriceX96()` this depends on rather than re-deriving the
    ///         deadline from timestamps.
    ///
    /// @param  token A token launched by this platform, already through
    ///               `launch()` — checked against the hook's `launched` flag,
    ///               since there is no pool to buy into before that — and whose
    ///               hook names a non-zero TWAP, checked here rather than left
    ///               to the operator; see above.
    function addLadderToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (_indexPlusOne[token] != 0) revert TokenAlreadyListed();

        address f = factory;
        if (f == address(0)) revert FactoryNotSet();

        address hook = IToshFactoryRegistry(f).tokenToHook(token);
        if (hook == address(0)) revert TokenNotLaunchedHere();

        // The pool must actually exist before it can be listed, or the first
        // buyback to reach this token would swap against nothing.
        //
        // This used to ride on the shape of the key: the hook stored it at
        // launch, so an unlaunched hook returned a zero key and failed the
        // `currency1` arm below.  The hook now restates its key from constants
        // and `projectToken` instead of storing it — cheaper, but well-formed
        // from the moment the token is set, which is before launch.  The
        // liveness check is asked for directly rather than inferred from a
        // side effect that no longer happens.
        if (!IToshHookPoolKey(hook).launched()) revert PoolNotLaunched();

        // The rule in the box above, enforced rather than written down.
        //
        // `_buybackSqrtFloor` reaches "unbounded" by two doors eight lines
        // apart — a zero reading and a revert — so a gate closing only one
        // would be decoration. Both are refused, and refusing on a revert is
        // the fail-closed direction on purpose: a hook that will not answer
        // cannot be shown to have a bound, and "cannot be shown" is the same
        // listing decision as "does not have".
        //
        // Asked of the hook just proven to be this token's, so it cannot be
        // pointed at some other pool's mature TWAP.
        //
        // And asked AFTER the `launched()` check above, which is load bearing
        // rather than tidy.  An unlaunched hook does not report 0 here: it has
        // no initialised `_prevCheckpointTs`, so `span` is the whole unix epoch,
        // `_twapSqrtPriceX96` takes its "flat for a full window" branch, and it
        // answers `getSqrtPriceAtTick(0)` — 2**96, non-zero, and meaningless.
        // Measured on 0xF40B2F1Dfb4fE4549F8812A4914FCA9a27Da7eEE, an abandoned
        // launch.  This check alone would wave that through; `PoolNotLaunched`
        // is what stops it, so the two are a pair and must stay in this order.
        //
        // Nothing is given up by refusing. The reservoir is not spent on an
        // unlisted token and the window closes on the clock alone, so the cost
        // is a wait of at most `TWAP_WINDOW`. That is the trade
        // `SECURITY_AUDIT.md` §2.3 priced when it chose the operational rule,
        // and the same one it called weaker than "the one-line code change that
        // would make it unreachable" while inviting an auditor to challenge it.
        // Nobody challenged it; publishing the repository on 2026-09-11 did.
        // `alerts.json` is public now, so STATE-07's `check` field names the
        // quantity to poll and its `why` field prices the prize — which makes a
        // procedural control resting on one key the wrong half of that trade to
        // keep.
        //
        // STATE-07 stays. This makes the state unreachable through the only
        // door leading to it; the alert is what notices if that is ever untrue
        // for a reason neither of us has thought of.
        try IToshHookTwap(hook).twapSqrtPriceX96() returns (uint160 twapSqrt) {
            if (twapSqrt == 0) revert TwapNotMature();
        } catch {
            revert TwapNotMature();
        }

        PoolKey memory key = IToshHookPoolKey(hook).getPoolKey();

        // The quote asset must be currency0 and `token` must be currency1,
        // otherwise the hard-wired `zeroForOne = true` buy direction in
        // `_buyAndBurn` would swap the wrong way round.
        //
        // THIS CHECK CARRIES MORE WEIGHT THAN IT USED TO. `isNative()` was a
        // property of the key — `address(0)` cannot be anything but currency0,
        // because no address sorts below it — so the old check could only fail
        // if the hook returned a key for the wrong pool entirely. An ERC20 quote
        // asset has no such guarantee: roughly two thirds of random addresses
        // sort above BEM and one third below, and a token in the latter group
        // would produce a pool with the token as currency0 and BEM as
        // currency1. `_buyAndBurn` would then spend the PROJECT TOKEN to buy
        // BEM — burning the reservoir's ammunition to acquire what it already
        // holds, once per cycle, permanently.
        //
        // The factory prevents such a token existing by grinding CREATE2 salts
        // until the address clears `quoteAsset` (`ToshCloneLib.deployBareCloneAbove`).
        // This is the independent confirmation at the listing gate: it fails
        // closed on a token from an older factory, a mis-ground salt, or a hook
        // whose quote asset is not this treasury's.
        if (Currency.unwrap(key.currency0) != address(quoteAsset)) revert InvalidPoolKey();
        if (Currency.unwrap(key.currency1) != token) revert InvalidPoolKey();
        if (address(key.hooks) != hook) revert InvalidPoolKey();

        _poolKeyOf[token] = key;

        ladderTokens.push(token);
        _indexPlusOne[token] = ladderTokens.length;

        emit LadderTokenAdded(token, ladderTokens.length - 1);
    }

    /// @notice Delist `token`, keeping `ladderTokens` compact via swap-and-pop.
    /// @dev    Swap-and-pop reorders the array, which perturbs the round-robin
    ///         sequence.  That is acceptable: the cursor only needs to be
    ///         in-range and eventually fair, not stable across delistings.
    function removeLadderToken(address token) external onlyOwner {
        uint256 idxPlusOne = _indexPlusOne[token];
        if (idxPlusOne == 0) revert TokenNotListed();

        uint256 idx = idxPlusOne - 1;
        uint256 lastIdx = ladderTokens.length - 1;

        if (idx != lastIdx) {
            address moved = ladderTokens[lastIdx];
            ladderTokens[idx] = moved;
            _indexPlusOne[moved] = idx + 1;
        }

        ladderTokens.pop();
        delete _indexPlusOne[token];
        delete _poolKeyOf[token];

        // Keep the cursor inside the (now shorter) array.
        uint256 len = ladderTokens.length;
        currentCursor = len == 0 ? 0 : currentCursor % len;

        emit LadderTokenRemoved(token, idx);
    }

    // ─── Piggyback buyback ────────────────────────────────────────────────────

    /// @notice Poke the buyback engine.  Called by every Tosh hook from
    ///         `afterSwap`; a no-op unless the reservoir has crossed
    ///         `TRIGGER_STEP`.
    ///
    /// @dev    This function must NEVER revert on a "not ready" condition — it
    ///         sits in the hot path of ordinary user swaps, and a revert here
    ///         would make the pool untradeable.  Every precondition therefore
    ///         returns early instead of reverting, and each buy leg is
    ///         individually fault-isolated behind `try/catch`.
    function autoPiggybackBuyback() external onlyHook {
        // Must be inside someone's unlock frame to touch swap/settle/take.  A
        // hook only ever calls this from `afterSwap`, so it always is — the
        // check is here because this is the one entry point whose caller we do
        // not control the surroundings of.
        // V4 answered this with `poolManager.isUnlocked()`. Infinity's Vault
        // holds the lock and names its holder instead, and a zero locker is
        // the same statement: nobody is inside a lock, so there is no swap for
        // the buyback to ride and settling against the Vault would revert.
        if (vault.getLocker() == address(0)) return;

        _runPiggyback();
    }

    /// @notice Deploy the reservoir without riding a swap.  Permissionless.
    ///
    /// @dev    The backstop for the gas gate in `ToshLaunchpadHook.afterSwap`.
    ///         A hook now skips the poke when the triggering trade cannot afford
    ///         it, which is what stops that trade from reverting — but it also
    ///         means the reservoir can no longer count on being deployed by
    ///         trading alone.  Before this existed there was no other path:
    ///         `autoPiggybackBuyback` is `onlyHook` and `executeBuyAndBurn` is
    ///         `onlySelf`, so a market where every trade ran a tight gas limit
    ///         would have stalled the buyback indefinitely with no recourse.
    ///
    ///         Open to anyone on purpose.  It moves no ETH to the caller and
    ///         chooses nothing: the venue comes from the hook, the size from the
    ///         reservoir balance, the order from the round-robin cursor, and the
    ///         price is bounded by the same TWAP floor as every other leg.  The
    ///         most a caller can do is decide WHEN, and the cursor makes that
    ///         uninteresting.  Gating it on the owner would reintroduce the
    ///         liveness dependency this removes.
    ///
    ///         Reverts rather than returning quietly when unarmed, because
    ///         unlike the hook path this is nobody's hot path and a caller
    ///         deserves to know the call did nothing.
    function pokeBuyback() external {
        if (piggybackActive()) revert PiggybackInProgress();
        if (_nextSpendAmount() == 0) revert NotArmed();
        if (ladderTokens.length == 0) revert NotArmed();

        // Opens our own frame, since there is no swap to borrow one from.
        vault.lock("");
    }

    /// @dev The Vault calls this back only on the address that called `lock`, so
    ///      reaching here means `pokeBuyback` above put us here.
    ///
    ///      Guarded against the VAULT, not the pool manager. Infinity moved the
    ///      frame — `lock` is the Vault's — so checking the manager here rejects
    ///      the only caller that can legitimately arrive.
    function lockAcquired(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(vault)) revert OnlyVault();
        _runPiggyback();
        return "";
    }

    /// @dev One cycle of the round-robin buyback.  Shared by the swap-borne poke
    ///      and the standalone one.
    ///
    ///      Never reverts on a "not ready" condition: the hook path sits in the
    ///      hot path of ordinary user swaps, so every precondition returns early
    ///      instead, and each leg is individually fault-isolated.
    function _runPiggyback() internal {
        // Already inside a piggyback (a nested Tosh pool poked us) — stay passive.
        if (piggybackActive()) return;

        uint256 spend = _nextSpendAmount();
        if (spend == 0) return;

        uint256 total = ladderTokens.length;
        if (total == 0) return;

        // Legs per poke and the spend divisor are separate numbers; see both
        // constants.  `count` is only clamped by the ladder length so a
        // one-token ladder does not index past the end.
        uint256 count = total < LEGS_PER_POKE ? total : LEGS_PER_POKE;

        // Divided by BATCH_SIZE rather than by `count`, so a short ladder
        // spends proportionally less instead of concentrating the same cheque
        // into fewer pools.  With `total >= BATCH_SIZE` — the steady state —
        // each pool gets a third of the cycle; the difference only shows up on
        // a list the owner has narrowed, which is exactly the case worth
        // throttling.
        uint256 perToken = spend / BATCH_SIZE;
        if (perToken == 0) return;

        _setPiggyback(true);

        uint256 cursor = currentCursor;
        for (uint256 i; i < count; ++i) {
            address token = ladderTokens[(cursor + i) % total];

            // Fault isolation: an illiquid, paused, or otherwise hostile ladder
            // pool must not brick the innocent trader's swap.  The self-call is
            // external, so a revert rolls back that leg's V4 deltas entirely
            // and leaves its ETH in the reservoir for the next cycle.
            try this.executeBuyAndBurn(token, perToken) {}
            catch {
                emit BuybackSkipped(token, perToken);
            }
        }

        currentCursor = (cursor + count) % total;

        _setPiggyback(false);

        emit PiggybackExecuted(perToken * count, count, currentCursor);
    }

    /// @notice Single buyback leg.  External ONLY so that `autoPiggybackBuyback`
    ///         can wrap it in `try/catch` for per-token fault isolation; it is
    ///         not reachable by anyone other than this contract.
    function executeBuyAndBurn(address token, uint256 nativeIn) external onlySelf {
        _buyAndBurn(token, nativeIn);
    }

    /// @dev Market-buy `token` with `nativeIn` wei through V4 and send 100 % of the
    ///      proceeds to `DEAD_ADDRESS`.
    ///
    ///      Runs inside the caller's existing unlock frame, so the sequence is
    ///      the bare V4 flash-accounting triad:
    ///        swap  → our delta becomes (-nativeIn on currency0, +out on currency1)
    ///        settle→ pay the ETH we owe
    ///        take  → collect the tokens straight into 0xdead
    ///
    ///      The swap is bounded by a TWAP-anchored price floor.  An earlier
    ///      revision passed `MIN_SQRT_PRICE + 1` — no bound at all — reasoning
    ///      that a burned output has no victim.  That misses who pays: a
    ///      sandwicher can buy ahead of the poke, let this leg fill against the
    ///      inflated price, and sell back into the support it just provided.
    ///      Nothing is stolen from a user, but the reservoir's ETH buys fewer
    ///      tokens to burn and the difference lands in the attacker's pocket,
    ///      so the deflation the tax was collected to deliver is skimmed.
    function _buyAndBurn(address token, uint256 nativeIn) internal {
        PoolKey memory key = _poolKeyOf[token];

        BalanceDelta delta = poolManager.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: true, // ETH (currency0) → token (currency1)
                amountSpecified: -int256(nativeIn), // negative == exact input
                sqrtPriceLimitX96: _buybackSqrtFloor(key)
            }),
            ""
        );

        // Settle exactly what the pool consumed, never the amount offered.  A
        // binding floor fills only part of `nativeIn`, and paying the full amount
        // would leave this contract holding an unclaimed credit — which fails
        // the unlock frame's all-deltas-zero check and reverts the whole swap
        // for the innocent trader who happened to trigger us.  Whatever goes
        // unspent simply stays in the reservoir for the next cycle.
        int128 owed = delta.amount0();
        uint256 spent = owed < 0 ? uint256(uint128(-owed)) : 0;
        if (spent > 0) {
            // Infinity's ERC-20 settle is three steps, and the ORDER IS THE
            // PROTOCOL: `sync` latches the currency and snapshots the Vault's
            // balance of it, the transfer moves the tokens in, and `settle`
            // credits us the difference the Vault now measures. Transferring
            // before the sync credits nothing — the snapshot would already
            // include our tokens — and the swap would revert on a non-zero
            // delta, taking the innocent trader's transaction with it.
            //
            // The clobbering hazard the native path carried is unchanged in
            // kind: `sync` overwrites whatever currency an outer frame had
            // latched, with no way to read it back or restore it. What changed
            // is that it is no longer avoidable in principle. Under native
            // settlement `settle{value:}` at least described its own amount, so
            // omitting the sync only mis-attributed it; here the amount IS the
            // synced balance delta, so there is no settling without syncing.
            //
            // Safe for the canonical pattern, where a caller syncs immediately
            // before the transfer it pairs with and therefore after any swap
            // that could poke us. Still corrupts a caller who syncs, then swaps,
            // then settles.
            vault.sync(key.currency0);
            SafeERC20.safeTransfer(quoteAsset, address(vault), spent);
            vault.settle();
        }

        int128 out = delta.amount1();
        if (out > 0) {
            uint256 bought = uint256(uint128(out));
            vault.take(key.currency1, DEAD_ADDRESS, bought);
            emit BuybackBurned(token, spent, bought);
        }
    }

    /// @dev Lower bound on the sqrt price this buyback may push the pool to.
    ///
    ///      Anchored to the hook's TWAP rather than to slot0: spot is the very
    ///      quantity a sandwicher displaces, so a spot-relative bound would
    ///      move with the attack and constrain nothing.  Against the TWAP, a
    ///      front-run that stretches the price past the bound makes this leg
    ///      fill partially or revert into `BuybackSkipped`, leaving the
    ///      attacker holding an inventory they bought with no exit.
    ///
    ///      Two fallbacks return unbounded, and they are NOT justified by the
    ///      same argument.  Conflating them is how the weaker one survived
    ///      review, so they are stated apart:
    ///
    ///        • `catch` — the hook does not answer at all.  Refusing here would
    ///          stall the reservoir PERMANENTLY on any pool whose hook predates
    ///          this interface, with no clock to rescue it.  Unbounded is the
    ///          lesser failure.
    ///
    ///        • `twapSqrt == 0` — the hook answers "no TWAP yet", which is true
    ///          only for the first `TWAP_WINDOW` after `launch()`.  The
    ///          permanent-stall argument does NOT carry over: this state is
    ///          one-shot, closes on the clock without needing a swap, and
    ///          refusing would cost a deferral of at most 30 minutes through
    ///          the `BuybackSkipped` path that already exists.  What it buys
    ///          instead is the absence of any anti-sandwich bound during the
    ///          window, measured at 0.93 ETH per leg and repeatable per block
    ///          via `pokeBuyback` — see
    ///          `test_probeG3_immatureTwapIsRefusedAtListing`.
    ///
    ///      The second branch WAS a known cost held closed off chain by not
    ///      listing a token until its TWAP matures.  Since 2026-09-11 it is
    ///      held closed here in code: `addLadderToken` reads this same getter
    ///      and refuses a pool that answers 0 or reverts, so a listed token has
    ///      cleared the window by construction and this branch is not reachable
    ///      through the listing door.
    ///
    ///      Read that as narrower than it sounds.  The gate fires ONCE, when the
    ///      token is listed; this function runs on every leg thereafter.  A
    ///      listed token whose getter later starts reverting still lands in the
    ///      `catch` below and still buys unbounded, which is why `STATE-07` in
    ///      `monitoring/alerts.json` polls both doors on every pass and is not
    ///      retired by the gate.  The assessment is that a getter which answered
    ///      once cannot stop answering on chain — `nowTs - _prevCheckpointTs`
    ///      cannot underflow where time only moves forward — and `SECURITY.md`
    ///      pre-discloses that assessment rather than burying it here.
    ///
    ///      This used to end by noting that the live treasury predated the gate
    ///      and could never receive it — `ladderTreasury` is `immutable` in
    ///      `ToshFactory` and is baked into the hook implementation every launch
    ///      clones, so the gate could only ever arrive with a new platform.  It
    ///      arrived on 2026-09-12, when the platform was redeployed for an
    ///      unrelated reason; the live treasury is now
    ///      0x255722226720914eF5B2CD54647f21f584BD4Ea2 and carries it.  The
    ///      sentence is kept in this shape because it still governs the old
    ///      treasury at 0x99aD248dD15498957B864Fd79917F0E103Aa78F7, and because
    ///      it is the reason a future redeploy must not quietly drop the gate:
    ///      there would be no second chance to add it.
    ///
    ///      Note the `twapSqrt == 0` early return is arithmetically redundant —
    ///      delete it and `floor` computes to 0 and the ternary picks
    ///      `unbounded` anyway.  It is kept because it is the only place the
    ///      branch can be NAMED, and an unnamed branch cannot carry this note.
    function _buybackSqrtFloor(PoolKey memory key) internal view returns (uint160) {
        uint160 unbounded = TickMath.MIN_SQRT_RATIO + 1;

        try IToshHookTwap(address(key.hooks)).twapSqrtPriceX96() returns (uint160 twapSqrt) {
            if (twapSqrt == 0) return unbounded;
            uint256 floor = (uint256(twapSqrt) * (BPS_DENOMINATOR - MAX_BUYBACK_SQRT_DEVIATION_BPS)) / BPS_DENOMINATOR;
            return floor > unbounded ? uint160(floor) : unbounded;
        } catch {
            return unbounded;
        }
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice True while a piggyback cycle is mid-flight.  Tosh hooks consult
    ///         this to suppress their dark tax and their own piggyback poke,
    ///         preventing cross-hook recursion.
    function piggybackActive() public view returns (bool active) {
        assembly ("memory-safe") {
            active := tload(_PIGGYBACK_SLOT)
        }
    }

    function ladderTokenCount() external view returns (uint256) {
        return ladderTokens.length;
    }

    function isLadderToken(address token) external view returns (bool) {
        return _indexPlusOne[token] != 0;
    }

    function getPoolKey(address token) external view returns (PoolKey memory) {
        return _poolKeyOf[token];
    }

    /// @notice Quote asset still needed before the next piggyback arms.
    function untilNextTrigger() external view returns (uint256) {
        uint256 bal = reservoir();
        return bal >= TRIGGER_STEP ? 0 : TRIGGER_STEP - bal;
    }

    /// @notice Quote asset the next piggyback cycle will spend, or 0 if unarmed.
    function nextSpendAmount() external view returns (uint256) {
        return _nextSpendAmount();
    }

    // ─── Internals ────────────────────────────────────────────────────────────

    /// @dev `max(TRIGGER_STEP, balance × SPEND_BPS / 10_000)`, or 0 below the
    ///      arming threshold.  Capped at the live balance so a rounding edge
    ///      can never try to spend more than the pot holds.
    ///
    ///      `virtual` exists for exactly one reason and it is worth naming, so
    ///      that nobody deletes it as decoration or takes it as an invitation.
    ///      `TRIGGER_STEP` is a 1 ETH `constant` with no setter, which means the
    ///      piggyback branch cannot be reached on any chain where a tester
    ///      cannot assemble 1 ETH — testnets, in other words. That branch is
    ///      also the only consumer of `PIGGYBACK_MIN_GAS` and
    ///      `PIGGYBACK_TAIL_RESERVE` in `ToshLaunchpadHook`, two gas budgets
    ///      measured against Ethereum's accounting and deployed to an ArbOS
    ///      chain that does not share it. Unreachable code carrying unverified
    ///      constants is how a feature ships dead: the gate is `>=`, so a budget
    ///      set too high retires the buyback silently, and a skipped poke
    ///      deliberately emits nothing.
    ///
    ///      This seam lets `test/probe/PiggybackGasProbe.sol` deploy the real
    ///      contract with a reachable threshold and measure the real path on the
    ///      real chain. `ToshV5Guards.t.sol::test_nextSpendAmountIsNotOverridden`
    ///      asserts production still uses this implementation, and the runtime
    ///      bytecode is byte-identical with and without the keyword — verified,
    ///      not assumed. See `docs/ROBINHOOD_MIGRATION.md` §F.7.
    function _nextSpendAmount() internal view virtual returns (uint256 spend) {
        uint256 bal = reservoir();
        if (bal < TRIGGER_STEP) return 0;
        spend = (bal * SPEND_BPS) / BPS_DENOMINATOR;
        if (spend < TRIGGER_STEP) spend = TRIGGER_STEP;
        if (spend > bal) spend = bal;
    }

    function _setPiggyback(bool value) private {
        assembly ("memory-safe") {
            tstore(_PIGGYBACK_SLOT, value)
        }
    }
}

/// @dev Minimal factory view used to authenticate piggyback callers and to
///      prove a candidate ladder token's provenance, kept thin to avoid a
///      circular import with ToshFactory.
interface IToshFactoryRegistry {
    function registeredHooks(address hook) external view returns (bool);
    function tokenToHook(address token) external view returns (address);
}

/// @dev Minimal hook view used to read back the canonical pool a launched token
///      trades in, so the buyback venue is never caller-supplied.
interface IToshHookPoolKey {
    function getPoolKey() external view returns (PoolKey memory);
    function launched() external view returns (bool);
}

/// @dev Minimal hook view exposing the manipulation-resistant price reference a
///      buyback bounds itself against.
interface IToshHookTwap {
    function twapSqrtPriceX96() external view returns (uint160);
}
