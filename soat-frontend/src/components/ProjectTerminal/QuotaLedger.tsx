import type * as React from 'react'

import { fmtQuote } from './format'
import { QUOTE_SYMBOL } from '@/lib/contracts'

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
//     → WITHIN YOUR LIMIT
//
// On actual breach (a parsed input that exceeds the remaining window budget)
// the guard line flips to:
//
//     → OVER YOUR LIMIT FOR THIS WINDOW
//
// and the DEPOSIT button locks (handled in the GenesisPanel).
//
// ⚠ AND THERE IS A THIRD STATE, which this ledger used to render as the first
//   one. When `blocked` is set, every figure here is an em-dash — quota, spent,
//   remaining, all unreadable — and the footer still printed
//   `→ WITHIN YOUR LIMIT` underneath them, because it was the `else` of a
//   two-way branch on `breached` and `breached` is forced false while stale.
//
//   So the panel's most reassuring sentence was reserved for precisely the case
//   where it knew nothing: a wallet with no attestation got four dashes and a
//   clean bill of health. "I cannot read this" and "you are fine" are not the
//   same answer, and collapsing them is what let a permanently ineligible
//   wallet believe it was one keystroke from depositing.
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

  // Why there is no limit to be within, said once per reason. Each names the
  // fact that is standing in for the figures, so the dashes above have an
  // explanation sitting under them instead of a reassurance.
  const staleTxt = blocked === 'cooldown'
      ? '→ NOT READABLE UNTIL THE COOLDOWN CLEARS'
    : blocked === 'banned'
      ? '→ THE BAN DECIDES THIS · THE LIMIT IS NOT WHAT STOPS YOU'
    : blocked === 'unattested'
      ? '→ NO QUOTA REGISTERED · THERE IS NO LIMIT TO MEASURE YET'
    : null

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between border-b border-border-subtle/60 py-1.5">
      <span className="font-mono text-label text-text-tertiary">{label}</span>
      <span className="font-mono text-note text-text-primary tabular-nums break-all text-right">
        {value}
      </span>
    </div>
  )

  return (
    <div className="border border-border-subtle px-4 py-3 flex flex-col gap-1">
      <div className="flex items-center justify-between pb-1">
        <span className="text-label tracking-[0.4em] uppercase text-text-tertiary font-bold">
          {'// [H-01] QUOTA LEDGER'}
        </span>
        <span className="font-mono text-label text-text-tertiary tabular-nums">
          {statusTxt}
        </span>
      </div>
      {row(
        'POG QUOTA · PER WINDOW',
        blocked === 'unattested' ? '—' : `${fmtQuote(quota)} ${QUOTE_SYMBOL}`,
      )}
      {row('SPENT THIS WINDOW',      stale ? '—' : `${fmtQuote(spent)} ${QUOTE_SYMBOL}`)}
      {row('REMAINING',              stale ? '—' : `${fmtQuote(remaining)} ${QUOTE_SYMBOL}`)}
      {!stale && projected > 0n && (
        row(
          'PROJECTED (THIS TX)',
          <>
            +{fmtQuote(projected)} {QUOTE_SYMBOL}{' '}
            <span className="text-text-quiet">→ {projConsumed.toFixed(1)}%</span>
          </>
        )
      )}
      <div className="pt-2">
        {/* A breach locks the deposit button, so it is a blocked action the
            reader can still fix by typing less — `warning`, not `danger`, and
            certainly not `brand`, which is the colour of the button they are
            being stopped from pressing. */}
        {breached
          ? (
            <p className="font-mono text-label tracking-[0.4em] uppercase text-warning">
              → OVER YOUR LIMIT FOR THIS WINDOW
            </p>
          )
          : stale
            ? (
              // `text-quiet`, not `tertiary`: this is the absence of a verdict,
              // and it must not carry the same weight as the two that are.
              <p className="font-mono text-label tracking-[0.4em] uppercase text-text-quiet">
                {staleTxt}
              </p>
            )
            : (
              <p className="font-mono text-label tracking-[0.4em] uppercase text-text-tertiary">
                → WITHIN YOUR LIMIT
              </p>
            )}
      </div>
    </div>
  )
}
