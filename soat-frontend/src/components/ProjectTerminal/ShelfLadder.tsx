'use client'
import { useReadContract } from 'wagmi'
import type { Address } from 'viem'

// No `TIER_COUNT`: the `#0 / 4,000` readout that needed it is gone, and the
// shelf count is stated by the curve section's header and the page title.
import { HOOK_ABI, TIER_SIZE, TWAP_WINDOW_LABEL } from '@/lib/contracts'
import { Readout, Progress } from '@/components/ui'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { fmt, fmtQuote } from './format'

// ─────────────────────────────────────────────────────────────────────────────
// SHELF LADDER  ·  4000 discrete rungs, 105 % price gate
// ─────────────────────────────────────────────────────────────────────────────

export type TierRow = { price: bigint; totalAmount: bigint; soldAmount: bigint }

export type TierStatus =
  readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean]

/**
 * Every state the 105% gate can be in, as one line.
 *
 * THIS USED TO BE TWO GATES. `BondingLadderSection` carried a `105% gate` cell
 * with five states, and this strip carried three of them — same card, one
 * table apart, and the strip was the poorer of the two: it had no props for
 * the same-block lock or the pre-market wait, so a hook that was refusing
 * mints for either reason read `GATE LOCKED · 105%` up here and `same-block
 * lock` down there. Two renderings of one machine will disagree eventually;
 * the fix is one rendering, and it has to be the complete one.
 *
 * Ordered by precedence, not severity: the breaker overrides the gate
 * entirely, and the same-block lock is checked before the price gate because
 * the hook rejects on it regardless of where the ceiling sits.
 */
function gateLine(s: {
  halted: boolean
  sameBlockLock: boolean
  awaitingFirstUnlock: boolean
  unlocked: boolean
}): { text: string; cls: string } {
  if (s.halted)              return { text: 'LADDER HALTED · BREAKER',   cls: 'text-danger'         }
  if (s.sameBlockLock)       return { text: '105% GATE · SAME-BLOCK LOCK', cls: 'text-warn'         }
  if (s.awaitingFirstUnlock) return { text: '105% GATE · AWAITING MARKET', cls: 'text-text-tertiary' }
  if (s.unlocked)            return { text: '105% GATE · OPEN',          cls: 'text-ok'             }
  return { text: '105% GATE · LOCKED', cls: 'text-warn' }
}

