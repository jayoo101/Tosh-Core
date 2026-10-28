// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "../../lib/openzeppelin-contracts/contracts/utils/math/Math.sol";

/// @title  GenesisCurve
/// @notice Price of the v2 genesis sale: linear in tokens sold, from P for the
///         first token to 1.5P for the last of `SALE_SUPPLY`.
///
/// ── Parameterised by the hard cap, not by P ──────────────────────────────────
///
///   A fully sold curve averages 1.25P over 5.6M tokens, so H = 7M · P. Every
///   function takes H and never materialises P, because P = H / 7M is not an
///   integer in quote units and rounding it once would move every price on the
///   curve. With C = SALE_SUPPLY and N = 7M (both in token wei):
///
///     price(s)   = P · (1 + s / 2C)              = H · (2C + s) / (2NC)
///     cost(s, x) = ∫ price  from s to s + x      = H · x · (4C + 2s + x) / (4NC)
///
///   Inverting the cost for a budget `a` is the quadratic
///     x² + 2b·x − K = 0,   b = 2C + s,   K = a · 4NC / H
///   whose positive root is x = √(b² + K) − b.
///
/// ── Rounding ─────────────────────────────────────────────────────────────────
///
///   Always toward the protocol: `costOf` rounds up and `tokensFor` rounds
///   down. Because both `K` and the square root are floored, the x it returns
///   never exceeds the exact root, so its exact cost is at most the budget —
///   and the ceiling of a value at most an integer is still at most that
///   integer. The returned cost therefore never exceeds the budget, with no
///   correction loop. The fuzz suite pins both that and the converse (the
///   result is within 2 wei of the best affordable amount).
///
/// ── Range ────────────────────────────────────────────────────────────────────
///
///   Every bound below assumes s + x ≤ C and H < 2¹²⁸ (the clone packs the cap
///   into 128 bits). Then x · (4C + 2s + x) ≤ 5C² ≈ 1.6·10⁵⁰ and b² + K stays
///   under 10⁵¹, so only the multiplication by H needs 512-bit `mulDiv`.
library GenesisCurve {
    /// @notice Tokens the genesis sale can sell, the curve's full length.
    uint256 internal constant SALE_SUPPLY = 5_600_000e18;

    /// @dev H / N = P. 7M = 5.6M × 1.25, the fully-sold average price.
    uint256 internal constant N = 7_000_000e18;

    uint256 private constant C = SALE_SUPPLY;
    uint256 private constant FOUR_NC = 4 * N * C;
    uint256 private constant TWO_NC = 2 * N * C;

    error CurveOverflow();

    /// @notice Price of the next token after `sold` have gone, in quote wei per
    ///         1e18 token wei, rounded up.
    function priceAt(uint256 hardCap, uint256 sold) internal pure returns (uint256) {
        if (sold > C) revert CurveOverflow();
        return Math.mulDiv(hardCap, 1e18 * (2 * C + sold), TWO_NC, Math.Rounding.Ceil);
    }

    /// @notice Quote owed for tokens `sold` → `sold + amount`, rounded up.
    function costOf(uint256 hardCap, uint256 sold, uint256 amount) internal pure returns (uint256) {
        if (sold + amount > C) revert CurveOverflow();
        return Math.mulDiv(hardCap, amount * (4 * C + 2 * sold + amount), FOUR_NC, Math.Rounding.Ceil);
    }

    /// @notice Most tokens `budget` buys from `sold`, capped at what is left,
    ///         and their `costOf`. `cost ≤ budget` always.
    function tokensFor(uint256 hardCap, uint256 sold, uint256 budget)
        internal
        pure
        returns (uint256 amount, uint256 cost)
    {
        if (sold > C) revert CurveOverflow();
        uint256 remaining = C - sold;
        if (remaining == 0 || budget == 0 || hardCap == 0) return (0, 0);

        uint256 full = costOf(hardCap, sold, remaining);
        if (budget >= full) return (remaining, full);

        // budget < full, so K < 5C² + 4NC / H; with b² ≤ 9C² the sum is < 10⁵¹.
        uint256 k = Math.mulDiv(budget, FOUR_NC, hardCap);
        uint256 b = 2 * C + sold;
        amount = Math.sqrt(b * b + k) - b;
        if (amount > remaining) amount = remaining;
        cost = costOf(hardCap, sold, amount);
    }
}
