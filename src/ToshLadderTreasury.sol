// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "../lib/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "../lib/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "../lib/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "../lib/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "../lib/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "../lib/v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "../lib/v4-core/src/libraries/TransientStateLibrary.sol";

import {Ownable2Step} from "../lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";

/// @title  ToshLadderTreasury (v5.0)
/// @notice Platform-wide dark-tax reservoir and round-robin buyback executor.
///
/// ── Purpose ─────────────────────────────────────────────────────────────────
///
///   v5.0 replaces the v4.x per-pool `harvestAndBurn` + off-chain harvest bot
///   with a fully on-chain, self-driving deflation engine:
///
///     1. ETH flows in through four pipes (all native ETH):
///          • the 0.7 % BUY-side in-flight tax from every Tosh pool,
///          • project launch fees from ToshFactory,
///          • orphaned referral commission (deposits with no referrer),
///          • the 1 % platform cut of every Phase-2 shelf mint.
///        The SELL-side tax never arrives here by design — those tokens are
///        burned in place by the hook, needing no reservoir at all.
///     2. Every swap's `afterSwap` pokes `autoPiggybackBuyback()`.
///     3. Whenever this contract's balance crosses `TRIGGER_STEP` (1 ETH), the
///        poking swap "gives a ride" (顺风车) to a buyback: `max(TRIGGER_STEP,
///        balance × SPEND_BPS / 10_000)` is split evenly across the next
///        `BATCH_SIZE` ladder tokens in round-robin order, market-bought
///        through Uniswap V4, and the proceeds are sent straight to
///        `DEAD_ADDRESS`.  The 10 % proportional spend means a full reservoir
///        does not sit idle waiting for dozens of 1-ETH drips; the 1 ETH
///        floor keeps a near-empty pot from wasting gas on dust legs.
///
/// ── Iron rule: one-way valve ────────────────────────────────────────────────
///
///   There is deliberately NO `withdraw`, NO `transfer`, NO `sweep`, NO
///   `rescue`, and NO `delegatecall` in this contract.  The ONLY code path that
///   moves ETH out is `_buyAndBurn`, whose output currency is hard-wired to
///   `DEAD_ADDRESS`.  Not the owner, not a hook, not the factory can take
///   custody of a single wei.
///
///   AUDIT GREP (must produce ZERO matches in this file):
///     • `function withdraw`         — absent by design
///     • `function sweep`            — absent by design
///     • `function rescue`           — absent by design
///     • `delegatecall`              — absent by design
///     • `.transfer(` / `.call{value` outside `_buyAndBurn` — absent by design
///
/// ── What the valve does NOT constrain ───────────────────────────────────────
///
///   The paragraph above is about CUSTODY, and it is easy to misread as a
///   statement about BENEFICIARIES.  It is not one.  The owner cannot take the
///   ETH, but the owner alone decides which markets absorb it, and buying
///   pressure that terminates in a burn is still buying pressure that lands in
///   somebody's order book.  An owner who lists one token and delists the rest
///   points the whole reservoir at a single price.
///
///   Two things bound that, and neither is the valve:
///
///     • `_buybackSqrtFloor` caps how far above a pool's TWAP any cycle will
///       fill, so concentration is rate-limited to roughly one deviation band
///       per TWAP window rather than being drainable on demand.
///     • `perToken` is divided by BATCH_SIZE, NOT by the number of listings, so
///       a one-token ladder deploys a third of the rate a full one does.  A
///       narrow list now buys a narrow trickle; it used to buy the same
///       cheque, concentrated.
///
///   What remains is a governance surface, not a code one: curation should sit
///   behind the same multisig and change-review as any other economic dial.
///
/// ── Execution context ───────────────────────────────────────────────────────
///
///   `autoPiggybackBuyback()` is invoked from a hook's `afterSwap`, i.e. while
///   the PoolManager is ALREADY unlocked by some third-party router.  We
///   therefore do NOT call `poolManager.unlock()` (that would revert with
///   `AlreadyUnlocked`); we call `swap` / `settle` / `take` directly and the
///   resulting deltas are attributed to `address(this)` and zeroed out before
///   we return.
///
contract ToshLadderTreasury is Ownable2Step {
    using CurrencyLibrary for Currency;
    using TransientStateLibrary for IPoolManager;

    // ─── Constants ────────────────────────────────────────────────────────────

    /// @notice Balance threshold that arms a piggyback buyback, and the
    ///         minimum ETH a cycle will spend.  A fuller reservoir spends
    ///         `SPEND_BPS` of its balance instead, so ammunition does not
    ///         pile up through quiet trading hours.
    uint256 public constant TRIGGER_STEP = 1 ether;

    /// @notice Fraction of the reservoir spent per piggyback cycle, in
    ///         basis points.  1000 = 10 %.  Floored at `TRIGGER_STEP`.
    uint256 public constant SPEND_BPS = 1000;

    /// @notice Maximum ladder tokens serviced by a single piggyback cycle.
    ///         Caps the gas surcharge borne by the unlucky trader whose swap
    ///         happens to cross the threshold.
    uint256 public constant BATCH_SIZE = 3;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice How far below the pool's TWAP a buyback leg may drive the sqrt
    ///         price before it stops filling.
    ///
    /// @dev    Stated in SQRT terms, so 1000 bps is roughly a 19 % move in
    ///         price, not 10 %.  Deliberately loose: the bound exists to make
    ///         sandwiching unprofitable, not to track the market closely, and a
    ///         tight bound would stall legitimate buybacks whenever a token
    ///         rallied hard inside a single TWAP window.  An attacker who wants
    ///         to evade it has to shift the price ~19 % and hold that through
    ///         the poke, paying the 0.3 % LP fee and the 0.7 % hook tax on both
    ///         legs of a position far larger than the 0.33 ETH they are trying
    ///         to skim.
    uint256 public constant MAX_BUYBACK_SQRT_DEVIATION_BPS = 1000;

    /// @dev Transient-storage slot holding the recursion guard.  A piggyback
    ///      buys through OTHER Tosh pools, whose hooks would otherwise tax the
    ///      buyback and re-trigger a nested piggyback.  Hooks read
    ///      `piggybackActive()` and go fully passive while it is set.
    ///      Transient (EIP-1153) because the flag is only meaningful within the
    ///      current transaction.
    uint256 private constant _PIGGYBACK_SLOT = 0x546f73685069676779626163b1000001;

    // ─── Immutables ───────────────────────────────────────────────────────────

    IPoolManager public immutable poolManager;

    // ─── State ────────────────────────────────────────────────────────────────

    /// @notice ToshFactory, used to authenticate calling hooks.  Set once.
    address public factory;

    /// @notice Platform-curated tokens eligible for buyback-and-burn.
    address[] public ladderTokens;

    /// @notice Round-robin cursor into `ladderTokens`.
    uint256 public currentCursor;

    /// @dev token => V4 PoolKey of its ETH pair.
    mapping(address => PoolKey) internal _poolKeyOf;

    /// @dev token => (index in `ladderTokens`) + 1.  Zero means "not listed".
    mapping(address => uint256) internal _indexPlusOne;

    // ─── Events ───────────────────────────────────────────────────────────────

    event FactorySet(address indexed factory);
    event LadderTokenAdded(address indexed token, uint256 index);
    event LadderTokenRemoved(address indexed token, uint256 index);
    event TaxReceived(address indexed from, uint256 amount);

    /// @notice Emitted once per piggyback cycle.
    event PiggybackExecuted(uint256 ethSpent, uint256 tokensServiced, uint256 newCursor);

    /// @notice Emitted per ladder token bought and burned.
    event BuybackBurned(address indexed token, uint256 ethIn, uint256 tokensBurned);

    /// @notice Emitted when one leg of a batch reverts.  The cycle continues —
    ///         a single broken pool must never brick platform-wide trading.
    event BuybackSkipped(address indexed token, uint256 ethIn);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error OnlyHook();
    error OnlySelf();
    error FactoryAlreadySet();
    error FactoryNotSet();
    error ZeroAddress();
    error TokenAlreadyListed();
    error TokenNotListed();
    error TokenNotLaunchedHere();
    error InvalidPoolKey();

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _poolManager, address _owner) Ownable(_owner) {
        if (_poolManager == address(0) || _owner == address(0)) revert ZeroAddress();
        poolManager = IPoolManager(_poolManager);
    }

    // ─── Funding ──────────────────────────────────────────────────────────────

    /// @notice Accepts the 1 % dark tax from hooks, launch fees from the
    ///         factory, orphaned referral commission, and unsolicited donations.
    ///         Every wei that lands here is buyback ammunition — there is no
    ///         path back out except `_buyAndBurn`.
    receive() external payable {
        emit TaxReceived(msg.sender, msg.value);
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyHook() {
        address f = factory;
        if (f == address(0) || !IToshFactoryRegistry(f).registeredHooks(msg.sender)) revert OnlyHook();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    // ─── Owner administration (ladder curation ONLY) ──────────────────────────

    /// @notice Bind the factory whose `registeredHooks` map authenticates
    ///         piggyback callers.  One-shot: the treasury is deployed before
    ///         the factory (the factory needs this address in its
    ///         constructor), so the link is completed post-deploy.
    function setFactory(address _factory) external onlyOwner {
        if (_factory == address(0)) revert ZeroAddress();
        if (factory != address(0)) revert FactoryAlreadySet();
        factory = _factory;
        emit FactorySet(_factory);
    }

    /// @notice List `token` on the buyback ladder.
    ///
    /// @dev    The venue is DERIVED, never supplied.  An earlier revision let
    ///         the owner pass an arbitrary `PoolKey` alongside the token and
    ///         checked only the currency ordering, which silently defeated the
    ///         one-way valve above: the owner could mint a worthless ERC-20,
    ///         pair it in a hookless pool they alone provided liquidity to,
    ///         list it, and let each 1 ETH buyback settle into their own
    ///         position — draining the entire reservoir one trigger at a time
    ///         while emitting nothing but ordinary `BuybackBurned` events.
    ///
    ///         Two facts now make the venue unforgeable.  `tokenToHook` proves
    ///         this platform launched the token, and the key is read back from
    ///         that hook, so the ETH can only ever be spent in the deep genesis
    ///         pool the hook itself polices.  Both depend on `factory`, which
    ///         is why its binding is one-shot: a re-pointable factory would
    ///         hand the answer to both questions back to the owner.
    ///
    /// @param  token A token launched by this platform, already through
    ///               `launch()` (an unlaunched hook has no pool key yet).
    function addLadderToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (_indexPlusOne[token] != 0) revert TokenAlreadyListed();

        address f = factory;
        if (f == address(0)) revert FactoryNotSet();

        address hook = IToshFactoryRegistry(f).tokenToHook(token);
        if (hook == address(0)) revert TokenNotLaunchedHere();

        PoolKey memory key = IToshHookPoolKey(hook).getPoolKey();

        // ETH must be currency0 and `token` must be currency1, otherwise the
        // hard-wired `zeroForOne = true` buy direction in `_buyAndBurn` would
        // swap the wrong way round.  A zero key — a hook that has not launched
        // — fails the `currency1` arm.
        if (!key.currency0.isAddressZero()) revert InvalidPoolKey();
        if (Currency.unwrap(key.currency1) != token) revert InvalidPoolKey();
        if (address(key.hooks) != hook) revert InvalidPoolKey();

        _poolKeyOf[token] = key;

        ladderTokens.push(token);
        _indexPlusOne[token] = ladderTokens.length;

        emit LadderTokenAdded(token, ladderTokens.length - 1);
    }

    /// @notice Delist `token`, keeping `ladderTokens` compact via swap-and-pop.
    /// @dev    Swap-and-pop reorders the array, which perturbs the round-robin
    ///         sequence.  That is acceptable: the cursor only needs to be
    ///         in-range and eventually fair, not stable across delistings.
    function removeLadderToken(address token) external onlyOwner {
        uint256 idxPlusOne = _indexPlusOne[token];
        if (idxPlusOne == 0) revert TokenNotListed();

        uint256 idx = idxPlusOne - 1;
        uint256 lastIdx = ladderTokens.length - 1;

        if (idx != lastIdx) {
            address moved = ladderTokens[lastIdx];
            ladderTokens[idx] = moved;
            _indexPlusOne[moved] = idx + 1;
        }

        ladderTokens.pop();
        delete _indexPlusOne[token];
        delete _poolKeyOf[token];

        // Keep the cursor inside the (now shorter) array.
        uint256 len = ladderTokens.length;
        currentCursor = len == 0 ? 0 : currentCursor % len;

        emit LadderTokenRemoved(token, idx);
    }

    // ─── Piggyback buyback ────────────────────────────────────────────────────

    /// @notice Poke the buyback engine.  Called by every Tosh hook from
    ///         `afterSwap`; a no-op unless the reservoir has crossed
    ///         `TRIGGER_STEP`.
    ///
    /// @dev    This function must NEVER revert on a "not ready" condition — it
    ///         sits in the hot path of ordinary user swaps, and a revert here
    ///         would make the pool untradeable.  Every precondition therefore
    ///         returns early instead of reverting, and each buy leg is
    ///         individually fault-isolated behind `try/catch`.
    function autoPiggybackBuyback() external onlyHook {
        // Already inside a piggyback (a nested Tosh pool poked us) — stay passive.
        if (piggybackActive()) return;

        // Must be inside someone's unlock frame to touch swap/settle/take.
        if (!poolManager.isUnlocked()) return;

        uint256 spend = _nextSpendAmount();
        if (spend == 0) return;

        uint256 total = ladderTokens.length;
        if (total == 0) return;

        uint256 count = total < BATCH_SIZE ? total : BATCH_SIZE;

        // Divided by BATCH_SIZE rather than by `count`, so a short ladder
        // spends proportionally less instead of concentrating the same cheque
        // into fewer pools.  With `total >= BATCH_SIZE` — the steady state —
        // the two are identical; the difference only shows up on a list the
        // owner has narrowed, which is exactly the case worth throttling.
        uint256 perToken = spend / BATCH_SIZE;
        if (perToken == 0) return;

        _setPiggyback(true);

        uint256 cursor = currentCursor;
        for (uint256 i; i < count; ++i) {
            address token = ladderTokens[(cursor + i) % total];

            // Fault isolation: an illiquid, paused, or otherwise hostile ladder
            // pool must not brick the innocent trader's swap.  The self-call is
            // external, so a revert rolls back that leg's V4 deltas entirely
            // and leaves its ETH in the reservoir for the next cycle.
            try this.executeBuyAndBurn(token, perToken) {}
            catch {
                emit BuybackSkipped(token, perToken);
            }
        }

        currentCursor = (cursor + count) % total;

        _setPiggyback(false);

        emit PiggybackExecuted(perToken * count, count, currentCursor);
    }

    /// @notice Single buyback leg.  External ONLY so that `autoPiggybackBuyback`
    ///         can wrap it in `try/catch` for per-token fault isolation; it is
    ///         not reachable by anyone other than this contract.
    function executeBuyAndBurn(address token, uint256 ethIn) external onlySelf {
        _buyAndBurn(token, ethIn);
    }

    /// @dev Market-buy `token` with `ethIn` wei through V4 and send 100 % of the
    ///      proceeds to `DEAD_ADDRESS`.
    ///
    ///      Runs inside the caller's existing unlock frame, so the sequence is
    ///      the bare V4 flash-accounting triad:
    ///        swap  → our delta becomes (-ethIn on currency0, +out on currency1)
    ///        settle→ pay the ETH we owe
    ///        take  → collect the tokens straight into 0xdead
    ///
    ///      The swap is bounded by a TWAP-anchored price floor.  An earlier
    ///      revision passed `MIN_SQRT_PRICE + 1` — no bound at all — reasoning
    ///      that a burned output has no victim.  That misses who pays: a
    ///      sandwicher can buy ahead of the poke, let this leg fill against the
    ///      inflated price, and sell back into the support it just provided.
    ///      Nothing is stolen from a user, but the reservoir's ETH buys fewer
    ///      tokens to burn and the difference lands in the attacker's pocket,
    ///      so the deflation the tax was collected to deliver is skimmed.
    function _buyAndBurn(address token, uint256 ethIn) internal {
        PoolKey memory key = _poolKeyOf[token];

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: true, // ETH (currency0) → token (currency1)
                amountSpecified: -int256(ethIn), // negative == exact input
                sqrtPriceLimitX96: _buybackSqrtFloor(key)
            }),
            ""
        );

        // Settle exactly what the pool consumed, never the amount offered.  A
        // binding floor fills only part of `ethIn`, and paying the full amount
        // would leave this contract holding an unclaimed credit — which fails
        // the unlock frame's all-deltas-zero check and reverts the whole swap
        // for the innocent trader who happened to trigger us.  Whatever goes
        // unspent simply stays in the reservoir for the next cycle.
        int128 owed = delta.amount0();
        uint256 spent = owed < 0 ? uint256(uint128(-owed)) : 0;
        if (spent > 0) {
            // `sync(native)` resets the synced-currency slot so `settle`
            // attributes our msg.value to the native currency even if an outer
            // frame had synced an ERC-20.
            //
            // This CLOBBERS that outer frame's slot, and V4 gives us no way to
            // read it back or restore it.  Harmless for the canonical settle
            // pattern, where `sync` immediately precedes the transfer it pairs
            // with and therefore runs after any swap that could poke us; it
            // would corrupt an integrator who instead syncs, then swaps, then
            // settles.  Documented rather than fixed because the fix does not
            // exist at the V4 interface level — and because the alternative,
            // omitting the sync, breaks our own settle in the far more common
            // case where an outer frame left an ERC-20 latched.
            poolManager.sync(CurrencyLibrary.ADDRESS_ZERO);
            poolManager.settle{value: spent}();
        }

        int128 out = delta.amount1();
        if (out > 0) {
            uint256 bought = uint256(uint128(out));
            poolManager.take(key.currency1, DEAD_ADDRESS, bought);
            emit BuybackBurned(token, spent, bought);
        }
    }

    /// @dev Lower bound on the sqrt price this buyback may push the pool to.
    ///
    ///      Anchored to the hook's TWAP rather than to slot0: spot is the very
    ///      quantity a sandwicher displaces, so a spot-relative bound would
    ///      move with the attack and constrain nothing.  Against the TWAP, a
    ///      front-run that stretches the price past the bound makes this leg
    ///      fill partially or revert into `BuybackSkipped`, leaving the
    ///      attacker holding an inventory they bought with no exit.
    ///
    ///      Falls back to unbounded when the hook has no TWAP yet (the first
    ///      window after launch) or does not answer, because refusing to buy
    ///      would be the worse failure: the reservoir would stall permanently
    ///      on any pool whose hook predates this interface.
    function _buybackSqrtFloor(PoolKey memory key) internal view returns (uint160) {
        uint160 unbounded = TickMath.MIN_SQRT_PRICE + 1;

        try IToshHookTwap(address(key.hooks)).twapSqrtPriceX96() returns (uint160 twapSqrt) {
            if (twapSqrt == 0) return unbounded;
            uint256 floor = (uint256(twapSqrt) * (BPS_DENOMINATOR - MAX_BUYBACK_SQRT_DEVIATION_BPS)) / BPS_DENOMINATOR;
            return floor > unbounded ? uint160(floor) : unbounded;
        } catch {
            return unbounded;
        }
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @notice True while a piggyback cycle is mid-flight.  Tosh hooks consult
    ///         this to suppress their dark tax and their own piggyback poke,
    ///         preventing cross-hook recursion.
    function piggybackActive() public view returns (bool active) {
        assembly ("memory-safe") {
            active := tload(_PIGGYBACK_SLOT)
        }
    }

    function ladderTokenCount() external view returns (uint256) {
        return ladderTokens.length;
    }

    function isLadderToken(address token) external view returns (bool) {
        return _indexPlusOne[token] != 0;
    }

    function getPoolKey(address token) external view returns (PoolKey memory) {
        return _poolKeyOf[token];
    }

    /// @notice ETH still needed before the next piggyback arms.
    function untilNextTrigger() external view returns (uint256) {
        uint256 bal = address(this).balance;
        return bal >= TRIGGER_STEP ? 0 : TRIGGER_STEP - bal;
    }

    /// @notice ETH the next piggyback cycle will spend, or 0 if unarmed.
    function nextSpendAmount() external view returns (uint256) {
        return _nextSpendAmount();
    }

    // ─── Internals ────────────────────────────────────────────────────────────

    /// @dev `max(TRIGGER_STEP, balance × SPEND_BPS / 10_000)`, or 0 below the
    ///      arming threshold.  Capped at the live balance so a rounding edge
    ///      can never try to spend more than the pot holds.
    function _nextSpendAmount() internal view returns (uint256 spend) {
        uint256 bal = address(this).balance;
        if (bal < TRIGGER_STEP) return 0;
        spend = (bal * SPEND_BPS) / BPS_DENOMINATOR;
        if (spend < TRIGGER_STEP) spend = TRIGGER_STEP;
        if (spend > bal) spend = bal;
    }

    function _setPiggyback(bool value) private {
        assembly ("memory-safe") {
            tstore(_PIGGYBACK_SLOT, value)
        }
    }
}

/// @dev Minimal factory view used to authenticate piggyback callers and to
///      prove a candidate ladder token's provenance, kept thin to avoid a
///      circular import with ToshFactory.
interface IToshFactoryRegistry {
    function registeredHooks(address hook) external view returns (bool);
    function tokenToHook(address token) external view returns (address);
}

/// @dev Minimal hook view used to read back the canonical pool a launched token
///      trades in, so the buyback venue is never caller-supplied.
interface IToshHookPoolKey {
    function getPoolKey() external view returns (PoolKey memory);
}

/// @dev Minimal hook view exposing the manipulation-resistant price reference a
///      buyback bounds itself against.
interface IToshHookTwap {
    function twapSqrtPriceX96() external view returns (uint160);
}
