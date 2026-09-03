/**
 * Cross-checks the hand-ported fixed-point maths in `src/lib/v4Math.ts`
 * against reference vectors produced by v4-core's own `SqrtPriceMath` and
 * v4-periphery's `LiquidityAmounts`.
 *
 * The vectors below are regenerated and asserted by
 * `test/ToshV5LpMathVectors.t.sol`, which READS THEM OUT OF THIS FILE — so
 * `EXPECT` is the single copy, and editing it here to silence a failure will
 * simply move the failure into `forge test`. They are taken at a realistic
 * launched-pool price (0.9 ETH against 2.1M tokens, full range) with a
 * 0.05 ETH / 200k token deposit against it, the case where the ETH leg binds.
 *
 * That pairing is the whole value of this guard. On its own it would only pin
 * the TS against numbers nobody can re-derive — which is what it was for a
 * while, when its generator was an uncommitted scratch test that no longer
 * existed. A `lib/v4-core` bump could then have re-rounded the maths under the
 * frontend and this would have stayed green against the pre-bump values.
 *
 * If the TS drifts from the Solidity the panel starts quoting deposits the
 * pool will refuse: `amount1Max` is the binding side, so an under-quoted token
 * leg reverts at the wallet prompt.
 *
 *   npm run guard:v4math
 */

import {
  SQRT_PRICE_LOWER, SQRT_PRICE_UPPER,
  amountsForLiquidity, liquidityForAmounts, pairedAmount1,
} from '../src/lib/v4Math'

const SQRT_P = 121_023_017_297_959_709_708_926_085_430_745n
const ETH_IN = 50_000_000_000_000_000n        // 0.05 ETH
const TOKEN_IN = 200_000_000_000_000_000_000_000n // 200k tokens

const EXPECT = {
  sqrtLower:    4_310_618_292n,
  sqrtUpper:    1_456_195_216_270_955_103_206_513_029_158_776_779_468_408_838_535n,
  liquidity:    76_376_261_582_597_339_790n,
  amount0:      49_999_999_999_999_999n,
  amount1:      116_666_666_666_666_676_361_660n,
  pairedToken:  116_666_666_666_666_676_361_661n,
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
  liquidityForAmounts(SQRT_P, ETH_IN, TOKEN_IN),
  EXPECT.liquidity,
)

const amounts = amountsForLiquidity(SQRT_P, EXPECT.liquidity)
check('amountsForLiquidity.amount0 matches SqrtPriceMath.getAmount0Delta', amounts.amount0, EXPECT.amount0)
check('amountsForLiquidity.amount1 matches SqrtPriceMath.getAmount1Delta', amounts.amount1, EXPECT.amount1)

check(
  'pairedAmount1 matches getAmount1Delta(roundUp) off the ETH leg',
  pairedAmount1(SQRT_P, ETH_IN),
  EXPECT.pairedToken,
)

console.log(failures === 0 ? '\nAll v4 maths vectors agree.' : `\n${failures} mismatch(es).`)
process.exit(failures === 0 ? 0 : 1)
