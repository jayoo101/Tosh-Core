import type * as React from 'react'

import { fmt } from './format'

// ─────────────────────────────────────────────────────────────────────────────
// H-01 LEDGER  ·  pure-text reconciliation
// ─────────────────────────────────────────────────────────────────────────────
//
// Account ledger format — left aligned debit, right aligned credit, totals at
// the bottom.  The quota is a per-WINDOW budget (`quotaWindowDuration`, 24 h by
// default), not a lifetime allowance, so everything here is denominated against
// the live `factory.eligibility()` verdict rather than against a cumulative
// deposit total.  While the projected deposit still fits, the final line reads:
//
//     → H-01_GUARD: ACTIVE
//
// On actual breach (a parsed input that exceeds the remaining window budget)
// the guard line flips to:
//
//     → H-01_BREACH: INTERCEPTED
//
// and the DEPOSIT button locks (handled in the GenesisPanel).
//

/// Why `eligibility` reports no headroom, when the reason is not that the
/// window is spent.  A live cooldown, a ban and a never-registered attestation
/// all short-circuit it to `(false, 0, 0)`, and none of the three is the fact
/// "you have none left" — so each is named rather than rendered as a balance.
export type QuotaBlock = 'cooldown' | 'banned' | 'unattested' | null

export function QuotaLedger({
  quota, remaining, projected, blocked,
}: {
  quota:     bigint
  remaining: bigint
  projected: bigint
  blocked:   QuotaBlock
}) {
  const stale     = blocked !== null
  const spent     = quota > remaining ? quota - remaining : 0n
  const breached  = !stale && projected > 0n && projected > remaining
  const consumed  = quota > 0n
    ? Number((spent * 10_000n) / quota) / 100
    : 0
  const projConsumed = quota > 0n && projected > 0n
    ? Number(((spent + projected) * 10_000n) / quota) / 100
    : consumed
  const statusTxt = blocked === 'cooldown'   ? 'WINDOW UNREADABLE'
                  : blocked === 'banned'     ? 'BLACKLISTED'
                  : blocked === 'unattested' ? 'NO ATTESTATION'
                  : `${consumed.toFixed(1)}% CONSUMED`

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between border-b border-border-subtle/60 py-1.5">
      <span className="font-mono text-label text-text-tertiary">{label}</span>
      <span className="font-mono text-[11px] text-text-primary tabular-nums break-all text-right">
        {value}
      </span>
    </div>
  )

  return (
    <div className="border border-border-subtle px-4 py-3 flex flex-col gap-1">
      <div className="flex items-center justify-between pb-1">
        <span className="text-[10px] tracking-[0.4em] uppercase text-text-tertiary font-bold">
          {'// [H-01] QUOTA LEDGER'}
        </span>
        <span className="font-mono text-[10px] text-text-tertiary tabular-nums">
          {statusTxt}
        </span>
      </div>
      {row(
        'POG QUOTA · PER WINDOW',
        blocked === 'unattested' ? '—' : `${fmt(quota)} ETH`,
      )}
      {row('SPENT THIS WINDOW',      stale ? '—' : `${fmt(spent)} ETH`)}
      {row('REMAINING',              stale ? '—' : `${fmt(remaining)} ETH`)}
      {!stale && projected > 0n && (
        row(
          'PROJECTED (THIS TX)',
          <>
            +{fmt(projected)} ETH{' '}
            <span className="text-text-quiet">→ {projConsumed.toFixed(1)}%</span>
          </>
        )
      )}
      <div className="pt-2">
        {breached
          ? (
            <p className="font-mono text-[10px] tracking-[0.4em] uppercase text-brand">
              → H-01_BREACH: INTERCEPTED
            </p>
          )
          : (
            <p className="font-mono text-[10px] tracking-[0.4em] uppercase text-text-tertiary">
              → H-01_GUARD: ACTIVE
            </p>
          )}
      </div>
    </div>
  )
}
