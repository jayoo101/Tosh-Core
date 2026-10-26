// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "../lib/openzeppelin-contracts/contracts/utils/math/Math.sol";

interface IBidBookHook {
    function launched() external view returns (bool);
    function currentGenesisPrice() external view returns (uint256);
    function quoteAsset() external view returns (address);
    function projectToken() external view returns (address);
}

interface IBidBookFactory {
    function registeredHooks(address hook) external view returns (bool);
    function minBuy() external view returns (uint256);
    function bidBook() external view returns (address);
}

interface IBidBookToken {
    function isReceiver(address account) external view returns (bool);
    function registerFor(address account) external;
}

/// @title  ToshBidBook — buy-only order book for ToshX tokens before launch
/// @notice Buyers lock quote and post bids; holders can only sell into them.
///         There are no asks. One instance serves every v2 project on both
///         quote assets. Not upgradeable; after `initialize` it has no admin.
///
/// @dev    Lifecycle per project: bids may be placed and filled while the
///         project's hook reports `launched() == false`. Once it launches the
///         book stops taking and filling bids for it; cancelling always works.
///         The hook never calls in here — the book reads `launched()` itself,
///         so nothing it does can stand between a project and its pool.
///
///         Fees: 1 % from the buyer and 1 % from the seller, charged only on
///         fill, accrued per quote asset and swept to `feeRecipient`.
///
///         Escrow bookkeeping is cumulative. With F the quantity filled so far,
///         Gc(F) = ceil(price·F/1e18) and Bc(F) = ceil(Gc(F)·1 %). A fill from
///         F to F' debits Gc(F') − Gc(F) + Bc(F') − Bc(F) from escrow. Both are
///         monotone and equal G and ceil(G·1 %) at F = qty, so escrow never
///         goes negative and is exactly zero once a bid is fully filled.
///
///         Invariant: Σ escrow + Σ feesAccrued == balance, per quote asset.
contract ToshBidBook is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 100;
    uint256 public constant FILL_FLOOR_BPS = 9000;
    uint256 public constant BPS = 10_000;
    uint256 public constant MIN_FILL_QTY = 1e18;
    uint256 private constant ONE = 1e18;

    struct Bid {
        address bidder;
        address hook;
        address token;
        address quote;
        uint256 price;
        uint256 qty;
        uint256 filled;
        uint256 escrow;
    }

    address public immutable feeRecipient;
    address private immutable _deployer;

    address[] private _factories;
    bool public initialized;

    uint256 public nextBidId = 1;
    mapping(uint256 => Bid) public bids;
    mapping(address quote => uint256) public feesAccrued;
    mapping(address quote => uint256) public escrowTotal;

    event Initialized(address[] factories);
    event BidPlaced(
        uint256 indexed bidId, address indexed hook, address indexed bidder, uint256 price, uint256 qty, uint256 escrow
    );
    event BidCancelled(uint256 indexed bidId, address indexed hook, uint256 refund);
    event BidFilled(
        uint256 indexed bidId,
        address indexed hook,
        address indexed seller,
        uint256 qty,
        uint256 price,
        uint256 gross,
        uint256 buyerFee,
        uint256 sellerFee
    );
    event FeesSwept(address indexed quote, uint256 amount);

    error ZeroAddress();
    error OnlyDeployer();
    error AlreadyInitialized();
    error NotInitialized();
    error FactoryMismatch();
    error UnknownHook();
    error Launched();
    error NotAWallet();
    error PriceBelowGenesis();
    error BelowMinBid();
    error BelowMinQty();
    error ZeroPrice();
    error NotBidder();
    error BidClosed();
    error LengthMismatch();
    error NothingFilled();
    error InsufficientOutput();
    error EscrowNotReceived();

    constructor(address feeRecipient_) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        _deployer = msg.sender;
    }

    /// @notice Name the factories whose hooks this book serves. Once.
    function initialize(address[] calldata factories_) external {
        if (msg.sender != _deployer) revert OnlyDeployer();
        if (initialized) revert AlreadyInitialized();
        for (uint256 i; i < factories_.length; ++i) {
            if (IBidBookFactory(factories_[i]).bidBook() != address(this)) revert FactoryMismatch();
            _factories.push(factories_[i]);
        }
        initialized = true;
        emit Initialized(factories_);
    }

    function factories() external view returns (address[] memory) {
        return _factories;
    }

    /// @notice The factory `hook` was created by, or zero.
    function factoryOf(address hook) public view returns (address) {
        uint256 n = _factories.length;
        for (uint256 i; i < n; ++i) {
            if (IBidBookFactory(_factories[i]).registeredHooks(hook)) return _factories[i];
        }
        return address(0);
    }

    // ─── Bids ─────────────────────────────────────────────────────────────────

    /// @notice Lock quote for a bid of `qty` tokens at `price` quote per 1e18
    ///         tokens. `price` must be at least the latest genesis price.
    function placeBid(address hook, uint256 price, uint256 qty) external nonReentrant returns (uint256 bidId) {
        if (!initialized) revert NotInitialized();
        if (msg.sender != tx.origin || msg.sender.code.length != 0) revert NotAWallet();
        address factory = factoryOf(hook);
        if (factory == address(0)) revert UnknownHook();
        IBidBookHook h = IBidBookHook(hook);
        if (h.launched()) revert Launched();
        if (price == 0) revert ZeroPrice();
        if (price < h.currentGenesisPrice()) revert PriceBelowGenesis();
        if (qty < MIN_FILL_QTY) revert BelowMinQty();

        uint256 gross = Math.mulDiv(price, qty, ONE, Math.Rounding.Ceil);
        if (gross < IBidBookFactory(factory).minBuy()) revert BelowMinBid();
        uint256 escrow = gross + _fee(gross);

        address quote = h.quoteAsset();
        address token = h.projectToken();

        bidId = nextBidId++;
        bids[bidId] = Bid({
            bidder: msg.sender,
            hook: hook,
            token: token,
            quote: quote,
            price: price,
            qty: qty,
            filled: 0,
            escrow: escrow
        });
        escrowTotal[quote] += escrow;

        uint256 before = IERC20(quote).balanceOf(address(this));
        IERC20(quote).safeTransferFrom(msg.sender, address(this), escrow);
        if (IERC20(quote).balanceOf(address(this)) - before != escrow) revert EscrowNotReceived();

        if (!IBidBookToken(token).isReceiver(msg.sender)) IBidBookToken(token).registerFor(msg.sender);

        emit BidPlaced(bidId, hook, msg.sender, price, qty, escrow);
    }

    /// @notice Close a bid and refund what is left of its escrow. Always
    ///         available to the bidder, before and after launch.
    function cancelBid(uint256 bidId) external nonReentrant {
        Bid storage b = bids[bidId];
        if (b.bidder != msg.sender) revert NotBidder();
        uint256 refund = b.escrow;
        if (refund == 0 && b.filled == b.qty) revert BidClosed();
        address quote = b.quote;
        address hook = b.hook;
        b.escrow = 0;
        b.qty = b.filled;
        escrowTotal[quote] -= refund;
        if (refund != 0) IERC20(quote).safeTransfer(msg.sender, refund);
        emit BidCancelled(bidId, hook, refund);
    }

    /// @notice Sell into bids on `hook`. Each `qtys[i]` is clamped to what is
    ///         left on `bidIds[i]`. Bids priced under 90 % of the latest genesis
    ///         price, bids whose bidder now has code, closed bids and fills
    ///         under one token (unless they finish the bid) are skipped rather
    ///         than reverting the batch.
    /// @param  minTotalOut Least quote the seller accepts net of fees.
    function fill(address hook, uint256[] calldata bidIds, uint256[] calldata qtys, uint256 minTotalOut)
        external
        nonReentrant
        returns (uint256 totalOut, uint256 totalQty)
    {
        if (bidIds.length != qtys.length) revert LengthMismatch();
        if (msg.sender != tx.origin || msg.sender.code.length != 0) revert NotAWallet();
        IBidBookHook h = IBidBookHook(hook);
        if (factoryOf(hook) == address(0)) revert UnknownHook();
        if (h.launched()) revert Launched();

        uint256 floor = h.currentGenesisPrice() * FILL_FLOOR_BPS / BPS;
        address quote = h.quoteAsset();
        IERC20 token = IERC20(h.projectToken());
        uint256 fees;

        for (uint256 i; i < bidIds.length; ++i) {
            Bid storage b = bids[bidIds[i]];
            if (b.hook != hook || b.price < floor) continue;
            address bidder = b.bidder;
            if (bidder.code.length != 0) continue;

            uint256 f = b.filled;
            uint256 left = b.qty - f;
            uint256 q = qtys[i] < left ? qtys[i] : left;
            if (q == 0 || (q < MIN_FILL_QTY && q != left)) continue;

            uint256 f2 = f + q;
            uint256 gc1 = Math.mulDiv(b.price, f, ONE, Math.Rounding.Ceil);
            uint256 gc2 = Math.mulDiv(b.price, f2, ONE, Math.Rounding.Ceil);
            uint256 gross = gc2 - gc1;
            uint256 buyerFee = _fee(gc2) - _fee(gc1);
            uint256 sellerFee = gross * FEE_BPS / BPS;

            b.filled = f2;
            b.escrow -= gross + buyerFee;
            escrowTotal[quote] -= gross + buyerFee;
            fees += buyerFee + sellerFee;
            totalOut += gross - sellerFee;
            totalQty += q;

            token.safeTransferFrom(msg.sender, bidder, q);
            emit BidFilled(bidIds[i], hook, msg.sender, q, b.price, gross, buyerFee, sellerFee);
        }

        if (totalQty == 0) revert NothingFilled();
        if (totalOut < minTotalOut) revert InsufficientOutput();
        feesAccrued[quote] += fees;
        if (totalOut != 0) IERC20(quote).safeTransfer(msg.sender, totalOut);
    }

    /// @notice Move accrued fees in `quote` to `feeRecipient`. Anyone may call.
    function sweepFees(address quote) external nonReentrant {
        uint256 amount = feesAccrued[quote];
        if (amount == 0) return;
        feesAccrued[quote] = 0;
        IERC20(quote).safeTransfer(feeRecipient, amount);
        emit FeesSwept(quote, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice Lowest price a fill on `hook` may execute at right now.
    function fillFloor(address hook) external view returns (uint256) {
        return IBidBookHook(hook).currentGenesisPrice() * FILL_FLOOR_BPS / BPS;
    }

    /// @notice Escrow `placeBid(_, price, qty)` would pull.
    function escrowFor(uint256 price, uint256 qty) external pure returns (uint256) {
        uint256 gross = Math.mulDiv(price, qty, ONE, Math.Rounding.Ceil);
        return gross + _fee(gross);
    }

    /// @notice What a seller nets for `q` more tokens into `bidId`, after fees.
    function quoteFill(uint256 bidId, uint256 q) external view returns (uint256 out) {
        Bid storage b = bids[bidId];
        uint256 left = b.qty - b.filled;
        if (q > left) q = left;
        uint256 gross = Math.mulDiv(b.price, b.filled + q, ONE, Math.Rounding.Ceil)
            - Math.mulDiv(b.price, b.filled, ONE, Math.Rounding.Ceil);
        return gross - gross * FEE_BPS / BPS;
    }

    function _fee(uint256 amount) private pure returns (uint256) {
        return Math.mulDiv(amount, FEE_BPS, BPS, Math.Rounding.Ceil);
    }
}
