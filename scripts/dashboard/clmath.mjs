/**
 * Concentrated-liquidity swap math, and why a closed form is exact here.
 *
 * A general CL quote has to walk the tick bitmap, because liquidity changes as
 * the price crosses initialised ticks and each segment prices differently.
 * That is not a simplification this file makes — it is a property of these
 * pools: every position in them spans the full range. The hook seeds the
 * genesis position at ±887200 (`ToshLaunchpadHook._launch`), and the only other
 * way to add liquidity, the frontend's LP panel, hard-codes the same bounds
 * (`soat-frontend/src/lib/contracts.ts` TICK_LOWER/TICK_UPPER). With one
 * liquidity band covering every reachable tick, `L` is constant for any trade
 * that does not exhaust the pool, so the single-segment formulas below are the
 * exact answer rather than an approximation of one.
 *
 * That assumption is load-bearing, so `quote.mjs` does not rely on it alone —
 * it checks the quote against a simulation of the real router call before any
 * swap is signed. If someone ever mints a narrow position, the simulation and
 * this math will disagree and the tool refuses rather than trades.
 *
 * Rounding follows Uniswap V3's `SqrtPriceMath`: against the trader on the
 * price, down on the output. Being a wei pessimistic is free; being a wei
 * optimistic makes `amountOutMinimum` unreachable and burns gas on a revert.
 */

export const Q96 = 2n ** 96n

function divRoundingUp(a, b) {
  return a / b + (a % b === 0n ? 0n : 1n)
}

/**
 * The protocol's cut for one direction, unpacked from the composite in slot0.
 *
 * `protocolFee` packs two independent fees into a uint24: zeroForOne in the low
 * 12 bits, oneForZero in the high 12. Reading the composite as a single number
 * is a silent 4096x error, so both call sites go through here.
 * (lib/infinity-core/src/libraries/ProtocolFeeLibrary.sol)
 */
export function protocolFeeForDirection(protocolFee, zeroForOne) {
  const p = BigInt(protocolFee)
  return zeroForOne ? p & 0xfffn : p >> 12n
}

/**
 * The pool's total fee, protocol and LP combined.
 *
 * ⚠ NOT `lpFee`. The protocol fee is taken from the input first and the LP fee
 *   from what survives, so the two compose rather than add:
 *   `protocolFee + lpFee - protocolFee·lpFee/1e6`. This pool carries a 1475-pip
 *   protocol fee in both directions, which makes the real swap fee 4471 pips
 *   (0.4471%) against the 3000 (0.30%) that `getSlot0().lpFee` reports on its
 *   own. Quoting on `lpFee` alone overstates the output by about 0.147%.
 *
 * Mirrors `ProtocolFeeLibrary.calculateSwapFee`, floor division included — the
 * Solidity is `div`, and rounding the other way here would put the quote back
 * on the optimistic side of the contract by a wei.
 */
export function calculateSwapFee(protocolFeePips, lpFee) {
  const p = BigInt(protocolFeePips) & 0xfffn
  const l = BigInt(lpFee) & 0xffffffn
  return p + l - (p * l) / 1_000_000n
}

/**
 * Input actually delivered to the curve.
 *
 * TWO LAYERS, IN THIS ORDER, AND THE ORDER MATTERS.
 *
 * 1. The hook's `TAX_BPS` comes off first, in `beforeSwap`, before the pool has
 *    seen the trade at all — so the pool's fees are charged on the remainder,
 *    not on what the trader sent.
 * 2. The pool's combined swap fee comes off next, on what is left.
 *
 * Collapsing these into one haircut overstates the input by the product term.
 * It is small, and it is small in the direction that makes `amountOutMinimum`
 * unreachable, which is the expensive direction.
 */
export function inputAfterCuts(amountIn, taxBps, bps, swapFeePips) {
  const afterHook = amountIn - (amountIn * taxBps) / bps
  return (afterHook * (1_000_000n - BigInt(swapFeePips))) / 1_000_000n
}

/**
 * Next sqrt price when currency0 is the input and the price falls.
 *
 * `sqrtP' = L·sqrtP / (L + amountIn·sqrtP/Q96)`, in integer Q96 form. Rounded
 * up, which moves the resulting price against the trader.
 */
