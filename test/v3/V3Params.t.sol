// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "infinity-core/src/pool-cl/libraries/FullMath.sol";

import {V2BaseV3} from "./utils/V2BaseV3.sol";
import {ToshLaunchpadHookV3} from "../../src/v3/ToshLaunchpadHookV3.sol";
import {ToshToken} from "../../src/ToshToken.sol";
import {GenesisCurveV3} from "../../src/v3/libraries/GenesisCurveV3.sol";

/// @dev The v3 supply split and ladder geometry, pinned as numbers.
contract V3ParamsTest is V2BaseV3 {
    uint256 internal constant STEP_E18 = 1_005_195_562_353_288_450;
    uint256 internal constant SPAN_E18 = 1e9 * 1e18;

    ToshToken token;
    ToshLaunchpadHookV3 hook;

    function setUp() public override {
        super.setUp();
        (token, hook) = _create();
    }

    function test_supplySplit() public view {
        assertEq(GenesisCurveV3.SALE_SUPPLY, 1_800_000e18, "genesis sells 1.8M");
        assertEq(GenesisCurveV3.N, GenesisCurveV3.SALE_SUPPLY * 5 / 4, "N = 1.25 x sale");
        assertEq(hook.GENESIS_SUPPLY(), GenesisCurveV3.SALE_SUPPLY * 3 / 2, "genesis = sale + half for the pool");
        assertEq(hook.GENESIS_SUPPLY(), 2_700_000e18);
        assertEq(hook.TIER_COUNT(), 4000);
        assertEq(hook.TIER_SIZE(), 4_575e18);
        assertEq(hook.BONDING_MAX(), 18_300_000e18);
        assertEq(hook.GENESIS_SUPPLY() + hook.BONDING_MAX(), token.MAX_SUPPLY(), "the split fills 21M exactly");
    }

    /// Mirrors the hook's `_powE18`, floor mulDiv at every step.
    function _pow(uint256 b, uint256 e) internal pure returns (uint256 r) {
        r = 1e18;
        while (e > 0) {
            if (e & 1 == 1) r = FullMath.mulDiv(r, b, 1e18);
            e >>= 1;
            if (e > 0) b = FullMath.mulDiv(b, b, 1e18);
        }
    }

    function test_stepIsTheLargestNotAboveTheSpan() public pure {
        assertLe(_pow(STEP_E18, 3999), SPAN_E18);
        assertGt(_pow(STEP_E18 + 1, 3999), SPAN_E18);
        assertApproxEqRel(_pow(STEP_E18, 3999), SPAN_E18, 1e4, "within 1e-14 of x1e9");
    }

    function test_soldOut_opensWithPointNineMillionAndALadderSpanningOneBillion() public {
        _sellOut(hook);
        _launchAsAdmin(hook);

        uint256 lpTokens = hook.GENESIS_SUPPLY() - hook.genesisSold() - token.balanceOf(DEAD);
        assertApproxEqAbs(hook.genesisSold(), 1_800_000e18, 1e15, "sold out");
        assertApproxEqRel(lpTokens, 900_000e18, 1e12, "pool side is half the sale");
        assertEq(token.totalSupply(), 2_700_000e18);
        assertEq(hook.tierSize(), 4_575e18, "full-size shelves on a sold-out raise");

        uint256 p0 = hook.shelfP0();
        assertEq(hook.tierPriceAt(3999), FullMath.mulDiv(p0, _pow(STEP_E18, 3999), 1e18));
        assertApproxEqRel(hook.tierPriceAt(3999), p0 * 1e9, 1e6, "top shelf is p0 x 1e9");
        assertApproxEqRel(hook.tierPriceAt(1) * 1e18 / hook.tierPriceAt(0), STEP_E18, 1e12, "+0.52% per shelf");
    }

    function test_basePriceIsHardCapOverTwoPointTwoFiveMillion() public view {
        // The same hard cap buys 1.8M tokens instead of 5.6M: P = H / 2.25M, v2 had H / 7M.
        assertEq(lens.basePrice(address(hook)), GenesisCurveV3.priceAt(HARD_CAP, 0));
        assertApproxEqRel(lens.basePrice(address(hook)), HARD_CAP * 1e18 / 2_250_000e18, 1e9);
    }
}
