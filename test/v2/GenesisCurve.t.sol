// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GenesisCurve} from "../../src/libraries/GenesisCurve.sol";
import {V2LibHarness} from "./utils/V2LibHarness.sol";

contract GenesisCurveTest is Test {
    uint256 internal constant C = 5_600_000e18;
    uint256 internal constant N = 7_000_000e18;

    V2LibHarness internal h;

    function setUp() public {
        h = new V2LibHarness();
    }

    function _boundCap(uint256 cap) internal pure returns (uint256) {
        return bound(cap, 1e6, type(uint128).max);
    }

    // ── Shape ────────────────────────────────────────────────────────────────

    function test_fullCurveCostsExactlyHardCap() public view {
        uint256[4] memory caps = [uint256(100e18), 7_000_000e18, 1e15 + 3, type(uint128).max];
        for (uint256 i; i < caps.length; ++i) {
            assertEq(h.costOf(caps[i], 0, C), caps[i]);
        }
    }

    function test_priceEndpoints_100BNB() public view {
        uint256 cap = 100e18;
        // P = 100 / 7M ≈ 0.00001428571 BNB, rounded up.
        assertEq(h.priceAt(cap, 0), 14_285_714_285_715);
        assertEq(h.priceAt(cap, C), 21_428_571_428_572);
        assertEq(h.priceAt(cap, C / 2), 17_857_142_857_143);
    }

    function testFuzz_lastTokenCostsOneAndAHalfTimesTheFirst(uint256 cap) public view {
        cap = bound(cap, 1e18, type(uint128).max);
        uint256 first = h.priceAt(cap, 0);
        uint256 last = h.priceAt(cap, C);
        assertApproxEqAbs(last * 2, first * 3, 3);
    }

    function test_revertsPastSaleSupply() public {
        vm.expectRevert(GenesisCurve.CurveOverflow.selector);
        h.costOf(100e18, C, 1);
        vm.expectRevert(GenesisCurve.CurveOverflow.selector);
        h.costOf(100e18, 1, C);
        vm.expectRevert(GenesisCurve.CurveOverflow.selector);
        h.priceAt(100e18, C + 1);
        vm.expectRevert(GenesisCurve.CurveOverflow.selector);
        h.tokensFor(100e18, C + 1, 1);
    }

    // ── costOf ───────────────────────────────────────────────────────────────

    /// Splitting a purchase can never cost less than buying it in one go.
    function testFuzz_splittingNeverUndercharges(uint256 cap, uint256 sold, uint256 a, uint256 b) public view {
        cap = _boundCap(cap);
        sold = bound(sold, 0, C);
        a = bound(a, 0, C - sold);
        b = bound(b, 0, C - sold - a);

        uint256 whole = h.costOf(cap, sold, a + b);
        uint256 parts = h.costOf(cap, sold, a) + h.costOf(cap, sold + a, b);
        assertGe(parts, whole);
        assertLe(parts, whole + 1);
    }

    function testFuzz_costIsMonotonic(uint256 cap, uint256 sold, uint256 a, uint256 extra) public view {
        cap = _boundCap(cap);
        sold = bound(sold, 0, C);
        a = bound(a, 0, C - sold);
        extra = bound(extra, 0, C - sold - a);
        assertLe(h.costOf(cap, sold, a), h.costOf(cap, sold, a + extra));
    }

    /// The same tokens cost more the later they are bought.
    function testFuzz_laterIsDearer(uint256 cap, uint256 sold, uint256 later, uint256 amount) public view {
        cap = _boundCap(cap);
        amount = bound(amount, 1, C);
        sold = bound(sold, 0, C - amount);
        later = bound(later, sold, C - amount);
        assertLe(h.costOf(cap, sold, amount), h.costOf(cap, later, amount));
    }

    // ── tokensFor ────────────────────────────────────────────────────────────

    function testFuzz_tokensForNeverOverspends(uint256 cap, uint256 sold, uint256 budget) public view {
        cap = _boundCap(cap);
        sold = bound(sold, 0, C);
        budget = bound(budget, 0, cap);

        (uint256 amount, uint256 cost) = h.tokensFor(cap, sold, budget);
        assertLe(amount, C - sold);
        assertLe(cost, budget);
        assertEq(cost, h.costOf(cap, sold, amount));
    }

    /// Within 2 token-wei of the most the budget could afford.
    function testFuzz_tokensForIsNearMaximal(uint256 cap, uint256 sold, uint256 budget) public view {
        cap = _boundCap(cap);
        sold = bound(sold, 0, C);
        budget = bound(budget, 0, cap);

        (uint256 amount,) = h.tokensFor(cap, sold, budget);
        if (amount + 2 <= C - sold) {
            assertGt(h.costOf(cap, sold, amount + 2), budget);
        }
    }

    function testFuzz_budgetPastRemainingBuysTheRest(uint256 cap, uint256 sold, uint256 surplus) public view {
        cap = _boundCap(cap);
        sold = bound(sold, 0, C);
        surplus = bound(surplus, 0, cap);

        uint256 full = h.costOf(cap, sold, C - sold);
        (uint256 amount, uint256 cost) = h.tokensFor(cap, sold, full + surplus);
        assertEq(amount, C - sold);
        assertEq(cost, full);
    }

    function test_tokensForZeroInputs() public view {
        (uint256 a, uint256 c) = h.tokensFor(100e18, 0, 0);
        assertEq(a, 0);
        assertEq(c, 0);
        (a, c) = h.tokensFor(100e18, C, 1e18);
        assertEq(a, 0);
        assertEq(c, 0);
    }

    function test_example_firstBuyerOfOneBNB() public view {
        // 1 BNB at the start of a 100 BNB curve buys a little under 1/P = 70,000.
        (uint256 amount, uint256 cost) = h.tokensFor(100e18, 0, 1e18);
        assertLe(cost, 1e18);
        assertGt(amount, 69_000e18);
        assertLt(amount, 70_000e18);
    }
}
