/**
 * Turning pool state into a number a trader can act on.
 *
 * Thin by design: the math lives in `clmath.mjs` where it can be tested without
 * a chain, and the state lives in `pool.mjs`. What this file adds is the part
 * that is specific to *these* pools — which side is which, and the slippage
 * bound that every swap must carry because the router offers no other.
 */

import { ethers } from 'ethers'
import { quoteExactIn, spotToken0PerToken1, priceImpact } from './clmath.mjs'
import { TAX_BPS, BPS, QUOTE_DECIMALS, TOKEN_DECIMALS, SAFETY } from './config.mjs'

/**
 * Quote one leg.
 *
 * @param {object} pool   From `loadPool`.
 * @param {bigint} amountIn
 * @param {'buy'|'sell'} side  `buy` spends the quote asset, `sell` spends the token.
 * @param {bigint} [slippageBps]
 */
export function quoteLeg(pool, amountIn, side, slippageBps = SAFETY.slippageBps) {
  // currency0 is always the quote asset — `loadPool` refuses a pool where it is
  // not — so buying is unambiguously zeroForOne.
  const zeroForOne = side === 'buy'

  const { amountOut, sqrtPriceAfter, effectiveIn, swapFeePips } = quoteExactIn({
    sqrtPriceX96: pool.sqrtPriceX96,
    liquidity: pool.liquidity,
    amountIn,
    zeroForOne,
    lpFee: pool.lpFee,
    protocolFee: pool.protocolFee,
    taxBps: TAX_BPS,
    bps: BPS,
  })

  // The bound the router enforces. Derived from the quote rather than from a
  // remembered price: between reading state and landing a transaction the pool
  // can move, and a bound anchored to a stale price is either unreachable or
  // no bound at all.
  const minOut = amountOut - (amountOut * slippageBps) / BPS

  return {
    side,
    zeroForOne,
    amountIn,
    effectiveIn,
    amountOut,
    minOut,
    swapFeePips,
    sqrtPriceBefore: pool.sqrtPriceX96,
    sqrtPriceAfter,
    impact: priceImpact(pool.sqrtPriceX96, sqrtPriceAfter),
    /** What the hook skims, for the cost line in the report. */
    hookTax: (amountIn * TAX_BPS) / BPS,
    decimalsIn: zeroForOne ? QUOTE_DECIMALS : TOKEN_DECIMALS,
    decimalsOut: zeroForOne ? TOKEN_DECIMALS : QUOTE_DECIMALS,
  }
}

/** Quote-asset price of one whole project token. */
export function spotPrice(pool) {
  return spotToken0PerToken1(pool.sqrtPriceX96, QUOTE_DECIMALS, TOKEN_DECIMALS)
}

/**
 * Round-trip cost at a given size, as a fraction.
 *
 * Worth printing before anyone runs a loop, because it is the number that
 * decides whether a strategy can work at all. Buying and immediately selling
 * back returns less than it cost by roughly 2.6% before price impact — two
 * legs of a 1% hook tax and a 0.30% pool fee — and any rule that round-trips
 * more often than it captures that has a negative expectation no amount of
 * tuning fixes.
 */
export function roundTripCost(pool, amountIn) {
  const buy = quoteLeg(pool, amountIn, 'buy', 0n)
  // Price the return leg against the book the first leg leaves behind, not the
  // one it started from. Quoting both at spot understates the cost by the
  // impact of the first leg, which at this depth is not a rounding detail.
  const moved = { ...pool, sqrtPriceX96: buy.sqrtPriceAfter }
  const sell = quoteLeg(moved, buy.amountOut, 'sell', 0n)
  return {
    spent: amountIn,
    recovered: sell.amountOut,
    lossFraction: amountIn === 0n ? 0 : 1 - Number(sell.amountOut) / Number(amountIn),
  }
}

export const fmt = (v, decimals, places = 6) =>
  Number(ethers.formatUnits(v, decimals)).toLocaleString('en-US', { maximumFractionDigits: places })
