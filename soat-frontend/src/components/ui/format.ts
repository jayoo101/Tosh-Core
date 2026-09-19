/**
 * Display formatting for on-chain values.
 *
 * One job: turn a `bigint` from a contract into something a human reads,
 * without ever throwing.
 *
 * NON-OBVIOUS CONSTRAINT — a permanent ban is stored as `type(uint256).max`,
 * and `new Date(Number(thatValue) * 1000).toISOString()` throws a RangeError
 * that takes the whole panel down with it.  Nothing in this module hands an
 * unchecked value to `Date`: `classifyHorizon` is the only gateway, it returns
 * a discriminated union, and the `'unbounded'` arm has no timestamp to format.
 * There is deliberately no `formatUtc(bigint)` that accepts a raw stamp
 * without going through that check.
 */

import { formatUnits } from 'viem'
import { UNBOUNDED_BAN_SECONDS, QUOTE_DECIMALS } from '@/lib/contracts'
import { CLOCK_UNSYNCED } from './useClock'

/**
 * JavaScript's `Date` range is ±8.64e15 ms.  Anything past this in seconds
 * cannot be a date at all, whatever the product horizon says.
 */
const MAX_SAFE_EPOCH_SECONDS = 8_640_000_000_000n

export const EM_DASH = '—'

// ─────────────────────────────────────────────────────────────────────────────
// TIME
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an on-chain timestamp means right now.
 *
 *   unsynced  — the clock has not ticked on the client yet (see CLOCK_UNSYNCED).
 *   unbounded — past the horizon, or past what `Date` can represent.  Name it
 *               ("PERMANENT"); never count it down, never format it.
 *   elapsed   — in the past.
 *   pending   — in the future and safely representable.
 */
export type Horizon =
  | { readonly kind: 'unsynced' }
  | { readonly kind: 'unbounded' }
  | { readonly kind: 'elapsed'; readonly sinceSec: number }
  | { readonly kind: 'pending'; readonly remainingSec: number; readonly atSec: number }

/**
 * The single gateway between a raw contract timestamp and anything that
 * formats it.
 *
 * @param atSec     the on-chain stamp, in seconds
 * @param nowSec    from `useNowSec()`; `CLOCK_UNSYNCED` yields `'unsynced'`
 * @param horizonSec how far out a stamp stops being a date, defaulting to the
 *                   protocol's own `UNBOUNDED_BAN_SECONDS`
 */
