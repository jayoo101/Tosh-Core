/**
 * Cross-checks the hand-ported fixed-point maths in `src/lib/v4Math.ts`
 * against reference vectors produced by v4-core's own `SqrtPriceMath` and
 * v4-periphery's `LiquidityAmounts`.
 *
 * The vectors below came from `test/ScratchLpMath.t.sol` run under Foundry at
 * a realistic launched-pool price (0.9 ETH against 2.1M tokens, full range).
 * If the TS drifts from the Solidity the panel starts quoting deposits the
 * pool will refuse, so this is worth pinning.
 *
 *   npx tsx scripts/checkV4Math.ts
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
