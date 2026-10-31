// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";

import {IERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "../../lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  ToshBuybackV31
/// @notice The v3.1 platform revenue sink: every USDT it receives is turned
///         into $TOSH and burned.
///
///         It sits in the v3.1 hook's `ladderTreasury` slot, so it receives
///         the 1 % cut of every L2 mint and the 0.4 % buy-side swap tax, and
///         it is poked from `afterSwap` like v3's treasury. Point the
///         platform fee recipient here as well and it also receives the
///         opening position's pool fees and the launch rounding remainder.
///
///         Two legs:
///
///           1. CONVERT: USDT → WBNB through the PancakeSwap V2 USDT/WBNB
///              pair, refused if the fill is more than
///              `MAX_ORACLE_DEVIATION_BPS` worse than Chainlink's BNB/USD.
///           2. BURN: WBNB → TOSH through TOSH's own Infinity pool, bounded
///              against that pool's 30-minute TWAP, with every TOSH bought
///              sent to 0xdEaD. The TOSH hook charges its 1 % buy tax on it.
///
///         A swap's piggyback only ever converts. The burn leg runs only from
///         `pokeBuyback`, inside this contract's own Vault lock: there no
///         outer locker can add liquidity for the length of the leg to lift
///         its depth cap, and the leg has the gas a piggyback cannot spare.
///         A poke tries the burn leg while the contract holds at least
///         `MIN_BNB_LEG` WBNB and converts when it cannot run. Each leg is
///         capped at `MAX_LEG_DEPTH_BPS` of its pool's depth, so a large
///         balance is worked off over many pokes rather than in one bite a
///         sandwich could profit from.
///
///         No owner and no withdrawal. In normal running the only ways out
///         are the V2 pair (for WBNB back to this contract) and the Infinity
///         Vault (for TOSH to 0xdEaD). The deployer's one power is binding
///         the factory whose hooks may poke, once.
///
///         The one exception is a rescue, for a dependency that has died (a
///         retired feed, a drained pair, a dead TOSH pool): the `rescuer`
///         Safe requests one token's whole balance to one address, and may
///         execute it only `RESCUE_DELAY` later. The request is public for
///         that whole wait and can be cancelled.
contract ToshBuybackV31 {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    // ─── Constants ────────────────────────────────────────────────────────────

    /// @notice Share of the USDT balance one convert leg spends, floored at
    ///         `TRIGGER_STEP`. 5000 = 50 %.
    uint256 public constant SPEND_BPS = 5000;

    /// @notice Largest share of a pool's input-side depth one leg may take.
    ///         50 = 0.5 %, the figure v3's treasury measured as safely below
    ///         the ~1.4 % at which sandwiching a leg starts to pay.
    uint256 public constant MAX_LEG_DEPTH_BPS = 50;

    /// @notice How much worse than Chainlink's BNB/USD a convert leg may fill,
    ///         covering the pair's 0.25 % fee, the leg's own impact and oracle
    ///         lag. What it leaves beyond those is what a sandwich could take.
    uint256 public constant MAX_ORACLE_DEVIATION_BPS = 300;

    /// @notice Oldest Chainlink answer a convert leg will trust.
    uint256 public constant MAX_ORACLE_AGE = 1 hours;

    /// @notice How far below the TOSH pool's TWAP, in sqrt price, a burn leg
    ///         may push the pool before it stops filling (TOSH up to ≈ 23 %
    ///         dearer in price).
    uint256 public constant MAX_BUYBACK_SQRT_DEVIATION_BPS = 1000;

    /// @notice How far the TOSH pool's spot may already sit above its TWAP,
    ///         in sqrt price (≈ 1 %), for a burn leg to start at all.
    uint256 public constant MAX_PRE_LEG_SQRT_PREMIUM_BPS = 50;

    /// @notice WBNB below which a poke converts more USDT instead of burning.
    uint256 public constant MIN_BNB_LEG = 0.001 ether;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Wait between a rescue's request and its execution.
    uint256 public constant RESCUE_DELAY = 72 hours;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant V2_FEE_FACTOR = 9975; // PancakeSwap V2: 0.25 %

    /// @dev Transient recursion guard, read by v3.1 hooks through
    ///      `piggybackActive()`.
    uint256 private constant _PIGGYBACK_SLOT = 0x546f73684275796261636b5633310001;

    // ─── Immutables ───────────────────────────────────────────────────────────

    /// @notice USDT balance that arms a poke, and the least a convert leg
    ///         spends. The v3.1 hook copies it in its constructor.
    uint256 public immutable TRIGGER_STEP;

    ICLPoolManager public immutable poolManager;
    IVault public immutable vault;
    IERC20 public immutable usdt;
    IERC20 public immutable wbnb;
    /// @notice PancakeSwap V2 USDT/WBNB pair.
    IPancakeV2PairV31 public immutable pair;
    bool internal immutable _usdtIsToken0;
    /// @notice Chainlink BNB/USD.
    IChainlinkFeedV31 public immutable bnbUsdFeed;
    uint256 internal immutable _feedScale;
    /// @notice TOSH's launch hook; its pool is the burn leg's venue and its
    ///         TWAP the burn leg's bound.
    address public immutable toshHook;
    IERC20 public immutable tosh;
    address public immutable deployer;
    /// @notice The Safe that may request and execute a rescue.
    address public immutable rescuer;

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice The v3.1 factory whose hooks may poke. Set once.
    address public factory;

    /// @notice Block of the last burn leg. One per block: the TWAP cannot move
    ///         inside a block, so two legs there could share one sandwich.
    uint256 public lastBurnBlock;

    struct Rescue {
        address token;
        address to;
        uint64 readyAt;
    }

    /// @notice The requested rescue, if any; `readyAt == 0` when none.
    Rescue public pendingRescue;

    // ─── Events / errors ──────────────────────────────────────────────────────

    event FactorySet(address indexed factory);
    event Converted(uint256 usdtIn, uint256 wbnbOut);
    event BuybackBurned(uint256 wbnbIn, uint256 toshBurned);
    event LegSkipped(bool burnLeg, uint256 amount);
    event RescueRequested(address indexed token, address indexed to, uint256 readyAt);
    event RescueCancelled(address indexed token, address indexed to);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error OnlyDeployer();
    error FactoryAlreadySet();
    error FactoryMismatch();
    error OnlyHook();
    error OnlySelf();
    error OnlyVault();
    error NotArmed();
    error PiggybackInProgress();
    error BadDecimals();
    error BadPair();
    error BadPoolKey();
    error BadVault();
    error OracleStale();
    error PriceOffOracle();
    error TwapNotMature();
    error SpotAboveTwap();
    error LegAlreadyRanThisBlock();
    error OnlyRescuer();
    error NoRescuePending();
    error RescueNotReady();

    constructor(
        address _poolManager,
        address _vault,
        address _usdt,
        address _wbnb,
        address _pair,
        address _bnbUsdFeed,
        address _toshHook,
        uint256 _triggerStep,
        address _rescuer
    ) {
        if (
            _poolManager == address(0) || _vault == address(0) || _usdt == address(0) || _wbnb == address(0)
                || _pair == address(0) || _bnbUsdFeed == address(0) || _toshHook == address(0) || _triggerStep == 0
                || _rescuer == address(0)
        ) revert ZeroAddress();
        if (IERC20Metadata(_usdt).decimals() != 18 || IERC20Metadata(_wbnb).decimals() != 18) revert BadDecimals();
        // A mismatch would fail every burn leg inside its try, for good.
        if (IPoolManagerVaultV31(_poolManager).vault() != _vault) revert BadVault();

        address t0 = IPancakeV2PairV31(_pair).token0();
        address t1 = IPancakeV2PairV31(_pair).token1();
        if (!((t0 == _usdt && t1 == _wbnb) || (t0 == _wbnb && t1 == _usdt))) revert BadPair();

        PoolKey memory key = IToshHookV3ViewV31(_toshHook).getPoolKey();
        if (
            Currency.unwrap(key.currency0) != _wbnb || address(key.hooks) != _toshHook
                || address(key.poolManager) != _poolManager
        ) revert BadPoolKey();

        poolManager = ICLPoolManager(_poolManager);
        vault = IVault(_vault);
        usdt = IERC20(_usdt);
        wbnb = IERC20(_wbnb);
        pair = IPancakeV2PairV31(_pair);
        _usdtIsToken0 = t0 == _usdt;
        bnbUsdFeed = IChainlinkFeedV31(_bnbUsdFeed);
        _feedScale = 10 ** IChainlinkFeedV31(_bnbUsdFeed).decimals();
        toshHook = _toshHook;
        tosh = IERC20(Currency.unwrap(key.currency1));
        TRIGGER_STEP = _triggerStep;
        deployer = msg.sender;
        rescuer = _rescuer;
    }

    /// @notice Bind the v3.1 factory whose hooks may poke. Its hook
    ///         implementation must name this contract as `ladderTreasury`.
    function setFactory(address factory_) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        if (
            IToshHookV31TreasuryView(IToshFactoryV31Registry(factory_).hookImplementation()).ladderTreasury()
                != address(this)
        ) {
            revert FactoryMismatch();
        }
        factory = factory_;
        emit FactorySet(factory_);
    }

    // ─── Rescue ───────────────────────────────────────────────────────────────

    /// @notice Ask to send this contract's whole `token` balance to `to`,
    ///         executable `RESCUE_DELAY` from now. Replaces any pending ask.
    function requestRescue(address token, address to) external {
        if (msg.sender != rescuer) revert OnlyRescuer();
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        uint256 readyAt = block.timestamp + RESCUE_DELAY;
        // forge-lint: disable-next-line(unsafe-typecast) — a timestamp plus 72 hours
        pendingRescue = Rescue({token: token, to: to, readyAt: uint64(readyAt)});
        emit RescueRequested(token, to, readyAt);
    }

    function cancelRescue() external {
        if (msg.sender != rescuer) revert OnlyRescuer();
        Rescue memory r = pendingRescue;
        if (r.readyAt == 0) revert NoRescuePending();
        delete pendingRescue;
        emit RescueCancelled(r.token, r.to);
    }

    /// @notice Carry out the pending rescue once its delay has passed. Sends
    ///         the balance held now, not the one held at the request.
    function executeRescue() external returns (uint256 amount) {
        if (msg.sender != rescuer) revert OnlyRescuer();
        Rescue memory r = pendingRescue;
        if (r.readyAt == 0) revert NoRescuePending();
        if (block.timestamp < r.readyAt) revert RescueNotReady();
        delete pendingRescue;
        amount = IERC20(r.token).balanceOf(address(this));
        IERC20(r.token).safeTransfer(r.to, amount);
        emit Rescued(r.token, r.to, amount);
    }

    // ─── Pokes ────────────────────────────────────────────────────────────────

    /// @notice Called by v3.1 hooks from `afterSwap`, inside the swapper's
    ///         Vault lock. Converts only. Never reverts on a "not ready"
    ///         condition.
    function autoPiggybackBuyback() external {
        address f = factory;
        if (f == address(0) || !IToshFactoryV31Registry(f).registeredHooks(msg.sender)) revert OnlyHook();
        _run(false);
    }

    /// @notice Run one leg without riding a swap. Permissionless: the caller
    ///         chooses nothing but the moment. The only way the burn leg runs.
    function pokeBuyback() external {
        if (piggybackActive()) revert PiggybackInProgress();
        (, uint256 amount) = nextLeg();
        if (amount == 0) revert NotArmed();
        vault.lock("");
    }

    function lockAcquired(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(vault)) revert OnlyVault();
        _run(true);
        return "";
    }

    /// @notice One leg. External only so `_run` can fault-isolate it.
    function executeLeg(bool burnLeg, uint256 amount) external {
        if (msg.sender != address(this)) revert OnlySelf();
        if (burnLeg) _burnLeg(amount);
        else _convertLeg(amount);
    }

    /// @dev `ownLock` is true only inside this contract's own Vault lock. A
    ///      burn leg that cannot run falls through to a convert, so a stuck
    ///      TOSH pool never holds the USDT up as well.
    function _run(bool ownLock) internal {
        if (piggybackActive()) return;
        if (ownLock) {
            uint256 bnb = wbnb.balanceOf(address(this));
            if (bnb >= MIN_BNB_LEG && _leg(true, bnb)) return;
        }
        uint256 amount = _convertAmount();
        if (amount != 0) _leg(false, amount);
    }

    function _leg(bool burnLeg, uint256 amount) private returns (bool ran) {
        _setPiggyback(true);
        try this.executeLeg(burnLeg, amount) {
            ran = true;
        } catch {
            emit LegSkipped(burnLeg, amount);
        }
        _setPiggyback(false);
    }

    // ─── Legs ─────────────────────────────────────────────────────────────────

    /// @dev USDT → WBNB on the V2 pair, capped by depth, checked against
    ///      Chainlink.
    function _convertLeg(uint256 amountIn) internal {
        (uint256 r0, uint256 r1,) = pair.getReserves();
        (uint256 rIn, uint256 rOut) = _usdtIsToken0 ? (r0, r1) : (r1, r0);
        uint256 cap = (rIn * MAX_LEG_DEPTH_BPS) / BPS;
        if (amountIn > cap) amountIn = cap;
        uint256 inWithFee = amountIn * V2_FEE_FACTOR;
        uint256 out = (inWithFee * rOut) / (rIn * BPS + inWithFee);
        if (out == 0) revert NotArmed();
        if ((out * bnbUsdPrice()) / 1e18 < (amountIn * (BPS - MAX_ORACLE_DEVIATION_BPS)) / BPS) {
            revert PriceOffOracle();
        }

        usdt.safeTransfer(address(pair), amountIn);
        (uint256 out0, uint256 out1) = _usdtIsToken0 ? (uint256(0), out) : (out, uint256(0));
        pair.swap(out0, out1, address(this), "");
        emit Converted(amountIn, out);
    }

    /// @dev WBNB → TOSH in TOSH's pool, inside the current Vault lock, with
    ///      the proceeds taken straight to 0xdEaD.
    function _burnLeg(uint256 amountIn) internal {
        if (lastBurnBlock == block.number) revert LegAlreadyRanThisBlock();
        PoolKey memory key = IToshHookV3ViewV31(toshHook).getPoolKey();
        uint256 twap = IToshHookV3ViewV31(toshHook).twapSqrtPriceX96();
        if (twap == 0) revert TwapNotMature();

        PoolId id = key.toId();
        (uint160 spot,,,) = poolManager.getSlot0(id);
        // TOSH is currency1, so a dearer TOSH is a lower sqrt price.
        if (spot < (twap * (BPS - MAX_PRE_LEG_SQRT_PREMIUM_BPS)) / BPS) revert SpotAboveTwap();

        uint256 cap = ((uint256(poolManager.getLiquidity(id)) << 96) * MAX_LEG_DEPTH_BPS) / (uint256(spot) * BPS);
        if (amountIn > cap) amountIn = cap;
        if (amountIn == 0) revert NotArmed();

        uint256 floor = (twap * (BPS - MAX_BUYBACK_SQRT_DEVIATION_BPS)) / BPS;
        if (floor <= TickMath.MIN_SQRT_RATIO) floor = TickMath.MIN_SQRT_RATIO + 1;

        lastBurnBlock = block.number;
        BalanceDelta delta = poolManager.swap(
            key,
            ICLPoolManager.SwapParams({
                zeroForOne: true,
                // forge-lint: disable-next-line(unsafe-typecast) — capped at 0.5 % of a uint128 liquidity's depth
                amountSpecified: -int256(amountIn),
                // forge-lint: disable-next-line(unsafe-typecast) — below a uint160 TWAP
                sqrtPriceLimitX96: uint160(floor)
            }),
            ""
        );

        // Settle what the pool consumed, never the amount offered: a binding
        // floor fills only part of it, and the rest stays here.
        int128 owed = delta.amount0();
        // forge-lint: disable-next-line(unsafe-typecast) — negated only when negative
        uint256 spent = owed < 0 ? uint256(uint128(-owed)) : 0;
        if (spent > 0) {
            vault.sync(key.currency0);
            wbnb.safeTransfer(address(vault), spent);
            vault.settle();
        }
        int128 got = delta.amount1();
        if (got > 0) {
            // forge-lint: disable-next-line(unsafe-typecast) — positive
            uint256 bought = uint256(uint128(got));
            vault.take(key.currency1, DEAD_ADDRESS, bought);
            emit BuybackBurned(spent, bought);
        }
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice True while a leg is running. v3.1 hooks go passive while set.
    function piggybackActive() public view returns (bool active) {
        assembly ("memory-safe") {
            active := tload(_PIGGYBACK_SLOT)
        }
    }

    /// @notice What the next poke tries first: the burn leg with the WBNB
    ///         held, or the convert leg with `max(TRIGGER_STEP, USDT ×
    ///         SPEND_BPS)`, before the depth caps. Zero when unarmed.
    function nextLeg() public view returns (bool burnLeg, uint256 amount) {
        uint256 bnb = wbnb.balanceOf(address(this));
        if (bnb >= MIN_BNB_LEG) return (true, bnb);
        return (false, _convertAmount());
    }

    function _convertAmount() internal view returns (uint256 amount) {
        uint256 bal = usdt.balanceOf(address(this));
        if (bal < TRIGGER_STEP) return 0;
        amount = (bal * SPEND_BPS) / BPS;
        if (amount < TRIGGER_STEP) amount = TRIGGER_STEP;
    }

    /// @notice Chainlink BNB/USD in 1e18, or a revert if stale or invalid.
    function bnbUsdPrice() public view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = bnbUsdFeed.latestRoundData();
        if (answer <= 0 || updatedAt + MAX_ORACLE_AGE < block.timestamp) revert OracleStale();
        // forge-lint: disable-next-line(unsafe-typecast) — positive
        return (uint256(answer) * 1e18) / _feedScale;
    }

    function _setPiggyback(bool value) private {
        assembly ("memory-safe") {
            tstore(_PIGGYBACK_SLOT, value)
        }
    }
}

interface IPancakeV2PairV31 {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IPoolManagerVaultV31 {
    function vault() external view returns (address);
}

interface IChainlinkFeedV31 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IToshHookV3ViewV31 {
    function getPoolKey() external view returns (PoolKey memory);
    function twapSqrtPriceX96() external view returns (uint160);
}

interface IToshHookV31TreasuryView {
    function ladderTreasury() external view returns (address);
}

interface IToshFactoryV31Registry {
    function registeredHooks(address hook) external view returns (bool);
    function hookImplementation() external view returns (address);
}
