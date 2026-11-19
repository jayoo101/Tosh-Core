// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "../../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "../../lib/openzeppelin-contracts/contracts/utils/math/Math.sol";

interface IOuroborosMintPhase {
    function launched() external view returns (bool);
    function l2Start() external view returns (uint64);
}

/// @title  OuroborosBidBook
/// @notice The L1.5 market: buy orders only.
///
///         Buyers lock USDT at a price of their choosing. Holders sell by
///         filling a bid, in whole or in part. There are no asks, so with no
///         bids nobody can sell.
///
///         Each fill pays 2 % on both sides to the treasury, in the asset paid:
///         the buyer receives the tokens less 2 %, the seller the USDT less 2 %.
///
///         Fills are possible from launch until L2 opens. A bid can be
///         cancelled for its unfilled USDT at any time. Deployed by
///         `OuroborosMint`, which reads the fill volume when the pool is seeded.
contract OuroborosBidBook is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 200;
    uint256 private constant BPS = 10_000;
    uint256 public constant MIN_BID = 1 ether;

    IERC20 public immutable token;
    IERC20 public immutable usdt;
    IOuroborosMintPhase public immutable mint;
    address public immutable treasury;

    struct Bid {
        address buyer;
        uint96 price;
        uint256 usdtLeft;
    }

    /// @dev `price` is USDT wei per whole token (1e18 token wei).
    mapping(uint256 => Bid) public bids;
    uint256 public nextBidId = 1;

    /// @notice Gross USDT and tokens exchanged through fills, before fees.
    uint256 public filledUsdt;
    uint256 public filledTokens;

    error ZeroAddress();
    error MarketClosed();
    error BidTooSmall();
    error BadPrice();
    error NotBuyer();
    error BidEmpty();
    error FillTooLarge();
    error BelowMinOut();

    event BidPlaced(uint256 indexed id, address indexed buyer, uint256 price, uint256 usdtAmount);
    event BidFilled(
        uint256 indexed id,
        address indexed buyer,
        address indexed seller,
        uint256 tokens,
        uint256 usdtGross,
        uint256 buyerFeeTokens,
        uint256 sellerFeeUsdt
    );
    event BidCancelled(uint256 indexed id, uint256 refund);

    constructor(address token_, address usdt_, address mint_, address treasury_) {
        if (token_ == address(0) || usdt_ == address(0) || mint_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        token = IERC20(token_);
        usdt = IERC20(usdt_);
        mint = IOuroborosMintPhase(mint_);
        treasury = treasury_;
    }

    function isOpen() public view returns (bool) {
        return mint.launched() && block.timestamp < mint.l2Start();
    }

    function placeBid(uint256 usdtAmount, uint256 price) external nonReentrant returns (uint256 id) {
        if (!isOpen()) revert MarketClosed();
        if (usdtAmount < MIN_BID) revert BidTooSmall();
        if (price == 0 || price > type(uint96).max) revert BadPrice();

        usdt.safeTransferFrom(msg.sender, address(this), usdtAmount);
        id = nextBidId++;
        bids[id] = Bid({buyer: msg.sender, price: uint96(price), usdtLeft: usdtAmount});
        emit BidPlaced(id, msg.sender, price, usdtAmount);
    }

    /// @notice Sell `tokenAmount` into bid `id`.
    /// @param  minUsdtOut Least USDT the seller accepts after the 2 % fee.
    function fill(uint256 id, uint256 tokenAmount, uint256 minUsdtOut) external nonReentrant {
        if (!isOpen()) revert MarketClosed();
        Bid storage b = bids[id];
        if (b.usdtLeft == 0) revert BidEmpty();

        uint256 gross = Math.mulDiv(tokenAmount, b.price, 1 ether);
        if (gross == 0) revert BidTooSmall();
        if (gross > b.usdtLeft) revert FillTooLarge();
        b.usdtLeft -= gross;
        filledUsdt += gross;
        filledTokens += tokenAmount;

        uint256 sellerFee = gross * FEE_BPS / BPS;
        if (gross - sellerFee < minUsdtOut) revert BelowMinOut();
        uint256 buyerFee = tokenAmount * FEE_BPS / BPS;
        address buyer = b.buyer;

        token.safeTransferFrom(msg.sender, address(this), tokenAmount);
        token.safeTransfer(treasury, buyerFee);
        token.safeTransfer(buyer, tokenAmount - buyerFee);
        usdt.safeTransfer(treasury, sellerFee);
        usdt.safeTransfer(msg.sender, gross - sellerFee);

        emit BidFilled(id, buyer, msg.sender, tokenAmount, gross, buyerFee, sellerFee);
    }

    /// @notice Tokens that fill the rest of bid `id`.
    function tokensToFill(uint256 id) external view returns (uint256) {
        Bid memory b = bids[id];
        if (b.usdtLeft == 0) return 0;
        return Math.mulDiv(b.usdtLeft, 1 ether, b.price);
    }

    function cancel(uint256 id) external nonReentrant {
        Bid storage b = bids[id];
        if (b.buyer != msg.sender) revert NotBuyer();
        uint256 refund = b.usdtLeft;
        if (refund == 0) revert BidEmpty();
        b.usdtLeft = 0;
        usdt.safeTransfer(msg.sender, refund);
        emit BidCancelled(id, refund);
    }
}
