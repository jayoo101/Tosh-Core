// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ToshLadderTreasury} from "../../src/ToshLadderTreasury.sol";
import {IPoolManager} from "../../lib/v4-core/src/interfaces/IPoolManager.sol";

/// @title  RH-B4 piggyback gas probe
///
/// @notice Measures, on a real ArbOS chain, the gas a single buyback leg costs.
///         That number is the whole basis for `PIGGYBACK_MIN_GAS` and
///         `PIGGYBACK_TAIL_RESERVE` in `ToshLaunchpadHook`, and both were tuned
///         against Ethereum's gas accounting, which ArbOS does not share.
///
/// ── Why a probe is needed at all ────────────────────────────────────────────
///
///   The piggyback branch only executes once the reservoir holds `TRIGGER_STEP`
///   — 1 ETH, a `constant` with no setter. A testnet faucet does not dispense
///   that, and the dark tax that would fill it organically needs roughly 143 ETH
///   of swap volume. So on every chain where the constants COULD be measured,
///   the code that consumes them is unreachable.
///
///   A Foundry fork does not close the gap either: it replays ArbOS state on a
///   vanilla EVM, so it reproduces the Ethereum number with extra steps. See
///   `docs/ROBINHOOD_MIGRATION.md` §5.3.
///
///   Hence this: the real `ToshLadderTreasury`, deployed against the real
///   PoolManager and a real launched pool, with the arming threshold — and only
///   the arming threshold — replaced.
///
/// ── What is real here and what is not ───────────────────────────────────────
///
///   Real: `_runPiggyback`, `executeBuyAndBurn`, `_buyAndBurn`,
///   `_buybackSqrtFloor`, the V4 swap/settle/take triad, the pool, the hook
///   invoked by that swap, and ArbOS's own accounting for all of it.
///
///   Not real: the arming threshold, and the caller. `ProbeGasMeter` stands in
///   for a hook because `autoPiggybackBuyback` is `onlyHook`; it opens the
///   unlock frame that `afterSwap` would otherwise have opened.
///
///   The substitution is deliberately confined to `_nextSpendAmount`, the one
///   function that reads `TRIGGER_STEP` on the execution path. Everything the
///   measurement is about lies downstream of it.
///
/// @dev THIS FILE IS NOT PRODUCTION CODE and nothing in `src/` may import it.

/// @notice Stands in for `ToshFactory` so `onlyHook` and `addLadderToken`
///         resolve. It authenticates nothing — that is the point, and it is why
///         this contract lives under `test/`.
contract ProbeRegistry {
    address public immutable hook;
    address public immutable token;

    constructor(address _hook, address _token) {
        hook = _hook;
        token = _token;
    }

    /// @dev Any caller is a hook here. The production registry is the thing
    ///      being stood in for, not the thing being tested.
    function registeredHooks(address) external pure returns (bool) {
        return true;
    }

    /// @dev Answers only for the one token this probe was built around, so a
    ///      mistyped address fails loudly in `addLadderToken` rather than
    ///      listing something that does not exist.
    function tokenToHook(address t) external view returns (address) {
        return t == token ? hook : address(0);
    }
}

/// @notice The production treasury with a reachable arming threshold.
///
/// @dev The override drops the `TRIGGER_STEP` floor and the proportional
///      `SPEND_BPS` term, returning a flat operator-set figure instead. Both
///      omissions are safe for what is being measured: `_runPiggyback` divides
///      whatever it gets by `BATCH_SIZE` and runs `LEGS_PER_POKE` legs, so the
///      cost of a leg depends on the amount only through the swap itself, and
///      any amount small enough not to move the pool measures the same leg.
contract ProbeTreasury is ToshLadderTreasury {
    uint256 public probeSpend;

    event ProbeSpendSet(uint256 amount);

    constructor(address _poolManager, address _owner) ToshLadderTreasury(_poolManager, _owner) {}

    function setProbeSpend(uint256 amount) external onlyOwner {
        probeSpend = amount;
        emit ProbeSpendSet(amount);
    }

    function _nextSpendAmount() internal view override returns (uint256) {
        uint256 bal = address(this).balance;
        if (probeSpend == 0 || bal < probeSpend) return 0;
        return probeSpend;
    }
}

/// @notice Opens an unlock frame and measures the poke inside it, which is the
///         position a hook's `afterSwap` pokes from.
contract ProbeGasMeter {
    IPoolManager public immutable poolManager;
    ProbeTreasury public immutable treasury;

    /// @notice `gasleft()` consumed by `autoPiggybackBuyback` alone. This is the
    ///         quantity `PIGGYBACK_MIN_GAS` has to cover, less the tail reserve.
    uint256 public lastPokeGas;

    /// @notice `gasleft()` consumed by the whole `unlock` round trip, poke
    ///         included. The difference between the two is what V4 charges to
    ///         open and close a frame on this chain.
    uint256 public lastFrameGas;

    error NotPoolManager();

    event Measured(uint256 pokeGas, uint256 frameGas);

    constructor(address _poolManager, address payable _treasury) {
        poolManager = IPoolManager(_poolManager);
        treasury = ProbeTreasury(_treasury);
    }

    function measure() external {
        uint256 frameStart = gasleft();
        poolManager.unlock("");
        lastFrameGas = frameStart - gasleft();
        emit Measured(lastPokeGas, lastFrameGas);
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        // Read the counter before and after and nothing in between: an
        // intervening SLOAD or event would be billed to the measurement.
        uint256 before = gasleft();
        treasury.autoPiggybackBuyback();
        lastPokeGas = before - gasleft();

        return "";
    }
}
