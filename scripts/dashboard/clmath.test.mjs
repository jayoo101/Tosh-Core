/**
 * Tests for the swap math, built around one idea: check the answer with
 * different arithmetic than produced it.
 *
 * Re-deriving `quoteExactIn` with the same sqrt-price formulas would only
 * prove the file is self-consistent, which is not the failure worth catching.
 * A full-range CL pool is exactly a constant-product pool over the virtual
 * reserves `x = L/√P` and `y = L·√P`, so `x·y = L²` is invariant and the
 * output can be computed as `y - L²/(x + Δx)` — no sqrt prices anywhere. If the
 * Q96 integer path has a rounding bug or an inverted formula, the two disagree.
 *
 * Run: node --test scripts/dashboard/clmath.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Q96, quoteExactIn, calculateSwapFee, protocolFeeForDirection,
  inputAfterCuts, spotToken0PerToken1,
} from './clmath.mjs'

/** Live state read from the $TO pool on chain 56, so the numbers are realistic. */
const POOL = {
  sqrtPriceX96: 337797843947084782602217337655734542n,
  liquidity: 797210828226714278n,
  lpFee: 3000,
  protocolFee: 6043075,
}
const TAX_BPS = 100n
const BPS = 10_000n

test('protocol fee unpacks into two independent directions', () => {
  // 6043075 is 0x5C35C3: both 12-bit halves are 0x5C3 = 1475.
  assert.equal(protocolFeeForDirection(6043075, true), 1475n)
  assert.equal(protocolFeeForDirection(6043075, false), 1475n)
  // Reading the composite whole would be a 4096x error, which is the mistake
  // this helper exists to make impossible.
  assert.notEqual(protocolFeeForDirection(6043075, true), 6043075n)
})

test('protocol and LP fees compose rather than add', () => {
  // ProtocolFeeLibrary: protocolFee + lpFee - protocolFee*lpFee/1e6, floored.
  assert.equal(calculateSwapFee(1475n, 3000n), 4471n)
  // Naive addition would say 4475. The four-pip gap is the whole point.
  assert.notEqual(calculateSwapFee(1475n, 3000n), 4475n)
  // A zero protocol fee leaves the LP fee untouched.
  assert.equal(calculateSwapFee(0n, 3000n), 3000n)
})

test('the hook tax is charged before the pool fee, not alongside it', () => {
  const amountIn = 10n ** 18n
  const composed = inputAfterCuts(amountIn, TAX_BPS, BPS, 4471n)

  // What a caller gets by summing the two into one haircut.
  const summed = (amountIn * (1_000_000n - 4471n - 10_000n)) / 1_000_000n

  // Sequential application keeps more input than one summed haircut, because
  // the pool fee applies to 99% of the notional rather than 100%.
  assert.ok(composed > summed, `${composed} should exceed ${summed}`)
  // And the gap is the product term: 1% of 0.4471%, about 45 ppm.
  const gap = Number(composed - summed) / Number(amountIn)
  assert.ok(gap > 4e-5 && gap < 5e-5, `gap was ${gap}`)
})

/**
 * The cross-check. `x·y = L²` over virtual reserves, in floating point, with
 * no sqrt-price arithmetic in sight.
 */
function constantProductOut(pool, amountIn, zeroForOne) {
  const L = Number(pool.liquidity)
  const sqrtP = Number(pool.sqrtPriceX96) / Number(Q96)
  const x = L / sqrtP // virtual currency0
  const y = L * sqrtP // virtual currency1
  const k = x * y

  const fee = Number(calculateSwapFee(protocolFeeForDirection(pool.protocolFee, zeroForOne), pool.lpFee))
  const afterHook = Number(amountIn) * (1 - Number(TAX_BPS) / Number(BPS))
  const dIn = afterHook * (1 - fee / 1_000_000)

  return zeroForOne ? y - k / (x + dIn) : x - k / (y + dIn)
}

/**
 * Agreement between the two derivations, to the only precision that is
 * available to both.
 *
 * Two separate error terms, and conflating them is what made the first version
 * of this test fail on a correct implementation. The float carries ~15
 * significant digits, so it contributes a *relative* error. The integer path
 * floors every division, so it contributes an *absolute* error of at most a
 * unit or two — which on a small output (a sell returning 0.54 BEM, so ~5.4e7
 * raw units) is a relative drift of 2e-8 and swamps any sane relative bound.
 *
 * The direction is asserted separately, and it is the part that would actually
 * cost money: flooring must never land above the true value, because a quote
 * that is optimistic by even one unit sets an `amountOutMinimum` the pool
 * cannot fill.
 */
