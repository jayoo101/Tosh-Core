// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ECDSA} from "../lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "../lib/openzeppelin-contracts/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable2Step} from "../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "../lib/openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

import {ToshToken} from "./ToshToken.sol";
import {ToshLaunchpadHook} from "./ToshLaunchpadHook.sol";
import {HookMiner} from "./libraries/HookMiner.sol";
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

    /// @notice Ceiling on `launchFee`, denominated in BNB.
    ///
    /// @dev    `setLaunchFee` was the one setter on this contract with no
    ///         validation of any kind — no floor, no ceiling, no zero-check —
    ///         while both duration setters are capped at `MAX_COOLDOWN` and
    ///         `setDefaultSoftCap` is floored at `MIN_SOFT_CAP_PROD`.
    ///
    ///         The failure it admits is not an exploit, it is an accident with
    ///         no undo short of a second owner transaction: the fee is quoted in
    ///         wei, and the difference between `0.35 ether` and `0.35e18 ether`
    ///         is one keystroke in a Safe transaction builder.  Above the ceiling
    ///         `createLaunch` becomes unaffordable for everyone, which is a
    ///         platform-wide outage produced by a typo rather than by an
    ///         attacker.
    ///
    ///         Deliberately generous — 100x the 0.35 BNB default — because this
    ///         guards against an order-of-magnitude slip, not against pricing
    ///         judgement.  Zero stays legal: a fee-free platform is a policy
    ///         choice, and `test_setLaunchFee_allowsZero` pins it.
    uint256 public constant MAX_LAUNCH_FEE = 35 ether;

    /// @notice Ceilings on the two other BNB-denominated dials, in wei.
    ///
    /// @dev    Same failure mode as `MAX_LAUNCH_FEE` — a wei-denominated field
    ///         typed into a Safe transaction builder — but deliberately many
    ///         orders of magnitude looser, and the difference is the point.
    ///
    ///         A launch fee above 35 BNB cannot be a considered choice, so that
    ///         ceiling can double as a sanity bound on pricing judgement.  These
    ///         two have no such comfortable range: this repo's own suites set a
    ///         1000-unit per-wallet limit in a fixture and a 300-unit one to pin
    ///         `test_registerPoG_noSilentClamp`, and an 8000-unit soft cap
    ///         appears in a local rehearsal script.  A tight bound here would
    ///         not be conservative, it would be wrong.
    ///
    ///         So these guard exactly one class of mistake: **unit confusion**.
    ///         `35 ether` entered as `35e18 ether` is eighteen orders of
    ///         magnitude, and 1 M BNB is both far above any conceivable raise or
    ///         wallet cap — well under 1% of BNB's supply, but several thousand
    ///         times the largest raise this platform could plausibly host — and
    ///         ~1e14 below that slip.  Do not read them as anything more.
    ///         Deliberately left at 1 M rather than rescaled with the other
    ///         dials: these bound a typo, not a value, so the factor that
    ///         matters is the distance to `1e18 ether` and that is unchanged.
    ///         In particular a
    ///         `maxPogAllocationLimit` under this ceiling is **not** evidence
    ///         that PoG still limits whales: once the per-wallet cap reaches the
    ///         soft cap a single wallet can fill an entire genesis round, and no
    ///         constant can enforce that ratio, because `defaultSoftCap` moves
    ///         independently and coupling the two would make the outcome depend
    ///         on which setter the owner happened to call first.  That sizing is
    ///         a policy judgement and stays one.
    uint256 public constant MAX_DEFAULT_SOFT_CAP = 1_000_000 ether;

    /// @dev    See `MAX_DEFAULT_SOFT_CAP`; identical reasoning, kept as its own
    ///         constant so the two can diverge without a migration.
    uint256 public constant MAX_POG_ALLOCATION_LIMIT = 1_000_000 ether;

    /// @notice Minimum acceptable `defaultSoftCap`, denominated in BNB (v5.0).
    ///
    /// @dev    Guards two cliffs, and the one this comment used to name alone is
    ///         not the binding one.
    ///
    ///         The obvious cliff is `p0 = 0`.  The hook derives
    ///         `p0 = (lpEth * 1e18) / GENESIS_LP_SUPPLY` with
    ///         `GENESIS_LP_SUPPLY = 3.78e24`, so `p0` truncates to zero once
    ///         `lpEth < 3_780_000` wei — which would collapse the entire tier
    ///         ladder to a free-mint zone.  This cliff does have a backstop:
    ///         the hook's `launch()` asserts `p0 > 0`.
    ///
    ///         The binding cliff is ladder *flattening*, it sits far above the
    ///         first, and it has no backstop.  Shelf monotonicity breaks below
    ///         `shelfP0 = 526` wei: at 525 the step to shelf 1 rounds to 0 wei,
    ///         which would let a buyer clear the upper shelf at the lower
    ///         shelf's price.  Dropping this floor to 1 gwei yields `p0 = 238`
    ///         and `shelfP0 = 249` — non-zero, so `launch()`'s assert still
    ///         passes, yet shelves 0 and 1 come out identically priced.
    ///         Nothing else in the system checks for a flat ladder, so this
    ///         literal is the entire defence.
    ///
    ///         Both cliffs are pure wei arithmetic and know nothing about what
    ///         the native coin is worth, which is why the BNB cutover could
    ///         move this floor without re-deriving them.  `p0` scales linearly
    ///         with the cap, so raising the floor only ever widens the margin:
    ///         at the old 0.01 it was around 2.38e9 wei/token with a 4,756,270
    ///         wei step, and at 0.035 `shelfP0` is 8,749,999,999 with a step of
    ///         16,646,947 wei — a margin of 16.6 million to one over break-even,
    ///         3.5x the headroom the ETH figure had — while still permitting
    ///         small testnet raises.  Pinned by
    ///         `test_setDefaultSoftCap_rejectsBelowFloor` and
    ///         `testFuzz_tierPriceAt_strictlyMonotone`; derived in
    ///         `docs/SECURITY_AUDIT.md` §5.11.
    uint256 public constant MIN_SOFT_CAP_PROD = 0.035 ether;

    // ─── Immutables ───────────────────────────────────────────────────────────

    /// @dev v5.0 dropped the `satoToken` immutable entirely.  SATO is an
    ///      ordinary launch on this platform with no protocol-level privileges,
    ///      so pinning its address here only implied a special status the
    ///      contract never actually honoured.

    address public immutable poolManager;

    /// @notice Platform buyback reservoir; receives every launch fee.
    address payable public immutable ladderTreasury;

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
    uint256 public cooldownDuration = 24 hours;

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

    /// @notice BNB charged on `createLaunch`. Default: 0.35 BNB (v5.0).
    uint256 public launchFee = 0.35 ether;

    /// @notice Per-wallet BNB cap. Serves double duty: it ceilings the PoG
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
    ///         Note the two dials are no longer in the same currency as the
    ///         gas history the oracle reads.  `maxAlloc` is BNB because a
    ///         deposit is BNB; the gas history it is derived from is ETH,
    ///         because the chains scanned for it settle in ETH.  The rate
    ///         between them carries the conversion, and
    ///         `docs/BSC_MIGRATION.md` §6 is where that split is argued.
    uint256 public maxPogAllocationLimit = 1.75 ether;

    /// @notice Global default soft-cap baked into every NEW hook, in BNB (v5.0).
    uint256 public defaultSoftCap = 35 ether;

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
    error InvalidHookSalt();
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

    /// @notice `msg.value` did not cover `launchFee`.
    error InsufficientLaunchFee();
    /// @notice Owner raised `launchFee` above the caller's slippage cap.
    error FeeChanged();
    /// @notice Native-ETH transfer to a treasury or refund recipient failed.
    error EthTransferFailed();

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _poolManager, address _pogSigner, address _platformTreasury, address _ladderTreasury)
        Ownable(msg.sender)
    {
        require(_poolManager != address(0), "zero poolManager");
        require(_pogSigner != address(0), "zero pogSigner");
        require(_platformTreasury != address(0), "zero platformTreasury");
        require(_ladderTreasury != address(0), "zero ladderTreasury");

        poolManager = _poolManager;
        pogSigner = _pogSigner;
        platformTreasury = _platformTreasury;
        ladderTreasury = payable(_ladderTreasury);

        HOOK_CREATION_CODEHASH = HookDeployLib.creationCodeHash();

        // Deploying the implementation here is what lets it hold `factory` as an
        // ordinary immutable: the library call is a DELEGATECALL, so
        // `address(this)` inside it is this factory, mid-construction.
        hookImplementation = HookDeployLib.deployImplementation(_poolManager, _ladderTreasury, _platformTreasury);
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

    /// @notice Set the native-ETH toll charged by `createLaunch`.
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
        if (ToshLaunchpadHook(payable(hook)).ethDeposited(referrer) == 0) return;

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
    ///         CREATE2 salt, paying `launchFee` in native ETH.
    ///
    /// @param  expectedFee Slippage cap on `launchFee`; pass the value read in
    ///                     the same block to prevent an owner fee-bump front-run.
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
        uint256 genesisDuration
    ) external payable whenNotPaused nonReentrant returns (address token, address hook) {
        require(projectTreasury != address(0), "zero treasury");
        if (projectAdmin == address(0)) revert InvalidAdmin();

        uint256 fee = launchFee;
        if (fee > expectedFee) revert FeeChanged();
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

        bytes32 initHash = ToshCloneLib.initcodeHash(
            hookImplementation, msg.sender, projectTreasury, launchSoftCap, launchWalletCap, genesisDuration
        );
        address predictedHook = HookMiner.computeAddress(address(this), finalSalt, initHash);
        if (!HookMiner.isValidHookAddress(predictedHook)) revert InvalidHookSalt();

        hook = ToshCloneLib.deployHook(
            finalSalt, hookImplementation, msg.sender, projectTreasury, launchSoftCap, launchWalletCap, genesisDuration
        );
        if (hook == address(0)) revert DeployFailed();

        token = ToshCloneLib.deployBareClone(tokenImplementation);
        ToshToken(token).initialize(hook, name, symbol);
        ToshLaunchpadHook(payable(hook)).initializeToken(token, projectAdmin);

        registeredHooks[hook] = true;
        tokenToHook[token] = hook;
        nameTaken[nameKey] = true;
        hookNameKey[hook] = nameKey;

        uint256 launchId = launches.length;
        launches.push(LaunchInfo(token, hook, msg.sender, block.timestamp));

        emit LaunchCreated(launchId, token, hook, msg.sender, name, symbol);

        // ── Route the fee to the buyback reservoir, refund any overpayment ────
        if (fee > 0) {
            _sendEth(ladderTreasury, fee);
            emit LaunchFeeForwarded(fee);
        }
        uint256 change = msg.value - fee;
        if (change > 0) _sendEth(msg.sender, change);
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
    function deposit(address hook, address referrer) external payable nonReentrant {
        uint256 amount = msg.value;
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

        ToshLaunchpadHook(payable(hook)).deposit{value: amount}(msg.sender, boundProject, boundLifetime);

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
        return ToshLaunchpadHook(payable(hook)).ethDeposited(referrer) > 0;
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    /// @notice The value an off-chain miner must hash salts against.
    ///
    /// @dev    ⚠ `projectAdmin` USED TO BE AN ARGUMENT HERE AND NO LONGER IS.
    ///         It was a hook constructor argument and therefore part of the
    ///         initcode; it is now set by `initializeToken` and is not committed
    ///         to by the hook's address.  Nothing was lost — `changeProjectAdmin`
    ///         always let it rotate, so the address only ever pinned its initial
    ///         value — but a miner still passing six arguments will silently hash
    ///         the wrong tuple and every salt it finds will fail
    ///         `InvalidHookSalt`.
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
    ///      ⚠ NOT A MINING INPUT.  `platformTreasury` stands in for both
    ///      `projectTreasury` and `creator`, neither of which a real launch
    ///      shares.  `createLaunch` recomputes the hash from the caller's actual
    ///      addresses, so a salt mined against this value fails
    ///      `InvalidHookSalt` every time.  Mine against `hookInitcodeHash`.
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
        return HookMiner.computeAddress(address(this), keccak256(abi.encode(creator_, rawSalt)), initcodeHash_);
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
        return HookMiner.computeAddress(address(this), finalSalt, initcodeHash_) == hook;
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

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
