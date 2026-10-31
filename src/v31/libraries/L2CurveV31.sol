// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "infinity-core/src/pool-cl/libraries/FullMath.sol";
import {wadLn, wadExp} from "solmate/src/utils/SignedWadMath.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

/// @title  L2CurveV31
/// @notice The v3.1 L2 price: a continuous exponential curve with Dutch decay.
///
///         curve(x) = p0 · 247^(x / supply) = p0 · e^{kx},  k = ln(247) / supply
///
///         Paying C at price p mints Δ = ln(1 + kC/p) / k tokens and leaves the
///         price at p + kC. While nobody mints, the price falls 0.1 % per whole
///         minute, with no floor, and every whole 10 minutes supply / 1008
///         unminted tokens are burned. Prices are quote wei per whole (1e18)
///         token.
library L2CurveV31 {
    /// @notice ln(247) in 1e18 fixed point.
    uint256 internal constant LN_SPAN_WAD = 5_509_388_336_627_977_196;
    uint256 internal constant DECAY_INTERVAL = 1 minutes;
    uint256 internal constant DECAY_FACTOR_WAD = 0.999e18;
    uint256 internal constant ONE = 1e18;
    uint256 internal constant BURN_INTERVAL = 10 minutes;
    /// @notice 6 · 24 · 7: an idle week burns the whole supply.
    uint256 internal constant BURN_PERIODS = 1008;

    /// @dev price · 0.999^(whole minutes in `idle` seconds). Held at 1 wei so
    ///      `quote` never divides by zero.
    function decayed(uint256 price, uint256 idle) internal pure returns (uint256 p) {
        uint256 steps = idle / DECAY_INTERVAL;
        p = FullMath.mulDiv(price, FixedPointMathLib.rpow(DECAY_FACTOR_WAD, steps, ONE), ONE);
        if (p == 0) p = 1;
    }

    /// @dev Mint `pay` at `price` with `minted` of `supply` already sold.
    ///      Past the end of the supply, mints the remainder and charges what
    ///      it costs, (price·e^{k·remaining} − price) / k rounded up, never
    ///      more than `pay`.
    function quote(uint256 price, uint256 minted, uint256 supply, uint256 pay)
        internal
        pure
        returns (uint256 tokens, uint256 cost, uint256 priceAfter)
    {
        uint256 remaining = supply - minted;
        priceAfter = price + FullMath.mulDiv(LN_SPAN_WAD, pay, supply);
        // forge-lint: disable-next-line(unsafe-typecast) — a price ratio, far below 2^255
        int256 lnRatio = wadLn(int256(FullMath.mulDiv(priceAfter, ONE, price)));
        // forge-lint: disable-next-line(unsafe-typecast) — ln of a ratio ≥ 1 is ≥ 0
        tokens = FullMath.mulDiv(supply, uint256(lnRatio), LN_SPAN_WAD);
        cost = pay;
        if (tokens >= remaining) {
            tokens = remaining;
            // forge-lint: disable-next-line(unsafe-typecast) — ≤ LN_SPAN_WAD
            int256 exponent = int256(FullMath.mulDiv(LN_SPAN_WAD, remaining, supply));
            // forge-lint: disable-next-line(unsafe-typecast) — e^x > 0
            priceAfter = FullMath.mulDiv(price, uint256(wadExp(exponent)), ONE);
            if (priceAfter <= price) priceAfter = price + 1;
            cost = FullMath.mulDivRoundingUp(priceAfter - price, supply, LN_SPAN_WAD);
            if (cost > pay) cost = pay;
        }
    }
}
