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
import {CircuitNFT} from "./CircuitNFT.sol";

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
///   3. PERMISSIONED LAUNCHES (GrantPad).  Only the owner may call
///      `createLaunch`, with a per-launch hard cap and per-wallet cap taken
///      from the platform's review form. There is no launch fee. Every launch
///      mints a Circuit NFT to the developer and deploys the vault it
///      controls, and the hook pays its 99 % shelf share to that vault for
///      the life of the project.
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

    /// @notice Bounds on a launch's `hardCap`, in quote-asset base units.
    ///
    /// @dev    The floor is set by the ladder, not by policy. `launch()` refuses
    ///         any raise below ~21.04 BEM (`RaiseTooSmallForLadder`), because
    ///         under that the first shelf step truncates to zero. A round can
    ///         close anywhere under its cap, so a cap close to 21.04 would mean
    ///         only a nearly full round can launch at all. 30 BEM means a round
    ///         launches once it reaches ~70 % of the smallest legal cap.
    ///
    ///         The ceiling guards unit confusion (`20_000 ether` where
    ///         `20_000e8` was meant is a factor of 1e10). 20,000 BEM is ~10.4 %
    ///         of BEM's 191,739 supply, far above any raise this platform could
    ///         fill.
    uint256 public constant MIN_HARD_CAP = 30e8;
    uint256 public constant MAX_HARD_CAP = 20_000e8;

    /// @notice What a `hardCap` of 0 is stored as: no cap, the round runs to
    ///         its deadline whatever it raises.
    ///
    /// @dev    A sentinel rather than a flag because the hook cannot grow (its
    ///         deployer is within bytes of the size limit) and already refuses
    ///         a zero cap. The widest value its uint128 arg holds is one no
    ///         deposit sum can reach — BEM's whole supply is ~1.9e13 base units.
    ///         `MIN_HARD_CAP`/`MAX_HARD_CAP` do not apply; the wallet cap is
    ///         held to `MAX_HARD_CAP` instead, as the unit-slip guard.
    uint256 public constant UNCAPPED = type(uint128).max;

    /// @notice Ceiling on `maxPogAllocationLimit`, in base units.
    ///
    /// @dev    Guards the same unit slip as `MAX_HARD_CAP`.
    ///
    ///         A `maxPogAllocationLimit` under this ceiling is **not** evidence
    ///         that PoG still limits whales: a per-launch wallet cap equal to
    ///         the hard cap lets one wallet fill an entire round. That sizing is
    ///         made per launch, on the review form.
    uint256 public constant MAX_POG_ALLOCATION_LIMIT = 20_000e8;

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

    /// @notice Platform buyback reservoir.  Receives the shelf cut and the
    ///         70 bps buy-side tax share from the hooks.
    address payable public immutable ladderTreasury;

    /// @notice The ERC20 genesis deposits are paid in, and `currency0` of every
    ///         project pool.
    ///
    /// @dev    Same value the hook implementation holds, from the same
    ///         constructor argument — see the note in the constructor for why
    ///         the two cannot disagree and no cross-check is warranted.
    ///
    ///         Held here as well as on the hook because this contract is the
    ///         one that pulls: `deposit` collects the depositor's stake by
    ///         `transferFrom` and needs the token without an extra hop.
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

    /// @notice The Circuit NFT collection. One token per launch, minted to the
    ///         developer; holding it controls that project's revenue vault.
    ///
    /// @dev    Deployed from this constructor, so its `factory` is this
    ///         contract by construction and no one else can ever mint.
    address public immutable circuitNFT;

    /// @notice The shared `CircuitRevenueVault` implementation every project's
    ///         vault clone delegates to. Deployed by `circuitNFT`'s constructor
    ///         and copied here; no setter, for the same reason as
    ///         `hookImplementation`.
    address public immutable vaultImplementation;

    // ─── Owner-controlled state ───────────────────────────────────────────────

    address public pogSigner;

    /// @notice Platform fee destination. Receives two flows, both in BEM: the
    ///         0.30 % maintenance cut of every buy's quote input, and orphaned
    ///         referral commission flushed at each `launch`.
    ///
    /// @dev    There is no launch fee any more, so nothing native arrives here.
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
    ///         a sentinel filler, documented as metadata rather than a lever.
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
    ///         What still routes to `ladderTreasury` is the Phase-2 shelf cut
    ///         and the 70 bps reservoir share of the same buy-side tax.  This
    ///         address also receives orphaned referral commission at `launch`.
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

    /// @notice Platform-wide ceiling on the PoG `maxAlloc` an oracle attestation
    ///         may grant.
    ///
    /// @dev    No longer a per-project cap. Each launch takes its own per-wallet
    ///         cap from `createLaunch`, frozen into its hook, so retuning this
    ///         value never touches a round already open.
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

    /// @notice The Circuit token issued for each launch, and its reverse. The
    ///         vault it controls is the hook's `projectAdmin`.
    mapping(address hook => uint256 tokenId) public circuitOf;
    mapping(uint256 tokenId => address hook) public hookOfCircuit;

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
    event CooldownDurationUpdated(uint256 duration);
    event QuotaWindowDurationUpdated(uint256 duration);
    event MaxPogAllocationLimitUpdated(uint256 newLimit);

    /// @notice A launch's revenue right was issued: `developer` received Circuit
    ///         `tokenId`, which controls `vault`, the hook's permanent payee.
    event CircuitIssued(uint256 indexed tokenId, address indexed hook, address indexed developer, address vault);

    /// @notice A wallet's quota window lapsed and its budget was topped back up.
    event QuotaWindowReset(address indexed user, uint256 windowEnd);

    /// @notice A dead launch's name/symbol went back on the market.
    event NameReleased(address indexed hook, bytes32 indexed nameKey);

    // ─── Errors ───────────────────────────────────────────────────────────────

    /// @notice `renounceOwnership` is disabled — see the override for why.
    error OwnershipCannotBeRenounced();

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
    /// @notice `createLaunch` was given the zero address as the developer.
    error InvalidDeveloper();
    error ExceedsGlobalPogLimit();
    /// @notice `hardCap` below `MIN_HARD_CAP`.
    error HardCapTooLow();
    /// @notice `hardCap` above `MAX_HARD_CAP`.
    error HardCapTooHigh();
    /// @notice The per-wallet cap is zero or exceeds the launch's hard cap.
    error InvalidWalletCap();
    /// @notice `maxPogAllocationLimit` may not be set to zero, since no
    ///         attestation could then grant any quota.
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

        CircuitNFT circuit = new CircuitNFT(address(this), _quoteAsset);
        circuitNFT = address(circuit);
        vaultImplementation = circuit.vaultImplementation();
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
    ///         The reason is that a genesis round fails by NOT raising enough to
    ///         seed the ladder — `ToshLaunchpadHook.ladderViable()`, since the
    ///         soft cap stopped gating anything. Gating `deposit` would hand the
    ///         owner a switch that starves a live raise into failure and forces
    ///         every depositor into refund. Pausing must be able to stop the
    ///         platform growing without killing what it has already taken money
    ///         for.
    ///
    ///         ⚠ THAT IS A PROPERTY OF `pause()`, NOT A GUARANTEE ABOUT THE
    ///           OWNER. This paragraph used to call it "a unilateral veto over
    ///           projects the platform already accepted" and imply the owner has
    ///           no such veto. The owner does: `setBlacklist` gates `deposit`
    ///           directly, takes 200 addresses per call, and `PoGRegistered` is
    ///           on-chain, so the attested wallets funding a live raise can be
    ///           enumerated and blocked mid-window. The boundary this function
    ///           draws is real and worth keeping; the claim about what the owner
    ///           cannot do was not this function's to make.
    ///
    ///         What no owner power reaches is money already committed: `refund`,
    ///         `claimGenesis` and `claimReferralReward` live on the hook and read
    ///         no pause, no halt and no blacklist. A banned depositor still gets
    ///         their quote asset back.
    ///
    ///         `registerPoG` stays gated because it mints new spending budget
    ///         against an oracle signature, which is the one thing that needs a
    ///         faster brake than `setPogSigner` if the signer key leaks.  It
    ///         blocks new entrants only; committed quote and existing quota are
    ///         untouched.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Permanently disabled. Ownership can be TRANSFERRED but never
    ///         abandoned.
    ///
    /// @dev    ⚠ THE INHERITED VERSION WAS A ONE-CALL, UNCONFIRMED, IRREVERSIBLE
    ///           LOSS OF EVERY BRAKE ON THIS CONTRACT, sitting next to a transfer
    ///           path deliberately built as two steps. `Ownable2Step` makes
    ///           `transferOwnership` propose-then-accept so a typo cannot strand
    ///           the factory on an address nobody holds — and then inherits
    ///           `renounceOwnership` from `Ownable`, where a single transaction
    ///           sets the owner to zero with no confirmation and no way back.
    ///
    ///         What that would cost here is not abstract. It is `pause`,
    ///         `setBlacklist`, `haltLadder`, `setPogSigner` and
    ///         the rest of the owner-gated surface — the emergency stops, gone,
    ///         on a live launchpad holding user quote.
    ///
    ///         Reverting costs nothing real, because renouncing was never a thing
    ///         this protocol wants to do. The endpoint of the handoff is a Safe,
    ///         not the zero address; "no admin" is a strictly worse state than
    ///         "admin is a multisig that chooses not to act".
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
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

    // ─── Deposit freeze ───────────────────────────────────────────────────────
    //
    // `pause()` deliberately leaves open rounds taking deposits. This is the
    // brake for when they should not: scoped like the ladder halt, with
    // `address(0)` meaning every project. It reaches `deposit` only — refund,
    // claims and `launch` read nothing here, so committed quote is never
    // trapped. It does not expire, because the worst it can do is let a round
    // close small and fall through to refunds.

    /// @notice Every project's deposits are frozen.
    bool public globalDepositsPaused;

    /// @notice Per-hook deposit freeze.
    mapping(address hook => bool) public hookDepositsPaused;

    event DepositsPausedSet(address indexed hook, bool paused);

    error DepositsPaused();

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

    /// @notice Open `hook`'s pool once its genesis window has closed.
    ///
    /// @dev    The hook accepts `launch` from this factory only, so the right to
    ///         launch follows the factory's CURRENT owner. A Safe rotated after
    ///         `createLaunch` can still open the rounds created before it.
    function launch(address hook) external onlyOwner {
        if (!registeredHooks[hook]) revert HookNotRegistered();
        ToshLaunchpadHook(payable(hook)).launch();
    }

    /// @notice Freeze or unfreeze deposits into `hook`, or into every project
    ///         when `hook == address(0)`.
    function setDepositsPaused(address hook, bool paused_) external onlyOwner {
        if (hook == address(0)) {
            globalDepositsPaused = paused_;
        } else {
            hookDepositsPaused[hook] = paused_;
        }
        emit DepositsPausedSet(hook, paused_);
    }

    /// @notice Whether `hook` currently refuses deposits.
    function depositsPaused(address hook) public view returns (bool) {
        return globalDepositsPaused || hookDepositsPaused[hook];
    }

    /// @notice Set `users`' PoG quota outright — lower, revoke with 0, or raise.
    ///
    /// @dev    `registerPoG` only ever raises quota, so this is the only way
    ///         down short of a blacklist. It also bumps each user's nonce:
    ///         otherwise a signature issued before the cut but not yet
    ///         submitted would restore the old figure.
    function setPogQuota(address[] calldata users, uint256 quota) external onlyOwner {
        require(users.length <= 200, "Batch too large");
        if (quota > maxPogAllocationLimit) revert ExceedsGlobalPogLimit();
        for (uint256 i; i < users.length; ++i) {
            pogQuota[users[i]] = quota;
            pogNonces[users[i]]++;
            emit PoGRegistered(users[i], quota);
        }
    }

    function setPogSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "zero signer");
        pogSigner = newSigner;
        emit PogSignerUpdated(newSigner);
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

    /// @notice Retune the platform-wide PoG attestation ceiling.
    ///
    /// @dev    Floored at 1 base unit: at zero every attestation would revert
    ///         `ExceedsGlobalPogLimit`, which closes the deposit entrance for
    ///         new wallets with nothing in the event to suggest it. Pausing is
    ///         the supported way to stop taking on wallets; see `pause()`.
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
    ///         with.  Their 8 % orphans to the platform.  The playbook
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

    /// @notice Deploy a new launch: hook, token, Circuit NFT and revenue vault,
    ///         with the parameters the platform approved on its review form.
    ///
    /// @dev    OWNER ONLY. The platform reviews every project off chain and is
    ///         the only party that can list one, so the caller is always the
    ///         owner Safe. That Safe is recorded as the hook's `creator`, but
    ///         launching goes through `launch(hook)` and follows whoever owns
    ///         the factory then. If nobody launches within `LAUNCH_WINDOW` the
    ///         round opens for refunds.
    ///
    ///         The developer receives the project's Circuit NFT. The vault it
    ///         controls is the hook's `projectAdmin`, the permanent payee of 99 %
    ///         of every shelf sale. The developer address is also baked into the
    ///         hook as `projectTreasury`, an unalterable record of who the
    ///         platform listed.
    ///
    ///         `finalSalt` still binds the hook address to `msg.sender`. With a
    ///         single permitted caller that no longer defends against a rival
    ///         creator, but it keeps the address predictable from
    ///         `hookInitcodeHash` and `predictHookAddress` unchanged.
    ///
    /// @param  developer       Receives the Circuit NFT.
    /// @param  hardCap         Most the genesis round may raise in total, in
    ///                         quote base units. `MIN_HARD_CAP`..`MAX_HARD_CAP`,
    ///                         or 0 for no cap (stored as `UNCAPPED`).
    /// @param  walletCap       Most one wallet may deposit into this round.
    ///                         Non-zero and at most `hardCap`; at most
    ///                         `MAX_HARD_CAP` when uncapped.
    /// @param  genesisDuration One of the hook's three rungs (3 h / 24 h / 72 h);
    ///                         `initializeToken` rejects anything else.
    function createLaunch(
        string calldata name,
        string calldata symbol,
        address developer,
        bytes32 hookSalt,
        uint256 hardCap,
        uint256 walletCap,
        uint256 genesisDuration
    ) external onlyOwner whenNotPaused nonReentrant returns (address token, address hook) {
        if (developer == address(0)) revert InvalidDeveloper();
        if (hardCap == 0) {
            if (walletCap == 0 || walletCap > MAX_HARD_CAP) revert InvalidWalletCap();
            hardCap = UNCAPPED;
        } else {
            if (hardCap < MIN_HARD_CAP) revert HardCapTooLow();
            if (hardCap > MAX_HARD_CAP) revert HardCapTooHigh();
            if (walletCap == 0 || walletCap > hardCap) revert InvalidWalletCap();
        }

        // ── Squat defence ─────────────────────────────────────────────────────
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyName();
        bytes32 nameKey = keccak256(abi.encode(name, symbol));
        if (nameTaken[nameKey]) revert NameTaken();

        bytes32 finalSalt = keccak256(abi.encode(msg.sender, hookSalt));
        hook = ToshCloneLib.deployHook(
            finalSalt, hookImplementation, msg.sender, developer, hardCap, walletCap, genesisDuration
        );
        if (hook == address(0)) revert DeployFailed();

        // Ground so the token sorts ABOVE the quote asset, which is what keeps
        // the quote side as `currency0` in this project's pool. `nameKey` seeds
        // the grind because it is already unique per factory, and because it
        // makes the resulting address predictable from the name alone. See
        // `ToshCloneLib.deployBareCloneAbove`. The winning salt is dropped
        // because `predictBareClone` reproduces it from `nameKey`.
        (token,) = ToshCloneLib.deployBareCloneAbove(tokenImplementation, address(quoteAsset), nameKey);
        // Belt to the grind's braces: the invariant 91 sites in the hook depend
        // on is asserted rather than argued.
        if (token <= address(quoteAsset)) revert TokenBelowQuoteAsset();
        ToshToken(token).initialize(hook, name, symbol);

        uint256 tokenId = CircuitNFT(circuitNFT).mint(developer);
        address revenueVault = ToshCloneLib.deployVaultClone(vaultImplementation, tokenId);
        ToshLaunchpadHook(payable(hook)).initializeToken(token, revenueVault);

        registeredHooks[hook] = true;
        tokenToHook[token] = hook;
        nameTaken[nameKey] = true;
        hookNameKey[hook] = nameKey;
        circuitOf[hook] = tokenId;
        hookOfCircuit[tokenId] = hook;

        uint256 launchId = launches.length;
        launches.push(LaunchInfo(token, hook, msg.sender, block.timestamp));

        emit LaunchCreated(launchId, token, hook, msg.sender, name, symbol);
        emit CircuitIssued(tokenId, hook, developer, revenueVault);
    }

    /// @notice The revenue vault a Circuit token would control, for tooling that
    ///         wants the address before or without reading the hook.
    function predictVaultAddress(uint256 tokenId) external view returns (address) {
        return ToshCloneLib.predictVaultClone(address(this), vaultImplementation, tokenId);
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
        if (depositsPaused(hook)) revert DepositsPaused();
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
    ///         dead, i.e. the hook's own refund path has opened — either
    ///         because the raise closed too small to carry a ladder, or
    ///         because the 7-day launch window lapsed unused.  This reads
    ///         `canRefund()` rather than a clock precisely so that it does not
    ///         have to know which door opened.
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
        if (block.timestamp < blacklistedUntil[user] || pogQuota[user] == 0 || depositsPaused(hook)) {
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
    /// @dev    `projectAdmin` is not an argument: it is set by
    ///         `initializeToken` and is not committed to by the hook's address.
    ///         `projectTreasury` is the launch's developer address. `hardCap`
    ///         is taken as `createLaunch` takes it, so 0 predicts `UNCAPPED`.
    function hookInitcodeHash(
        address projectTreasury,
        address creator_,
        uint256 hardCap,
        uint256 perWalletCap,
        uint256 genesisDuration
    ) external view returns (bytes32) {
        return ToshCloneLib.initcodeHash(
            hookImplementation, creator_, projectTreasury, _storedHardCap(hardCap), perWalletCap, genesisDuration
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
        uint256 hardCap,
        uint256 perWalletCap,
        uint256 genesisDuration,
        bytes32 rawSalt
    ) external view returns (bool) {
        if (!registeredHooks[hook]) return false;
        bytes32 initcodeHash_ = ToshCloneLib.initcodeHash(
            hookImplementation, creator_, projectTreasury, _storedHardCap(hardCap), perWalletCap, genesisDuration
        );
        bytes32 finalSalt = keccak256(abi.encode(creator_, rawSalt));
        return HookAddress.computeAddress(address(this), finalSalt, initcodeHash_) == hook;
    }

    // ─── Internals ────────────────────────────────────────────────────────────

    function _storedHardCap(uint256 hardCap) internal pure returns (uint256) {
        return hardCap == 0 ? UNCAPPED : hardCap;
    }

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
