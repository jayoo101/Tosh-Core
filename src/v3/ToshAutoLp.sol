// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {LiquidityAmounts} from "infinity-periphery/src/pool-cl/libraries/LiquidityAmounts.sol";

import {IERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "../../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "../../lib/openzeppelin-contracts/contracts/utils/math/Math.sol";

interface IToshAutoLpHook {
    function getPoolKey() external view returns (PoolKey memory);
    function twapSqrtPriceX96() external view returns (uint160);
    function lastSwapBlock() external view returns (uint256);
    function TAX_BPS() external view returns (uint256);
    function TICK_SPACING() external view returns (int24);
    function autoLp() external view returns (address);
}

interface IToshAutoLpFactory {
    function registeredHooks(address hook) external view returns (bool);
    function hookImplementation() external view returns (address);
}

/// @title  ToshAutoLp — buys shelf revenue into each project's pool and locks it
/// @notice One per market. Every v3 shelf sale sends `LP_SHARE_BPS` of its
///         payment here; this contract spends part of it buying the project
///         token in the project's own pool, then adds what it bought and the
///         rest of the payment as full-range liquidity it can never remove.
///
/// @dev    ── Why a separate contract ─────────────────────────────────────────
///
///   The hook is at the EIP-170 limit, so it only forwards the payment and
///   calls `deposit`. Everything that can be deferred lives here, booked per
///   hook: `pendingQuote` and `pendingToken` are what each project's pool is
///   still owed, and nothing else in the balance is anyone's.
///
///   ── When it adds, and when it waits ───────────────────────────────────
///
///   A buy is sandwichable, so it only runs when the price it buys at is one
///   the market has held:
///     • the hook's TWAP has matured (it reads 0 for the first window), and
///       spot is not more than ~2 % dearer than it (`MAX_SPOT_PREMIUM_SQRT_BPS`);
///     • a `flush` additionally needs a block with no swap in it yet. A
///       `deposit` arrives from inside `mintBondingCurve`, which has already
///       refused a block whose price moved more than `MAX_MINT_TICK_DRIFT`;
///     • each run spends at most `MAX_DEPTH_BPS` of the pool's virtual quote
///       reserve, about half of it on the buy, which keeps the buy's impact
///       under the ~2 % round trip (1 % tax each way) a sandwich has to clear.
///   Anything not added stays pending and goes in on a later sale or `flush`.
///   A failed attempt never fails the sale that triggered it.
///
///   ── Taxed, and not a buyback carrier ──────────────────────────────────
///
///   The buy goes through the hook like any other swap: it pays the 1 % buy
///   tax, stamps the block and feeds the TWAP. The v3 hook only skips the
///   piggyback buyback poke for swaps whose sender is this contract.
///
///   ── Fees compound ─────────────────────────────────────────────────────
///
///   Adding to an existing position settles the fees it has earned in the
///   same delta, so they are booked back to pending and go in next time.
contract ToshAutoLp is ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    /// @notice Most quote one run may commit, as bps of the pool's virtual
    ///         quote reserve. Roughly half is swapped, so the buy is ~1 %.
    uint256 public constant MAX_DEPTH_BPS = 200;

    /// @notice How much dearer than its TWAP the token may be before a run
    ///         waits, in bps of sqrt price. 99 bps of sqrt is ~2 % of price.
    uint256 public constant MAX_SPOT_PREMIUM_SQRT_BPS = 99;

    /// @notice Hard floor on how far the buy may move the sqrt price, in bps.
    ///         A backstop: the depth cap keeps a normal run well inside it.
    uint256 public constant MAX_SWAP_SQRT_MOVE_BPS = 200;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant PPM = 1_000_000;

    IVault public immutable vault;
    ICLPoolManager public immutable poolManager;
    address public immutable deployer;

    /// @notice The factory whose hooks may deposit. Set once.
    address public factory;

    mapping(address hook => uint256) public pendingQuote;
    mapping(address hook => uint256) public pendingToken;
    mapping(address hook => uint256) public totalQuoteAdded;
    mapping(address hook => uint256) public totalTokenAdded;

    event FactorySet(address factory);
    event Deposited(address indexed hook, uint256 amount);
    event LiquidityAdded(address indexed hook, uint256 quoteIn, uint256 tokenIn, uint128 liquidity);
    event Deferred(address indexed hook, uint8 reason);

    error ZeroAddress();
    error OnlyDeployer();
    error FactoryAlreadySet();
    error FactoryMismatch();
    error UnknownHook();
    error OnlyVault();
    error PriceMovedThisBlock();
    error NothingAdded(uint8 reason);

    uint8 internal constant ADDED = 0;
    uint8 internal constant NOTHING_PENDING = 1;
    uint8 internal constant NO_TWAP = 2;
    uint8 internal constant SPOT_ABOVE_TWAP = 3;
    uint8 internal constant NO_DEPTH = 4;
    uint8 internal constant LOCK_FAILED = 5;

    constructor(address vault_, address poolManager_) {
        if (vault_ == address(0) || poolManager_ == address(0)) revert ZeroAddress();
        vault = IVault(vault_);
        poolManager = ICLPoolManager(poolManager_);
        deployer = msg.sender;
    }

    /// @notice Bind the factory. Its hook implementation must name this
    ///         contract, so a factory built for another AutoLp is refused.
    function setFactory(address factory_) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        if (IToshAutoLpHook(IToshAutoLpFactory(factory_).hookImplementation()).autoLp() != address(this)) {
            revert FactoryMismatch();
        }
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Book `amount` of quote, already transferred here, to the
    ///         calling hook's pool and try to add it. Never reverts on a
    ///         market condition: the shelf sale it rides on must go through.
    function deposit(uint256 amount) external nonReentrant {
        if (!_registered(msg.sender)) revert UnknownHook();
        pendingQuote[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
        uint8 r = _tryAdd(msg.sender);
        if (r != ADDED) emit Deferred(msg.sender, r);
    }

    /// @notice Add whatever `hook`'s pool is still owed. Permissionless; needs
    ///         a block in which nothing has swapped on that pool yet.
    function flush(address hook) external nonReentrant {
        if (!_registered(hook)) revert UnknownHook();
        if (IToshAutoLpHook(hook).lastSwapBlock() >= block.number) revert PriceMovedThisBlock();
        uint8 r = _tryAdd(hook);
        if (r != ADDED) revert NothingAdded(r);
    }

    function _registered(address hook) internal view returns (bool) {
        address f = factory;
        return f != address(0) && IToshAutoLpFactory(f).registeredHooks(hook);
    }

    function _tryAdd(address hook) internal returns (uint8) {
        uint256 pending = pendingQuote[hook];
        if (pending == 0) return NOTHING_PENDING;

        IToshAutoLpHook h = IToshAutoLpHook(hook);
        uint160 twap = h.twapSqrtPriceX96();
        if (twap == 0) return NO_TWAP;

        PoolKey memory key = h.getPoolKey();
        PoolId id = key.toId();
        (uint160 spot,,,) = poolManager.getSlot0(id);
        // The token is currency1, so a dearer token is a LOWER sqrt price.
        if (uint256(spot) * BPS < uint256(twap) * (BPS - MAX_SPOT_PREMIUM_SQRT_BPS)) return SPOT_ABOVE_TWAP;

        uint128 liquidity = poolManager.getLiquidity(id);
        if (liquidity == 0 || spot == 0) return NO_DEPTH;
        uint256 reserve = (uint256(liquidity) << 96) / spot;
        uint256 cap = reserve * MAX_DEPTH_BPS / BPS;
        if (cap == 0) return NO_DEPTH;
        uint256 q = pending < cap ? pending : cap;

        try vault.lock(abi.encode(hook, key, q, reserve, spot)) {
            return ADDED;
        } catch {
            return LOCK_FAILED;
        }
    }

    /// @dev Buy, add, settle the net. Reached only through `vault.lock` above.
    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(vault)) revert OnlyVault();
        (address hook, PoolKey memory key, uint256 q, uint256 reserve, uint160 spot) =
            abi.decode(data, (address, PoolKey, uint256, uint256, uint160));

        BalanceDelta swapDelta;
        uint256 s = _swapAmount(reserve, q, IToshAutoLpHook(hook).TAX_BPS(), key.fee);
        if (s > 0) {
            // s <= q <= a pending balance of real tokens, far below 2^255; the
            // limit is under `spot`, so it fits in uint160.
            swapDelta = poolManager.swap(
                key,
                ICLPoolManager.SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(s),
                    sqrtPriceLimitX96: uint160(uint256(spot) * (BPS - MAX_SWAP_SQRT_MOVE_BPS) / BPS)
                }),
                ""
            );
        }

        // What is available to the position: the quote not swapped, and the
        // tokens bought plus any left over from earlier runs. One wei off each
        // side so the pool's round-up on a floored liquidity cannot ask for
        // more than is there.
        uint256 spent = uint256(uint128(-swapDelta.amount0()));
        uint256 quoteAvail = q - spent;
        uint256 tokenAvail = uint256(uint128(swapDelta.amount1())) + pendingToken[hook];

        (uint160 sqrtNow,,,) = poolManager.getSlot0(key.toId());
        int24 spacing = IToshAutoLpHook(hook).TICK_SPACING();
        // Truncating toward zero is the point: the widest tick the spacing allows.
        int24 lower = (TickMath.MIN_TICK / spacing) * spacing;
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtNow,
            TickMath.getSqrtRatioAtTick(lower),
            TickMath.getSqrtRatioAtTick(-lower),
            quoteAvail > 0 ? quoteAvail - 1 : 0,
            tokenAvail > 0 ? tokenAvail - 1 : 0
        );

        BalanceDelta liqDelta;
        if (liquidity > 0) {
            (liqDelta,) = poolManager.modifyLiquidity(
                key,
                ICLPoolManager.ModifyLiquidityParams({
                    tickLower: lower, tickUpper: -lower, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)
                }),
                ""
            );
        }

        int256 net0 = int256(swapDelta.amount0()) + int256(liqDelta.amount0());
        int256 net1 = int256(swapDelta.amount1()) + int256(liqDelta.amount1());
        _settleNet(key.currency0, net0);
        _settleNet(key.currency1, net1);

        // net0 is what the run cost in quote (negative) or earned in fees
        // beyond it; net1 is what the token side gained or drew from pending.
        // Neither can go below zero: the run spends at most `q` <= pending
        // quote, and at most the tokens it bought plus pending tokens.
        pendingQuote[hook] = uint256(int256(pendingQuote[hook]) + net0);
        pendingToken[hook] = uint256(int256(pendingToken[hook]) + net1);

        uint256 quoteIn = spent + _paid(liqDelta.amount0());
        uint256 tokenIn = _paid(liqDelta.amount1());
        totalQuoteAdded[hook] += quoteIn;
        totalTokenAdded[hook] += tokenIn;
        emit LiquidityAdded(hook, quoteIn, tokenIn, liquidity);
        return "";
    }

    /// @dev What a liquidity delta drew from this contract, net of the fees
    ///      settled in the same delta.
    ///      `d` comes from the Vault, which bounds deltas well inside int128.
    function _paid(int128 d) internal pure returns (uint256) {
        return d < 0 ? uint256(uint128(-d)) : 0;
    }

    /// @dev Both casts are taken on the side of zero their branch checks.
    function _settleNet(Currency currency, int256 net) internal {
        if (net < 0) {
            vault.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(vault), uint256(-net));
            vault.settle();
        } else if (net > 0) {
            vault.take(currency, address(this), uint256(net));
        }
    }

    /// @dev Quote to swap so that what is left of `q` and what it buys sit in
    ///      the pool's ratio afterwards. Constant-product zap on the virtual
    ///      reserve `x`, with the input discounted by the hook's tax and the
    ///      pool fee (`g` = what of each unit reaches the curve, in ppm):
    ///
    ///          s = (√(x²(1+g)² + 4g·x·q) − x(1+g)) / 2g
    ///
    ///      Approximate on concentrated liquidity and on the tax leaving the
    ///      pool rather than staying in it; the error is a remainder that
    ///      stays pending, never a loss.
    function _swapAmount(uint256 x, uint256 q, uint256 taxBps, uint24 feePpm) internal pure returns (uint256) {
        uint256 g = (BPS - taxBps) * (PPM - feePpm) / BPS;
        uint256 b = x * (PPM + g);
        uint256 root = Math.sqrt(b * b + 4 * g * PPM * x * q);
        return root > b ? (root - b) / (2 * g) : 0;
    }
}