export function classifyHorizon(
  atSec: bigint,
  nowSec: number,
  horizonSec: bigint = UNBOUNDED_BAN_SECONDS,
): Horizon {
  if (nowSec === CLOCK_UNSYNCED) return { kind: 'unsynced' }
  if (atSec <= 0n) return { kind: 'elapsed', sinceSec: 0 }
  if (atSec >= MAX_SAFE_EPOCH_SECONDS) return { kind: 'unbounded' }

  const now = BigInt(nowSec)
  if (atSec <= now) return { kind: 'elapsed', sinceSec: Number(now - atSec) }

  const remaining = atSec - now
  if (remaining > horizonSec) return { kind: 'unbounded' }
  return { kind: 'pending', remainingSec: Number(remaining), atSec: Number(atSec) }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** `HH:MM:SS`, clamped at zero, hours uncapped. */
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00:00'
  const total = Math.floor(seconds)
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`
}

/** `HH:MM:SS_cs` — the drawer's centisecond layout. Needs the 'frame' cadence. */
export function formatCountdownMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00:00_00'
  return `${formatCountdown(ms / 1_000)}_${pad2(Math.floor((ms % 1_000) / 10))}`
}

/** Coarse duration for prose: `3D 04H`, `12M 05S`, `45S`. */
export function formatDuration(seconds: number, zeroLabel = 'none'): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return zeroLabel
  const total = Math.floor(seconds)
  const d = Math.floor(total / 86_400)
  const h = Math.floor((total % 86_400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return `${d}D ${pad2(h)}H`
  if (h > 0) return `${h}H ${pad2(m)}M`
  if (m > 0) return `${m}M ${pad2(s)}S`
  return `${s}S`
}

/**
 * `YYYY-MM-DD HH:MM UTC` for a horizon already proven representable.
 *
 * Takes a `Horizon`, not a stamp — that is what makes it impossible to call
 * with `type(uint256).max`.
 */
export function formatHorizonUtc(horizon: Horizon, precision: 'minute' | 'second' = 'minute'): string | null {
  if (horizon.kind !== 'pending') return null
  try {
    const iso = new Date(horizon.atSec * 1_000).toISOString()
    return `${iso.slice(0, precision === 'minute' ? 16 : 19).replace('T', ' ')} UTC`
  } catch {
    return null
  }
}

/**
 * One line naming what a deadline is doing, safe for every input.
 *
 * `formatHorizonLabel(classifyHorizon(blacklistedUntil, nowSec), {
 *    unbounded: 'PERMANENT · NO EXPIRY',
 *    pending:   (d) => `LIFTS IN ${d}`,
 *    elapsed:   'CLEAR',
 *  })`
 */
export interface HorizonLabels {
  unsynced?: string
  unbounded: string
  elapsed: string
  pending: (duration: string) => string
}

export function formatHorizonLabel(horizon: Horizon, labels: HorizonLabels): string {
  switch (horizon.kind) {
    case 'unsynced':
      return labels.unsynced ?? EM_DASH
    case 'unbounded':
      return labels.unbounded
    case 'elapsed':
      return labels.elapsed
    case 'pending':
      return labels.pending(formatDuration(horizon.remainingSec))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AMOUNTS
// ─────────────────────────────────────────────────────────────────────────────

export interface AmountOptions {
  decimals?: number
  /** Max fraction digits below the compaction threshold. */
  precision?: number
  /** Collapse ≥1e3 to K / M / B. Default true. */
  compact?: boolean
  /** Rendered for `undefined`. Default `'—'`. */
  fallback?: string
}

/**
 * The compact readout used across the terminal: `1.23M`, `0.0451`, `1.20e-5`.
 * Replaces the `fmt()` copies in ProjectTerminal, UserDrawer and launch/page.
 */
export function formatAmount(wei: bigint | undefined | null, options: AmountOptions = {}): string {
  const { decimals = 18, precision = 4, compact = true, fallback = EM_DASH } = options
  if (wei === undefined || wei === null) return fallback
  try {
    const n = Number.parseFloat(formatUnits(wei, decimals))
    if (!Number.isFinite(n)) return fallback
    if (n === 0) return '0'
    const abs = Math.abs(n)
    if (abs < 0.0001) return n.toExponential(2)
    if (compact) {
      if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`
      if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`
    }
    return n.toLocaleString('en-US', { maximumFractionDigits: precision })
  } catch {
    return fallback
  }
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THE QUOTE ASSET IS 8 DECIMALS, AND `decimals = 18` IS THE DEFAULT ABOVE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Those two facts together are a trap, so the way out of it is named rather than
 * left to each caller to remember. Every amount this module was written for had 18
 * decimals: the project token, and a quote asset that was the chain's own coin.
 * The quote asset is now an 8-decimal ERC-20, and the default silently understates
 * one of the two populations by a factor of 10^10.
 *
 * Understates it PLAUSIBLY, which is what makes it worth a named helper instead of
 * a comment. A 9.28 launch fee formatted at 18 decimals renders `9.28e-8`. Nothing
 * throws, nothing warns, and the output is a perfectly believable small number — so
 * the error survives review by looking like data.
 *
 * `formatQuote` exists so a call site declares which asset it is printing. `fmtEth`
 * keeps the 18-decimal default for the native coin, where it remains correct, and
 * token amounts keep using `formatAmount` directly.
 */

/** A quote-asset amount: raises, fees, caps, shelf prices, treasury balances. */
export function formatQuote(
  units: bigint | undefined | null,
  options: Omit<AmountOptions, 'decimals'> = {},
): string {
  return formatAmount(units, { ...options, decimals: QUOTE_DECIMALS })
}

/** A quote-asset amount at full precision, for a hint line under a compact value. */
export function formatQuoteExact(
  units: bigint | undefined | null,
  fallback = EM_DASH,
): string {
  return formatExact(units, QUOTE_DECIMALS, fallback)
}

/** Full precision, trailing zeros trimmed — the hint line under a compact value. */
export function formatExact(
  wei: bigint | undefined | null,
  decimals = 18,
  fallback = EM_DASH,
): string {
  if (wei === undefined || wei === null) return fallback
  try {
    const s = formatUnits(wei, decimals)
    if (!s.includes('.')) return s
    return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '0'
  } catch {
    return fallback
  }
}

/** Percentage from a bigint ratio, without going through a lossy float divide. */
export function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0
  return Number((part * 10_000n) / whole) / 100
}

// ─────────────────────────────────────────────────────────────────────────────
// IDENTIFIERS
// ─────────────────────────────────────────────────────────────────────────────

export interface TruncateOptions {
  lead?: number
  tail?: number
}

/** `0x1234…cdef`. Returns the input untouched when it is already short. */
export function truncateHex(value: string, { lead = 6, tail = 4 }: TruncateOptions = {}): string {
  if (value.length <= lead + tail + 1) return value
  return `${value.slice(0, lead)}…${value.slice(-tail)}`
}

/** `0x1234abcd…12345678` — the wider form used for transaction hashes. */
export function truncateTxHash(hash: string): string {
  return truncateHex(hash, { lead: 10, tail: 6 })
}
