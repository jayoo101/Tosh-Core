import { LAUNCH_WINDOW_SECONDS } from '@/lib/contracts'

// ─────────────────────────────────────────────────────────────────────────────
// PHASE RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

export type Phase = 'genesis' | 'awaiting_launch' | 'bonding' | 'refund'

/// Mirrors the hook's own state machine.  Two rules matter and an earlier
/// revision broke both with one clause (`totalEthDeposited >= softCap` also
/// meaning "bonding"):
///
///   • The shelf ladder does not exist until `launch()` has run.  Reaching the
///     soft cap does NOT open it — the creator still has to call `launch()`,
///     and cannot even do that until the genesis deadline passes.  Showing the
///     bonding panel early handed users a mint button that could only revert.
///   • Deposits stay open for the whole genesis window.  The soft cap is a
///     floor, not a ceiling, so closing the deposit panel on contact with it
///     capped every raise at exactly its minimum.
///
/// PRECONDITION: `nowSec` must be a synced wall clock, never the shared clock
/// store's `CLOCK_UNSYNCED` (0).  At 0 every comparison below reads as "the
/// window is still open", so an expired genesis resolves back to `'genesis'`
/// and the caller mounts a deposit panel over a raise that has already failed.
/// ProjectTerminal holds its whole body behind a clock gate for this reason.
export function resolvePhase({
  totalEthDeposited, softCap, canRefund, launched, genesisDeadline, nowSec,
}: {
  totalEthDeposited: bigint
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

  // Deadline passed and not yet launched.  Re-derive the outcome from the same
  // inputs the contract uses instead of trusting `canRefund`, which is polled
  // and can lag the clock by up to a refetch interval.
  //
  // The soft cap alone is not enough: once the launch window lapses on top of
  // it the hook opens `refund()` to everyone, and reading the cap in isolation
  // parked the user on a launch panel whose own copy said the refund was open
  // while no refund button existed anywhere on the page.
  const zombie = BigInt(nowSec) >= genesisDeadline + LAUNCH_WINDOW_SECONDS
  return totalEthDeposited >= softCap && softCap > 0n && !zombie
    ? 'awaiting_launch'
    : 'refund'
}
