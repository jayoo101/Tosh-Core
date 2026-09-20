// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ECDSA} from "../lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "../lib/openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable2Step} from "../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "../lib/openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ToshToken} from "./ToshToken.sol";
import {ToshLaunchpadHook} from "./ToshLaunchpadHook.sol";
import {HookAddress} from "./libraries/HookAddress.sol";
import {HookDeployLib} from "./libraries/HookDeployLib.sol";
import {ToshCloneLib} from "./libraries/ToshCloneLib.sol";

/// @title  ToshFactory v5.0 — ETH-native launchpad with a global referral graph
/// @notice Platform singleton: deploys launches, guards genesis eligibility, and
///         owns the platform-wide lifetime referral registry.
///
/// ── What changed in v5.0 ────────────────────────────────────────────────────
///
///   1. 100 % ETH-NATIVE.  Launch fees and genesis deposits are native ETH.
///      SATO has no protocol role whatsoever — it is simply one of the tokens
///      launched on this platform, and the factory no longer even stores its
///      address.
///
///   2. TWO REFERRAL REGISTRIES, ONE LINK.  A deposit resolves two referrers
///      and the hook pays them different rates out of the same 10 % carve.
///
///        `globalReferrers[user]`         bound ONCE per wallet, platform-wide
///                                        and permanently, on that wallet's
///                                        first genesis deposit → 2 %
///        `projectReferrers[user][hook]`  bound once per wallet PER PROJECT
///                                        → 8 %
///
///      `deposit` takes ONE referrer argument and offers it to both registries,
///      each of which accepts only if its own slot is still empty.  So a
///      first-time depositor's link fills both slots and that referrer earns
///      the whole 10 %, while a returning depositor arriving on someone else's
///      link leaves the lifetime slot alone and hands the new sharer the 8 %.
///      One link, no project-specific link format, no way for a sharer to pick
///      which slot they are claiming.
///
///      Both bindings are immutable once written: passing a different referrer
///      later is silently ignored rather than reverting, so a stale referral
///      link in a shared URL can never brick a deposit.
///
///   3. Launch fees are forwarded to `ladderTreasury`, becoming buyback fuel
///      instead of platform profit.
contract ToshFactory is Ownable2Step, Pausable, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant MAX_SIG_VALIDITY = 24 hours;
    uint256 public constant MAX_COOLDOWN = 7 days;

    /// @dev One whole unit of the quote asset. BEM has 8 decimals, so this is
    ///      1e8 and not 1e18, and `ether` must not appear anywhere near these
    ///      dials any more.
    ///
    ///      Spelled out as its own constant because the literals below read as
    ///      plausible numbers either way: `928.4e8` and `928.4 ether` are both
    ///      well-formed Solidity and differ by ten orders of magnitude, with
    ///      nothing in the syntax to suggest which was meant. Writing
    ///      `928.4 * QUOTE_UNIT` makes the unit part of the expression.
    uint256 public constant QUOTE_UNIT = 1e8;

    /// @notice Ceiling on `launchFee`, denominated in **native BNB wei**.
    ///
    /// @dev    `setLaunchFee` was the one setter on this contract with no
    ///         validation of any kind — no floor, no ceiling, no zero-check —
    ///         while both duration setters are capped at `MAX_COOLDOWN` and
    ///         `setDefaultSoftCap` is floored at `MIN_SOFT_CAP_PROD`.
    ///
    ///         The failure it admits is not an exploit, it is an accident with
    ///         no undo short of a second owner transaction: the difference
    ///         between `0.005 ether` and `5 ether` is one keystroke in a Safe
    ///         transaction builder. Above the ceiling `createLaunch` becomes
    ///         unaffordable for everyone, which is a platform-wide outage
    ///         produced by a typo rather than by an attacker.
    ///
    ///         Deliberately generous — 100x the 0.005 BNB default — because this
    ///         guards against an order-of-magnitude slip, not against pricing
    ///         judgement.  Zero stays legal: a fee-free platform is a policy
    ///         choice, and `test_setLaunchFee_allowsZero` pins it.
    ///
    ///         ⚠ THE UNIT-CONFUSION ARGUMENT NOW CUTS THE OTHER WAY, and that is
    ///           why `ether` is spelled here while `QUOTE_UNIT` guards the dials
    ///           below. The fee is the one figure on this contract denominated
    ///           in the chain's own coin rather than in the quote asset, so
    ///           `0.005 * QUOTE_UNIT` — the shape every neighbouring constant
    ///           takes — would be the mistake here. The two unit systems now
    ///           coexist on one contract deliberately: see `launchFee`.
    uint256 public constant MAX_LAUNCH_FEE = 0.5 ether;

    /// @notice Ceilings on the two other quote-denominated dials, in base units.
    ///
    /// @dev    Same failure mode as `MAX_LAUNCH_FEE` — a base-unit field typed
    ///         into a Safe transaction builder — and looser, because a raise or a
    ///         wallet cap has no comfortable range the way a launch fee does.
    ///         They guard **unit confusion**: `928.4 ether` where
    ///         `928.4 * QUOTE_UNIT` was meant is a factor of 1e10.
    ///
    ///         THESE WERE CUT FROM 1,000,000 TO 20,000 AND THAT IS NOT A
    ///         RESCALING. Under a native quote asset, 1 M units was chosen to be
    ///         so far above any conceivable raise that it could only ever catch a
    ///         typo — it was well under 1% of BNB's supply. BEM's entire supply is
    ///         191,739.22 BEM (19,173,922,124,972 base units, measured on 56).
    ///         A 1 M ceiling would therefore have sat five times ABOVE the total
    ///         number of tokens in existence, which is not a loose bound, it is
    ///         no bound: every value it admits includes values that cannot be
    ///         raised because the units do not exist.
    ///
    ///         20,000 BEM is ~10.4% of supply — still far above any raise this
    ///         platform could fill, still 1e10 clear of the `ether` slip, and now
    ///         actually a statement about reachable amounts.
    ///
    ///         ⚠ NEITHER CEILING IS A LIQUIDITY CHECK, and with BEM the gap
    ///           between "exists" and "obtainable" is where the real risk lives.
    ///           BEM's only pool of consequence held 1,959 BEM when last
    ///           measured, so even the 928.4 BEM DEFAULT soft cap asks for
    ///           roughly half the float. A cap under this ceiling says nothing
    ///           about whether depositors can buy the tokens to fill it. See
    ///           docs/BEM_QUOTE_ASSET.md §1.2.
    ///
    ///         A `maxPogAllocationLimit` under this ceiling is likewise **not**
    ///         evidence that PoG still limits whales: once the per-wallet cap
    ///         reaches the soft cap a single wallet can fill an entire genesis
    ///         round, and no constant can enforce that ratio, because
    ///         `defaultSoftCap` moves independently and coupling the two would
    ///         make the outcome depend on which setter the owner happened to call
    ///         first.  That sizing is a policy judgement and stays one.
    uint256 public constant MAX_DEFAULT_SOFT_CAP = 20_000e8;

    /// @dev    See `MAX_DEFAULT_SOFT_CAP`; identical reasoning, kept as its own
    ///         constant so the two can diverge without a migration.
    uint256 public constant MAX_POG_ALLOCATION_LIMIT = 20_000e8;

    /// @notice Minimum acceptable `defaultSoftCap`, in quote-asset base units.
    ///
    /// @dev    Guards two cliffs, and the one this comment used to name alone is
    ///         not the binding one.
    ///
    ///         The obvious cliff is `p0 = 0`.  The hook derives
    ///         `p0 = (lpQuote * 1e18) / GENESIS_LP_SUPPLY` with
    ///         `GENESIS_LP_SUPPLY = 3.78e24`, so `p0` truncates to zero once
    ///         `lpQuote < 3_780_000` base units — which would collapse the entire
    ///         tier ladder to a free-mint zone.  This cliff does have a backstop:
    ///         the hook's `launch()` asserts `p0 > 0`.
    ///
    ///         The binding cliff is ladder *flattening*, and it sits far above
    ///         the first.  Shelves are geometric —
    ///         `price(i) = shelfP0 · 1.001902508^i` — so monotonicity needs the
    ///         first step to survive truncation: `shelfP0 · 0.0019025 ≥ 1`, i.e.
    ///         `shelfP0 ≥ 526`, which needs a raise of 21.042 quote units.
    ///
    ///         ⚠ THIS CONSTANT IS NOT WHAT DEFENDS THAT CLIFF, whatever this
    ///           comment used to claim. It floors the CAP, and the cap gates
    ///           nothing: `launch()` opens on any non-zero raise and
    ///           `canRefund()` reads only the clock, so a raise far below its cap
    ///           is the ordinary case rather than an error. A floor on the cap
    ///           therefore says nothing about the quantity the cliff depends on.
    ///
    ///           The real guard is `ToshLaunchpadHook.launch()`, which now
    ///           refuses a raise whose shelf 0 -> 1 step truncates to zero
    ///           (`RaiseTooSmallForLadder`). Read that comment for the window
    ///           this constant was believed to be covering and was not.
    ///
    ///         What this constant still does is worth keeping: it stops an owner
    ///         advertising a cap so small that no raise under it could open a
    ///         pool, which would be a launch that fails at `launch()` after
    ///         taking deposits rather than at `createLaunch`.
    ///
    ///         ⚠ THE MARGIN OVER THAT CLIFF IS NOW 4.75x, DOWN FROM 16.6 MILLION,
    ///           and that collapse is the whole reason this constant was retuned.
    ///
    ///           Both cliffs are pure base-unit arithmetic — they know nothing
    ///           about what a unit is worth, only how many of them arrive. The
    ///           native quote asset had 18 decimals, so a 35-unit soft cap
    ///           delivered `lpQuote = 3.15e19` and `shelfP0 = 8,749,999,999`:
    ///           16.6 million times the break-even, a margin so wide it could be
    ///           treated as infinite. BEM has 8 decimals. The SAME NUMBER OF
    ///           TOKENS now arrives as 1e10 fewer base units, so the entire
    ///           margin has to be bought back out of the token count.
    ///
    ///           At this floor: `lpQuote = 9e9` (100 BEM less the 10% commission
    ///           carve), `p0 = 2380`, `shelfP0 = 2499`, first step 4 units.
    ///           2499 / 526 = 4.75.
    ///
    ///           What that costs in practice: raises below ~21 BEM cannot produce
    ///           a monotone ladder AT ALL, so the floor is no longer a formality
    ///           that only testnet dust could hit — it is close enough to the
    ///           cliff that `testFuzz_tierPriceAt_strictlyMonotone` is now a
    ///           load-bearing test rather than a sanity check, and lowering this
    ///           value is a change to ladder correctness rather than to policy.
    ///           Do not treat 100 as round-number caution.
    ///
    ///         `p0` scales linearly with the cap, so raising the floor only ever
    ///         widens the margin. Pinned by
    ///         `test_setDefaultSoftCap_rejectsBelowFloor` and
    ///         `testFuzz_tierPriceAt_strictlyMonotone`; derived in
    ///         `docs/SECURITY_AUDIT.md` §5.11 and docs/BEM_QUOTE_ASSET.md §2.1.
    uint256 public constant MIN_SOFT_CAP_PROD = 100e8;

    // ─── Immutables ───────────────────────────────────────────────────────────

    /// @dev v5.0 dropped the `satoToken` immutable entirely.  SATO is an
    ///      ordinary launch on this platform with no protocol-level privileges,
    ///      so pinning its address here only implied a special status the
    ///      contract never actually honoured.

    address public immutable poolManager;

    /// @notice PancakeSwap Infinity Vault: balances and the lock. Held beside
    ///         the manager because Infinity needs both, and passed on to every
    ///         hook implementation this factory deploys.
    address public immutable vault;

    /// @notice Platform buyback reservoir; receives every launch fee.
    address payable public immutable ladderTreasury;

    /// @notice The ERC20 launch fees and genesis deposits are paid in, and
    ///         `currency0` of every project pool.
    ///
    /// @dev    Same value the hook implementation holds, from the same
    ///         constructor argument — see the note in the constructor for why
    ///         the two cannot disagree and no cross-check is warranted.
    ///
    ///         Held here as well as on the hook because this contract is the
    ///         one that pulls: `createLaunch` collects `launchFee` and
    ///         `deposit` collects the depositor's stake, both by
    ///         `transferFrom`, and both need the token without an extra hop.
    ///
    ///         ALSO THE FLOOR EVERY PROJECT TOKEN ADDRESS MUST CLEAR.
    ///         `currency0` is the lower of the two addresses, so keeping the
    ///         quote asset on that side means every token must sort above it.
    ///         `createLaunch` enforces that against this value.
    IERC20 public immutable quoteAsset;

    bytes32 public immutable HOOK_CREATION_CODEHASH;

    /// @notice The single shared `ToshLaunchpadHook` implementation that every
    ///         project's hook clone delegates to.
    ///
    /// @dev    Deployed once, from this factory's constructor, so the pair is
    ///         wired up structurally rather than by deploy-script convention.
    ///         Immutable: there is no setter, which means the platform owner
    ///         cannot repoint future launches at different logic, and no
    ///         existing clone could be repointed even if they could — a clone
    ///         hard-codes this address in its own runtime bytecode.
    address public immutable hookImplementation;

    /// @notice The single shared `ToshToken` implementation that every project's
    ///         token clone delegates to.
    ///
    /// @dev    Same reasoning as `hookImplementation`, and the same absence of a
    ///         setter.  Deployed here rather than through a library because the
    ///         token's creation code is ~3.5 KB and the factory has the margin
    ///         for it — the hook's 19.5 KB is what needed isolating.
    address public immutable tokenImplementation;

    // ─── Owner-controlled state ───────────────────────────────────────────────

    address public pogSigner;

    /// @notice Legacy platform fee destination.
    ///
    /// @notice Receives the platform's 0.30 % maintenance cut of every buy's
    ///         ETH input, and nothing else.
    ///
    /// @dev    ON A MONEY PATH AGAIN, AND IMMUTABLE BECAUSE OF IT.
    ///
    ///         The history is worth knowing, because this field has been all
    ///         three things.  In v4.x it collected the launch fee and the
    ///         Phase-2 platform cut, and it was mutable — which was audit
    ///         finding M-2, since the owner could retarget live fee routing.
    ///         v5.0 moved 100 % of platform revenue to `ladderTreasury` to be
    ///         burned rather than banked, which closed M-2 by leaving this
    ///         address with no inflow at all; for a while it survived only as
    ///         the sentinel filler in `getLiveHookInitcodeHash`, documented as
    ///         metadata rather than a lever.
    ///
    ///         It now carries `ToshLaunchpadHook.PLATFORM_SWAP_FEE_BPS`.  That
    ///         reopens exactly the surface M-2 described, so the mutability
    ///         went instead of the inflow: this is `immutable` and
    ///         `setPlatformTreasury` is gone.  Rotating the payout address
    ///         means deploying a new factory.
    ///
    ///         Being immutable here is also what keeps this field HONEST.  The
    ///         hook implementation bakes the same address in as its own
    ///         `platformFeeRecipient` immutable at construction, so a mutable
    ///         field would have let the two diverge — an operator could rotate
    ///         this one, read it back changed, and still be paying the old
    ///         address on every swap.  One address, set once, in both places.
    ///
    ///         Everything else still routes to `ladderTreasury`: launch fees,
    ///         the Phase-2 shelf cut, orphaned referral commission, and the
    ///         70 bps reservoir share of the same buy-side tax.
    address public immutable platformTreasury;

    /// @notice Per-(wallet, hook) re-deposit throttle.  Orthogonal to the
    ///         PoG quota window — a wallet can be off cooldown and still
    ///         out of quota, or vice versa.  `0` disables the throttle.
    ///
    /// @dev    ⚠ AT 72 h THIS IS NO LONGER A THROTTLE, IT IS A ONE-DEPOSIT RULE,
    ///           and that is why the value moved from 24 h.
    ///
    ///         At 24 h it throttled without bounding: the PoG quota window is
    ///         also 24 h, so a wallet on a 72 h genesis got three refills and
    ///         three deposits into the same project, accumulating up to
    ///         `perWalletCap` in instalments its quota never justified in one
    ///         go. The quota refills; `nativeDeposited` does not reset. So the
    ///         two clocks agreeing was what let a small quota add up to a large
    ///         position.
    ///
    ///         At 72 h the second deposit is unreachable for every legal genesis,
    ///         and the proof is a one-liner rather than a margin:
    ///
    ///           first deposit at t1, necessarily t1 >= tCreate and
    ///           t1 < tCreate + D with D <= DURATION_SLOW = 72 h;
    ///           cooldown ends at t1 + 72 h >= tCreate + 72 h >= tCreate + D,
    ///           i.e. never before the genesis deadline the deposit must beat.
    ///
    ///         The worst case is tight, not comfortable: a 72 h genesis whose
    ///         first deposit lands in the creation block makes the two instants
    ///         EQUAL, and it still fails because `deposit` needs
    ///         `block.timestamp < genesisDeadline` strictly.
    ///
    ///         ⚠ ZERO MARGIN IS THE WHOLE RISK. This holds because
    ///           `cooldownDuration >= DURATION_SLOW`, and nothing structural ties
    ///           them — they are a dial on this contract and a constant on the
    ///           hook. Adding a fourth, longer genesis rung, or lowering this
    ///           dial, silently restores instalment deposits with no error
    ///           anywhere. `test_cooldown_isAtLeastTheLongestGenesis` is what
    ///           makes that a failing build instead of a discovery.
    ///
    ///         It is still a dial, so this is policy rather than an invariant:
    ///         the owner can set it back. Deliberate — the one-deposit rule is a
    ///         market decision, and making it structural would cost a redeploy to
    ///         revisit. `MONITOR_` coverage of the dial is the compensating
    ///         control.
    uint256 public cooldownDuration = 72 hours;

    /// @notice How long a wallet's PoG spend ledger lasts before it rolls
    ///         back to zero.  Independent of `cooldownDuration`.
    ///
    /// @dev    `0` is a deliberate semantic shift, not a "disabled" flag:
    ///         there is then nothing to anchor a window to, so `quotaSpent`
    ///         never resets and the quota degrades to a lifetime budget.
    ///         The two knobs used to be the same storage slot, which meant
    ///         turning off the deposit throttle also froze every wallet's
    ///         remaining allowance for life.  They are separate so a
    ///         platform can run a cool-off without a refill (or a refill
    ///         without a cool-off) without that coupling.
    uint256 public quotaWindowDuration = 24 hours;

    /// @notice Native BNB toll charged by `createLaunch`. Default: 0.005 BNB.
    ///
    /// @dev    ⚠ THIS IS THE ONE DIAL ON THIS CONTRACT NOT DENOMINATED IN THE
    ///           QUOTE ASSET. Everything else here — `defaultSoftCap`,
    ///           `maxPogAllocationLimit` — is BEM at 8 decimals and is written
    ///           `x * QUOTE_UNIT` so the unit cannot be misread. This is BNB at
    ///           18, written with `ether`. Two unit systems on one contract is
    ///           a hazard, and the spelling is the mitigation: if a literal here
    ///           ever acquires a `QUOTE_UNIT` it is wrong by ten orders of
    ///           magnitude, and if one below acquires an `ether` so is that.
    ///
    ///         It was 9.28 BEM before, and moving it back to the chain's own
    ///         coin is not a reversal of the BEM migration but a recognition of
    ///         what this particular payment is. The quote asset denominates
    ///         everything a project RAISES, prices and settles in, so a fee paid
    ///         in it made the creator acquire BEM before they could even deploy.
    ///         A launch toll is not part of the raise; it is the cost of using
    ///         the platform, and asking for it in the coin the creator already
    ///         holds for gas removes an approval and an acquisition from the
    ///         path to a first launch.
    ///
    ///         ⚠ IT ALSO STOPS BEING BUYBACK FUEL, AND THAT IS A REAL LOSS, JUST
    ///           A SMALL ONE. The fee used to be pulled to `ladderTreasury`,
    ///           whose whole outflow is buy-and-burn; it now goes to
    ///           `platformTreasury`. The reservoir cannot spend BNB — it settles
    ///           `quoteAsset` and `reservoir()` reads only that balance — so
    ///           routing BNB there would strand it permanently, and the treasury
    ///           has no `receive()` to accept it in the first place. What makes
    ///           this affordable is the price rather than the plumbing: at 0.005
    ///           BNB against a `TRIGGER_STEP` of 92.8 BEM (~3.5 BNB), roughly
    ///           700 launches arm one buyback, where 9.28 BEM was a tenth of a
    ///           step and ten launches did. The fee had already ceased to be
    ///           meaningful ammunition before it changed denomination.
    ///
    ///         Not pegged to anything. 0.005 BNB is 0.005 BNB until an owner
    ///         transaction says otherwise, which is the same property the BEM
    ///         figure had — one asset closer to what the creator already holds.
    uint256 public launchFee = 0.005 ether;

    /// @notice Per-wallet quote-asset cap. Serves double duty: it ceilings the PoG
    ///         `maxAlloc` an oracle attestation may grant, and it is
    ///         snapshotted into every NEW hook as that project's per-wallet
    ///         deposit limit.
    ///
    /// @dev    Only the snapshot is binding for a live round.  Retuning this
    ///         value governs projects created afterwards; rounds already
    ///         raising keep the cap they were deployed with, so the terms a
    ///         depositor committed under cannot be rewritten under them.
    ///
    ///         Kept in step with `DEFAULT_POG_MAX_ALLOC_WEI` in
    ///         `soat-frontend/src/app/lib/pogQuota.ts`, which seeds the
    ///         off-chain ceiling the oracle signs against.  This is the
    ///         binding half of that pair: an attestation above this value
    ///         reverts `ExceedsGlobalPogLimit`, so the off-chain dial may be
    ///         lowered freely and raised only after this one moves.
    ///
    ///         THE UNIT GAP BETWEEN THIS DIAL AND ITS INPUT IS NOW TWO HOPS, not
    ///         one, and it is the weakest link in the PoG chain.  `maxAlloc` is
    ///         BEM because a deposit is BEM; the gas history it is derived from is
    ///         ETH, because the chains scanned for it settle in ETH. So the
    ///         oracle's rate has to carry ETH → BNB → BEM.
    ///
    ///         The first hop is two deep, liquid markets. The second is BEM,
    ///         whose only pool of consequence held 1,959 BEM. A rate derived
    ///         through it is therefore as stable as that pool is deep, and an
    ///         allocation signed against a stale one is wrong in BEM terms the
    ///         moment anyone trades. `docs/BSC_MIGRATION.md` §6 argues the first
    ///         hop; docs/BEM_QUOTE_ASSET.md §2.7 is where the second is the
    ///         open problem.
    uint256 public maxPogAllocationLimit = 46.4e8;

    /// @notice Global default soft-cap baked into every NEW hook, in quote-asset
    ///         base units. Default: 928.4 BEM.
    ///
    /// @dev    ⚠ THIS DEFAULT ASKS FOR MORE BEM THAN THE MARKET CAN SUPPLY, and it
    ///           is left here as the arithmetic conversion of 35 BNB rather than
    ///           as a defensible target.
    ///
    ///           928.4 BEM is 0.48% of BEM's 191,739-token supply and roughly
    ///           HALF the 1,959 BEM sitting in its only pool of consequence. A
    ///           round at this cap cannot be filled by depositors buying BEM on
    ///           the open market; it can only be filled by holders who already
    ///           have it. The soft cap is not a gate — `launch()` opens on any
    ///           non-zero raise and `canRefund()` reads only the clock — so the
    ///           consequence is a progress bar that reads near-empty on a
    ///           perfectly healthy round, not a failed launch.
    ///
    ///           It is a dial, not a constant, and lowering it is a single owner
    ///           transaction floored at `MIN_SOFT_CAP_PROD` (100 BEM). Do that
    ///           before the first mainnet launch rather than shipping a default
    ///           that misrepresents every project using it.
    uint256 public defaultSoftCap = 928.4e8;

    // ─── Eligibility maps ─────────────────────────────────────────────────────

    mapping(address => uint256) public blacklistedUntil;
    mapping(address => mapping(address => uint256)) public userLaunchCooldownEnd;
    mapping(address => uint256) public pogQuota;
    mapping(address => uint256) public pogNonces;

    /// @notice Lifetime ETH a wallet has ever committed to genesis rounds.
    ///         Statistics only — no longer gates anything.
    mapping(address => uint256) public totalGenesisDeposited;

    /// @notice ETH spent against the PoG quota inside the CURRENT window.
    mapping(address => uint256) public quotaSpent;

    /// @notice When the caller's current quota window lapses and `quotaSpent`
    ///         rolls back to zero.
    ///
    /// @dev    The PoG quota is a cooling-off budget, not a lifetime one: a
    ///         wallet spends up to `pogQuota` per `quotaWindowDuration` window
    ///         and is then topped back up.  Refunds deliberately do NOT credit
    ///         the window back — withdrawing is meant to cost you your turn, or
    ///         deposit/refund cycling would recycle one wallet's quota
    ///         indefinitely.  Waiting out the window is the only way back in.
    mapping(address => uint256) public quotaWindowEnd;

    // ─── Global referral registry (v5.0) ──────────────────────────────────────

    /// @notice Permanent, platform-wide referrer binding.  Written at most once
    ///         per wallet, on that wallet's first genesis deposit.
    mapping(address => address) public globalReferrers;

    /// @notice How many wallets a referrer has recruited (informational).
    mapping(address => uint256) public referralCount;

    /// @notice Per-project referrer binding: wallet → hook → referrer.  Written
    ///         at most once per (wallet, project), on that wallet's first
    ///         deposit into that project.
    ///
    /// @dev    Independent of `globalReferrers` in both directions.  A wallet
    ///         can have a lifetime referrer and no project referrer (the
    ///         common case early in a raise, where the deposit gate below is
    ///         unmet), a project referrer and no lifetime one is impossible
    ///         since the same call offers the same address to both, and the
    ///         two can name different wallets or the same one.
    mapping(address => mapping(address => address)) public projectReferrers;

    /// @notice How many wallets a referrer has recruited into a given project
    ///         (informational).  Keyed hook → referrer, the opposite order to
    ///         `projectReferrers`, because the useful question here is "who
    ///         brought people to this project" and not "which projects did
    ///         this wallet recruit for".
    mapping(address => mapping(address => uint256)) public projectReferralCount;

    // ─── Launch registry ──────────────────────────────────────────────────────

    struct LaunchInfo {
        address token;
        address hook;
        address creator;
        uint256 createdAt;
    }

    LaunchInfo[] public launches;
    mapping(address => bool) public registeredHooks;
    mapping(address => address) public tokenToHook;

    /// @notice Tracks which (name, symbol) tuples have already produced a launch
    ///         (front-run / squatting defence).
    mapping(bytes32 => bool) public nameTaken;

    /// @notice Reverse index from hook to the reservation it holds, so a name
    ///         belonging to a launch that never made it out of genesis can be
    ///         handed back.  Without this the reservation is permanent, which
    ///         turns two survivable events into unrecoverable ones: a squatter
    ///         burning 0.1 ETH to sit on a ticker forever, and a genesis that
    ///         failed only because the factory was paused through its window.
    mapping(address => bytes32) public hookNameKey;

    // ─── Events ───────────────────────────────────────────────────────────────

    /// @dev `creator` is the one unindexed address here, and that is a choice
    ///      rather than an omission: three topics is the EVM ceiling for a
    ///      non-anonymous event and all three are spent.
    ///
    ///      `hook` earns its topic outright — `/api/projects/launch-tx` filters
    ///      on it to recover the creating transaction. `token` keys the public
    ///      route (`/projects/{token}`). `launchId` is the weakest of the three
    ///      and would be the one to trade if a creator filter is ever wanted,
    ///      since `launches(i)` already answers by index for a single `call`,
    ///      whereas nothing else can answer "every launch by this address"
    ///      without a scan.
    ///
    ///      Nothing needs that today, which is why this is a note and not a
    ///      change: moving `indexed` would shift a field from `data` to
    ///      `topics`, so `monitoring/watch.mjs`, `alerts.json`,
    ///      `e2eLaunchFlow.mjs` and the two documents quoting the signature
    ///      would all have to move with it, and logs already emitted on `97`
    ///      would decode differently from new ones. Note that topic0 itself is
    ///      unaffected — it hashes the type signature, which `indexed` does not
    ///      enter.
    ///
    ///      Slither's `unindexed-event-address` does not fire on this: it wants
    ///      *some* indexed parameter, and there are three. It fires twice on
    ///      this repo, both inside `lib/openzeppelin-contracts` on `Pausable`,
    ///      and the gated baseline filters `lib/` — so if you are reading a
    ///      `slither_report.md` that lists them, it was generated without
    ///      `_filterPaths`.
    event LaunchCreated(
        uint256 indexed launchId,
        address indexed token,
        address indexed hook,
        address creator,
        string name,
        string symbol
    );
    event Blacklisted(address indexed user, uint256 untilTimestamp);
    event PoGRegistered(address indexed user, uint256 quota);
    /// @dev `lifetimeReferrer` is the one unindexed address of the four fields.
    ///      Three topics is the ceiling, and the project referrer is the one
    ///      worth filtering on: it is the leg that varies per project and
    ///      carries 8 of the 10 points.
    event GenesisDeposit(
        address indexed user,
        address indexed hook,
        uint256 amount,
        address indexed projectReferrer,
        address lifetimeReferrer
    );
    event ReferralBound(address indexed user, address indexed referrer);
    event ProjectReferralBound(address indexed user, address indexed hook, address indexed referrer);
    event PogSignerUpdated(address indexed newSigner);
    event LaunchFeeUpdated(uint256 fee);
    event LaunchFeeForwarded(uint256 amount);
    event CooldownDurationUpdated(uint256 duration);
    event QuotaWindowDurationUpdated(uint256 duration);
    event DefaultSoftCapUpdated(uint256 newSoftCap);
    event MaxPogAllocationLimitUpdated(uint256 newLimit);

    /// @notice A wallet's quota window lapsed and its budget was topped back up.
    event QuotaWindowReset(address indexed user, uint256 windowEnd);

    /// @notice A dead launch's name/symbol went back on the market.
    event NameReleased(address indexed hook, bytes32 indexed nameKey);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error IsBlacklisted();
    error NoPogQuota();
    error QuotaExceeded();
    error CooldownActive();
    error InvalidSignature();
    error NonceConflict();
    error SignatureExpired();
    error SignatureTooLong();
    error HookNotRegistered();
    error DeployFailed();
    error ZeroAmount();
    error InvalidAdmin();
    error ExceedsGlobalPogLimit();
    error InvalidSoftCap();
    error LaunchFeeTooHigh();
    /// @notice `defaultSoftCap` above `MAX_DEFAULT_SOFT_CAP` — see that constant.
    error SoftCapTooHigh();
    /// @notice `maxPogAllocationLimit` may not be set to zero — the hook
    ///         constructor rejects a zero per-wallet cap, so it would brick
    ///         `createLaunch` platform-wide.
    error InvalidPogLimit();
    /// @notice `maxPogAllocationLimit` above `MAX_POG_ALLOCATION_LIMIT`.
    error PogLimitTooHigh();
    error NameTaken();
    error EmptyName();
    /// @notice The launch still has a live claim on its name.
    error NameStillHeld();

    /// @notice The ground token address failed to clear the quote asset.
    ///
    /// @dev    UNREACHABLE IF `ToshCloneLib.deployBareCloneAbove` IS CORRECT,
    ///         which is why it is here. The grind's whole contract is that the
    ///         address it returns exceeds the floor, and the consequence of a
    ///         silent failure is a pool whose sides are inverted for this one
    ///         project — a condition the treasury would reject at listing and
    ///         nothing would reject before then. Re-asserting the postcondition
    ///         at the call site costs a comparison and turns an offset bug in the
    ///         grind from a shipped project into a reverted transaction.
    error TokenBelowQuoteAsset();
    /// @notice Owner raised `launchFee` above the caller's slippage cap.
    error FeeChanged();
    /// @notice `defaultSoftCap` or `maxPogAllocationLimit` moved between the
    ///         caller reading them and this launch executing.
    ///
    /// @dev    Replaces what `InvalidHookSalt` used to catch by accident. See
    ///         `createLaunch`'s `expectedSoftCap` parameter.
    error CapsChanged();
    /// @notice `createLaunch` was sent less than `launchFee`.
    ///
    /// @dev    Reachable again. It was removed when the fee became a BEM pull,
    ///         because a pull has nothing in hand to be short of and the
    ///         token's own allowance revert carried the two figures. The fee is
    ///         native once more, so the shortfall is local and gets a local
    ///         name rather than an ERC20 error the creator has to translate.
    error InsufficientLaunchFee();
    /// @notice A native-coin transfer to a treasury or refund recipient failed.
    ///
    /// @dev    Reachable again, and the history is the point. `_sendNative` was
    ///         deleted when Slither called it dead code, which it was: every
    ///         value path had become `SafeERC20.safeTransferFrom`, and this
    ///         contract had no payable function to hold a native balance with.
    ///         The error was kept anyway so the ABI would not lose a selector
    ///         indexers might match on.
    ///
    ///         That turned out to be the right call for the wrong reason.
    ///         "Unused" was a fact about one denomination, not about the
    ///         design: `createLaunch` takes BNB again, `_sendNative` is back,
    ///         and this reverts when `platformTreasury` or a creator taking
    ///         change refuses the transfer.
    error NativeTransferFailed();

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @dev `_vault` arrived with the PancakeSwap Infinity port. Infinity splits
    ///      Uniswap V4's PoolManager into a manager that owns pool state and a
    ///      Vault that owns balances and the lock, so every contract that
    ///      settles needs both addresses. The factory holds them only to pass
    ///      them to the hook implementation it deploys below.
    constructor(
        address _poolManager,
        address _vault,
        address _pogSigner,
        address _platformTreasury,
        address _ladderTreasury,
        address _quoteAsset
    ) Ownable(msg.sender) {
        require(_poolManager != address(0), "zero poolManager");
        require(_vault != address(0), "zero vault");
        require(_pogSigner != address(0), "zero pogSigner");
        require(_platformTreasury != address(0), "zero platformTreasury");
        require(_ladderTreasury != address(0), "zero ladderTreasury");
        require(_quoteAsset != address(0), "zero quoteAsset");

        poolManager = _poolManager;
        vault = _vault;
        pogSigner = _pogSigner;
        platformTreasury = _platformTreasury;
        ladderTreasury = payable(_ladderTreasury);
        quoteAsset = IERC20(_quoteAsset);

        HOOK_CREATION_CODEHASH = HookDeployLib.creationCodeHash();

        // Deploying the implementation here is what lets it hold `factory` as an
        // ordinary immutable: the library call is a DELEGATECALL, so
        // `address(this)` inside it is this factory, mid-construction.
        //
        // It is also why `quoteAsset` gets no cross-check against the
        // implementation's copy. Both are written from `_quoteAsset` inside this
        // one construction, so there is no deploy ordering in which they name
        // different tokens — the same structural argument `hookImplementation`
        // makes about itself. The decimals assertion lives in the hook's
        // constructor, so it is paid once, here, rather than per caller.
        hookImplementation =
            HookDeployLib.deployImplementation(_poolManager, _vault, _ladderTreasury, _platformTreasury, _quoteAsset);
        tokenImplementation = address(new ToshToken(address(this)));
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Owner Admin
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Stop the platform from taking on NEW projects.
    ///
    /// @dev    Deliberately narrow.  A pause halts `createLaunch` and freezes
    ///         new PoG registrations; it does NOT touch a genesis round that is
    ///         already open, a project that has already launched, or any pool.
    ///         `deposit` is therefore not gated: a wallet that already holds
    ///         quota can keep funding an in-flight raise for the whole window.
    ///
    ///         The reason is that a genesis round fails by NOT reaching its soft
    ///         cap.  Gating `deposit` would hand the owner a switch that starves
    ///         a live raise into failure and forces every depositor into refund
    ///         — a unilateral veto over projects the platform already accepted.
    ///         Pausing must be able to stop the platform growing without being
    ///         able to kill what it has already taken money for.
    ///
    ///         `registerPoG` stays gated because it mints new spending budget
    ///         against an oracle signature, which is the one thing that needs a
    ///         faster brake than `setPogSigner` if the signer key leaks.  It
    ///         blocks new entrants only; committed ETH and existing quota are
    ///         untouched.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Ladder halt: the one brake that reaches a launched project ───────────
    //
    // `pause()` deliberately stops nothing on a project that has already
    // launched (see its natspec). That boundary is the platform's core promise,
    // and it left exactly one gap worth closing: if a defect is found in the
    // shelf pricing itself, every live project keeps selling supply against it
    // and there is no way to stop except to ask buyers nicely.
    //
    // This is a SEPARATE switch from `pause()` on purpose. Folding the two
    // together would have quietly widened what "paused" means for every reader
    // and every existing test, and the two brakes answer different questions:
    // `pause()` stops the platform GROWING, this stops the ladder SELLING.
    //
    // Three properties keep it from becoming the veto that `pause()` refuses to
    // be:
    //
    //   • It reaches `mintBondingCurve` and nothing else. Pool swaps, LP,
    //     `claimGenesis`, `claimReferralReward` and `refund` are all untouched,
    //     so no user's funds can be held hostage by it. A halted ladder costs a
    //     buyer an opportunity, never a balance.
    //
    //   • IT EXPIRES. A halt carries a deadline capped at `MAX_HALT_DURATION`,
    //     so an owner who is hostile, compromised, or simply gone cannot brick
    //     Phase 2 permanently — the worst case is a rolling one-week outage
    //     that has to be renewed in public, on-chain, every time. This is the
    //     difference between a break-glass brake and a kill switch, and it is
    //     the reason the new trust assumption is bounded rather than absolute.
    //
    //   • It is scoped. `hook == address(0)` halts every ladder; any other
    //     address halts that project alone, so a single compromised market does
    //     not require taking the whole platform's Phase 2 offline.

    /// @notice Longest a single halt may run before it lapses on its own.
    uint256 public constant MAX_HALT_DURATION = 7 days;

    /// @notice Timestamp until which ALL ladders are halted. Zero when inactive.
    uint256 public globalLadderHaltedUntil;

    /// @notice Per-hook halt deadlines, for containing a single bad market.
    mapping(address hook => uint256 until) public hookLadderHaltedUntil;

    event LadderMintingHalted(address indexed hook, uint256 until);
    event LadderMintingResumed(address indexed hook);

    error HaltDurationTooLong();

    /// @notice Suspend shelf minting for `duration` seconds.
    ///
    /// @param  hook     The project to halt, or `address(0)` for every project.
    /// @param  duration Seconds from now; must be non-zero and `<= 7 days`.
    ///                  Re-arm before expiry to extend an ongoing incident.
    function haltLadderMinting(address hook, uint256 duration) external onlyOwner {
        if (duration == 0 || duration > MAX_HALT_DURATION) revert HaltDurationTooLong();

        uint256 until = block.timestamp + duration;
        if (hook == address(0)) {
            globalLadderHaltedUntil = until;
        } else {
            hookLadderHaltedUntil[hook] = until;
        }
        emit LadderMintingHalted(hook, until);
    }

    /// @notice Lift a halt before it lapses.
    function resumeLadderMinting(address hook) external onlyOwner {
        if (hook == address(0)) {
            globalLadderHaltedUntil = 0;
        } else {
            hookLadderHaltedUntil[hook] = 0;
        }
        emit LadderMintingResumed(hook);
    }

    /// @notice Whether `hook` may currently sell shelves. Read by the hook on
    ///         every mint and by `maxMintable()`, so the UI and the guard agree.
    function ladderMintingHalted(address hook) external view returns (bool) {
        return block.timestamp < globalLadderHaltedUntil || block.timestamp < hookLadderHaltedUntil[hook];
    }

    function setPogSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "zero signer");
        pogSigner = newSigner;
        emit PogSignerUpdated(newSigner);
    }

    /// @notice Set the native BNB toll charged by `createLaunch`, in wei
    ///         (18 decimals, so 0.005 BNB is `5e15`).
    /// @dev    Bounded above by `MAX_LAUNCH_FEE`; see that constant for why.
    ///         Zero is legal.  Not retroactive in any sense — `createLaunch`
    ///         reads it live and `expectedFee` protects the creator against a
    ///         change that lands in the same block.
    function setLaunchFee(uint256 fee) external onlyOwner {
        if (fee > MAX_LAUNCH_FEE) revert LaunchFeeTooHigh();
        launchFee = fee;
        emit LaunchFeeUpdated(fee);
    }

    function setCooldownDuration(uint256 duration) external onlyOwner {
        require(duration <= MAX_COOLDOWN, "cooldown > MAX_COOLDOWN");
        cooldownDuration = duration;
        emit CooldownDurationUpdated(duration);
    }

    function setQuotaWindowDuration(uint256 duration) external onlyOwner {
        require(duration <= MAX_COOLDOWN, "quota window > MAX_COOLDOWN");
        quotaWindowDuration = duration;
        emit QuotaWindowDurationUpdated(duration);
    }

    /// @notice Owner-rotatable global default soft-cap, floored at
    ///         `MIN_SOFT_CAP_PROD` to keep `p0` off the truncation cliff and
    ///         capped at `MAX_DEFAULT_SOFT_CAP` to catch a wei/ether slip.
    function setDefaultSoftCap(uint256 newSoftCap) external onlyOwner {
        if (newSoftCap < MIN_SOFT_CAP_PROD) revert InvalidSoftCap();
        if (newSoftCap > MAX_DEFAULT_SOFT_CAP) revert SoftCapTooHigh();
        defaultSoftCap = newSoftCap;
        emit DefaultSoftCapUpdated(newSoftCap);
    }

    /// @notice Retune the per-wallet ETH ceiling.
    ///
    /// @dev    Floored at 1 wei rather than left open, because this value is
    ///         snapshotted into every new hook's constructor tuple and that
    ///         constructor does `require(_perWalletCap > 0)`.  At zero the
    ///         CREATE2 construction reverts and `createLaunch` dies with
    ///         `DeployFailed` for EVERY creator — a dial documented as
    ///         governing "new projects only" would instead have taken the
    ///         entire launch entrance offline, with nothing in the signature
    ///         or the event to suggest it.  Pausing is the supported way to
    ///         stop taking on projects; see `pause()`.
    ///
    ///         Capped at `MAX_POG_ALLOCATION_LIMIT`, which catches a wei/ether
    ///         slip and nothing subtler — read that constant before treating the
    ///         ceiling as an anti-whale guarantee.
    function setMaxPogAllocationLimit(uint256 newLimit) external onlyOwner {
        if (newLimit == 0) revert InvalidPogLimit();
        if (newLimit > MAX_POG_ALLOCATION_LIMIT) revert PogLimitTooHigh();
        maxPogAllocationLimit = newLimit;
        emit MaxPogAllocationLimitUpdated(newLimit);
    }

    function setBlacklist(address[] calldata users, uint256 banDuration) external onlyOwner {
        require(users.length <= 200, "Batch too large");
        uint256 untilTimestamp = banDuration == type(uint256).max ? type(uint256).max : block.timestamp + banDuration;
        for (uint256 i; i < users.length; ++i) {
            blacklistedUntil[users[i]] = untilTimestamp;
            emit Blacklisted(users[i], untilTimestamp);
        }
    }

    function liftBlacklist(address[] calldata users) external onlyOwner {
        require(users.length <= 200, "Batch too large");
        for (uint256 i; i < users.length; ++i) {
            blacklistedUntil[users[i]] = 0;
            emit Blacklisted(users[i], 0);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PoG Quota Registration
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Register a Proof-of-Gas quota under an oracle-signed
    ///         attestation.  Quotas are denominated in ETH-wei from v5.0.
    ///
    /// @dev    Blacklisted wallets are refused here, not only at `deposit`.
    ///         Otherwise a banned address can keep raising its ceiling and
    ///         come back the moment the ban lifts carrying a quota it never
    ///         would have been granted while banned.  Quotas are monotonic
    ///         (only ever raised, never cut) so the only way to stop a
    ///         raise is to refuse the attestation; lowering
    ///         `maxPogAllocationLimit` does not claw back what is already
    ///         on the books.
    function registerPoG(uint256 maxAlloc, uint256 deadline, uint256 nonce, bytes calldata signature)
        external
        whenNotPaused
    {
        if (block.timestamp < blacklistedUntil[msg.sender]) revert IsBlacklisted();
        if (deadline > block.timestamp + MAX_SIG_VALIDITY) revert SignatureTooLong();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce != pogNonces[msg.sender]) revert NonceConflict();
        if (maxAlloc > maxPogAllocationLimit) revert ExceedsGlobalPogLimit();

        bytes32 hash = keccak256(abi.encode(msg.sender, maxAlloc, nonce, deadline, address(this), block.chainid))
            .toEthSignedMessageHash();
        if (hash.recover(signature) != pogSigner) revert InvalidSignature();

        pogNonces[msg.sender]++;
        if (maxAlloc > pogQuota[msg.sender]) {
            pogQuota[msg.sender] = maxAlloc;
        }
        emit PoGRegistered(msg.sender, pogQuota[msg.sender]);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Global referral registry
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Permanently bind `user` to `referrer`, if and only if `user` has
    ///         never been bound before.
    ///
    /// @dev    Deliberately silent on every rejection path.  This runs inside
    ///         `deposit`, and a revert would mean a user who already has a
    ///         referrer could never deposit again through a link carrying a
    ///         different code — turning a cosmetic mismatch into a denial of
    ///         service.  A rejected binding is not a rejected deposit: the
    ///         commission simply falls through to `orphanReferral` and becomes
    ///         buyback fuel.  The four rejection cases:
    ///           • already bound        → first binding wins, forever;
    ///           • zero referrer        → nothing to bind;
    ///           • self-referral        → the trivial case;
    ///           • referrer holds no PoG quota → see below.
    ///
    ///         ── On self-farming ─────────────────────────────────────────────
    ///
    ///         `referrer != user` alone is one address deep.  A second EOA the
    ///         same person controls is not `user`, so the check used to hand
    ///         back 10 % of every deposit to anyone who knew to open a throwaway
    ///         wallet — and the wallet needed nothing at all: no quota, no
    ///         deposit, no history.  That is not a referral programme, it is an
    ///         undocumented 10 % discount for the informed, funded by the
    ///         orphan sweep that only the uninformed pay into.
    ///
    ///         Requiring `pogQuota[referrer] > 0` does NOT make sybils
    ///         impossible — nothing on-chain can, since a referrer is just an
    ///         address.  What it does is move the judgement to the only party
    ///         that can actually make it: the PoG oracle.  A referrer must now
    ///         have passed the same attestation a depositor passes, so farming
    ///         costs an attestation per throwaway wallet and the signer can
    ///         price, rate-limit, or refuse that off-chain.  The guard is
    ///         honest about being a cost, not a wall.
    function _recordReferral(address user, address referrer) internal {
        if (globalReferrers[user] != address(0)) return;
        if (referrer == address(0) || referrer == user) return;
        if (pogQuota[referrer] == 0) return;

        globalReferrers[user] = referrer;
        unchecked {
            ++referralCount[referrer];
        }
        emit ReferralBound(user, referrer);
    }

    /// @notice Bind `user` to `referrer` FOR ONE PROJECT, if and only if that
    ///         pair has never been bound before.
    ///
    /// @dev    Silent on every rejection path for the same reason
    ///         `_recordReferral` is: this runs inside `deposit`, and a revert
    ///         would turn a cosmetic link mismatch into a denial of service on
    ///         the deposit itself.  A rejected binding is not a rejected
    ///         deposit — the 8 % leg simply falls through to `orphanReferral`
    ///         and becomes buyback fuel.
    ///
    ///         ── Why this gate is stricter than the lifetime one ─────────────
    ///
    ///         Per-project binding multiplies the self-rebate.  Under the
    ///         lifetime registry alone, a farmer running a throwaway wallet as
    ///         the referrer for their own real wallet collected the carve ONCE,
    ///         ever, for the cost of one PoG attestation.  Bind per project and
    ///         the same pair collects 8 % in every project the real wallet ever
    ///         deposits into, with the attestation cost amortised across all of
    ///         them.  The cheapest attack got N times better and no more
    ///         expensive.
    ///
    ///         So the project slot additionally requires the referrer to
    ///         already hold a deposit IN THIS PROJECT.  Farming now needs
    ///         capital committed per project rather than one attestation
    ///         spread over many.
    ///
    ///         Be honest about the size of that: the throwaway's deposit is not
    ///         burned, it earns genesis tokens like any other, so the cost is
    ///         capital tied up and not capital lost.  This is a price, not a
    ///         wall — the wall, as ever, is the off-chain PoG oracle, which is
    ///         the only party that can price or refuse an attestation.
    ///
    ///         ── What this costs honest promoters ────────────────────────────
    ///
    ///         A project's earliest deposits CANNOT bind a project referrer,
    ///         because at that point nobody has a deposit here to qualify
    ///         with.  Their 8 % orphans to the buyback reservoir.  The playbook
    ///         that follows is deliberate and has to be surfaced in the UI: to
    ///         earn on a project, deposit into it before sharing the link.
    ///
    ///         A failed binding is NOT sticky.  The slot stays empty, so the
    ///         same user's next deposit into the same project tries again and
    ///         will bind if the referrer has since qualified.
    function _recordProjectReferral(address user, address hook, address referrer) internal {
        if (projectReferrers[user][hook] != address(0)) return;
        if (referrer == address(0) || referrer == user) return;
        if (pogQuota[referrer] == 0) return;

        // Read before the caller's own ETH reaches the hook, so this is the
        // referrer's state from an earlier transaction. `referrer != user`
        // above already rules out self-qualification either way.
        if (ToshLaunchpadHook(payable(hook)).nativeDeposited(referrer) == 0) return;

        projectReferrers[user][hook] = referrer;
        unchecked {
            ++projectReferralCount[hook][referrer];
        }
        emit ProjectReferralBound(user, hook, referrer);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Launch Creation
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Deploy a new launch (Hook + ToshToken pair) under a creator-bound
    ///         CREATE2 salt, paying `launchFee` in native BNB as `msg.value`.
    ///         Anything above the fee is returned in the same transaction.
    ///
    /// @param  expectedFee Slippage cap on `launchFee`; pass the value read in
    ///                     the same block to prevent an owner fee-bump front-run.
    /// @param  expectedSoftCap Exact `defaultSoftCap` the caller agreed to.
    /// @param  expectedWalletCap Exact `maxPogAllocationLimit` the caller agreed
    ///                     to.
    ///
    ///                     ⚠ THESE TWO ARE EXACT, NOT CAPS, and unlike
    ///                       `expectedFee` there is no direction in which a
    ///                       mismatch is harmless. A fee that moved DOWN still
    ///                       leaves the caller better off, so that one is a
    ///                       bound. A soft cap that moved in either direction
    ///                       changes the project's economics AND re-rolls the
    ///                       CREATE2 address the caller predicted, so equality is
    ///                       the only useful test.
    ///
    ///                     They exist because the PancakeSwap Infinity port
    ///                     removed the thing that used to catch this by accident.
    ///                     Uniswap V4 required a MINED salt, so a dial rotated
    ///                     between quote and execution re-rolled the address into
    ///                     one that failed the permission mask about 98% of the
    ///                     time, and the launch reverted. Infinity takes
    ///                     permissions from the hook's own bitmap, every salt is
    ///                     valid, and the launch would otherwise succeed silently
    ///                     at an unpredicted address with dials the caller never
    ///                     agreed to. See docs/PANCAKESWAP_INFINITY.md §11.3.
    /// @param  genesisDuration Genesis window length.  Must be one of the hook's
    ///                     three allowed rungs (3 h / 24 h / 72 h) —
    ///                     `initializeToken` rejects anything else, and because
    ///                     the value is baked into the clone's bytecode and hence
    ///                     the initcode hash, it also has to match whatever the
    ///                     salt was mined against.
    function createLaunch(
        string calldata name,
        string calldata symbol,
        address projectTreasury,
        address projectAdmin,
        bytes32 hookSalt,
        uint256 expectedFee,
        uint256 expectedSoftCap,
        uint256 expectedWalletCap,
        uint256 genesisDuration
    ) external payable whenNotPaused nonReentrant returns (address token, address hook) {
        require(projectTreasury != address(0), "zero treasury");
        if (projectAdmin == address(0)) revert InvalidAdmin();

        uint256 fee = launchFee;
        if (fee > expectedFee) revert FeeChanged();
        // The fee is native again, so it is already in hand when this runs and
        // the only question is whether it is enough. That is a local check with
        // a local name, unlike the pull it replaces — a `transferFrom` reverts
        // from inside the token, and the creator has to work out that an
        // ERC20 allowance error was about a platform fee.
        if (msg.value < fee) revert InsufficientLaunchFee();

        // ── Squat / front-run defence ─────────────────────────────────────────
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyName();
        bytes32 nameKey = keccak256(abi.encode(name, symbol));
        if (nameTaken[nameKey]) revert NameTaken();

        bytes32 finalSalt = keccak256(abi.encode(msg.sender, hookSalt));

        // Freeze both dials into the hook's initcode. From here the project's
        // economics are fixed even if the platform owner retunes the globals.
        uint256 launchSoftCap = defaultSoftCap;
        uint256 launchWalletCap = maxPogAllocationLimit;

        // Read and compared in the same breath as the freeze, deliberately: the
        // window this closes is between the caller reading the dials and this
        // line running, so the comparison has to be against the values actually
        // about to be baked in, not a re-read.
        if (launchSoftCap != expectedSoftCap || launchWalletCap != expectedWalletCap) revert CapsChanged();

        // NO ADDRESS-BIT GATE, and its absence is the PancakeSwap Infinity port
        // rather than an omission.
        //
        // Uniswap V4 read a hook's permissions out of the low bits of its own
        // address, so this line used to be a real check: `isValidHookAddress`
        // refused any salt whose CREATE2 address did not carry the 0x20CC mask,
        // and a launch therefore had to arrive with a MINED salt. Infinity reads
        // permissions from `ToshLaunchpadHook.getHooksRegistrationBitmap()` and
        // makes `CLPoolManager.initialize` refuse a pool whose
        // `PoolKey.parameters` disagrees with it. The permission set is still
        // pinned to the key — by equality now, rather than by address
        // arithmetic — so there is nothing left for an address to encode and
        // nothing left to mine.
        //
        // `finalSalt` stays, and it is not vestigial: it keeps the deployment
        // address deterministic and binds it to `msg.sender`, which is what
        // stops one creator front-running another's predicted address. It is
        // simply a free choice now instead of a mining target, so `hookSalt`
        // can be any value the caller likes.
        //
        // The local initcode hash went with the gate. It existed only to be
        // checked here; `hookInitcodeHash` and `verifyHookDeployment` below
        // recompute their own from the caller's arguments, so off-chain tooling
        // can still predict and verify an address — it just no longer has to
        // grind for one.

        hook = ToshCloneLib.deployHook(
            finalSalt, hookImplementation, msg.sender, projectTreasury, launchSoftCap, launchWalletCap, genesisDuration
        );
        if (hook == address(0)) revert DeployFailed();

        // Ground so the token sorts ABOVE the quote asset, which is what keeps
        // the quote side as `currency0` in this project's pool. `nameKey` seeds
        // the grind because it is already unique per factory, and because it
        // makes the resulting address predictable from the name alone. See
        // `ToshCloneLib.deployBareCloneAbove`.
        //
        // THE DISCARDED SECOND RETURN IS THE WINNING SALT, and dropping it is
        // deliberate — Slither reports it as `unused-return` at Medium, so the
        // reasoning is written here rather than left in a baseline file that
        // records only which line was triaged.
        //
        // Nothing on chain needs it: the address is the whole product of the
        // grind, and the line below re-checks the one property the salt was
        // ground for instead of trusting that the loop delivered it. Nothing
        // off chain needs it either, because the loop is deterministic given
        // `nameKey` — `ToshCloneLib.predictBareClone` is the shared derivation
        // both the grind and the frontend run, so a caller reproduces the
        // sequence from the project's name alone. Storing or emitting the salt
        // would add a word of state per launch to carry a value that is already
        // recomputable from one that is stored.
        (token,) = ToshCloneLib.deployBareCloneAbove(tokenImplementation, address(quoteAsset), nameKey);
        // Belt to the grind's braces. `deployBareCloneAbove` reverts
        // `NoSaltAboveFloor` rather than returning a low address, so this is
        // unreachable — and it is the invariant 91 sites in the hook depend on,
        // which is the kind that gets asserted rather than argued.
        if (token <= address(quoteAsset)) revert TokenBelowQuoteAsset();
        ToshToken(token).initialize(hook, name, symbol);
        ToshLaunchpadHook(payable(hook)).initializeToken(token, projectAdmin);

        registeredHooks[hook] = true;
        tokenToHook[token] = hook;
        nameTaken[nameKey] = true;
        hookNameKey[hook] = nameKey;

        uint256 launchId = launches.length;
        launches.push(LaunchInfo(token, hook, msg.sender, block.timestamp));

        emit LaunchCreated(launchId, token, hook, msg.sender, name, symbol);

        // ── Forward the fee, and give back the change ─────────────────────────
        //
        // ⚠ THE DESTINATION MOVED WITH THE DENOMINATION, AND IT HAD TO. This
        //   used to pull BEM to `ladderTreasury`, the buy-and-burn reservoir.
        //   That contract settles `quoteAsset`, sizes itself from
        //   `quoteAsset.balanceOf`, and — since native settlement was dropped —
        //   has no `receive()` at all, so a BNB send there would revert every
        //   launch, and a `receive()` bolted on would only let the coin arrive
        //   somewhere nothing can ever spend it. See `launchFee` for why losing
        //   the fee as ammunition costs little at this price.
        //
        // `platformTreasury` is `immutable`, so this destination is fixed at
        // deployment and no owner transaction can redirect the toll.
        //
        // THE OVERPAYMENT REFUND IS BACK, because native value makes
        // overpayment possible again. `expectedFee` is a ceiling rather than an
        // equality, so a fee the owner LOWERS between the caller reading it and
        // this executing is explicitly allowed — and a caller who sent the old
        // figure would otherwise have the difference quietly kept. Requiring
        // `msg.value == fee` would instead revert that caller for being early
        // to good news.
        if (fee > 0) {
            _sendNative(platformTreasury, fee);
            emit LaunchFeeForwarded(fee);
        }
        uint256 change = msg.value - fee;
        if (change > 0) _sendNative(msg.sender, change);
    }

    /// @dev Native transfer that does not swallow failure, and forwards more
    ///      than the 2300 gas stipend.
    ///
    ///      ⚠ THIS WAS DELETED AS DEAD CODE DURING THE BEM MIGRATION, ON A
    ///        SLITHER FINDING, AND IT WAS DEAD — every value path had become an
    ///        ERC20 transfer. It is back because the launch fee is native
    ///        again, which is the thing to notice: "unused" was a fact about
    ///        one denomination, not about the design.
    ///
    ///      `call` rather than `transfer` because both recipients are contracts
    ///      in the expected case. `platformTreasury` is a Gnosis Safe, whose
    ///      receive costs ~27k gas and would fail outright on a 2300 stipend;
    ///      `msg.sender` taking change may be a Safe or a smart account too.
    ///      `verifyOwnerSafe.mjs` checks the Safe accepts plain BNB before a
    ///      deployment names it, because a treasury that reverts on receive
    ///      bricks `createLaunch` for the whole platform.
    function _sendNative(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Genesis Deposit Gateway
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Deposit native ETH into a project's genesis round.
    ///
    /// @dev    The PoG quota is a platform-wide budget spent across all
    ///         projects, refilled once per `quotaWindowDuration` window rather
    ///         than granted for life.  Refunds never credit it back, so
    ///         deposit/refund churn cannot recycle a single wallet's
    ///         allowance — the only way to regain room is to wait out the
    ///         window.  The per-PROJECT ceiling is enforced separately, by the
    ///         hook, against the cap snapshotted when it was created.
    ///
    ///         Not gated by `whenNotPaused` — see `pause()`.  A raise already
    ///         underway must be able to run to its deadline on its own merits.
    ///
    /// @param  hook     Target launch hook.
    /// @param  referrer The single referrer carried by the caller's link, which
    ///                  is offered to BOTH registries.  Each accepts only if
    ///                  its own slot is empty, so this one argument can bind
    ///                  the lifetime slot, the project slot, both, or neither
    ///                  — and the caller cannot choose which.  See
    ///                  `_recordProjectReferral` for the extra gate the project
    ///                  slot applies.
    /// @param  amount   Quote-asset units to deposit. AN EXPLICIT ARGUMENT NOW,
    ///                  where it used to be `msg.value`, and the difference is
    ///                  worth one line of caution: the caller states the figure
    ///                  and the allowance merely has to cover it, so an approval
    ///                  granted once for a large round can be drawn on by a later
    ///                  call for a different amount. Approve what you intend to
    ///                  deposit, not what you intend to deposit eventually.
    function deposit(address hook, address referrer, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!registeredHooks[hook]) revert HookNotRegistered();
        if (block.timestamp < blacklistedUntil[msg.sender]) revert IsBlacklisted();
        if (pogQuota[msg.sender] == 0) revert NoPogQuota();
        if (block.timestamp < userLaunchCooldownEnd[msg.sender][hook]) revert CooldownActive();

        uint256 alreadyIn = _rollQuotaWindow(msg.sender);
        if (alreadyIn + amount > pogQuota[msg.sender]) revert QuotaExceeded();

        if (cooldownDuration > 0) {
            userLaunchCooldownEnd[msg.sender][hook] = block.timestamp + cooldownDuration;
        }

        // Bind BOTH slots before reading either back, so a first-time
        // depositor's own link is honoured on this very deposit. The project
        // binding runs while the hook still holds pre-deposit state, which is
        // what lets its gate ask whether the referrer already had a stake here.
        _recordReferral(msg.sender, referrer);
        _recordProjectReferral(msg.sender, hook, referrer);

        // Read back rather than reuse `referrer`: either binding may have been
        // rejected, and what the hook must be paid against is the slot that
        // actually stands, not the address that was offered.
        address boundLifetime = globalReferrers[msg.sender];
        address boundProject = projectReferrers[msg.sender][hook];

        quotaSpent[msg.sender] = alreadyIn + amount;
        totalGenesisDeposited[msg.sender] += amount;

        // Straight to the hook, not through this contract. Each project's
        // deposits live in its own hook — that isolation is why the protocol
        // deploys a clone per launch rather than one shared hook — and a pull
        // into the factory followed by a push out would put every open round's
        // genesis money in one place for the length of a transaction.
        //
        // The transfer precedes the call, so the hook re-derives the arrival from
        // its own balance rather than taking `amount` on our word. See its
        // `deposit`.
        SafeERC20.safeTransferFrom(quoteAsset, msg.sender, hook, amount);
        ToshLaunchpadHook(payable(hook)).deposit(msg.sender, boundProject, boundLifetime, amount);

        emit GenesisDeposit(msg.sender, hook, amount, boundProject, boundLifetime);
    }

    /// @notice Hand a name/symbol back to the pool once its launch is provably
    ///         dead, i.e. the hook's own refund path has opened because the
    ///         7-day launch window lapsed unused.
    ///
    /// @dev    Permissionless on purpose.  The condition is objective and read
    ///         from the hook, there is nothing to steal — a live or launched
    ///         project can never satisfy `canRefund()` — and leaving it to the
    ///         creator would strand exactly the names most worth reclaiming,
    ///         since an abandoned launch is one whose creator has stopped
    ///         showing up.  Deliberately NOT `whenNotPaused`: a pause is one of
    ///         the things that can kill a genesis, so it must not also block
    ///         the cleanup.
    function releaseAbandonedName(address hook) external {
        if (!registeredHooks[hook]) revert HookNotRegistered();

        bytes32 key = hookNameKey[hook];
        if (key == bytes32(0)) revert NameStillHeld(); // already released
        if (!ToshLaunchpadHook(payable(hook)).canRefund()) revert NameStillHeld();

        delete hookNameKey[hook];
        nameTaken[key] = false;

        emit NameReleased(hook, key);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Views
    // ══════════════════════════════════════════════════════════════════════════

    function eligibility(address user, address hook)
        external
        view
        returns (bool eligible, uint256 remainingQuota, uint256 cooldownRemaining)
    {
        if (block.timestamp < blacklistedUntil[user] || pogQuota[user] == 0) {
            return (false, 0, 0);
        }
        uint256 cd = userLaunchCooldownEnd[user][hook];
        if (block.timestamp < cd) return (false, 0, cd - block.timestamp);

        uint256 quota = pogQuota[user];

        // Mirror `_rollQuotaWindow` without writing: a lapsed window means the
        // budget is already refilled from the caller's point of view.
        uint256 spent = (quotaWindowDuration > 0 && block.timestamp >= quotaWindowEnd[user]) ? 0 : quotaSpent[user];

        remainingQuota = spent >= quota ? 0 : quota - spent;
        eligible = remainingQuota > 0;
    }

    /// @notice The permanent referrer of `user`, or the zero address.
    function referrerOf(address user) external view returns (address) {
        return globalReferrers[user];
    }

    /// @notice The referrer bound to `user` for `hook`, or the zero address.
    function projectReferrerOf(address user, address hook) external view returns (address) {
        return projectReferrers[user][hook];
    }

    /// @notice Whether `referrer`'s link would bind on `hook` right now.
    ///
    /// @dev    For the share side of the UI, which otherwise has to reproduce
    ///         `_recordProjectReferral`'s gate in TypeScript and go stale the
    ///         moment the gate changes.  Deliberately ignores whether any
    ///         particular depositor is already bound — this answers "is my link
    ///         live on this project", not "will it bind for this one visitor".
    function canBindProjectReferral(address referrer, address hook) external view returns (bool) {
        if (referrer == address(0)) return false;
        if (!registeredHooks[hook]) return false;
        if (pogQuota[referrer] == 0) return false;
        return ToshLaunchpadHook(payable(hook)).nativeDeposited(referrer) > 0;
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    /// @notice The initcode hash a caller predicts a hook's address from.
    ///
    /// @dev    NO LONGER A MINING INPUT, because nothing mines. Under Uniswap
    ///         V4 a launch had to arrive with a salt whose CREATE2 address
    ///         carried the permission mask in its low bits, and this was the
    ///         value to grind against. PancakeSwap Infinity takes permissions
    ///         from `getHooksRegistrationBitmap()` instead, so `createLaunch`
    ///         accepts any salt and `InvalidHookSalt` is gone.
    ///
    ///         What this is still for: predicting the address a given salt will
    ///         produce, which the launch UI shows before the transaction and
    ///         `verifyHookDeployment` checks after it.
    ///
    /// @dev    ⚠ `projectAdmin` USED TO BE AN ARGUMENT HERE AND NO LONGER IS.
    ///         It was a hook constructor argument and therefore part of the
    ///         initcode; it is now set by `initializeToken` and is not committed
    ///         to by the hook's address.  Nothing was lost — `changeProjectAdmin`
    ///         always let it rotate, so the address only ever pinned its initial
    ///         value — but a caller still passing six arguments will silently
    ///         hash the wrong tuple and predict an address the launch will not
    ///         deploy to.
    function hookInitcodeHash(
        address projectTreasury,
        address creator_,
        uint256 softCap,
        uint256 perWalletCap,
        uint256 genesisDuration
    ) external view returns (bytes32) {
        return ToshCloneLib.initcodeHash(
            hookImplementation, creator_, projectTreasury, softCap, perWalletCap, genesisDuration
        );
    }

    /// @dev Reports the STANDARD-window hash.  The duration is now a per-launch
    ///      choice, so there is no single "live" initcode hash any more; this
    ///      keeps the 24 h default answerable for existing tooling.
    ///
    ///      ⚠ NOT AN ADDRESS-PREDICTION INPUT.  `platformTreasury` stands in
    ///      for both `projectTreasury` and `creator`, neither of which a real
    ///      launch shares, so an address predicted from this value is never the
    ///      address a launch deploys to.  Use `hookInitcodeHash` for that.
    ///      Its value is as a build fingerprint: it changes iff the
    ///      implementation address or the platform's soft-cap / wallet-cap dials
    ///      changed.
    ///
    ///      The 24 h literal has to track `ToshLaunchpadHook.DURATION_STANDARD`;
    ///      Solidity will not let us read that constant off the contract type,
    ///      so `test_factory_liveInitcodeHash_tracksStandardDuration` pins the
    ///      two together instead.
    function getLiveHookInitcodeHash() external view returns (bytes32 hashSnapshot) {
        address sentinel = platformTreasury;
        return ToshCloneLib.initcodeHash(
            hookImplementation, sentinel, sentinel, defaultSoftCap, maxPogAllocationLimit, 24 hours
        );
    }

    function predictHookAddress(address creator_, bytes32 rawSalt, bytes32 initcodeHash_)
        external
        view
        returns (address)
    {
        return HookAddress.computeAddress(address(this), keccak256(abi.encode(creator_, rawSalt)), initcodeHash_);
    }

    /// @dev `projectAdmin` is no longer part of the commitment — see
    ///      `hookInitcodeHash`.
    function verifyHookDeployment(
        address hook,
        address creator_,
        address projectTreasury,
        uint256 softCap,
        uint256 perWalletCap,
        uint256 genesisDuration,
        bytes32 rawSalt
    ) external view returns (bool) {
        if (!registeredHooks[hook]) return false;
        bytes32 initcodeHash_ = ToshCloneLib.initcodeHash(
            hookImplementation, creator_, projectTreasury, softCap, perWalletCap, genesisDuration
        );
        bytes32 finalSalt = keccak256(abi.encode(creator_, rawSalt));
        return HookAddress.computeAddress(address(this), finalSalt, initcodeHash_) == hook;
    }

    // ─── Internals ────────────────────────────────────────────────────────────

    /// @dev Lapse `user`'s quota window if it has expired and open a fresh one.
    ///
    ///      With `quotaWindowDuration == 0` there is no window to anchor a
    ///      refill to, so the quota degrades to a single lifetime budget
    ///      rather than silently refilling on every deposit.
    ///
    /// @return spent ETH already committed inside the now-current window.
    function _rollQuotaWindow(address user) internal returns (uint256 spent) {
        uint256 duration = quotaWindowDuration;
        if (duration == 0) return quotaSpent[user];

        if (block.timestamp >= quotaWindowEnd[user]) {
            uint256 windowEnd = block.timestamp + duration;
            quotaWindowEnd[user] = windowEnd;
            quotaSpent[user] = 0;
            emit QuotaWindowReset(user, windowEnd);
            return 0;
        }
        return quotaSpent[user];
    }
}