export function nextSqrtPriceFromAmount0(sqrtP, liquidity, amountIn) {
  if (amountIn === 0n) return sqrtP
  const numerator = liquidity << 96n
  const product = amountIn * sqrtP
  // No overflow branch: BigInt is arbitrary precision, so the `product /
  // amountIn === sqrtP` guard the Solidity original needs has nothing to catch.
  return divRoundingUp(numerator * sqrtP, numerator + product)
}

/**
 * Next sqrt price when currency1 is the input and the price rises.
 *
 * `sqrtP' = sqrtP + amountIn·Q96/L`. Rounded down, again against the trader.
 */
export function nextSqrtPriceFromAmount1(sqrtP, liquidity, amountIn) {
  if (amountIn === 0n) return sqrtP
  return sqrtP + (amountIn * Q96) / liquidity
}

/** currency1 released by a fall from `a` to `b`. Rounded down. */
export function amount1Delta(sqrtA, sqrtB, liquidity) {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA]
  return (liquidity * (hi - lo)) / Q96
}

/** currency0 released by a rise from `a` to `b`. Rounded down. */
export function amount0Delta(sqrtA, sqrtB, liquidity) {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA]
  return (liquidity * Q96 * (hi - lo)) / (hi * lo)
}

/**
 * Exact-input quote for one full-range CL pool.
 *
 * @param {object}  p
 * @param {bigint}  p.sqrtPriceX96 Current price, from `CLPoolManager.getSlot0`.
 * @param {bigint}  p.liquidity    Current L, from `CLPoolManager.getLiquidity`.
 * @param {bigint}  p.amountIn     Raw input, before either cut.
 * @param {boolean} p.zeroForOne   True when spending currency0 (the quote asset).
 * @param {number}  p.lpFee        LP fee in hundredths of a bip, from slot0.
 * @param {number}  p.protocolFee  Composite protocol fee, from slot0.
 * @param {bigint}  p.taxBps       The hook's input skim.
 * @param {bigint}  p.bps          Basis-point denominator.
 * @returns {{ amountOut: bigint, sqrtPriceAfter: bigint, effectiveIn: bigint, swapFeePips: bigint }}
 */
export function quoteExactIn({ sqrtPriceX96, liquidity, amountIn, zeroForOne, lpFee, protocolFee, taxBps, bps }) {
  if (liquidity === 0n) throw new Error('pool holds no liquidity')
  if (sqrtPriceX96 === 0n) throw new Error('pool is not initialised')
  if (amountIn <= 0n) throw new Error('amountIn must be positive')

  const swapFeePips = calculateSwapFee(protocolFeeForDirection(protocolFee, zeroForOne), lpFee)
  const effectiveIn = inputAfterCuts(amountIn, taxBps, bps, swapFeePips)
  if (effectiveIn === 0n) throw new Error('amountIn is smaller than the fees taken from it')

  const sqrtPriceAfter = zeroForOne
    ? nextSqrtPriceFromAmount0(sqrtPriceX96, liquidity, effectiveIn)
    : nextSqrtPriceFromAmount1(sqrtPriceX96, liquidity, effectiveIn)

  const amountOut = zeroForOne
    ? amount1Delta(sqrtPriceX96, sqrtPriceAfter, liquidity)
    : amount0Delta(sqrtPriceX96, sqrtPriceAfter, liquidity)

  return { amountOut, sqrtPriceAfter, effectiveIn, swapFeePips }
}

/**
 * Spot price of one whole token1, denominated in whole token0.
 *
 * `sqrtPriceX96` encodes token1-per-token0, so this inverts it. Done in
 * floating point on purpose: this feeds display and the engine's threshold
 * comparisons, never a `minOut`, and carrying a Q96 rational through a
 * threshold check buys precision nothing downstream can use.
 */
export function spotToken0PerToken1(sqrtPriceX96, decimals0, decimals1) {
  const ratio = Number(sqrtPriceX96) / Number(Q96)
  const token1PerToken0 = ratio * ratio
  if (token1PerToken0 === 0) return 0
  return (1 / token1PerToken0) * 10 ** (decimals1 - decimals0)
}

/** Price impact of a quote, as a fraction (0.01 === 1%). */
export function priceImpact(sqrtBefore, sqrtAfter) {
  const before = Number(sqrtBefore)
  const after = Number(sqrtAfter)
  if (before === 0) return 0
  return Math.abs((after * after - before * before) / (before * before))
}
