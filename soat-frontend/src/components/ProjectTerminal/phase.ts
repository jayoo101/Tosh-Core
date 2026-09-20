import { LAUNCH_WINDOW_SECONDS } from '@/lib/contracts'

// ─────────────────────────────────────────────────────────────────────────────
// PHASE RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

export type Phase = 'genesis' | 'awaiting_launch' | 'bonding' | 'refund'

/// Mirrors the hook's own state machine.
///
///   • The shelf ladder does not exist until `launch()` has run. Reaching any
///     raise size does NOT open it — the creator still has to call `launch()`,
///     and cannot even do that until the genesis deadline passes. Showing the
///     bonding panel early handed users a mint button that could only revert.
///   • Deposits stay open for the whole genesis window. The soft cap is a
///     progress target, not a floor: time-up is what opens `launch()`, and a
///     raise of any non-zero size may seed the pool.
///   • Refunds open on either of two failures, and they run on different
///     clocks — see `ladderViable` below.
///
/// PRECONDITION: `nowSec` must be a synced wall clock, never the shared clock
/// store's `CLOCK_UNSYNCED` (0).  At 0 every comparison below reads as "the
/// window is still open", so an expired genesis resolves back to `'genesis'`
/// and the caller mounts a deposit panel over a raise that has already closed.
/// ProjectTerminal holds its whole body behind a clock gate for this reason.
export function resolvePhase({
  canRefund, launched, genesisDeadline, nowSec, ladderViable,
}: {
  canRefund:          boolean
  launched:           boolean
  genesisDeadline:    bigint
  nowSec:             number
  /**
   * The hook's `ladderViable()`. `undefined` until the read lands.
   *
   * ⚠ `undefined` IS NOT `false` HERE, and the distinction decides what a
   *   healthy round looks like on first paint. Treating a pending read as
   *   "cannot launch" would mount the refund terminal over every project for
   *   the length of one RPC round-trip.
   */
  ladderViable?: boolean
}): Phase {
  if (launched) return 'bonding'
  if (canRefund) return 'refund'

  // Before the first poll resolves, `genesisDeadline` is 0; treat that as
  // "still loading" rather than "expired".
  if (genesisDeadline === 0n || BigInt(nowSec) < genesisDeadline) return 'genesis'

  // Deadline passed and not yet launched. Re-derive the outcome from the same
  // inputs the contract uses instead of trusting `canRefund`, which is polled
  // and can lag the clock by up to a refetch interval.
  //
  // A raise too small to carry a ladder refunds NOW, not in seven days: the
  // contract's `canRefund()` returns true the moment genesis closes, because
  // `launch()` is arithmetically impossible on it and the window it would
  // otherwise wait out cannot change that. Deriving this from the clock alone
  // would put the page a week behind the chain — `awaiting_launch`, with a
  // countdown to a deadline that means nothing, over a refund the depositor
  // could already take.
  if (ladderViable === false) return 'refund'

  const zombie = BigInt(nowSec) >= genesisDeadline + LAUNCH_WINDOW_SECONDS
  return zombie ? 'refund' : 'awaiting_launch'
}

// ─────────────────────────────────────────────────────────────────────────────
// GENESIS CLOCK
// ─────────────────────────────────────────────────────────────────────────────

export interface GenesisWindow {
  /** 0–100, how much of the window REMAINS. The track drains. */
  pct: number
  /** `HH:MM:SS left`. */
  label: string
  /** The chosen window in whole hours — 3, 24 or 72. */
  hours: number
}

/**
 * The genesis countdown, as a fraction of the window the creator chose.
 *
 * ⚠ `pct` IS WHAT REMAINS, NOT WHAT HAS ELAPSED, and that is the one thing
 *   here worth a test. Both directions render, both animate, and the wrong one
 *   is wrong in a way nobody notices from a screenshot: a countdown that FILLS
 *   as the deadline approaches reads as progress toward something, which is
 *   the exact misreading the soft-cap bar used to produce. This drains.
 *
 * Lives beside `resolvePhase` rather than in the component because it is the
 * half that can be wrong about the world. The component only has to draw the
 * number it is handed.
 *
 * Returns `undefined` — draw nothing — rather than a zeroed window whenever
 * the inputs cannot support a fraction: outside genesis, before the first poll
 * resolves `genesisDeadline`, or once the clock has run out. A bar pinned at 0
 * says "this window is over" in a phase where that is not yet true.
 */
export function genesisWindow({
  phase, genesisDeadline, genesisDuration, nowSec,
}: {
  phase:           Phase
  genesisDeadline: bigint
  genesisDuration: bigint
  nowSec:          number
}): GenesisWindow | undefined {
  if (phase !== 'genesis') return undefined
  if (genesisDeadline === 0n || genesisDuration === 0n) return undefined

  const remaining = Number(genesisDeadline) - nowSec
  const total = Number(genesisDuration)
  if (remaining <= 0 || total <= 0) return undefined

  const h = Math.floor(remaining / 3600)
  const m = Math.floor((remaining % 3600) / 60)
  const s = remaining % 60
  const pad = (n: number) => String(n).padStart(2, '0')

  return {
    pct: Math.max(0, Math.min(100, (remaining / total) * 100)),
    label: `${pad(h)}:${pad(m)}:${pad(s)} left`,
    hours: Math.round(total / 3600),
  }
}
