import { formatUnits } from 'viem'
import { V2 } from '@/lib/v2/config'

/** Mirrors `GenesisCurve` (and `GenesisCurveV3`): P at zero sold, 1.5P at `SALE_SUPPLY`, the pool opens at 2P. */
export const SALE_TOKENS = Number(V2.SALE_SUPPLY / V2.ONE)
export const GENESIS_TOKENS = Number(V2.GENESIS_SUPPLY / V2.ONE)
export const LP_TOKENS_MAX = GENESIS_TOKENS - SALE_TOKENS
export const TOTAL_TOKENS = 21_000_000
export const SHELF_TOKENS = TOTAL_TOKENS - GENESIS_TOKENS

/** A wei amount as a float, for charts and ratios only, never for a transaction. */
export function toNum(x: bigint | undefined | null, decimals = 18): number {
  if (x === undefined || x === null) return 0
  return Number(formatUnits(x, decimals))
}

export function priceAt(sold: number, p: number): number {
  return p * (1 + (0.5 * Math.min(Math.max(sold, 0), SALE_TOKENS)) / SALE_TOKENS)
}

/** The curve price after `tokens` more are sold, in wei, exactly as the contract rounds it. */
export function priceAfterWei(basePrice: bigint, sold: bigint, tokens: bigint): bigint {
  const sale = BigInt(SALE_TOKENS) * 10n ** 18n
  const s = sold + tokens > sale ? sale : sold + tokens
  return basePrice + (basePrice * s) / (2n * sale)
}

/** Up to four significant digits, zeros spelled out: 0.0001093, never 1.093e-4. */
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n >= 0.001) return Number(n.toPrecision(4)).toString()
  const [, decimals = ''] = n.toFixed(20).split('.')
  const zeros = decimals.match(/^0*/)?.[0].length ?? 0
  const digits = decimals.slice(zeros, zeros + 4).replace(/0+$/, '')
  return `0.${'0'.repeat(zeros)}${digits}`
}

export function fmtCompact(n: number): string {
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 })
}

/** `HH:MM:SS`, hours unbounded. */
export function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return [h, m, s % 60].map(v => String(v).padStart(2, '0')).join(':')
}

export function pct(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0
  return Number((part * 10_000n) / whole) / 100
}
