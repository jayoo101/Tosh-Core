// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";

import {V2BaseV3} from "./utils/V2BaseV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {ToshTokenV3 as ToshToken} from "../../src/v3/ToshTokenV3.sol";

/// @notice Sandwich probe for `ToshAutoLp`'s buy (SECURITY.md asked for one).
///
///         The attacker buys `pump` quote of the token, the AutoLp buy runs,
///         and the attacker sells everything they bought. The same round trip
///         without the AutoLp buy is the control, so
///
///             edge = pnl(with AutoLp buy) − pnl(without)
///
///         is what the AutoLp buy hands the attacker, and `pnl(with)` is what
///         the attack actually earns. The protocol needs `pnl(with) < 0` at
///         every size: `edge > 0` is unavoidable for any buy, and is only a
///         problem if it beats the round trip's tax and fees.
contract AutoLpSandwichTestV3 is V2BaseV3 {
    using PoolIdLibrary for PoolKey;

    ToshToken token;
    ToshLaunchpadHookV3 hook;
    address attacker;

    /// Pump sizes as bps of the pool's virtual quote reserve.
    uint256[8] PUMPS_BPS = [uint256(25), 50, 100, 200, 400, 800, 1_600, 3_200];

    function setUp() public override {
        super.setUp();
        // The same launch as `AutoLp.t.sol`: 10 raised, 8 pooled.
        (token, hook) = _create();
        _buy(hook, alice, 5e18);
        _buy(hook, bob, 5e18);
        _launchAsAdmin(hook);
        _nextBlock();
        // Lift spot onto the ladder and let the TWAP agree.
        _swapBuy(hook, trader, 0.1e18);
        _matureTwap();
        attacker = dave;
    }

    function test_shelfSaleReachesAutoLp() public {
        (bool sold, uint256 added) = _shelfSale();
        assertTrue(sold, "shelf sale");
        assertGt(added, 0, "autoLp bought");
        console2.log("cap", _cap(), "added", added);
    }

    // ─── helpers ──────────────────────────────────────────────────────────────

    function _matureTwap() internal {
        vm.warp(block.timestamp + hook.TWAP_WINDOW());
        _nextBlock();
    }

    function _reserve() internal view returns (uint256) {
        PoolKey memory key = hook.getPoolKey();
        (uint160 spot,,,) = poolManager.getSlot0(key.toId());
        return (uint256(poolManager.getLiquidity(key.toId())) << 96) / spot;
    }

    function _cap() internal view returns (uint256) {
        return _reserve() * autoLp.MAX_DEPTH_BPS() / 10_000;
    }

    function _pumpFront(uint256 pump) internal returns (uint256 quote0, uint256 token0) {
        quote0 = quote.balanceOf(attacker);
        token0 = token.balanceOf(attacker);
        _swapBuy(hook, attacker, pump);
    }

    function _sellBack(uint256 quote0, uint256 token0) internal returns (int256 pnl) {
        _swapSell(hook, attacker, token.balanceOf(attacker) - token0);
        pnl = int256(quote.balanceOf(attacker)) - int256(quote0);
    }

    /// @dev A shelf sale big enough that AutoLp's run is the capped maximum.
    function _shelfSale() internal returns (bool sold, uint256 added) {
        uint256 before = autoLp.totalQuoteAdded(address(hook));
        uint256 amount = hook.tierSize() * 40;
        uint256 mintable = hook.maxMintable();
        if (mintable < amount) amount = mintable;
        if (amount == 0) return (false, 0);
        vm.prank(bob, bob);
        try hook.mintBondingCurve(amount, type(uint256).max) {
            sold = true;
        } catch {}
        added = autoLp.totalQuoteAdded(address(hook)) - before;
    }

    function _log(string memory label, uint256 bps, uint256 pump, uint256 added, int256 withBuy, int256 without)
        internal
        pure
    {
        console2.log(label, bps, "bps of reserve");
        console2.log("  pump", pump);
        console2.log("  autoLp quote in", added);
        console2.log("  pnl with buy");
        console2.logInt(withBuy);
        console2.log("  edge");
        console2.logInt(withBuy - without);
    }

    // ─── deposit path: the buy rides a shelf sale in the attacker's block ───

    /// @dev `MAX_MINT_TICK_DRIFT` (10 ticks) refuses the sale once a pump has
    ///      moved the block, so only pumps under ~0.05 % of the reserve get here.
    function test_probe_sandwichDeposit() public {
        uint256[6] memory sizes = [uint256(1), 2, 4, 8, 16, 25];
        uint256 reserve = _reserve();
        uint256 snap = vm.snapshotState();
        uint256 ran;
        for (uint256 i; i < sizes.length; ++i) {
            uint256 pump = reserve * sizes[i] / 10_000;

            (uint256 q0, uint256 t0) = _pumpFront(pump);
            (bool sold, uint256 added) = _shelfSale();
            int256 withBuy = _sellBack(q0, t0);
            vm.revertToState(snap);

            (q0, t0) = _pumpFront(pump);
            int256 without = _sellBack(q0, t0);
            vm.revertToState(snap);

            _log("deposit", sizes[i], pump, added, withBuy, without);
            if (sizes[i] >= 25) assertFalse(sold, "a 0.25 % pump shuts the shelf for the block");
            if (!sold || added == 0) continue;
            ++ran;
            assertLt(withBuy, 0, "sandwiching the AutoLp buy must not pay");
        }
        assertGt(ran, 0, "at least one size reached the AutoLp buy");
    }

    // ─── deposit path across blocks: pump ends one block, the sale opens the next ─

    function test_probe_sandwichDepositNextBlock() public {
        uint256 reserve = _reserve();
        uint256 snap = vm.snapshotState();
        uint256 ran;
        for (uint256 i; i < PUMPS_BPS.length; ++i) {
            uint256 pump = reserve * PUMPS_BPS[i] / 10_000;

            (uint256 q0, uint256 t0) = _pumpFront(pump);
            _nextBlock();
            (bool sold, uint256 added) = _shelfSale();
            int256 withBuy = _sellBack(q0, t0);
            vm.revertToState(snap);

            (q0, t0) = _pumpFront(pump);
            _nextBlock();
            int256 without = _sellBack(q0, t0);
            vm.revertToState(snap);

            _log("deposit, next block", PUMPS_BPS[i], pump, added, withBuy, without);
            if (!sold || added == 0) continue;
            ++ran;
            assertLt(withBuy, 0, "sandwiching the AutoLp buy across blocks must not pay");
        }
        assertGt(ran, 0, "at least one size reached the AutoLp buy");
    }

    // ─── flush path: pump at the end of one block, flush first in the next ──

    function test_probe_sandwichFlush() public {
        // Leave several capped runs pending, as a burst of shelf sales would.
        uint256 owed = _cap() * 6;
        quote.mint(address(autoLp), owed);
        vm.prank(address(hook));
        autoLp.deposit(owed);
        _matureTwap();

        uint256 reserve = _reserve();
        uint256 snap = vm.snapshotState();
        uint256 ran;
        for (uint256 i; i < PUMPS_BPS.length; ++i) {
            uint256 pump = reserve * PUMPS_BPS[i] / 10_000;

            (uint256 q0, uint256 t0) = _pumpFront(pump);
            _nextBlock();
            uint256 before = autoLp.totalQuoteAdded(address(hook));
            bool flushed;
            try autoLp.flush(address(hook)) {
                flushed = true;
            } catch {}
            uint256 added = autoLp.totalQuoteAdded(address(hook)) - before;
            int256 withBuy = _sellBack(q0, t0);
            vm.revertToState(snap);

            (q0, t0) = _pumpFront(pump);
            _nextBlock();
            int256 without = _sellBack(q0, t0);
            vm.revertToState(snap);

            _log("flush", PUMPS_BPS[i], pump, added, withBuy, without);
            if (!flushed) continue;
            ++ran;
            assertLt(withBuy, 0, "sandwiching a flush must not pay");
        }
        assertGt(ran, 0, "at least one size reached the flush");
    }

    /// @dev One pump, then as many back-to-back flushes as the gates allow
    ///      (one per block, nothing else trading), then one sell. Several
    ///      capped runs against a single round trip is the attacker's best case.
    function test_probe_sandwichManyFlushes() public {
        uint256 owed = _cap() * 20;
        quote.mint(address(autoLp), owed);
        vm.prank(address(hook));
        autoLp.deposit(owed);
        _matureTwap();

        uint256 reserve = _reserve();
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < PUMPS_BPS.length; ++i) {
            uint256 pump = reserve * PUMPS_BPS[i] / 10_000;

            (uint256 q0, uint256 t0) = _pumpFront(pump);
            uint256 before = autoLp.totalQuoteAdded(address(hook));
            uint256 runs;
            for (uint256 k; k < 20; ++k) {
                _nextBlock();
                vm.warp(block.timestamp + 3);
                try autoLp.flush(address(hook)) {
                    ++runs;
                } catch {
                    break;
                }
            }
            uint256 added = autoLp.totalQuoteAdded(address(hook)) - before;
            int256 withBuy = _sellBack(q0, t0);
            vm.revertToState(snap);

            (q0, t0) = _pumpFront(pump);
            for (uint256 k; k < runs; ++k) {
                _nextBlock();
                vm.warp(block.timestamp + 3);
            }
            int256 without = _sellBack(q0, t0);
            vm.revertToState(snap);

            _log("many flushes", PUMPS_BPS[i], pump, added, withBuy, without);
            console2.log("  runs", runs);
            if (runs == 0) continue;
            assertLt(withBuy, 0, "a pump held across several flushes must not pay");
        }
    }
}