export function ShelfLadder({
  hookAddress, p0, halted, sameBlockLock, awaitingFirstUnlock, status,
}: {
  hookAddress: Address
  p0:          bigint
  /// The protocol circuit breaker, lifted from the panel that already reads it
  /// rather than polled a second time here.  It is orthogonal to the 105% price
  /// gate — the gate can be wide open while the hook refuses every mint — so it
  /// takes precedence in `gateLine` instead of being folded into `unlocked`.
  halted:      boolean
  /// The two gate states this component could not express before, and the
  /// reason the panel's duplicate cell existed. Both come from the same
  /// provider `halted` does, so none of them is an extra read.
  sameBlockLock:       boolean
  awaitingFirstUnlock: boolean
  /// Also lifted rather than re-read. This component and BondingPanel were
  /// polling the same `tierStatus` on the same 8s cadence, so every bonding
  /// page ran the call twice and could render the two copies a beat apart.
  status:      TierStatus | undefined
}) {
  const tierIndex = status?.[0] ?? 0n
  const tierPrice = status?.[1] ?? 0n
  const remaining = status?.[2] ?? 0n
  const spotPrice = status?.[3] ?? 0n
  const twapPrice = status?.[4] ?? 0n
  const ceiling   = status?.[5] ?? 0n
  const unlocked  = status?.[6] ?? false

  /**
   * THREE ROWS, NOT FIVE: the one that just cleared, the live one, the next.
   *
   * Five meant two cleared and two queued, and on a 2,000×-over-4,000-shelves
   * ladder the extra pair says nothing — adjacent rungs differ by 0.19%, so
   * `#3 2.51e-9 QUEUED` under `#2 2.51e-9 QUEUED` is the same number twice with
   * a different index. The whole point of this table is succession: what is
   * behind, what is live, what is next. Rows four and five were padding, and
   * they are also two more `getTiers` entries on an 8-second poll.
   *
   * The curve above is where the shape of the other 3,997 shelves lives.
   */
  const windowStart = tierIndex > 0n ? tierIndex - 1n : 0n
  const { data: windowRaw } = useReadContract({
    address:      hookAddress,
    abi:          HOOK_ABI,
    functionName: 'getTiers',
    args:         [windowStart, 3n],
    query:        { refetchInterval: 8_000 },
  })
  const window = (windowRaw as readonly TierRow[] | undefined) ?? []

  const gate = gateLine({ halted, sameBlockLock, awaitingFirstUnlock, unlocked })

  const fillPct = TIER_SIZE > 0n
    ? Number(((TIER_SIZE - remaining) * 10_000n) / TIER_SIZE) / 100
    : 0

  return (
    <div className="border border-border-subtle">
      {/* THE TITLE IS GONE FROM THIS STRIP, leaving the gate alone on it.
          It read `// SHELF LADDER · 4,000 SHELVES · 2,000× SPAN`, which was
          the third copy of that sentence within one screen: the `Card` this
          sits inside is titled `SHELF LADDER · <symbol>`, and the curve
          section directly above is headed `// <symbol> shelf ladder · 4,000
          shelves · 2,000× span`. The gate state is the one thing here that is
          neither in the card title nor on the curve, so it is what the strip
          is for now. */}
      <div className="border-b border-border-subtle px-4 py-2">
        <span className={`font-mono text-label tabular-nums ${gate.cls}`}>{gate.text}</span>
      </div>

      {/* `stack`, not the default `row`. Three cells across an already-narrow
          card leaves roughly 120px each, and a label pinned left with a price
          pinned right cannot share that — the price ends up breaking at the
          hyphen in its own exponent. Stacked, the label gets its own line and
          the figure gets the full cell width.

          THREE, DOWN FROM FOUR. `ACTIVE SHELF · #0 / 4,000` came out, and it
          was the fourth statement of the live index inside this one card: the
          fill bar below is labelled `SHELF #0 FILL`, the table under it marks
          that row `LIVE`, and the page header prints `shelf #0 / 4,000` beside
          the headline price. */}
      <div className="grid grid-cols-2 @lg:grid-cols-3 gap-4 px-4 py-3">
        <Readout layout="stack" label="SHELF PRICE"  value={`${fmtQuote(tierPrice)} ${QUOTE_SYMBOL}`} hint="per whole token" />
        <Readout layout="stack" label="REMAINING"    value={fmt(remaining)} hint="tokens on this rung" />
        <Readout
          layout="stack"
          label="105% CEILING"
          value={`${fmtQuote(ceiling)} ${QUOTE_SYMBOL}`}
          hint={unlocked ? 'tracks the pool and its average' : 'held at the opening price'}
          tone={unlocked ? 'ok' : 'mute'}
        />
      </div>

      <div className="px-4 pb-3">
        <Progress
          pct={fillPct}
          label={`SHELF #${tierIndex.toString()} FILL`}
          caption={`${fmt(TIER_SIZE - remaining)} / ${fmt(TIER_SIZE)}`}
          tone="ink"
          ascii
        />
      </div>

      <div className="border-t border-border-subtle divide-y divide-border-subtle/60">
        {window.map((t, i) => {
          const idx = windowStart + BigInt(i)
          const active = idx === tierIndex
          const soldPct = t.totalAmount > 0n
            ? Number((t.soldAmount * 10_000n) / t.totalAmount) / 100
            : 0
          return (
            <div
              key={idx.toString()}
              className={`grid grid-cols-[4rem_1fr_6rem_5rem] gap-3 px-4 py-1.5 font-mono text-note tabular-nums
                          ${active ? 'text-text-primary bg-surface-hover' : 'text-text-tertiary'}`}
            >
              <span>#{idx.toString()}</span>
              <span>{fmtQuote(t.price)} {QUOTE_SYMBOL}</span>
              <span>{soldPct.toFixed(1)}%</span>
              <span className="text-right">{active ? 'LIVE' : idx < tierIndex ? 'CLEARED' : 'QUEUED'}</span>
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-border-subtle
                      font-mono text-label text-text-tertiary tabular-nums">
        <span>opening = <span className="text-text-primary">{fmtQuote(p0)} {QUOTE_SYMBOL}</span></span>
        <span>now = <span className="text-text-primary">{fmtQuote(spotPrice)}</span></span>
        {/* A zero average is the contract's "no full window yet" signal, not a
            price of zero — the ceiling caps against the opening price until the
            window matures, which is what the fallback text has to say. */}
        <span>
          average ={' '}
          {twapPrice > 0n
            ? <span className="text-text-primary">{fmtQuote(twapPrice)}</span>
            : <span className="text-text-tertiary">SETTLING · {TWAP_WINDOW_LABEL} WINDOW · CEILING HELD AT OPENING</span>}
        </span>
      </div>
    </div>
  )
}
