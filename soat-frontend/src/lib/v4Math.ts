// ─────────────────────────────────────────────────────────────────────────────
// The slice of Uniswap V4 fixed-point maths the LP panel needs.
//
// Every Tosh pool uses ONE range — the same full range the hook seeds its
// genesis position at — so the two tick boundaries are compile-time constants
// and there is no need to port TickMath's 20-constant binary ladder.  The
// values below came from `TickMath.getSqrtPriceAtTick(±887200)` run against
// v4-core, not from a floating-point approximation.
// ─────────────────────────────────────────────────────────────────────────────

import { encodeAbiParameters, keccak256, type Address } from 'viem'
import { POOL_FEE, TICK_SPACING } from './contracts'

/** sqrtPriceX96 at tick -887200. */
export const SQRT_PRICE_LOWER = 4_310_618_292n

/** sqrtPriceX96 at tick +887200. */
export const SQRT_PRICE_UPPER = 1_456_195_216_270_955_103_206_513_029_158_776_779_468_408_838_535n

const Q96 = 1n << 96n

export interface PoolKeyStruct {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export const NATIVE_CURRENCY: Address = '0x0000000000000000000000000000000000000000'

/** abi-parameter spec for `PoolKey`, for hand-encoding posm action payloads. */
export const POOL_KEY_PARAM = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const

/** ETH is `address(0)` and therefore always sorts to `currency0`. */
export function toshPoolKey(token: Address, hook: Address): PoolKeyStruct {
  return {
    currency0: NATIVE_CURRENCY,
    currency1: token,
    fee: POOL_FEE,
    tickSpacing: TICK_SPACING,
    hooks: hook,
  }
}

/** `PoolId.toId()` — keccak of the abi-encoded struct. */
export function poolIdOf(key: PoolKeyStruct): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'currency0', type: 'address' },
            { name: 'currency1', type: 'address' },
            { name: 'fee', type: 'uint24' },
            { name: 'tickSpacing', type: 'int24' },
            { name: 'hooks', type: 'address' },
          ],
        },
      ],
      [key],
    ),
  )
}

function clampSqrt(sqrtP: bigint): bigint {
  if (sqrtP < SQRT_PRICE_LOWER) return SQRT_PRICE_LOWER
  if (sqrtP > SQRT_PRICE_UPPER) return SQRT_PRICE_UPPER
  return sqrtP
}

/**
 * Token amounts a full-range position of `liquidity` is currently worth.
 *
 * Rounds DOWN, matching what the pool actually pays out on a burn, so the
 * panel never shows a number the user cannot withdraw.
 */
export function amountsForLiquidity(
  sqrtPriceX96: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (liquidity === 0n || sqrtPriceX96 === 0n) return { amount0: 0n, amount1: 0n }

  const sqrtP = clampSqrt(sqrtPriceX96)
  const amount0 =
    (liquidity * Q96 * (SQRT_PRICE_UPPER - sqrtP)) / (sqrtP * SQRT_PRICE_UPPER)
  const amount1 = (liquidity * (sqrtP - SQRT_PRICE_LOWER)) / Q96

  return { amount0, amount1 }
}

/**
 * Liquidity obtainable from a pair of maximum deposits, full range.
 *
 * Mirrors `LiquidityAmounts.getLiquidityForAmounts`: take the binding side, so
 * neither leg is ever over-drawn.
 */
export function liquidityForAmounts(
  sqrtPriceX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtPriceX96 === 0n) return 0n
  const sqrtP = clampSqrt(sqrtPriceX96)

  const liq0 =
    (amount0 * sqrtP * SQRT_PRICE_UPPER) / (Q96 * (SQRT_PRICE_UPPER - sqrtP))
  const liq1 = (amount1 * Q96) / (sqrtP - SQRT_PRICE_LOWER)

  return liq0 < liq1 ? liq0 : liq1
}

/**
 * Token side required to pair with `amount0` of ETH at the current price.
 *
 * Derived by round-tripping through liquidity rather than through a spot
 * price, so the figure the panel shows is the figure the pool will actually
 * pull.  Rounds UP: under-quoting the token side makes the mint revert on the
 * `amount1Max` guard.
 */
export function pairedAmount1(sqrtPriceX96: bigint, amount0: bigint): bigint {
  if (sqrtPriceX96 === 0n || amount0 === 0n) return 0n
  const sqrtP = clampSqrt(sqrtPriceX96)

  const liquidity =
    (amount0 * sqrtP * SQRT_PRICE_UPPER) / (Q96 * (SQRT_PRICE_UPPER - sqrtP))
  const exact = liquidity * (sqrtP - SQRT_PRICE_LOWER)

  return exact / Q96 + (exact % Q96 === 0n ? 0n : 1n)
}
