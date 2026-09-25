/**
 * Turning pool state into the numbers the pool-health panel shows.
 *
 * Thin by design: the math lives in `clmath.mjs` where it can be tested without
 * a chain, and the state lives in `pool.mjs`. What this file adds is the part
 * that is specific to *these* pools — which side is which, and the hook's tax.
 */

import { quoteExactIn, spotToken0PerToken1, priceImpact } from './clmath.mjs'
import { TAX_BPS, BPS, QUOTE_DECIMALS, TOKEN_DECIMALS } from './config.mjs'

/**
 * Quote one leg.
 *
 * @param {object} pool   From `loadPool`.
 * @param {bigint} amountIn
 * @param {'buy'|'sell'} side  `buy` spends the quote asset, `sell` spends the token.
 */
export function quoteLeg(pool, amountIn, side) {
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

  return {
    side,
    zeroForOne,
    amountIn,
    effectiveIn,
    amountOut,
    swapFeePips,
    sqrtPriceBefore: pool.sqrtPriceX96,
    sqrtPriceAfter,
    impact: priceImpact(pool.sqrtPriceX96, sqrtPriceAfter),
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
 * Buying and immediately selling back returns less than it cost by roughly 2.6%
 * before price impact — two legs of a 1% hook tax and a 0.30% pool fee — which
 * is the friction any holder pays to get in and out.
 */
export function roundTripCost(pool, amountIn) {
  const buy = quoteLeg(pool, amountIn, 'buy')
  // Price the return leg against the book the first leg leaves behind, not the
  // one it started from. Quoting both at spot understates the cost by the
  // impact of the first leg, which at this depth is not a rounding detail.
  const moved = { ...pool, sqrtPriceX96: buy.sqrtPriceAfter }
  const sell = quoteLeg(moved, buy.amountOut, 'sell')
  return {
    spent: amountIn,
    recovered: sell.amountOut,
    lossFraction: amountIn === 0n ? 0 : 1 - Number(sell.amountOut) / Number(amountIn),
  }
}
