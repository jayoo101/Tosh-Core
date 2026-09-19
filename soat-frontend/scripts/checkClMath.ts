/**
 * Cross-checks the hand-ported fixed-point maths in `src/lib/clMath.ts`
 * against reference vectors produced by infinity-core's own `SqrtPriceMath` and
 * infinity-periphery's `LiquidityAmounts`.
 *
 * The vectors below are regenerated and asserted by
 * `test/ToshV5LpMathVectors.t.sol`, which READS THEM OUT OF THIS FILE — so
 * `EXPECT` is the single copy, and editing it here to silence a failure will
 * simply move the failure into `forge test`. They are taken at a realistic
 * launched-pool price with a deposit against it sized so that the QUOTE leg
 * binds, which is the case the panel has to get right — the token leg is what
 * the user is asked to approve.
 *
 * ⚑ REGENERATED FOR THE BEM QUOTE ASSET, and the reason matters more than the
 * numbers. The previous vectors sat at `SQRT_P` 1.21e32: a pool holding 0.9
 * NATIVE against 2.1M tokens, both sides 18 decimals. BEM has eight, so the real
 * pool sits at 1.62e36 — four orders of magnitude away, on the far side of 2⁹⁶.
 * The old vectors were internally consistent and would have gone on passing
 * forever while checking the panel's arithmetic at a price the protocol can no
 * longer produce.
 *
 * `SQRT_P` below is not chosen, it is measured: it is the `sqrtPriceX96` the hook
 * emits in `Launched` for its smallest real raise (90 BEM to the LP against
 * `GENESIS_LP_SUPPLY` of 3.78M, giving `p0` = 2380). Deposit is 5 BEM against
 * 400k tokens, which at that price needs ~210k — so the quote leg binds and
 * `pairedToken` is the number the panel would put in front of a user.
 *
 * The arithmetic is unchanged from the Uniswap V4 port this replaces — measured
 * in `test_infinityLibrariesReproduceTheSameVectors`, not assumed. What this
 * guard pins is that the TypeScript still agrees with those integers after the
 * PoolKey rewrite around them.
 *
 * If the TS drifts from the Solidity the panel starts quoting deposits the
 * pool will refuse: `amount1Max` is the binding side, so an under-quoted token
 * leg reverts at the wallet prompt.
 *
 *   npm run guard:clmath
 */

import {
  SQRT_PRICE_LOWER, SQRT_PRICE_UPPER,
  amountsForLiquidity, liquidityForAmounts, pairedAmount1,
} from '../src/lib/clMath'

const SQRT_P = 1_623_699_805_833_907_168_681_618_116_590_147_935n
const QUOTE_IN = 500_000_000n                     // 5 BEM, 8 decimals
const TOKEN_IN = 400_000_000_000_000_000_000_000n // 400k tokens, 18 decimals

// `amount0` is 499_999_999 against a `QUOTE_IN` of 500_000_000: one base unit lost
// to the round-down, same as the old vectors lost one wei. The absolute loss did
// not change and the relative one did, by ten orders of magnitude — 2e-9 of the
// deposit where it used to be 1e-17. Still far too small to matter to a depositor,
// recorded because "one unit" stops being self-evidently negligible at 8 decimals
// and someone will eventually want the figure rather than the reassurance.
const EXPECT = {
  sqrtLower:    4_310_618_292n,
  sqrtUpper:    1_456_195_216_270_955_103_206_513_029_158_776_779_468_408_838_535n,
  liquidity:    10_246_986_389_109_962n,
  amount0:      499_999_999n,
  amount1:      210_001_460_116_975_489_718_993n,
  pairedToken:  210_001_460_116_975_489_718_994n,
}

let failures = 0
function check(label: string, got: bigint, want: bigint) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}\n        got  ${got}\n        want ${want}`)
}

check('SQRT_PRICE_LOWER matches TickMath(-887200)', SQRT_PRICE_LOWER, EXPECT.sqrtLower)
check('SQRT_PRICE_UPPER matches TickMath(+887200)', SQRT_PRICE_UPPER, EXPECT.sqrtUpper)

check(
  'liquidityForAmounts matches LiquidityAmounts.getLiquidityForAmounts',
  liquidityForAmounts(SQRT_P, QUOTE_IN, TOKEN_IN),
  EXPECT.liquidity,
)

const amounts = amountsForLiquidity(SQRT_P, EXPECT.liquidity)
check('amountsForLiquidity.amount0 matches SqrtPriceMath.getAmount0Delta', amounts.amount0, EXPECT.amount0)
check('amountsForLiquidity.amount1 matches SqrtPriceMath.getAmount1Delta', amounts.amount1, EXPECT.amount1)

check(
  'pairedAmount1 matches getAmount1Delta(roundUp) off the quote leg',
  pairedAmount1(SQRT_P, QUOTE_IN),
  EXPECT.pairedToken,
)

console.log(failures === 0 ? '\nAll Infinity CL maths vectors agree.' : `\n${failures} mismatch(es).`)
process.exit(failures === 0 ? 0 : 1)
