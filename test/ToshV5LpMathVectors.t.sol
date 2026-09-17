// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {TickMath as InfinityTickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {SqrtPriceMath as InfinitySqrtPriceMath} from "infinity-core/src/pool-cl/libraries/SqrtPriceMath.sol";
import {
    LiquidityAmounts as InfinityLiquidityAmounts
} from "infinity-periphery/src/pool-cl/libraries/LiquidityAmounts.sol";

/// @notice Regenerates the reference vectors consumed by
///         `soat-frontend/scripts/checkV4Math.ts`, and asserts them.
///
///         The frontend hand-ports the slice of V4 fixed-point maths the LP
///         panel needs (`soat-frontend/src/lib/v4Math.ts`) rather than pulling
///         a solver into the bundle.  `checkV4Math.ts` pins that port against
///         six recorded numbers.  The numbers are only worth anything for as
///         long as something still derives them from v4-core, and for a while
///         nothing did: they were produced by a `test/ScratchLpMath.t.sol` that
///         was never committed, so a `lib/v4-core` bump could have re-rounded
///         `LiquidityAmounts` or `TickMath` under the frontend and the guard
///         would have kept asserting the pre-bump numbers, green, forever.  A
///         pin whose generator is gone is a pin against a moment, not against
///         the chain.
///
///         So the vectors are READ OUT of the guard rather than restated here.
///         Two copies of six integers is the same failure one indirection
///         further out — an author updating the TS side would have no reason to
///         look in `test/`, and the halves would drift apart while both passed.
///         With one copy the chain closes: this test asserts
///         v4-core == vector, `checkV4Math.ts` asserts vector == the TS port,
///         and neither can move alone.
///
///         What a failure here means, concretely: the LP panel quotes deposits
///         the pool will refuse.  `amount1Max` is the binding side, so an
///         under-quoted token leg reverts at the wallet prompt, and an
///         over-quoted one silently over-draws the user's allowance.
///
///         The tick bounds are derived, not typed in.  `-887200 / +887200` is
///         not a constant anyone chose; it is `TickMath.MAX_TICK` rounded down
///         onto the hook's `TICK_SPACING` grid, which is what makes the genesis
///         range mintable at all.  Deriving it means a change to `TICK_SPACING`
///         moves the boundaries here and fails loudly, instead of leaving the
///         frontend clamping to prices the hook's own position no longer spans.
///
///         How to fix when this fails: every assertion puts the freshly
///         computed Solidity value on the LEFT of the `a != b` it prints, so
///         that number IS the new vector.  Copy it into `EXPECT` in
///         `checkV4Math.ts`, then expect `npm run guard:v4math` to start
///         failing — the hand-port has to be re-derived too, and a bump that
///         moved the maths has to move both halves.  Never adjust this file to
///         agree with the vector; it has nothing of its own to adjust.
contract ToshV5LpMathVectorsTest is Test {
    string internal constant GUARD = "soat-frontend/scripts/checkV4Math.ts";
    string internal constant HOOK = "src/ToshLaunchpadHook.sol";

    /// @dev The pool state the vectors were taken at: a launched pool holding
    ///      0.9 ETH against 2.1M tokens, and a deposit of 0.05 ETH / 200k
    ///      tokens against it. At that ratio the ETH leg binds, which is the
    ///      case the panel actually has to get right — the token leg is what
    ///      the user is asked to approve.
    struct Vectors {
        uint160 sqrtP;
        uint256 nativeIn;
        uint256 tokenIn;
        uint256 sqrtLower;
        uint256 sqrtUpper;
        uint256 liquidity;
        uint256 amount0;
        uint256 amount1;
        uint256 pairedToken;
    }

    function _vectors() internal view returns (Vectors memory v) {
        bytes memory src = bytes(vm.readFile(GUARD));

        v.sqrtP = uint160(_numberAfter(src, bytes("const SQRT_P"), "n"));
        v.nativeIn = _numberAfter(src, bytes("const ETH_IN"), "n");
        v.tokenIn = _numberAfter(src, bytes("const TOKEN_IN"), "n");

        // Anchored inside the EXPECT literal so a field name that also occurs
        // in prose or an import above cannot capture the search.
        bytes memory expect = _from(src, bytes("const EXPECT"));

        v.sqrtLower = _numberAfter(expect, bytes("sqrtLower:"), "n");
        v.sqrtUpper = _numberAfter(expect, bytes("sqrtUpper:"), "n");
        v.liquidity = _numberAfter(expect, bytes("liquidity:"), "n");
        v.amount0 = _numberAfter(expect, bytes("amount0:"), "n");
        v.amount1 = _numberAfter(expect, bytes("amount1:"), "n");
        v.pairedToken = _numberAfter(expect, bytes("pairedToken:"), "n");
    }

    /// @dev The hook's genesis range, taken from the hook. `TICK_LOWER` and
    ///      `TICK_UPPER` are `internal constant`, so there is no getter to call
    ///      and no ABI entry to read — the source is the only place they exist
    ///      at test time, and restating them here would put the frontend's
    ///      clamp and the pool's actual range back into two files.
    ///
    ///      The alignment assertion is the load-bearing half. `+887200` is
    ///      `TickMath.MAX_TICK` floored onto the spacing grid; drop the grid and
    ///      `modifyLiquidity` rejects the genesis mint outright, so a spacing
    ///      change that nobody propagated has to fail here rather than at
    ///      launch.
    function _fullRangeTicks() internal view returns (int24 lower, int24 upper) {
        bytes memory src = bytes(vm.readFile(HOOK));

        int24 spacing = int24(int256(_numberAfter(src, bytes("int24 public constant TICK_SPACING"), ";")));
        upper = int24(int256(_numberAfter(src, bytes("int24 internal constant TICK_UPPER"), ";")));
        lower = -int24(int256(_numberAfter(src, bytes("int24 internal constant TICK_LOWER = -"), ";")));

        assertEq(int256(upper), int256(-lower), "hook genesis range is not symmetric about 0");
        assertEq(
            int256(upper),
            int256((TickMath.MAX_TICK / spacing) * spacing),
            "hook TICK_UPPER is no longer MAX_TICK floored onto TICK_SPACING"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────

    function test_sqrtPriceBounds_matchTickMath() public view {
        Vectors memory v = _vectors();
        (int24 lower, int24 upper) = _fullRangeTicks();

        assertEq(
            uint256(TickMath.getSqrtPriceAtTick(lower)),
            v.sqrtLower,
            "vector sqrtLower: TickMath.getSqrtPriceAtTick(TICK_LOWER) moved"
        );
        assertEq(
            uint256(TickMath.getSqrtPriceAtTick(upper)),
            v.sqrtUpper,
            "vector sqrtUpper: TickMath.getSqrtPriceAtTick(TICK_UPPER) moved"
        );
    }

    function test_liquidity_matchesLiquidityAmounts() public view {
        Vectors memory v = _vectors();
        (int24 lower, int24 upper) = _fullRangeTicks();

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            v.sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), v.nativeIn, v.tokenIn
        );

        assertEq(uint256(liquidity), v.liquidity, "vector liquidity: LiquidityAmounts.getLiquidityForAmounts moved");
    }

    /// @dev Both legs round DOWN, matching what a burn actually pays out. The
    ///      panel shows this figure as the position's worth, and a value the
    ///      pool will not hand back is a support ticket.
    function test_burnAmounts_matchSqrtPriceMathDeltas() public view {
        Vectors memory v = _vectors();
        (int24 lower, int24 upper) = _fullRangeTicks();
        uint128 liquidity = uint128(v.liquidity);

        assertEq(
            SqrtPriceMath.getAmount0Delta(v.sqrtP, TickMath.getSqrtPriceAtTick(upper), liquidity, false),
            v.amount0,
            "vector amount0: SqrtPriceMath.getAmount0Delta(roundDown) moved"
        );
        assertEq(
            SqrtPriceMath.getAmount1Delta(TickMath.getSqrtPriceAtTick(lower), v.sqrtP, liquidity, false),
            v.amount1,
            "vector amount1: SqrtPriceMath.getAmount1Delta(roundDown) moved"
        );
    }

    /// @dev Rounds UP, and is deliberately routed through liquidity rather than
    ///      a spot price: the pool charges the token leg off the liquidity it
    ///      actually mints, so a spot-price quote is short by the rounding and
    ///      trips `amount1Max`.
    function test_pairedTokenLeg_matchesRoundedUpDelta() public view {
        Vectors memory v = _vectors();
        (int24 lower, int24 upper) = _fullRangeTicks();

        uint128 liquidity =
            LiquidityAmounts.getLiquidityForAmount0(v.sqrtP, TickMath.getSqrtPriceAtTick(upper), v.nativeIn);

        assertEq(
            SqrtPriceMath.getAmount1Delta(TickMath.getSqrtPriceAtTick(lower), v.sqrtP, liquidity, true),
            v.pairedToken,
            "vector pairedToken: getAmount1Delta(roundUp) off the ETH leg moved"
        );
    }

    /// @notice The same four vectors, through PancakeSwap Infinity's copies of
    ///         these libraries. Asserted against the vectors rather than
    ///         against v4's output, so this extends the existing chain by one
    ///         link instead of starting a second one: vector == v4-core ==
    ///         infinity-core == the TypeScript port, and none of the four can
    ///         move alone.
    ///
    ///         Why it is worth a test rather than a reading. The two
    ///         `LiquidityAmounts` differ on inspection — Infinity renames
    ///         `sqrtPrice` to `sqrtRatio`, drops v4's `unchecked` wrapper, and
    ///         takes `toUint128` from a different `SafeCast`. All three look
    ///         cosmetic and all three are: the swap that precedes each
    ///         subtraction makes the `unchecked` a gas choice, and the casts
    ///         only diverge on an overflow these vectors do not reach. "Looks
    ///         cosmetic" is exactly the claim that should not be taken on
    ///         faith, because what it is guarding is the LP panel quoting
    ///         deposits the pool will refuse.
    ///
    ///         If this fails during the port, the port moves LP seeding, and
    ///         the genesis position and the frontend clamp have to be re-derived
    ///         together. Do not reconcile it by editing this file.
    function test_infinityLibrariesReproduceTheSameVectors() public view {
        Vectors memory v = _vectors();
        (int24 lower, int24 upper) = _fullRangeTicks();

        uint160 infLower = InfinityTickMath.getSqrtRatioAtTick(lower);
        uint160 infUpper = InfinityTickMath.getSqrtRatioAtTick(upper);

        assertEq(uint256(infLower), v.sqrtLower, "infinity sqrtLower disagrees with the vector");
        assertEq(uint256(infUpper), v.sqrtUpper, "infinity sqrtUpper disagrees with the vector");

        assertEq(
            uint256(
                InfinityLiquidityAmounts.getLiquidityForAmounts(v.sqrtP, infLower, infUpper, v.nativeIn, v.tokenIn)
            ),
            v.liquidity,
            "infinity getLiquidityForAmounts disagrees with the vector"
        );

        uint128 liquidity = uint128(v.liquidity);
        assertEq(
            InfinitySqrtPriceMath.getAmount0Delta(v.sqrtP, infUpper, liquidity, false),
            v.amount0,
            "infinity getAmount0Delta(roundDown) disagrees with the vector"
        );
        assertEq(
            InfinitySqrtPriceMath.getAmount1Delta(infLower, v.sqrtP, liquidity, false),
            v.amount1,
            "infinity getAmount1Delta(roundDown) disagrees with the vector"
        );

        assertEq(
            InfinitySqrtPriceMath.getAmount1Delta(
                infLower, v.sqrtP, InfinityLiquidityAmounts.getLiquidityForAmount0(v.sqrtP, infUpper, v.nativeIn), true
            ),
            v.pairedToken,
            "infinity pairedToken leg disagrees with the vector"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────

    /// @dev `terminator` is what must sit immediately after the digits — `n`
    ///      for a TS BigInt literal, `;` for a Solidity constant. Demanding it
    ///      rather than stopping at the first non-digit is the point: if either
    ///      file is reshaped so an anchor lands somewhere else, a bare digit
    ///      scan would happily parse a prefix and this test would assert
    ///      against a number nobody wrote, which is the failure mode it exists
    ///      to remove.
    function _numberAfter(bytes memory src, bytes memory anchor, bytes1 terminator)
        internal
        pure
        returns (uint256 value)
    {
        uint256 i = _indexOf(src, anchor) + anchor.length;

        while (i < src.length && (src[i] == " " || src[i] == "=" || src[i] == 0x09)) {
            ++i;
        }
        require(i < src.length && _isDigit(src[i]), "vector: no number after anchor");

        for (; i < src.length; ++i) {
            bytes1 c = src[i];
            if (c == "_") continue;
            if (!_isDigit(c)) break;
            value = value * 10 + (uint8(c) - 48);
        }
        require(i < src.length && src[i] == terminator, "vector: number not terminated as expected");
    }

    function _isDigit(bytes1 c) internal pure returns (bool) {
        return c >= "0" && c <= "9";
    }

    function _from(bytes memory src, bytes memory anchor) internal pure returns (bytes memory out) {
        uint256 start = _indexOf(src, anchor);
        out = new bytes(src.length - start);
        for (uint256 k; k < out.length; ++k) {
            out[k] = src[start + k];
        }
    }

    function _indexOf(bytes memory haystack, bytes memory needle) internal pure returns (uint256) {
        require(needle.length != 0 && haystack.length >= needle.length, "bad needle");

        for (uint256 i; i <= haystack.length - needle.length; ++i) {
            bool hit = true;
            for (uint256 j; j < needle.length; ++j) {
                if (haystack[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return i;
        }
        revert("anchor not found");
    }
}
