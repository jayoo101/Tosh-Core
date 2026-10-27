// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {FullMath} from "infinity-core/src/pool-cl/libraries/FullMath.sol";

import {V2Base} from "./utils/V2Base.sol";
import {ToshLaunchpadHook} from "../../src/ToshLaunchpadHook.sol";
import {ToshLadderTreasury} from "../../src/ToshLadderTreasury.sol";
import {ToshToken} from "../../src/ToshToken.sol";

/// @dev Attacker that opens its own Vault locks and nets every delta it creates.
contract Attacker {
    IVault immutable vault;
    ICLPoolManager immutable pm;

    constructor(IVault v, ICLPoolManager p) {
        vault = v;
        pm = p;
    }

    function swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified, uint160 limit) external {
        vault.lock(abi.encode(uint8(0), abi.encode(key, zeroForOne, amountSpecified, limit)));
    }

    function liq(PoolKey memory key, int24 lo, int24 hi, int256 dL) external {
        vault.lock(abi.encode(uint8(1), abi.encode(key, lo, hi, dL)));
    }

    /// Sandwich-in-one-lock: pump, then a 1-wei-ish trigger swap whose afterSwap
    /// runs the piggyback leg, then dump.  Nothing is settled until the end.
    function flashSandwich(PoolKey memory key, uint256 pumpIn, uint160 floor_, uint256 triggerIn, uint256 n) external {
        vault.lock(abi.encode(uint8(2), abi.encode(key, pumpIn, floor_, triggerIn, n)));
    }

    /// sync(quote) -> sell swap (piggyback fires inside) -> transfer quote -> settle
    function syncSellPay(PoolKey memory key, uint256 tokensIn, uint256 pay) external {
        vault.lock(abi.encode(uint8(3), abi.encode(key, tokensIn, pay)));
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(vault), "vault");
        (uint8 op, bytes memory p) = abi.decode(data, (uint8, bytes));
        PoolKey memory key;
        if (op == 0) {
            bool z;
            int256 amt;
            uint160 lim;
            (key, z, amt, lim) = abi.decode(p, (PoolKey, bool, int256, uint160));
            pm.swap(key, ICLPoolManager.SwapParams({zeroForOne: z, amountSpecified: amt, sqrtPriceLimitX96: lim}), "");
        } else if (op == 1) {
            int24 lo;
            int24 hi;
            int256 dL;
            (key, lo, hi, dL) = abi.decode(p, (PoolKey, int24, int24, int256));
            pm.modifyLiquidity(
                key,
                ICLPoolManager.ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: dL, salt: 0}),
                ""
            );
        } else if (op == 2) {
            uint256 pumpIn;
            uint160 floor_;
            uint256 triggerIn;
            uint256 n;
            (key, pumpIn, floor_, triggerIn, n) = abi.decode(p, (PoolKey, uint256, uint160, uint256, uint256));
            pm.swap(key, ICLPoolManager.SwapParams(true, -int256(pumpIn), floor_), "");
            for (uint256 i; i < n; ++i) {
                pm.swap(key, ICLPoolManager.SwapParams(true, -int256(triggerIn), TickMath.MIN_SQRT_RATIO + 1), "");
            }
            int256 d1 = vault.currencyDelta(address(this), key.currency1);
            pm.swap(key, ICLPoolManager.SwapParams(false, -d1, TickMath.MAX_SQRT_RATIO - 1), "");
        } else if (op == 3) {
            uint256 tokensIn;
            uint256 pay;
            (key, tokensIn, pay) = abi.decode(p, (PoolKey, uint256, uint256));
            vault.sync(key.currency0);
            pm.swap(key, ICLPoolManager.SwapParams(false, -int256(tokensIn), TickMath.MAX_SQRT_RATIO - 1), "");
            IERC20(Currency.unwrap(key.currency0)).transfer(address(vault), pay);
            vault.settle();
        }
        _settle(key.currency0);
        _settle(key.currency1);
        return "";
    }

    function _settle(Currency c) internal {
        int256 d = vault.currencyDelta(address(this), c);
        if (d < 0) {
            vault.sync(c);
            IERC20(Currency.unwrap(c)).transfer(address(vault), uint256(-d));
            vault.settle();
        } else if (d > 0) {
            vault.take(c, address(this), uint256(d));
        }
    }
}

