// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step} from "../../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {Ownable} from "../../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "../../lib/openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "../../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

import {IERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ToshToken} from "../ToshToken.sol";
import {ToshLaunchpadHookV3} from "./ToshLaunchpadHookV3.sol";
import {HookAddress} from "../libraries/HookAddress.sol";
import {ToshCloneLib} from "../libraries/ToshCloneLib.sol";
import {CircuitNFT} from "../CircuitNFT.sol";
import {AgentIdLib} from "../libraries/AgentIdLib.sol";

/// @title  ToshFactoryV3 (ToshX v2)
/// @notice Platform singleton for ONE quote asset: deploys launches and holds
///         the platform's brakes. BNB and USDT projects each have their own
///         factory, treasury and Circuit collection; the bid book is shared.
///
/// ── What v2 removed ─────────────────────────────────────────────────────────
///
///   Proof-of-Gas, the referral registries and the genesis deposit gateway are
///   gone. Genesis eligibility is a Binance Agent ID read on-chain by the hook
///   itself, buyers pay the hook directly, and the hook launches itself: the
///   Circuit NFT holder may do it for 48 h after the sale ends, anyone after
///   that. There is no owner-gated `launch` any more, so no platform action —
///   pause, blacklist, halt or simply going quiet — can keep a pool closed.
///
/// ── What the owner can still do ─────────────────────────────────────────────
///
///   • `createLaunch` — list a reviewed project (the platform remains the only
///     party that can list).
///   • `pause` — stop listing new projects.
///   • `setGenesisPaused` / `setBlacklist` — stop genesis buys for a project,
///     every project, or a wallet. Never touches tokens already bought,
///     transfers, the bid book or `launch`.
///   • `haltLadderMinting` — the shelf brake, at most 7 days per arm.
///   • Bounds on the hard cap and per-ID cap future launches may choose.
contract ToshFactoryV3 is Ownable2Step, Pausable, ReentrancyGuard {
    // ─── Constants ────────────────────────────────────────────────────────────

    /// @notice Floor no hard-cap bound may go under. At 1e12 base units the
    ///         first shelf already sits at 2e12·1e18/7e24 ≈ 2.9e5, three orders
    ///         clear of the ~526 below which the ladder's first step truncates.
    uint256 public constant ABS_MIN_HARD_CAP = 1e12;

    /// @notice The clone packs caps into 128 bits.
    uint256 public constant ABS_MAX_CAP = type(uint128).max;

    /// @notice Longest a single ladder halt may run before it lapses.
    uint256 public constant MAX_HALT_DURATION = 7 days;

    // ─── Immutables ───────────────────────────────────────────────────────────

    address public immutable poolManager;
    address public immutable vault;
    address payable public immutable ladderTreasury;

    /// @notice This factory's quote asset (WBNB or USDT) and `currency0` of
    ///         every pool it creates. Every project token is ground above it.
    IERC20 public immutable quoteAsset;

    /// @notice Receives the 0.30 % buy-side platform cut and the launch-time
    ///         surplus. Immutable so live fee routing cannot be retargeted.
    address public immutable platformTreasury;

    /// @notice The shared bid book, the one spender a token admits before launch.
    address public immutable bidBook;

    /// @notice Binance Agent ID registry the hooks read eligibility from.
    address public immutable agentRegistry;

    /// @notice Smallest genesis buy and smallest bid, in quote units.
    uint256 public immutable minBuy;

    /// @notice Whether this factory's quote asset is WBNB.
    bool public immutable acceptsNative;

    /// @notice Runtime code hash of the hook implementation, for checking the
    ///         deployed build against the audited source off-chain.
    bytes32 public immutable HOOK_RUNTIME_CODEHASH;
    address public immutable hookImplementation;
    address public immutable tokenImplementation;
    address public immutable circuitNFT;
    address public immutable vaultImplementation;

    // ─── Owner-controlled bounds ──────────────────────────────────────────────

    /// @notice Range a new launch's hard cap must fall in. Frozen into each
    ///         hook at creation, so retuning never touches a live round.
    uint256 public minHardCap;
    uint256 public maxHardCap;

    /// @notice Range a new launch's per-Agent-ID cap must fall in.
    uint256 public minAgentCap;
    uint256 public maxAgentCap;

    // ─── Brakes ───────────────────────────────────────────────────────────────

    mapping(address => uint256) public blacklistedUntil;

    bool public globalGenesisPaused;
    mapping(address hook => bool) public hookGenesisPaused;

    uint256 public globalLadderHaltedUntil;
    mapping(address hook => uint256 until) public hookLadderHaltedUntil;

    // ─── Launch registry ──────────────────────────────────────────────────────

    struct LaunchInfo {
        address token;
        address hook;
        address creator;
        uint256 createdAt;
    }

    LaunchInfo[] public launches;
    mapping(address => bool) public registeredHooks;

    /// @notice Most quote one Agent ID may spend on one project's shelves,
    ///         over the whole ladder. The owner can change it, and a change
    ///         applies to every project at once.
    uint256 public shelfCapPerAgent;

    /// @notice Quote spent on `hook`'s shelves per Agent ID, keyed like the
    ///         genesis allowance by `keccak256(handle)`. Separate from genesis:
    ///         the ladder starts every ID from zero.
    mapping(address hook => mapping(bytes32 agentKey => uint256)) public shelfSpentByAgent;

    /// @notice Quote spent on `hook`'s shelves per wallet. The allowance is
    ///         booked against the larger of this and `shelfSpentByAgent`, so
    ///         moving to another ID does not start a fresh one.
    mapping(address hook => mapping(address wallet => uint256)) public shelfSpentByWallet;
    mapping(address => address) public tokenToHook;
    mapping(bytes32 => bool) public nameTaken;
    mapping(address => bytes32) public hookNameKey;
    mapping(address hook => uint256 tokenId) public circuitOf;
    mapping(uint256 tokenId => address hook) public hookOfCircuit;

    // ─── Events ───────────────────────────────────────────────────────────────

    event LaunchCreated(
        uint256 indexed launchId,
        address indexed token,
        address indexed hook,
        address creator,
        string name,
        string symbol
    );
    event LaunchParams(
        address indexed hook, uint256 hardCap, uint256 perAgentCap, uint256 genesisDuration, address projectFund
    );
    event CircuitIssued(uint256 indexed tokenId, address indexed hook, address indexed developer, address vault);
    event NameReleased(address indexed hook, bytes32 indexed nameKey);
    event Blacklisted(address indexed user, uint256 untilTimestamp);
    event GenesisPausedSet(address indexed hook, bool paused);
    event LadderMintingHalted(address indexed hook, uint256 until);
    event LadderMintingResumed(address indexed hook);
    event HardCapBoundsSet(uint256 min, uint256 max);
    event AgentCapBoundsSet(uint256 min, uint256 max);
    event ShelfCapSet(uint256 cap);
    event ShelfMintBooked(address indexed hook, bytes32 indexed agentKey, address indexed buyer, uint256 cost);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error OwnershipCannotBeRenounced();
    error ZeroAddress();
    error HookNotRegistered();
    error DeployFailed();
    error InvalidDeveloper();
    error HardCapOutOfBounds();
    error AgentCapOutOfBounds();
    error InvalidBounds();
    error NameTaken();
    error EmptyName();
    error NameStillHeld();
    error TokenBelowQuoteAsset();
    error HaltDurationTooLong();
    error ImplementationMismatch();
    error OnlyCircuit();
    error InvalidShelfCap();
    error LadderHalted();
    error NoAgentId();
    error ShelfCapExceeded();

    // ─── Constructor ──────────────────────────────────────────────────────────

    struct Config {
        address hookImplementation;
        address poolManager;
        address vault;
        address platformTreasury;
        address ladderTreasury;
        address quoteAsset;
        address bidBook;
        address agentRegistry;
        uint256 minBuy;
        bool acceptsNative;
        uint256 minHardCap;
        uint256 maxHardCap;
        uint256 minAgentCap;
        uint256 maxAgentCap;
        uint256 shelfCapPerAgent;
    }

    /// @dev The hook implementation is too large to embed here, so it is
    ///      deployed first against this factory's predicted address and then
    ///      checked field by field: a mis-wired pair cannot be constructed.
    constructor(Config memory c) Ownable(msg.sender) {
        if (
            c.poolManager == address(0) || c.vault == address(0) || c.platformTreasury == address(0)
                || c.ladderTreasury == address(0) || c.quoteAsset == address(0) || c.bidBook == address(0)
                || c.agentRegistry == address(0) || c.minBuy == 0
        ) revert ZeroAddress();

        poolManager = c.poolManager;
        vault = c.vault;
        platformTreasury = c.platformTreasury;
        ladderTreasury = payable(c.ladderTreasury);
        quoteAsset = IERC20(c.quoteAsset);
        bidBook = c.bidBook;
        agentRegistry = c.agentRegistry;
        minBuy = c.minBuy;
        acceptsNative = c.acceptsNative;

        _setHardCapBounds(c.minHardCap, c.maxHardCap);
        _setAgentCapBounds(c.minAgentCap, c.maxAgentCap);
        _setShelfCapPerAgent(c.shelfCapPerAgent);

        ToshLaunchpadHookV3 impl = ToshLaunchpadHookV3(payable(c.hookImplementation));
        if (
            c.hookImplementation.code.length == 0 || impl.factory() != address(this)
                || address(impl.poolManager()) != c.poolManager || address(impl.vault()) != c.vault
                || address(impl.quoteAsset()) != c.quoteAsset || impl.ladderTreasury() != c.ladderTreasury
                || impl.platformFeeRecipient() != c.platformTreasury || impl.agentRegistry() != c.agentRegistry
                || impl.minBuy() != c.minBuy || impl.acceptsNative() != c.acceptsNative
        ) revert ImplementationMismatch();
        hookImplementation = c.hookImplementation;
        HOOK_RUNTIME_CODEHASH = c.hookImplementation.codehash;

        tokenImplementation = address(new ToshToken(address(this), c.bidBook));

        CircuitNFT circuit = new CircuitNFT(address(this), c.quoteAsset);
        circuitNFT = address(circuit);
        vaultImplementation = circuit.vaultImplementation();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Owner admin
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Stop listing new projects. Nothing already listed is affected.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disabled: ownership can move to another Safe but never to nobody,
    ///         which would strand every brake.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }

    function setHardCapBounds(uint256 min_, uint256 max_) external onlyOwner {
        _setHardCapBounds(min_, max_);
    }

    function setAgentCapBounds(uint256 min_, uint256 max_) external onlyOwner {
        _setAgentCapBounds(min_, max_);
    }

    function setShelfCapPerAgent(uint256 cap) external onlyOwner {
        _setShelfCapPerAgent(cap);
    }

    function _setShelfCapPerAgent(uint256 cap) private {
        if (cap < minBuy || cap > ABS_MAX_CAP) revert InvalidShelfCap();
        shelfCapPerAgent = cap;
        emit ShelfCapSet(cap);
    }

    function _setHardCapBounds(uint256 min_, uint256 max_) private {
        if (min_ < ABS_MIN_HARD_CAP || max_ < min_ || max_ > ABS_MAX_CAP) revert InvalidBounds();
        minHardCap = min_;
        maxHardCap = max_;
        emit HardCapBoundsSet(min_, max_);
    }

    function _setAgentCapBounds(uint256 min_, uint256 max_) private {
        if (min_ < minBuy || max_ < min_ || max_ > ABS_MAX_CAP) revert InvalidBounds();
        minAgentCap = min_;
        maxAgentCap = max_;
        emit AgentCapBoundsSet(min_, max_);
    }

    // ─── Genesis brakes ───────────────────────────────────────────────────────

    /// @notice Stop or resume genesis buys on `hook`, or on every project when
    ///         `hook == address(0)`. Tokens already bought, transfers, the bid
    ///         book and `launch` are untouched.
    function setGenesisPaused(address hook, bool paused_) external onlyOwner {
        if (hook == address(0)) {
            globalGenesisPaused = paused_;
        } else {
            hookGenesisPaused[hook] = paused_;
        }
        emit GenesisPausedSet(hook, paused_);
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

    /// @notice Whether `user` may not buy genesis on `hook` right now. Read by
    ///         the hook's `buyGenesis` and nowhere else.
    function genesisBlocked(address hook, address user) external view returns (bool) {
        return globalGenesisPaused || hookGenesisPaused[hook] || block.timestamp < blacklistedUntil[user];
    }

    // ─── Ladder halt ──────────────────────────────────────────────────────────

    /// @notice Suspend shelf minting for `duration` seconds on `hook`, or every
    ///         project when `hook == address(0)`. Lapses on its own.
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

    function resumeLadderMinting(address hook) external onlyOwner {
        if (hook == address(0)) {
            globalLadderHaltedUntil = 0;
        } else {
            hookLadderHaltedUntil[hook] = 0;
        }
        emit LadderMintingResumed(hook);
    }

    function ladderMintingHalted(address hook) public view returns (bool) {
        return block.timestamp < globalLadderHaltedUntil || block.timestamp < hookLadderHaltedUntil[hook];
    }

    // ─── Shelf allowance ──────────────────────────────────────────────────────

    /// @notice Called by a hook's `mintBondingCurve` once it knows what the
    ///         mint costs. Reverts if minting is halted on that hook, if
    ///         `buyer` has no Agent ID, or if `cost` would take the ID past
    ///         `shelfCapPerAgent` on that hook; otherwise books it.
    function bookShelfMint(address buyer, uint256 cost) external {
        if (!registeredHooks[msg.sender]) revert HookNotRegistered();
        if (ladderMintingHalted(msg.sender)) revert LadderHalted();
        bytes32 key = AgentIdLib.agentKeyOf(agentRegistry, buyer);
        if (key == bytes32(0)) revert NoAgentId();
        uint256 total = _shelfSpent(msg.sender, key, buyer) + cost;
        if (total > shelfCapPerAgent) revert ShelfCapExceeded();
        shelfSpentByAgent[msg.sender][key] = total;
        shelfSpentByWallet[msg.sender][buyer] = total;
        emit ShelfMintBooked(msg.sender, key, buyer, cost);
    }

    /// @notice Quote `account` may still spend on `hook`'s shelves; zero
    ///         without an Agent ID.
    function shelfRemaining(address hook, address account) external view returns (uint256) {
        bytes32 key = AgentIdLib.agentKeyOf(agentRegistry, account);
        if (key == bytes32(0)) return 0;
        uint256 spent = _shelfSpent(hook, key, account);
        uint256 cap = shelfCapPerAgent;
        return spent >= cap ? 0 : cap - spent;
    }

    function _shelfSpent(address hook, bytes32 key, address wallet) private view returns (uint256) {
        uint256 byAgent = shelfSpentByAgent[hook][key];
        uint256 byWallet = shelfSpentByWallet[hook][wallet];
        return byWallet > byAgent ? byWallet : byAgent;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Launch creation
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Deploy a reviewed project: hook, token, Circuit NFT and revenue
    ///         vault.
    ///
    /// @param  developer       Receives the Circuit NFT, and with it the right
    ///                         to launch in the exclusive window, the project
    ///                         fund and 19 % of shelf revenue.
    /// @param  projectFund     First recipient of the 20 % genesis share; the
    ///                         NFT holder can change it later.
    /// @param  hardCap         Quote raised when the sale sells out (P = H/2.25M).
    /// @param  perAgentCap     Most quote one Agent ID may spend.
    /// @param  genesisDuration 3 h, 24 h or 72 h.
    function createLaunch(
        string calldata name,
        string calldata symbol,
        address developer,
        address projectFund,
        bytes32 hookSalt,
        uint256 hardCap,
        uint256 perAgentCap,
        uint256 genesisDuration
    ) external onlyOwner whenNotPaused nonReentrant returns (address token, address hook) {
        if (developer == address(0)) revert InvalidDeveloper();
        if (projectFund == address(0)) revert ZeroAddress();
        if (hardCap < minHardCap || hardCap > maxHardCap) revert HardCapOutOfBounds();
        if (perAgentCap < minAgentCap || perAgentCap > maxAgentCap || perAgentCap > hardCap) {
            revert AgentCapOutOfBounds();
        }

        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyName();
        bytes32 nameKey = keccak256(abi.encode(name, symbol));
        if (nameTaken[nameKey]) revert NameTaken();

        bytes32 finalSalt = keccak256(abi.encode(msg.sender, hookSalt));
        {
            // Predicted before deploy so a revert cannot leave an orphan clone.
            bytes32 initHash = ToshCloneLib.initcodeHash(
                hookImplementation, msg.sender, developer, hardCap, perAgentCap, genesisDuration
            );
            if (projectFund == HookAddress.computeAddress(address(this), finalSalt, initHash)) {
                revert ZeroAddress();
            }
        }
        hook = ToshCloneLib.deployHook(
            finalSalt, hookImplementation, msg.sender, developer, hardCap, perAgentCap, genesisDuration
        );
        if (hook == address(0)) revert DeployFailed();

        // Ground above the quote asset so it is always `currency0`.
        (token,) = ToshCloneLib.deployBareCloneAbove(tokenImplementation, address(quoteAsset), nameKey);
        if (token <= address(quoteAsset)) revert TokenBelowQuoteAsset();
        ToshToken(token).initialize(hook, name, symbol);

        uint256 tokenId = CircuitNFT(circuitNFT).mint(developer);
        address revenueVault = ToshCloneLib.deployVaultClone(vaultImplementation, tokenId);
        ToshLaunchpadHookV3(payable(hook)).initializeToken(token, revenueVault, projectFund);

        registeredHooks[hook] = true;
        tokenToHook[token] = hook;
        nameTaken[nameKey] = true;
        hookNameKey[hook] = nameKey;
        circuitOf[hook] = tokenId;
        hookOfCircuit[tokenId] = hook;

        uint256 launchId = launches.length;
        launches.push(LaunchInfo(token, hook, msg.sender, block.timestamp));

        emit LaunchCreated(launchId, token, hook, msg.sender, name, symbol);
        emit LaunchParams(hook, hardCap, perAgentCap, genesisDuration, projectFund);
        emit CircuitIssued(tokenId, hook, developer, revenueVault);
    }

    /// @notice Hand a name back once its launch is provably dead: genesis closed
    ///         with nothing raised, so `launch()` can never run. Permissionless.
    function releaseAbandonedName(address hook) external {
        if (!registeredHooks[hook]) revert HookNotRegistered();
        bytes32 key = hookNameKey[hook];
        if (key == bytes32(0)) revert NameStillHeld();
        ToshLaunchpadHookV3 h = ToshLaunchpadHookV3(payable(hook));
        if (h.raised() != 0 || block.timestamp < h.genesisDeadline()) revert NameStillHeld();

        delete hookNameKey[hook];
        nameTaken[key] = false;
        emit NameReleased(hook, key);
    }

    /// @notice Called by the Circuit NFT on every transfer: pay the 20 % genesis
    ///         fund to the seller's chosen address and point it at the buyer.
    function settleProjectFund(uint256 tokenId, address newFund) external {
        if (msg.sender != circuitNFT) revert OnlyCircuit();
        address hook = hookOfCircuit[tokenId];
        if (hook == address(0)) revert HookNotRegistered();
        ToshLaunchpadHookV3(payable(hook)).settleProjectFund(newFund);
    }

    /// @notice Free a live launch's name for reuse. Owner only.
    /// @dev    For a launch the platform did not mean to list. Through
    ///         `ToshLaunchGateway` any single Safe signer can `createLaunch`,
    ///         and one genesis buy puts the name out of `releaseAbandonedName`'s
    ///         reach for good. The launch itself is untouched; only its claim
    ///         on the name goes. `execute` keeps this with the Safe as a whole.
    function releaseName(address hook) external onlyOwner {
        if (!registeredHooks[hook]) revert HookNotRegistered();
        bytes32 key = hookNameKey[hook];
        if (key == bytes32(0)) revert NameStillHeld();

        delete hookNameKey[hook];
        nameTaken[key] = false;
        emit NameReleased(hook, key);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Views
    // ══════════════════════════════════════════════════════════════════════════

    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    function predictVaultAddress(uint256 tokenId) external view returns (address) {
        return ToshCloneLib.predictVaultClone(address(this), vaultImplementation, tokenId);
    }

    /// @notice The initcode hash a caller predicts a hook's address from.
    function hookInitcodeHash(
        address projectTreasury,
        address creator_,
        uint256 hardCap,
        uint256 perAgentCap,
        uint256 genesisDuration
    ) external view returns (bytes32) {
        return ToshCloneLib.initcodeHash(
            hookImplementation, creator_, projectTreasury, hardCap, perAgentCap, genesisDuration
        );
    }

    function predictHookAddress(address creator_, bytes32 rawSalt, bytes32 initcodeHash_)
        external
        view
        returns (address)
    {
        return HookAddress.computeAddress(address(this), keccak256(abi.encode(creator_, rawSalt)), initcodeHash_);
    }

    function verifyHookDeployment(
        address hook,
        address creator_,
        address projectTreasury,
        uint256 hardCap,
        uint256 perAgentCap,
        uint256 genesisDuration,
        bytes32 rawSalt
    ) external view returns (bool) {
        if (!registeredHooks[hook]) return false;
        bytes32 initcodeHash_ = ToshCloneLib.initcodeHash(
            hookImplementation, creator_, projectTreasury, hardCap, perAgentCap, genesisDuration
        );
        bytes32 finalSalt = keccak256(abi.encode(creator_, rawSalt));
        return HookAddress.computeAddress(address(this), finalSalt, initcodeHash_) == hook;
    }
}