function assertAgrees(label, mine, theirs) {
  const absolute = Math.abs(Number(mine) - theirs)
  const tolerance = 2 + theirs * 1e-9
  assert.ok(absolute <= tolerance,
    `${label}: integer ${mine} vs float ${theirs}, off by ${absolute} (allowed ${tolerance})`)
  assert.ok(Number(mine) <= Math.ceil(theirs),
    `${label}: integer ${mine} rounded ABOVE the true ${theirs}, which would make minOut unfillable`)
}

test('matches a constant-product derivation across four orders of magnitude', () => {
  for (const whole of [1n, 10n, 100n, 1000n]) {
    const amountIn = whole * 10n ** 8n // BEM has 8 decimals
    const mine = quoteExactIn({
      ...POOL, amountIn, zeroForOne: true, taxBps: TAX_BPS, bps: BPS,
    }).amountOut
    assertAgrees(`buy ${whole}`, mine, constantProductOut(POOL, amountIn, true))
  }
})

test('matches a constant-product derivation on the sell side too', () => {
  for (const whole of [1000n, 100_000n, 1_000_000n]) {
    const amountIn = whole * 10n ** 18n
    const mine = quoteExactIn({
      ...POOL, amountIn, zeroForOne: false, taxBps: TAX_BPS, bps: BPS,
    }).amountOut
    assertAgrees(`sell ${whole}`, mine, constantProductOut(POOL, amountIn, false))
  }
})

test('quoting on lpFee alone would overstate the output', () => {
  const amountIn = 25n * 10n ** 8n
  const correct = quoteExactIn({
    ...POOL, amountIn, zeroForOne: true, taxBps: TAX_BPS, bps: BPS,
  }).amountOut
  // The bug this pool actually exposed: protocolFee read as zero.
  const optimistic = quoteExactIn({
    ...POOL, protocolFee: 0, amountIn, zeroForOne: true, taxBps: TAX_BPS, bps: BPS,
  }).amountOut
  assert.ok(optimistic > correct)
  const overstatement = Number(optimistic - correct) / Number(correct)
  // ~0.1475%, which is the protocol fee this pool charges.
  assert.ok(overstatement > 1.4e-3 && overstatement < 1.6e-3, `was ${overstatement}`)
})

test('output is monotonic and sublinear in input', () => {
  const q = (n) => quoteExactIn({
    ...POOL, amountIn: n * 10n ** 8n, zeroForOne: true, taxBps: TAX_BPS, bps: BPS,
  }).amountOut
  const [a, b] = [q(10n), q(20n)]
  assert.ok(b > a, 'more input must buy more output')
  // Price impact means doubling the input buys strictly less than double.
  assert.ok(b < a * 2n, 'a thin pool cannot pay linearly')
})

test('price moves against the trader on both sides', () => {
  const buy = quoteExactIn({
    ...POOL, amountIn: 10n ** 9n, zeroForOne: true, taxBps: TAX_BPS, bps: BPS,
  })
  const sell = quoteExactIn({
    ...POOL, amountIn: 10n ** 21n, zeroForOne: false, taxBps: TAX_BPS, bps: BPS,
  })
  // Spending currency0 lowers the sqrt price; spending currency1 raises it.
  assert.ok(buy.sqrtPriceAfter < POOL.sqrtPriceX96)
  assert.ok(sell.sqrtPriceAfter > POOL.sqrtPriceX96)
})

test('refuses states it cannot price', () => {
  const base = { ...POOL, amountIn: 10n ** 8n, zeroForOne: true, taxBps: TAX_BPS, bps: BPS }
  assert.throws(() => quoteExactIn({ ...base, liquidity: 0n }), /no liquidity/)
  assert.throws(() => quoteExactIn({ ...base, sqrtPriceX96: 0n }), /not initialised/)
  assert.throws(() => quoteExactIn({ ...base, amountIn: 0n }), /must be positive/)
  // Dust that the fees round entirely away must not quote as a free trade.
  assert.throws(() => quoteExactIn({ ...base, amountIn: 1n }), /smaller than the fees/)
})

test('spot price inverts sqrtPriceX96 and applies the decimal gap', () => {
  const spot = spotToken0PerToken1(POOL.sqrtPriceX96, 8, 18)
  // Independently: (1/ratio²)·10^(18-8).
  const ratio = Number(POOL.sqrtPriceX96) / Number(Q96)
  assert.ok(Math.abs(spot - (1 / (ratio * ratio)) * 1e10) / spot < 1e-12)
  // Sanity against the live pool: a fraction of a BEM per token.
  assert.ok(spot > 1e-4 && spot < 1e-2, `spot was ${spot}`)
})
