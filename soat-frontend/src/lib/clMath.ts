// ─────────────────────────────────────────────────────────────────────────────
// The slice of PancakeSwap Infinity CL fixed-point maths the LP panel needs.
//
// Every Tosh pool uses ONE range — the same full range the hook seeds its
// genesis position at — so the two tick boundaries are compile-time constants
// and there is no need to port TickMath's 20-constant binary ladder.  The
// values below came from `TickMath.getSqrtRatioAtTick(±887200)` run against the
// vendored Solidity, not from a floating-point approximation.
//
// THE ARITHMETIC IS UNCHANGED FROM THE UNISWAP V4 PORT THIS REPLACES, and that
// is a measured finding rather than an assumption anyone made.
// `test_infinityLibrariesReproduceTheSameVectors` in
// `test/ToshV5LpMathVectors.t.sol` drives Infinity's `TickMath`,
// `SqrtPriceMath` and `LiquidityAmounts` over the same six recorded vectors and
// gets the same integers bit-for-bit, so the fixed-point maths is genuinely
// shared between the two AMMs and was NOT re-derived here.  What changed in the
// migration is the pool key, and only the pool key — see `PoolKeyStruct`.
//
// Kept honest from both ends: `scripts/checkClMath.ts` pins this port against
// those recorded vectors, and `test/ToshV5LpMathVectors.t.sol` regenerates them
// from the vendored Solidity.  Neither half can drift alone.
// ─────────────────────────────────────────────────────────────────────────────

import { encodeAbiParameters, keccak256, numberToHex, type Address } from 'viem'
import { CL_POOL_MANAGER, POOL_FEE, TICK_SPACING } from './contracts'

/** sqrtPriceX96 at tick -887200. */
export const SQRT_PRICE_LOWER = 4_310_618_292n

/** sqrtPriceX96 at tick +887200. */
export const SQRT_PRICE_UPPER = 1_456_195_216_270_955_103_206_513_029_158_776_779_468_408_838_535n

const Q96 = 1n << 96n

/**
 * Infinity's `PoolKey` — SIX members, in an order that is not V4's.
 *
 * From `lib/infinity-core/src/types/PoolKey.sol`:
 *
 *     currency0    address
 *     currency1    address
 *     hooks        address    ← moved UP; V4 had this last
 *     poolManager  address    ← NEW, no V4 equivalent
 *     fee          uint24     ← moved DOWN; V4 had this third
 *     parameters   bytes32    ← NEW; replaces V4's `int24 tickSpacing`
 *
 * V4's was `(currency0, currency1, fee, tickSpacing, hooks)`, so this is a
 * REORDERING as well as a widening and a five-member encode is not even a
 * prefix of a correct six-member one.
 *
 * ⚠ THIS IS THE ONLY STRUCTURAL DIFFERENCE BETWEEN AN INFINITY MINT PAYLOAD AND
 *   A UNISWAP V4 ONE. The five action opcodes the LP panel uses hold identical
 *   values in both peripheries (see `CL_ACTIONS` in contracts.ts), so the
 *   packed `actions` string is byte-identical either way and cannot tell a
 *   reader — or a guard — which AMM a payload was built for. The key's width and
 *   member order carry the whole signal, which is why
 *   `scripts/checkLpActionsAbi.mjs` compares this tuple field-by-field against
 *   the vendored struct and separately refuses anything V4-shaped.
 */
export interface PoolKeyStruct {
  currency0: Address
  currency1: Address
  hooks: Address
  poolManager: Address
  fee: number
  parameters: `0x${string}`
}

export const NATIVE_CURRENCY: Address = '0x0000000000000000000000000000000000000000'

/** abi-parameter spec for `PoolKey`, for hand-encoding posm action payloads. */
export const POOL_KEY_PARAM = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'hooks', type: 'address' },
    { name: 'poolManager', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'parameters', type: 'bytes32' },
  ],
} as const

/**
 * `PoolKey.parameters` — the hook's permission bitmap with `tickSpacing` packed
 * above it.
 *
 * Layout, from `lib/infinity-core/src/pool-cl/libraries/CLPoolParametersHelper.sol`:
 *
 *     [0, 16)     hooks registration bitmap
 *     [16, 40)    tickSpacing, as uint24  (`OFFSET_TICK_SPACING = 16`)
 *     [40, 256)   unused
 *
 * The authoritative construction is the hook's own `_key()` in
 * `src/ToshLaunchpadHook.sol`:
 *
 *     parameters: bytes32(uint256(getHooksRegistrationBitmap())).setTickSpacing(TICK_SPACING)
 *
 * ⚠ `hooksRegistrationBitmap` MUST BE READ OFF THE DEPLOYED HOOK, never typed in
 *   here. `CLPoolManager.initialize` compares the bitmap carried in
 *   `PoolKey.parameters` against what the hook reports and reverts on mismatch,
 *   so reading it from the chain makes this key track that hook BY
 *   CONSTRUCTION. A hard-coded copy would be a second source of truth for a
 *   value the chain already publishes — the same reasoning that has the launch
 *   page read `factory.hookInitcodeHash()` rather than recomputing it.
 *
 *   A zero bitmap is refused rather than encoded. Zero is what an unresolved
 *   `useReadContract` coalesces to, and it yields a key that is WRONG BUT
 *   WELL-FORMED: nothing local rejects it, `modifyLiquidities` happily encodes
 *   it, and the complaint arrives from `initialize` — a long way from the cause,
 *   in a wallet popup. No pool this protocol creates has an empty permission
 *   set, so zero is never a legitimate answer.
 */