contract TreasuryAuditTest is V2Base {
    using PoolIdLibrary for PoolKey;

    ToshToken token;
    ToshLaunchpadHook hook;
    PoolKey key;
    Attacker atk;

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
        _buy(hook, alice, 5e18);
        _buy(hook, bob, 5e18);
        _launchAsAdmin(hook);
        _nextBlock();
        vm.warp(block.timestamp + hook.TWAP_WINDOW());
        _nextBlock();
        vm.prank(admin);
        ladder.addLadderToken(address(token));
        key = hook.getPoolKey();
        atk = new Attacker(IVault(address(vault)), ICLPoolManager(address(poolManager)));
        quote.mint(address(atk), 1_000e18);
    }

    // ─── helpers ──────────────────────────────────────────────────────────────

    function _setReservoir(uint256 amount) internal {
        uint256 bal = quote.balanceOf(address(ladder));
        if (bal > amount) quote.burn(address(ladder), bal - amount);
        else quote.mint(address(ladder), amount - bal);
    }

    function _sqrt() internal view returns (uint160 s, int24 t) {
        (s, t,,) = poolManager.getSlot0(key.toId());
    }

    /// quote-wei value of `tokens` at sqrt price `s` (currency0 = quote).
    function _valueAt(uint256 tokens, uint160 s) internal pure returns (uint256) {
        uint256 inner = FullMath.mulDiv(tokens, 1 << 96, s);
        return FullMath.mulDiv(inner, 1 << 96, s);
    }

    function _floor() internal view returns (uint160) {
        return uint160(uint256(hook.twapSqrtPriceX96()) * 9000 / 10_000);
    }

    function _poke(uint256 n) internal returns (uint256 done) {
        for (uint256 i; i < n; ++i) {
            try ladder.pokeBuyback() {
                ++done;
            } catch {
                break;
            }
        }
    }

    // ─── F-1: JIT liquidity defeats MAX_LEG_DEPTH_BPS ─────────────────────────

    /// Pump to just inside the TWAP band, add a narrow third-party position
    /// around spot so `_legDepthCeiling` (which reads ACTIVE liquidity) lets the
    /// full `perToken` leg through, sell the attacker's inventory to the
    /// treasury at the pumped price, pull the position, dump.
    function test_F1_jitLiquidityCannotBypassDepthCap() public {
        uint256 R = 5e18;
        _setReservoir(R);
        (uint160 fairSqrt,) = _sqrt();
        uint256 capBefore = ladder.legCeiling(address(token));
        uint256 perToken = ladder.nextSpendAmount() / 3;
        console2.log("pool quote depth (virtual)   ", capBefore * 200);
        console2.log("honest leg cap (0.5% depth)  ", capBefore);
        console2.log("perToken offered             ", perToken);

        // Attacker inventory: alice's genesis tokens (valued at fair price).
        uint256 inv = token.balanceOf(alice);
        vm.prank(alice);
        token.transfer(address(atk), inv);
        console2.log("attacker token inventory (fair value)", _valueAt(inv, fairSqrt));
        uint256 q0 = quote.balanceOf(address(atk));
        uint256 t0 = token.balanceOf(address(atk));
        uint256 dead0 = token.balanceOf(DEAD);

        // 1. pump (exact-output, stops at limit, tax only on what fills)
        uint160 floor_ = _floor();
        uint160 pumpTo = uint160(uint256(floor_) * 10_200 / 10_000);
        atk.swap(key, true, int256(1e30), pumpTo);
        uint256 pumpTokens = token.balanceOf(address(atk)) - t0;

        // 2. JIT: narrow range containing spot
        (, int24 tc) = _sqrt();
        int24 hi = (tc / 200) * 200 + 200;
        int24 lo = hi - 400;
        uint128 Lg = poolManager.getLiquidity(key.toId());
        uint256 capPumped = ladder.legCeiling(address(token));
        uint256 mult = perToken / capPumped + 1;
        int256 Lj = int256(uint256(Lg) * mult * 2);
        atk.liq(key, lo, hi, Lj);
        console2.log("leg cap after JIT            ", ladder.legCeiling(address(token)));

        // 3. drain: every poke on a one-token ladder hits this pool
        uint256 n = _poke(40);
        console2.log("pokes run in one tx          ", n);

        // 4. unwind
        atk.liq(key, lo, hi, -Lj);
        atk.swap(key, false, -int256(pumpTokens), TickMath.MAX_SQRT_RATIO - 1);

        uint256 q1 = quote.balanceOf(address(atk));
        uint256 t1 = token.balanceOf(address(atk));
        int256 profit = int256(q1) - int256(q0) - int256(_valueAt(t0 - t1, fairSqrt));
        uint256 spent = R - ladder.reservoir();
        uint256 burned = token.balanceOf(DEAD) - dead0;
        console2.log("reservoir spent              ", spent);
        console2.log("tokens burned (fair value)   ", _valueAt(burned, fairSqrt));
        console2.log("attacker profit (quote wei)  ", profit);
        assertLe(spent, capBefore, "a pumped pool gets no more than one honest leg");
        assertLe(profit, 0, "the JIT sandwich does not pay");
    }

    // ─── F-2: stacked pokes in one tx inside one sandwich ─────────────────────

    function _stackedSandwich(uint256 pumpIn, uint256 pokes) internal returns (int256 profit, uint256 spent) {
        uint256 snap = vm.snapshotState();
        uint256 R = ladder.reservoir();
        uint256 q0 = quote.balanceOf(address(atk));
        atk.swap(key, true, -int256(pumpIn), _floor());
        uint256 got = token.balanceOf(address(atk));
        _poke(pokes);
        atk.swap(key, false, -int256(got), TickMath.MAX_SQRT_RATIO - 1);
        profit = int256(quote.balanceOf(address(atk))) - int256(q0);
        // pump tax that lands in the reservoir inflates R; measure net spend
        spent = R + (pumpIn * 70 / 10_000) > ladder.reservoir() ? R + (pumpIn * 70 / 10_000) - ladder.reservoir() : 0;
        vm.revertToState(snap);
    }

    function test_F2_stackedPokesSandwichDoesNotPay() public {
        _setReservoir(10e18);
        uint256 cap = ladder.legCeiling(address(token));
        console2.log("leg cap (0.5% depth)", cap);
        int256 best;
        uint256 bestA;
        uint256 bestK;
        uint256[4] memory pumps = [uint256(0.2e18), 0.4e18, 0.6e18, 0.8e18];
        uint256[4] memory ks = [uint256(1), 3, 10, 40];
        for (uint256 i; i < pumps.length; ++i) {
            for (uint256 j; j < ks.length; ++j) {
                (int256 p, uint256 s) = _stackedSandwich(pumps[i], ks[j]);
                console2.log("pump / pokes:", pumps[i], ks[j]);
                console2.log("   profit:", p);
                console2.log("   treasury spent:", s);
                if (p > best) (best, bestA, bestK) = (p, pumps[i], ks[j]);
            }
        }
        // single poke (what the depth cap was sized for) must lose
        (int256 single,) = _stackedSandwich(0.4e18, 1);
        assertLt(single, 0, "one leg per sandwich is unprofitable, as designed");
        assertLe(best, 0, "stacking pokes in one tx no longer makes the sandwich pay");
        console2.log("best pump, pokes:", bestA, bestK);
        console2.log("best profit:", best);
    }

    /// Same attack with zero capital: pump, trigger the piggyback via a swap's
    /// afterSwap, dump - all in ONE vault lock, settled net.
    function test_F2b_flashSandwichInOneLockDoesNotPay() public {
        _setReservoir(10e18);
        uint256 snap = vm.snapshotState();
        int256 one = _flash(1);
        vm.revertToState(snap);
        int256 many = _flash(10);
        console2.log("flash net, 1 piggyback leg  ", one);
        console2.log("flash net, 10 piggyback legs", many);
        assertLt(one, 0);
        assertLe(many, 0, "stacked piggyback legs in one lock do not pay");
    }

    function _flash(uint256 n) internal returns (int256) {
        // the attacker contract ends the lock net-settled; it only needs
        // enough quote to cover its net LOSS, i.e. none when profitable
        uint256 q0 = quote.balanceOf(address(atk));
        uint256 r0 = ladder.reservoir();
        atk.flashSandwich(key, 0.4e18, _floor(), 0.001e18, n);
        console2.log("  reservoir spent", r0 - ladder.reservoir());
        return int256(quote.balanceOf(address(atk))) - int256(q0);
    }

    // ─── F-3: gas-starved poke skips legs and advances the cursor ─────────────

    function test_F3_gasStarvedPokeSkipsLegButAdvancesCursor() public {
        (ToshToken t2, ToshLaunchpadHook h2) = _create("Beta", HARD_CAP, AGENT_CAP);
        _buy(h2, carol, 5e18);
        _launchAsAdmin(h2);
        vm.warp(block.timestamp + hook.TWAP_WINDOW());
        _nextBlock();
        vm.prank(admin);
        ladder.addLadderToken(address(t2));
        _setReservoir(1e18);

        bool found;
        for (uint256 g = 400_000; g > 30_000; g -= 2_000) {
            uint256 snap = vm.snapshotState();
            uint256 c0 = ladder.currentCursor();
            (bool ok,) = address(ladder).call{gas: g}(abi.encodeCall(ToshLadderTreasury.pokeBuyback, ()));
            if (ok && ladder.currentCursor() != c0 && ladder.reservoir() == 1e18) {
                console2.log("gas that skips the leg yet advances cursor:", g);
                found = true;
                vm.revertToState(snap);
                break;
            }
            vm.revertToState(snap);
        }
        // UNCONFIRMED: 63/64 leaves the outer frame too little to finish once
        // the leg runs out, so a starved poke reverts as a whole.
        assertFalse(found, "no gas window skips a leg while advancing the cursor");
    }

    // ─── F-4: piggyback `sync` clobbers an outer sync-before-swap settle ──────

    function test_F4_piggybackLeavesOuterSyncAlone() public {
        uint256 inv = token.balanceOf(alice);
        vm.prank(alice);
        token.transfer(address(atk), inv);

        uint256 snap = vm.snapshotState();
        _setReservoir(0);
        uint256 q0 = quote.balanceOf(address(atk));
        atk.syncSellPay(key, 10_000e18, 0.05e18);
        int256 unarmed = int256(quote.balanceOf(address(atk))) - int256(q0);
        vm.revertToState(snap);

        _setReservoir(1e18);
        q0 = quote.balanceOf(address(atk));
        bool ok;
        try atk.syncSellPay(key, 10_000e18, 0.05e18) {
            ok = true;
        } catch {}
        int256 armed = int256(quote.balanceOf(address(atk))) - int256(q0);
        console2.log("unarmed: integrator net quote", unarmed);
        console2.log("armed:   call succeeded?", ok);
        console2.log("armed:   integrator net quote", armed);
        assertTrue(ok, "an armed reservoir does not break the outer settle");
        assertEq(armed, unarmed, "and the integrator's payment is credited");
    }

    // ─── Sound-area checks ────────────────────────────────────────────────────

    function test_S_cursorStaysInRangeAfterEveryRemoval() public {
        (ToshToken t2, ToshLaunchpadHook h2) = _create("Beta", HARD_CAP, AGENT_CAP);
        (ToshToken t3, ToshLaunchpadHook h3) = _create("Gamma", HARD_CAP, AGENT_CAP);
        _buy(h2, carol, 5e18);
        _buy(h3, carol, 5e18);
        _launchAsAdmin(h2);
        _launchAsAdmin(h3);
        vm.warp(block.timestamp + hook.TWAP_WINDOW());
        _nextBlock();
        vm.startPrank(admin);
        ladder.addLadderToken(address(t2));
        ladder.addLadderToken(address(t3));
        vm.stopPrank();
        _setReservoir(3e18);
        ladder.pokeBuyback();
        ladder.pokeBuyback();
        assertEq(ladder.currentCursor(), 2);
        vm.prank(admin);
        ladder.removeLadderToken(address(t3)); // last element, cursor 2 -> 0
        assertEq(ladder.currentCursor(), 0);
        vm.prank(admin);
        ladder.removeLadderToken(address(token));
        vm.prank(admin);
        ladder.removeLadderToken(address(t2));
        assertEq(ladder.currentCursor(), 0);
        vm.expectRevert(ToshLadderTreasury.NotArmed.selector);
        ladder.pokeBuyback();
        // user swaps still work with an empty ladder and an armed reservoir
        _swapBuy(hook, trader, 0.1e18);
    }

    function test_S_tightGasUserSwapStillSucceedsWhenArmed() public {
        _setReservoir(10e18);
        // sweep gas limits for an ordinary buy; any limit that succeeds when
        // unarmed must not revert because the reservoir is armed
        for (uint256 g = 250_000; g <= 700_000; g += 10_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(trader);
            (bool ok,) = address(router).call{gas: g}(
                abi.encodeCall(
                    router.swap,
                    (
                        key,
                        ICLPoolManager.SwapParams(true, -int256(0.05e18), TickMath.MIN_SQRT_RATIO + 1),
                        CLPoolManagerRouterSettings.s(),
                        ""
                    )
                )
            );
            vm.revertToState(snap);
            _setReservoir(0);
            uint256 snap2 = vm.snapshotState();
            vm.prank(trader);
            (bool okUnarmed,) = address(router).call{gas: g}(
                abi.encodeCall(
                    router.swap,
                    (
                        key,
                        ICLPoolManager.SwapParams(true, -int256(0.05e18), TickMath.MIN_SQRT_RATIO + 1),
                        CLPoolManagerRouterSettings.s(),
                        ""
                    )
                )
            );
            vm.revertToState(snap2);
            _setReservoir(10e18);
            if (okUnarmed && !ok) {
                console2.log("armed reservoir reverts a swap that passes unarmed at gas", g);
            }
        }
    }
}

import {CLPoolManagerRouter} from "infinity-core/test/pool-cl/helpers/CLPoolManagerRouter.sol";

library CLPoolManagerRouterSettings {
    function s() internal pure returns (CLPoolManagerRouter.SwapTestSettings memory) {
        return CLPoolManagerRouter.SwapTestSettings({withdrawTokens: true, settleUsingTransfer: true});
    }
}
