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
///   • Refunds open only after the 7-day launch window lapses unused. Missing
///     the target does not fail the round.
///
/// PRECONDITION: `nowSec` must be a synced wall clock, never the shared clock
/// store's `CLOCK_UNSYNCED` (0).  At 0 every comparison below reads as "the
/// window is still open", so an expired genesis resolves back to `'genesis'`
/// and the caller mounts a deposit panel over a raise that has already closed.
/// ProjectTerminal holds its whole body behind a clock gate for this reason.
export function resolvePhase({
  canRefund, launched, genesisDeadline, nowSec,
}: {
  totalNativeDeposited: bigint
  softCap:            bigint
  canRefund:          boolean
  launched:           boolean
  genesisDeadline:    bigint
  nowSec:             number
}): Phase {
  if (launched) return 'bonding'
  if (canRefund) return 'refund'

  // Before the first poll resolves, `genesisDeadline` is 0; treat that as
  // "still loading" rather than "expired".
  if (genesisDeadline === 0n || BigInt(nowSec) < genesisDeadline) return 'genesis'

  // Deadline passed and not yet launched. Re-derive the outcome from the same
  // inputs the contract uses instead of trusting `canRefund`, which is polled
  // and can lag the clock by up to a refetch interval.
  const zombie = BigInt(nowSec) >= genesisDeadline + LAUNCH_WINDOW_SECONDS
  return zombie ? 'refund' : 'awaiting_launch'
}
