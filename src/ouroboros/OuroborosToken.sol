// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IPancakeV2Pair, IPancakeV2Router} from "./interfaces/IOuroborosExternal.sol";

/// @title  OuroborosToken
/// @notice Fixed-cap token for the Ouroboros fair mint.
///
///         Supply: 21,000,000,000 tokens, all of it minted by `OuroborosMint`:
///         5/9 when L1 closes, 4/9 into the official pair when L2 opens.
///         Every L2 mint is matched by a burn of the same amount from the
///         pair, so the cap is a hard ceiling.
///
///         Market rules by phase:
///           • before launch    — no transfers at all;
///           • L1.5             — wallet transfers allowed; the official pair
///                                is empty and nobody but the mint can move
///                                tokens into or out of it;
///           • from L2          — the mint seeds the pair and opens it in the
///                                same transaction; buys pay 1.25 %
///                                (accrued here, swapped to USDT for the
///                                treasury), sells pay 1 % (burned).
///         Transfers into or out of any other pair holding this token, and of
///         the singleton venues named at deployment (PancakeSwap Infinity's
///         Vault, Uniswap V4's PoolManager), are refused in every phase, so
///         the official pair is the only AMM market.
///
///         Nothing here is adjustable after `wire`: tax rates, the cap and the
///         treasury are constants or immutables.
contract OuroborosToken is ERC20 {
    uint256 public constant CAP = 21_000_000_000 ether;

    uint256 public constant BUY_TAX_BPS = 125;
    uint256 public constant SELL_TAX_BPS = 100;
    uint256 private constant BPS = 10_000;

    /// @dev Each tax swap sells at most 0.10 % of the pair's token reserve and
    ///      runs at most once per block, which bounds its price impact.
    uint256 public constant SWAP_CAP_BPS = 10;

    uint256 private constant PAIR_PROBE_GAS = 30_000;

    address public immutable wirer;
    address public immutable usdt;
    address public immutable router;
    address public immutable treasury;

    mapping(address => bool) public isBlockedVenue;

    address public minter;
    address public pair;
    uint64 public tradingOpensAt;
    bool public launched;
    /// @dev Set by the mint once it has seeded the pair. Until then nobody
    ///      else can put tokens in, so nobody else can set the opening price.
    bool public poolOpened;

    bool private _inSwap;
    uint256 private _lastSwapBlock;

    error AlreadyWired();
    error NotWirer();
    error NotMinter();
    error ZeroAddress();
    error CapExceeded();
    error NotLaunched();
    error TradingNotOpen();
    error ForeignPair();

    event Wired(address minter, address pair, uint64 tradingOpensAt);
    event Launched();
    event PoolOpened();
    event BuyTax(address indexed buyer, uint256 amount);
    event SellTax(address indexed seller, uint256 burned);
    event TaxSwapped(uint256 tokensIn);

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    constructor(address usdt_, address router_, address treasury_, address[] memory blockedVenues_)
        ERC20("Ouroboros", "OURO")
    {
        if (usdt_ == address(0) || router_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        wirer = msg.sender;
        usdt = usdt_;
        router = router_;
        treasury = treasury_;
        for (uint256 i; i < blockedVenues_.length; ++i) {
            isBlockedVenue[blockedVenues_[i]] = true;
        }
    }

    /// @notice One-shot wiring by the deployer: the mint contract, the official
    ///         TOKEN/USDT pair and the moment L2 opens the pair to trading.
    function wire(address minter_, address pair_, uint64 tradingOpensAt_) external {
        if (msg.sender != wirer) revert NotWirer();
        if (minter != address(0)) revert AlreadyWired();
        if (minter_ == address(0) || pair_ == address(0)) revert ZeroAddress();
        minter = minter_;
        pair = pair_;
        tradingOpensAt = tradingOpensAt_;
        emit Wired(minter_, pair_, tradingOpensAt_);
    }

    // ── Mint-only hooks ──────────────────────────────────────────────────────

    function markLaunched() external onlyMinter {
        launched = true;
        emit Launched();
    }

    function markPoolOpened() external onlyMinter {
        poolOpened = true;
        emit PoolOpened();
    }

    function mint(address to, uint256 amount) external onlyMinter {
        if (totalSupply() + amount > CAP) revert CapExceeded();
        _mint(to, amount);
    }

    /// @notice Burns `amount` straight out of the official pair. The caller
    ///         syncs the pair afterwards. Used only by L2's equal burn.
    function burnFromPair(uint256 amount) external onlyMinter {
        _burn(pair, amount);
    }

    // ── Tax conversion ───────────────────────────────────────────────────────

    /// @notice Converts accrued buy tax to USDT for the treasury. Also runs on
    ///         every taxed sell; anyone may call it.
    function swapTaxes() external {
        _swapTaxes();
    }

    function tradingOpen() public view returns (bool) {
        return poolOpened && block.timestamp >= tradingOpensAt;
    }

    // ── Transfer rules ───────────────────────────────────────────────────────

    function _update(address from, address to, uint256 value) internal override {
        // Mint and burn paths are reached only through `onlyMinter` functions
        // or the sell tax below.
        // Zero-value transfers carry nothing to tax or restrict; the pair's
        // `skim` at launch sends them for both of its tokens.
        if (from == address(0) || to == address(0) || value == 0) {
            super._update(from, to, value);
            return;
        }
        if (!launched) revert NotLaunched();

        address p = pair;
        bool exempt = from == minter || to == minter || from == address(this);

        if (from != p && to != p) {
            // `from` too: a pair's address is known before it has code, so
            // tokens can reach one unprobed; they must not be able to leave.
            if (isBlockedVenue[to] || isBlockedVenue[from] || _looksLikeForeignPair(to) || _looksLikeForeignPair(from)) revert ForeignPair();
            super._update(from, to, value);
            return;
        }

        if (exempt) {
            super._update(from, to, value);
            return;
        }
        if (!tradingOpen()) revert TradingNotOpen();

        if (from == p) {
            uint256 fee = value * BUY_TAX_BPS / BPS;
            super._update(from, address(this), fee);
            super._update(from, to, value - fee);
            emit BuyTax(to, fee);
        } else {
            _swapTaxes();
            uint256 fee = value * SELL_TAX_BPS / BPS;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
            emit SellTax(from, fee);
        }
    }

    function _swapTaxes() private {
        if (_inSwap || !tradingOpen() || _lastSwapBlock == block.number) return;
        uint256 bal = balanceOf(address(this));
        if (bal == 0) return;

        address p = pair;
        (uint112 r0, uint112 r1,) = IPancakeV2Pair(p).getReserves();
        uint256 reserveToken = IPancakeV2Pair(p).token0() == address(this) ? r0 : r1;
        uint256 cap = reserveToken * SWAP_CAP_BPS / BPS;
        uint256 amount = bal < cap ? bal : cap;
        if (amount == 0) return;

        _inSwap = true;
        _lastSwapBlock = block.number;
        _approve(address(this), router, amount);
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = usdt;
        try IPancakeV2Router(router)
            .swapExactTokensForTokensSupportingFeeOnTransferTokens(amount, 0, path, treasury, block.timestamp) {
            emit TaxSwapped(amount);
        } catch {
            _approve(address(this), router, 0);
        }
        _inSwap = false;
    }

    /// @dev True when `account` is not the official pair and names this token
    ///      through a pool getter of a permissionless AMM deployed on BSC:
    ///      Uniswap V2/V3 forks, Algebra and Solidly (`token0`/`token1`),
    ///      iZiSwap (`tokenX`/`tokenY`), Trader Joe LB (`getTokenX`/`getTokenY`),
    ///      Maverick (`tokenA`/`tokenB`), DODO V2 (`_BASE_TOKEN_`/`_QUOTE_TOKEN_`),
    ///      Curve-style pools (`coins(0..3)`), Wombat assets (`underlyingToken`)
    ///      and ERC-4626 vaults such as Euler's, which EulerSwap trades out of
    ///      (`asset`). Probed with a gas cap so a hostile contract cannot make
    ///      transfers to it expensive.
    function _looksLikeForeignPair(address account) private view returns (bool) {
        if (account.code.length == 0 || account == pair || account == treasury || account == minter) return false;
        bytes4[12] memory getters = [
            IPancakeV2Pair.token0.selector,
            IPancakeV2Pair.token1.selector,
            bytes4(keccak256("tokenX()")),
            bytes4(keccak256("tokenY()")),
            bytes4(keccak256("getTokenX()")),
            bytes4(keccak256("getTokenY()")),
            bytes4(keccak256("tokenA()")),
            bytes4(keccak256("tokenB()")),
            bytes4(keccak256("_BASE_TOKEN_()")),
            bytes4(keccak256("_QUOTE_TOKEN_()")),
            bytes4(keccak256("underlyingToken()")),
            bytes4(keccak256("asset()"))
        ];
        for (uint256 i; i < getters.length; ++i) {
            if (_probe(account, getters[i], false, 0) == address(this)) return true;
        }
        bytes4 coins = bytes4(keccak256("coins(uint256)"));
        for (uint256 i; i < 4; ++i) {
            if (_probe(account, coins, true, i) == address(this)) return true;
        }
        return false;
    }

    function _probe(address target, bytes4 selector, bool withArg, uint256 arg) private view returns (address result) {
        bool ok;
        uint256 size;
        uint256 word;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            mstore(add(ptr, 4), arg)
            ok := staticcall(PAIR_PROBE_GAS, target, ptr, add(4, mul(withArg, 32)), ptr, 32)
            size := returndatasize()
            word := mload(ptr)
        }
        if (!ok || size != 32 || word >> 160 != 0) return address(0);
        result = address(uint160(word));
    }
}