export function clPoolParameters(
  hooksRegistrationBitmap: number,
  tickSpacing: number,
): `0x${string}` {
  if (!Number.isInteger(hooksRegistrationBitmap) ||
      hooksRegistrationBitmap < 0 ||
      hooksRegistrationBitmap > 0xffff) {
    throw new Error(
      `clMath: hooks registration bitmap ${hooksRegistrationBitmap} is not a uint16. ` +
      'It comes from `hook.getHooksRegistrationBitmap()`, which returns one.',
    )
  }
  if (hooksRegistrationBitmap === 0) {
    throw new Error(
      'clMath: refusing to build a PoolKey with a zero hooks registration bitmap. ' +
      'Read it from `hook.getHooksRegistrationBitmap()` and wait for the read to land — ' +
      'zero encodes a well-formed key for a pool that was never initialised, and the ' +
      'only thing that would reject it is CLPoolManager.initialize, far from here.',
    )
  }
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > 0xffffff) {
    throw new Error(`clMath: tickSpacing ${tickSpacing} does not fit the uint24 at bit 16`)
  }

  return numberToHex(
    BigInt(hooksRegistrationBitmap) | (BigInt(tickSpacing) << 16n),
    { size: 32 },
  )
}

/**
 * ETH is `address(0)` and therefore always sorts to `currency0`.
 *
 * `poolManager` comes from `CL_POOL_MANAGER`, which is a per-chain source
 * constant, and a chain with no Infinity deployment resolves it to the zero
 * sentinel. That is refused here for the same reason a zero bitmap is: it would
 * hash to a pool id nobody ever initialised, and the refusal has to name the
 * cause while the cause is still visible.
 */
export function toshPoolKey(
  token: Address,
  hook: Address,
  hooksRegistrationBitmap: number,
): PoolKeyStruct {
  if (/^0x0{40}$/.test(CL_POOL_MANAGER)) {
    throw new Error(
      'clMath: no Infinity CLPoolManager is known for this chain, so no PoolKey can be ' +
      'built. Infinity is named inside the key itself — see CL_POOL_MANAGER in contracts.ts.',
    )
  }

  return {
    currency0: NATIVE_CURRENCY,
    currency1: token,
    hooks: hook,
    poolManager: CL_POOL_MANAGER,
    fee: POOL_FEE,
    parameters: clPoolParameters(hooksRegistrationBitmap, TICK_SPACING),
  }
}

/**
 * `PoolId.toId()` — keccak of the abi-encoded struct.
 *
 * Infinity's is `keccak256(poolKey, 0xc0)`, six words, against V4's five. The
 * tuple spec is taken from `POOL_KEY_PARAM` rather than restated, because a
 * second copy of the member list is exactly how the five-member version of this
 * function survived the migration computing the wrong id for every pool.
 */
export function poolIdOf(key: PoolKeyStruct): `0x${string}` {
  return keccak256(encodeAbiParameters([POOL_KEY_PARAM], [key]))
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

  // At either boundary one leg's denominator collapses to zero, and BigInt
  // division by zero throws rather than yielding Infinity. The position is
  // single-sided there, so the degenerate leg contributes no ceiling at all.
  const span0 = SQRT_PRICE_UPPER - sqrtP
  const span1 = sqrtP - SQRT_PRICE_LOWER
  if (span0 === 0n && span1 === 0n) return 0n

  const liq0 = span0 === 0n
    ? null
    : (amount0 * sqrtP * SQRT_PRICE_UPPER) / (Q96 * span0)
  const liq1 = span1 === 0n
    ? null
    : (amount1 * Q96) / span1

  if (liq0 === null) return liq1 ?? 0n
  if (liq1 === null) return liq0
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

  // Price pinned at the upper boundary: the range holds no token0, so no
  // token1 pairs with it. Guarding the divisor also keeps BigInt from throwing.
  const span0 = SQRT_PRICE_UPPER - sqrtP
  if (span0 === 0n) return 0n

  const liquidity = (amount0 * sqrtP * SQRT_PRICE_UPPER) / (Q96 * span0)
  const exact = liquidity * (sqrtP - SQRT_PRICE_LOWER)

  return exact / Q96 + (exact % Q96 === 0n ? 0n : 1n)
}
