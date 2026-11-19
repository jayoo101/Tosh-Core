// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "../../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "../../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "../../lib/openzeppelin-contracts/contracts/utils/math/Math.sol";
import {AgentIdLib} from "../libraries/AgentIdLib.sol";
import {OuroborosToken} from "./OuroborosToken.sol";
import {OuroborosBidBook} from "./OuroborosBidBook.sol";
import {IPancakeV2Pair, IPancakeV2Router, IChainlinkFeed, IOuroborosSafe} from "./interfaces/IOuroborosExternal.sol";

/// @title  OuroborosMint
/// @notice L1 seeding, launch, L1 claims, pool seeding and L2 expansion.
///
///         L1    2 hours, 0.9 USDT a share, no total cap. When it closes, 5/9
///               of the 21 B supply is minted and split pro rata over L1
///               shares; 80 % of the L1 USDT is held here.
///         L1.5  Minting closed; the pair is empty and closed (see
///               `OuroborosToken`); the bid book is the only market.
///         L2    From `l2Start` a Safe signer calls `seedPool` with an opening
///               price, normally the L1.5 market's. The held USDT goes in
///               whole; tokens go in at that price, never below L1's, so at
///               most the other 4/9 (see `seedPool`). The pair then opens to
///               trading. Ladder-priced shares. Each mint is settled in one
///               transaction: tokens priced at the pool (+1 %), 80 % of the
///               payment bought-and-added as liquidity, the same number of
///               tokens burned from the pair, the minted tokens claimable
///               after 180 seconds.
///
///         Every Agent ID — and every wallet — has 30 shares across L1 and L2.
///         Payment is USDT, or BNB converted to USDT at a Chainlink quote +1 %.
///
///         The owner (the project Safe) can pause and resume minting. Nothing
///         else is adjustable: prices, quotas, splits and timings are fixed.
contract OuroborosMint is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant L1_DURATION = 2 hours;
    uint256 public constant L1_PRICE = 0.9 ether;
    uint256 public constant MAX_SHARES_PER_ID = 30;
    uint256 public constant L2_TOTAL_SHARES = 21_000_000;
    uint256 public constant VEST_DELAY = 180;

    uint256 public constant TREASURY_BPS = 2_000;
    uint256 public constant L2_BONUS_BPS = 10_100;
    /// @dev One L2 mint may cost at most this share of the pair's USDT reserve.
    ///      Above it, pushing the price down and minting in one transaction pays.
    uint256 public constant MAX_MINT_POOL_BPS = 1_000;
    uint256 public constant BNB_QUOTE_BPS = 10_100;
    uint256 private constant BPS = 10_000;

    /// @dev PancakeSwap V2 charges 0.25 %: 9975 / 10000 of the input trades.
    uint256 private constant PAIR_FEE_NUM = 9_975;

    uint256 public constant L1_ALLOCATION = 11_666_666_667 ether;
    uint256 public constant POOL_ALLOCATION = 21_000_000_000 ether - L1_ALLOCATION;

    /// @dev The equal burn never takes the pair's token reserve below this.
    uint256 public constant MIN_POOL_TOKENS = 1_000_000 ether;

    uint256 public constant FEED_MAX_AGE = 1 hours;

    /// @dev Below this share of the L1 raise traded on the bid book, the pool
    ///      opens at the L1 price whatever price the signer gives.
    uint256 public constant MIN_L15_VOLUME_BPS = 500;

    /// @dev After this long into L2 with the pool still unseeded, anyone may
    ///      seed it at the L1 price, so the held L1 USDT cannot stay stuck.
    uint256 public constant OPEN_SEED_DELAY = 3 days;

    /// @dev A Safe's `isOwner` is a mapping read; this is ample for it.
    uint256 private constant SAFE_PROBE_GAS = 50_000;

    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ── Immutables ───────────────────────────────────────────────────────────

    OuroborosToken public immutable token;
    IERC20 public immutable usdt;
    address public immutable wbnb;
    IPancakeV2Router public immutable router;
    IPancakeV2Pair public immutable pair;
    address public immutable agentRegistry;
    IChainlinkFeed public immutable bnbUsdFeed;
    address public immutable treasury;
    OuroborosBidBook public immutable bidBook;

    uint64 public immutable l1Start;
    uint64 public immutable l1End;
    uint64 public immutable l2Start;

    bool private immutable _tokenIsToken0;

    // ── State ────────────────────────────────────────────────────────────────

    bool public paused;
    bool public launched;
    bool public launchFailed;
    bool public poolSeeded;

    mapping(bytes32 agentKey => uint256) public agentShares;
    mapping(address wallet => uint256) public walletShares;

    mapping(address => uint256) public l1SharesOf;
    mapping(address => bool) public l1Claimed;
    uint256 public totalL1Shares;
    uint256 public l1Reserve;

    /// @notice USDT wei per whole token the pool opened at, and the tokens it opened with.
    uint256 public seedPrice;
    uint256 public seedTokens;

    uint256 public l2Minted;
    uint256 public totalBurned;
    uint256 public pendingQuote;

    /// @dev One entry per L2 mint, in mint order, so each unlocks 180 s after
    ///      its own mint. A wallet mints at most `MAX_SHARES_PER_ID` times,
    ///      which bounds the queue a claim walks.
    struct Vest {
        uint128 amount;
        uint64 unlockAt;
    }

    mapping(address => Vest[]) private _vests;
    /// @dev Index of each wallet's first unclaimed entry.
    mapping(address => uint256) private _vestHead;
    uint256 public totalVesting;

    enum Phase {
        Pending,
        L1,
        AwaitLaunch,
        L1_5,
        L2,
        SoldOut,
        Failed
    }

    // ── Errors / events ──────────────────────────────────────────────────────

    error ZeroAddress();
    error BadSchedule();
    error WrongPhase();
    error Paused();
    error NotAWallet();
    error NoAgentId();
    error BadShares();
    error QuotaExceeded();
    error SoldOut();
    error CostAboveMax();
    error InsufficientBnb();
    error StaleFeed();
    error BelowMinTokens();
    error PoolDepleted();
    error MintTooLarge();
    error NothingToClaim();
    error RefundFailed();
    error NotSeeder();
    error PoolNotSeeded();
    error PriceTooHigh();
    error RenounceDisabled();

    event PausedSet(bool paused);
    event L1Minted(
        address indexed user, bytes32 indexed agentKey, uint256 shares, uint256 cost, bool paidInBnb, bytes32 ref
    );
    event Launch(uint256 l1Shares, uint256 l1Tokens);
    event PoolSeeded(uint256 poolUsdt, uint256 poolTokens, uint256 price, uint256 requestedPrice);
    event LaunchFailed();
    event L1Claimed(address indexed user, uint256 amount);
    event L2Minted(
        address indexed user,
        bytes32 indexed agentKey,
        uint256 shares,
        uint256 cost,
        uint256 tokens,
        uint256 burned,
        uint256 firstShare,
        bool paidInBnb,
        bytes32 ref
    );
    event LiquidityAdded(uint256 usdtIn, uint256 tokensIn, uint256 liquidity);
    event Claimed(address indexed user, uint256 amount);
    event BnbSurplus(uint256 usdt);

    struct Config {
        OuroborosToken token;
        address usdt;
        address wbnb;
        address router;
        address pair;
        address agentRegistry;
        address bnbUsdFeed;
        address treasury;
        address owner;
        uint64 l1Start;
        uint64 l2Start;
    }

    constructor(Config memory c) Ownable(c.owner) {
        if (
            address(c.token) == address(0) || c.usdt == address(0) || c.wbnb == address(0) || c.router == address(0)
                || c.pair == address(0) || c.agentRegistry == address(0) || c.bnbUsdFeed == address(0)
                || c.treasury == address(0)
        ) revert ZeroAddress();
        uint64 end = c.l1Start + uint64(L1_DURATION);
        if (c.l2Start <= end) revert BadSchedule();

        token = c.token;
        usdt = IERC20(c.usdt);
        wbnb = c.wbnb;
        router = IPancakeV2Router(c.router);
        pair = IPancakeV2Pair(c.pair);
        agentRegistry = c.agentRegistry;
        bnbUsdFeed = IChainlinkFeed(c.bnbUsdFeed);
        treasury = c.treasury;
        l1Start = c.l1Start;
        l1End = end;
        l2Start = c.l2Start;
        _tokenIsToken0 = IPancakeV2Pair(c.pair).token0() == address(c.token);
        bidBook = new OuroborosBidBook(address(c.token), c.usdt, address(this), c.treasury);
    }

    receive() external payable {
        if (msg.sender != address(router)) revert NotAWallet();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Owner
    // ══════════════════════════════════════════════════════════════════════════

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    /// @notice Disabled: without an owner nobody could pause, and only the
    ///         open seeding of `seedPool` could open the pool.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  L1
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Buy `shares` L1 shares at 0.9 USDT. Pays USDT unless BNB is
    ///         sent, in which case BNB is converted (see `quoteBnb`).
    /// @param  maxPay Most USDT to spend; ignored for BNB payments.
    /// @param  ref    Partner referral code, only logged; zero for none.
    function mintL1(uint256 shares, uint256 maxPay, bytes32 ref) external payable nonReentrant {
        if (phase() != Phase.L1) revert WrongPhase();
        if (paused) revert Paused();
        bytes32 key = _consumeQuota(shares);

        uint256 cost = shares * L1_PRICE;
        l1SharesOf[msg.sender] += shares;
        totalL1Shares += shares;
        _collect(cost, maxPay);

        uint256 toTreasury = cost * TREASURY_BPS / BPS;
        usdt.safeTransfer(treasury, toTreasury);
        l1Reserve += cost - toTreasury;
        emit L1Minted(msg.sender, key, shares, cost, msg.value != 0, ref);
    }

    /// @notice Closes L1 and opens L1 claims and the bid book. Anyone may call
    ///         once L1 ends. The pool is seeded later, by `seedPool`.
    function launch() external nonReentrant {
        if (launched || launchFailed || block.timestamp < l1End) revert WrongPhase();
        uint256 shares = totalL1Shares;
        if (shares == 0) {
            launchFailed = true;
            emit LaunchFailed();
            return;
        }
        launched = true;
        token.markLaunched();
        token.mint(address(this), L1_ALLOCATION);
        emit Launch(shares, L1_ALLOCATION);
    }

    /// @notice Seeds the official pair and opens it to trading, from `l2Start`.
    ///         Callable by the owner (the project Safe) or any one of its
    ///         signers; L2 minting waits for it. From `l2Start +
    ///         OPEN_SEED_DELAY` anyone may call it, and then the pool opens at
    ///         the L1 price whatever `price` is.
    /// @param  price USDT wei per whole token to open at. The pool opens at the
    ///         L1 price instead when `price` is below it, or when the bid book
    ///         traded less than `MIN_L15_VOLUME_BPS` of the L1 raise. Above
    ///         the L1 price, fewer than 4/9 of the tokens go in and the rest are
    ///         never minted.
    function seedPool(uint256 price) external nonReentrant {
        if (!launched || poolSeeded || block.timestamp < l2Start) revert WrongPhase();
        if (isSeeder(msg.sender)) {
            _seedPool(price);
        } else if (block.timestamp >= l2Start + OPEN_SEED_DELAY) {
            // A pause holds the pool shut too; unpausing is the owner's call.
            if (paused) revert Paused();
            _seedPool(0);
        } else {
            revert NotSeeder();
        }
    }

    /// @notice The L1 price per whole token, and whether the bid book has traded
    ///         enough for `seedPool` to open above it.
    function seedTerms() public view returns (uint256 l1Price, bool volumeMet) {
        l1Price = Math.mulDiv(totalL1Shares * L1_PRICE, 1 ether, L1_ALLOCATION);
        volumeMet = bidBook.filledUsdt() * BPS >= totalL1Shares * L1_PRICE * MIN_L15_VOLUME_BPS;
    }

    /// @notice Whether `account` may call `seedPool`: the owner, or a signer
    ///         of the owner when it is a Safe.
    function isSeeder(address account) public view returns (bool) {
        address o = owner();
        if (account == o) return true;
        if (o.code.length == 0) return false;
        // Gas-capped and strictly decoded: an owner that is not a Safe can
        // neither block open seeding nor make every caller a seeder.
        (bool ok, bytes memory ret) =
            o.staticcall{gas: SAFE_PROBE_GAS}(abi.encodeWithSelector(IOuroborosSafe.isOwner.selector, account));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }

    function _seedPool(uint256 requested) private {
        poolSeeded = true;

        // The pool's USDT must be exactly the held L1 USDT. USDT donated to the
        // pair and not synced is skimmed to the treasury; USDT already synced
        // into its reserve stands in for the same amount of L1 USDT, which
        // goes to the treasury instead.
        pair.skim(treasury);
        (uint256 donated,) = _reserves();
        uint256 reserve = l1Reserve;
        l1Reserve = 0;
        uint256 usdtIn = donated < reserve ? reserve - donated : 1;
        if (reserve > usdtIn) usdt.safeTransfer(treasury, reserve - usdtIn);

        uint256 poolUsdt = donated + usdtIn;
        uint256 par = Math.mulDiv(poolUsdt, 1 ether, POOL_ALLOCATION);
        (, bool volumeMet) = seedTerms();
        uint256 price = volumeMet && requested > par ? requested : par;
        uint256 tokens = price == par ? POOL_ALLOCATION : Math.mulDiv(poolUsdt, 1 ether, price);
        if (tokens < 10 * MIN_POOL_TOKENS) revert PriceTooHigh();
        seedPrice = price;
        seedTokens = tokens;

        token.mint(address(pair), tokens);
        usdt.safeTransfer(address(pair), usdtIn);
        uint256 liquidity = pair.mint(DEAD);
        token.markPoolOpened();

        emit PoolSeeded(poolUsdt, tokens, price, requested);
        emit LiquidityAdded(usdtIn, tokens, liquidity);
    }

    function l1TokensOf(address user) public view returns (uint256) {
        uint256 total = totalL1Shares;
        if (total == 0) return 0;
        return Math.mulDiv(l1SharesOf[user], L1_ALLOCATION, total);
    }

    function claimL1() external nonReentrant {
        if (!launched) revert WrongPhase();
        if (l1Claimed[msg.sender]) revert NothingToClaim();
        uint256 amount = l1TokensOf(msg.sender);
        if (amount == 0) revert NothingToClaim();
        l1Claimed[msg.sender] = true;
        IERC20(address(token)).safeTransfer(msg.sender, amount);
        emit L1Claimed(msg.sender, amount);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  L2
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Mint `shares` L2 shares at the ladder price.
    /// @param  maxPay    Most USDT to spend; ignored for BNB payments.
    /// @param  minTokens Slippage bound on the tokens credited.
    /// @param  ref       Partner referral code, only logged; zero for none.
    function mintL2(uint256 shares, uint256 maxPay, uint256 minTokens, bytes32 ref) external payable nonReentrant {
        if (phase() != Phase.L2) revert WrongPhase();
        if (paused) revert Paused();
        if (!poolSeeded) revert PoolNotSeeded();
        uint256 first = l2Minted + 1;
        if (l2Minted + shares > L2_TOTAL_SHARES) revert SoldOut();
        bytes32 key = _consumeQuota(shares);

        uint256 cost = ladderCost(l2Minted, shares);
        l2Minted += shares;
        _collect(cost, maxPay);

        try token.swapTaxes() {} catch {}

        (uint256 reserveUsdt,) = _reserves();
        if (cost * BPS > reserveUsdt * MAX_MINT_POOL_BPS) revert MintTooLarge();

        uint256 toTreasury = cost * TREASURY_BPS / BPS;
        usdt.safeTransfer(treasury, toTreasury);
        _autoLp(cost - toTreasury + pendingQuote);

        // Priced after the liquidity lands, so selling straight back cannot
        // capture the price rise this mint's own USDT causes.
        uint256 reserveToken;
        (reserveUsdt, reserveToken) = _reserves();
        uint256 tokens = Math.mulDiv(cost, reserveToken, reserveUsdt) * L2_BONUS_BPS / BPS;
        if (tokens < minTokens) revert BelowMinTokens();
        if (reserveToken < tokens + MIN_POOL_TOKENS) revert PoolDepleted();
        token.burnFromPair(tokens);
        pair.sync();
        totalBurned += tokens;

        token.mint(address(this), tokens);
        _lock(msg.sender, tokens);

        emit L2Minted(msg.sender, key, shares, cost, tokens, tokens, first, msg.value != 0, ref);
    }

    /// @notice Adds any USDT left queued by an earlier mint. Anyone may call.
    function flush() external nonReentrant {
        if (phase() != Phase.L2 && phase() != Phase.SoldOut) revert WrongPhase();
        _autoLp(pendingQuote);
    }

    // ── Vesting ──────────────────────────────────────────────────────────────

    /// @notice Tokens still locked, tokens claimable now, and when the last
    ///         locked entry unlocks (everything is claimable from then on).
    function vestOf(address user) external view returns (uint256 locked, uint256 claimable, uint256 unlockAt) {
        Vest[] storage q = _vests[user];
        for (uint256 i = _vestHead[user]; i < q.length; ++i) {
            if (block.timestamp >= q[i].unlockAt) claimable += q[i].amount;
            else locked += q[i].amount;
        }
        if (q.length != 0) unlockAt = q[q.length - 1].unlockAt;
    }

    function claim() external nonReentrant {
        Vest[] storage q = _vests[msg.sender];
        uint256 i = _vestHead[msg.sender];
        uint256 amount;
        while (i < q.length && block.timestamp >= q[i].unlockAt) {
            amount += q[i].amount;
            ++i;
        }
        if (amount == 0) revert NothingToClaim();
        _vestHead[msg.sender] = i;
        totalVesting -= amount;
        IERC20(address(token)).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function _lock(address user, uint256 amount) private {
        // `amount` was just minted, so the token CAP (2.1e28) bounds it far below 2^128.
        _vests[user].push(Vest({amount: uint128(amount), unlockAt: uint64(block.timestamp + VEST_DELAY)}));
        totalVesting += amount;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Views
    // ══════════════════════════════════════════════════════════════════════════

    function phase() public view returns (Phase) {
        if (launchFailed) return Phase.Failed;
        if (block.timestamp < l1Start) return Phase.Pending;
        if (block.timestamp < l1End) return Phase.L1;
        if (!launched) return Phase.AwaitLaunch;
        if (block.timestamp < l2Start) return Phase.L1_5;
        if (l2Minted >= L2_TOTAL_SHARES) return Phase.SoldOut;
        return Phase.L2;
    }

    /// @notice Price of L2 share number `n` (1-based), in USDT wei.
    function ladderPrice(uint256 n) public pure returns (uint256) {
        if (n <= 10_000) return 1.2 ether;
        if (n <= 20_000) return 1.28 ether + 0.08 ether * ((n - 10_001) / 1_000);
        if (n <= 100_000) return 2.08 ether + 0.016 ether * ((n - 20_001) / 1_000);
        if (n <= 1_000_000) return 3.36 ether + 0.016 ether * ((n - 100_001) / 10_000);
        if (n <= 5_000_000) return 4.8 ether + 0.02 ether * ((n - 1_000_001) / 20_000);
        return 8.8 ether + 0.02 ether * ((n - 5_000_001) / 50_000);
    }

    /// @notice Cost of `shares` L2 shares after `minted` have been sold.
    function ladderCost(uint256 minted, uint256 shares) public pure returns (uint256 cost) {
        for (uint256 i = 1; i <= shares; ++i) {
            cost += ladderPrice(minted + i);
        }
    }

    /// @notice Cost and estimated tokens for `shares` L2 shares right now.
    ///         `tokens` assumes the liquidity addition lands in full; it is 0
    ///         when the cost is above `MAX_MINT_POOL_BPS` of the pool.
    function quoteL2(uint256 shares) external view returns (uint256 cost, uint256 tokens) {
        cost = ladderCost(l2Minted, shares);
        if (!launched) return (cost, 0);
        (uint256 reserveUsdt, uint256 reserveToken) = _poolView();
        if (cost * BPS > reserveUsdt * MAX_MINT_POOL_BPS) return (cost, 0);
        uint256 usdtAfter = reserveUsdt + cost - cost * TREASURY_BPS / BPS + pendingQuote;
        tokens = Math.mulDiv(cost, reserveToken, usdtAfter) * L2_BONUS_BPS / BPS;
    }

    /// @notice Largest L2 cost one mint may have against the pool right now.
    function maxL2Cost() external view returns (uint256) {
        (uint256 reserveUsdt,) = _poolView();
        return reserveUsdt * MAX_MINT_POOL_BPS / BPS;
    }

    /// @notice BNB charged for a USDT cost: the Chainlink BNB/USD price plus 1 %.
    function quoteBnb(uint256 usdtCost) public view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = bnbUsdFeed.latestRoundData();
        if (answer <= 0 || block.timestamp - updatedAt > FEED_MAX_AGE) revert StaleFeed();
        uint256 dec = bnbUsdFeed.decimals();
        return Math.mulDiv(usdtCost * BNB_QUOTE_BPS, 10 ** dec, uint256(answer) * BPS, Math.Rounding.Ceil);
    }

    /// @notice Shares still available to `account` across L1 and L2.
    function remainingShares(address account) external view returns (uint256) {
        bytes32 key = AgentIdLib.agentKeyOf(agentRegistry, account);
        if (key == bytes32(0)) return 0;
        uint256 used = Math.max(agentShares[key], walletShares[account]);
        return used >= MAX_SHARES_PER_ID ? 0 : MAX_SHARES_PER_ID - used;
    }

    /// @notice The pair's reserves; before the pool is seeded, the reserves it
    ///         will open with.
    function poolReserves() external view returns (uint256 reserveUsdt, uint256 reserveToken) {
        return _poolView();
    }

    function _poolView() private view returns (uint256 reserveUsdt, uint256 reserveToken) {
        if (poolSeeded) return _reserves();
        if (!launched) return (0, 0);
        return (l1Reserve, POOL_ALLOCATION);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Internals
    // ══════════════════════════════════════════════════════════════════════════

    function _consumeQuota(uint256 shares) private returns (bytes32 key) {
        if (msg.sender != tx.origin) revert NotAWallet();
        if (shares == 0 || shares > MAX_SHARES_PER_ID) revert BadShares();
        key = AgentIdLib.agentKeyOf(agentRegistry, msg.sender);
        if (key == bytes32(0)) revert NoAgentId();
        uint256 used = Math.max(agentShares[key], walletShares[msg.sender]);
        if (used + shares > MAX_SHARES_PER_ID) revert QuotaExceeded();
        agentShares[key] = used + shares;
        walletShares[msg.sender] = used + shares;
    }

    function _collect(uint256 cost, uint256 maxPay) private {
        if (msg.value == 0) {
            if (cost > maxPay) revert CostAboveMax();
            usdt.safeTransferFrom(msg.sender, address(this), cost);
            return;
        }

        uint256 bnbIn = quoteBnb(cost);
        if (msg.value < bnbIn) revert InsufficientBnb();

        address[] memory path = new address[](2);
        path[0] = wbnb;
        path[1] = address(usdt);
        uint256[] memory amounts =
            router.swapExactETHForTokens{value: bnbIn}(cost, path, address(this), block.timestamp);
        uint256 surplus = amounts[amounts.length - 1] - cost;
        if (surplus != 0) {
            usdt.safeTransfer(treasury, surplus);
            emit BnbSurplus(surplus);
        }

        uint256 refund = msg.value - bnbIn;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _reserves() private view returns (uint256 reserveUsdt, uint256 reserveToken) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (reserveToken, reserveUsdt) = _tokenIsToken0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// @dev Zap `amount` USDT into the pair: buy the optimal share of tokens,
    ///      then add both sides as liquidity, LP to the dead address. Whatever
    ///      cannot be placed stays queued in `pendingQuote`.
    function _autoLp(uint256 amount) private {
        if (amount == 0) {
            pendingQuote = 0;
            return;
        }
        (uint256 reserveUsdt, uint256 reserveToken) = _reserves();
        uint256 swapIn = _zapSwapAmount(reserveUsdt, amount);
        uint256 out = swapIn * PAIR_FEE_NUM * reserveToken / (reserveUsdt * BPS + swapIn * PAIR_FEE_NUM);
        if (swapIn == 0 || out == 0 || swapIn >= amount) {
            pendingQuote = amount;
            return;
        }

        usdt.safeTransfer(address(pair), swapIn);
        (uint256 a0, uint256 a1) = _tokenIsToken0 ? (out, uint256(0)) : (uint256(0), out);
        pair.swap(a0, a1, address(this), "");

        reserveUsdt += swapIn;
        reserveToken -= out;
        uint256 usdtLeft = amount - swapIn;
        uint256 tokenNeeded = Math.mulDiv(usdtLeft, reserveToken, reserveUsdt);
        uint256 usdtUsed = usdtLeft;
        uint256 tokenUsed = tokenNeeded;
        if (tokenNeeded > out) {
            tokenUsed = out;
            usdtUsed = Math.mulDiv(out, reserveUsdt, reserveToken);
        }

        usdt.safeTransfer(address(pair), usdtUsed);
        IERC20(address(token)).safeTransfer(address(pair), tokenUsed);
        uint256 liquidity = pair.mint(DEAD);
        pendingQuote = usdtLeft - usdtUsed;

        emit LiquidityAdded(usdtUsed + swapIn, tokenUsed, liquidity);
    }

    /// @dev Single-sided zap: the swap amount that leaves the pair's ratio
    ///      matching the remainder, for a 0.25 % fee.
    ///      s = (sqrt(U · (U · 19975² + 4 · a · 9975 · 10000)) − U · 19975) / (2 · 9975)
    function _zapSwapAmount(uint256 reserveUsdt, uint256 amount) private pure returns (uint256) {
        uint256 u = reserveUsdt;
        uint256 root = Math.sqrt(u * (u * 19_975 * 19_975 + amount * 4 * PAIR_FEE_NUM * BPS));
        uint256 sub = u * 19_975;
        if (root <= sub) return 0;
        return (root - sub) / (2 * PAIR_FEE_NUM);
    }
}
