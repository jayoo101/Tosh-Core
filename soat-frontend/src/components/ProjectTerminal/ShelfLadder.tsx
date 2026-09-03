'use client'
import { useReadContract } from 'wagmi'
import type { Address } from 'viem'

import { HOOK_ABI, TIER_COUNT, TIER_SIZE, TWAP_WINDOW_LABEL } from '@/lib/contracts'
import { Readout, Progress } from '@/components/ui'
import { fmt } from './format'

// ─────────────────────────────────────────────────────────────────────────────
// SHELF LADDER  ·  4000 discrete rungs, 105 % price gate
// ─────────────────────────────────────────────────────────────────────────────

export type TierRow = { price: bigint; totalAmount: bigint; soldAmount: bigint }

export type TierStatus =
  readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean]

export function ShelfLadder({
  hookAddress, p0, halted, status,
}: {
  hookAddress: Address
  p0:          bigint
  /// The protocol circuit breaker, lifted from the panel that already reads it
  /// rather than polled a second time here.  It is orthogonal to the 105% price
  /// gate — the gate can be wide open while the hook refuses every mint — so it
  /// gets its own badge state instead of being folded into `unlocked`.
  halted:      boolean
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

  const windowStart = tierIndex > 2n ? tierIndex - 2n : 0n
  const { data: windowRaw } = useReadContract({
    address:      hookAddress,
    abi:          HOOK_ABI,
    functionName: 'getTiers',
    args:         [windowStart, 5n],
    query:        { refetchInterval: 8_000 },
  })
  const window = (windowRaw as readonly TierRow[] | undefined) ?? []

  const fillPct = TIER_SIZE > 0n
    ? Number(((TIER_SIZE - remaining) * 10_000n) / TIER_SIZE) / 100
    : 0

  return (
    <div className="border border-border-subtle">
      {/* Wraps rather than squeezing: at 390px the title and the gate status
          were sharing one line and interleaving into
          "DISCRETE SHELF LADDER GATE / 4000 RUNGS OPEN". */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border-subtle px-4 py-2">
        <span className="text-label uppercase text-text-tertiary">
          {'// SHELF LADDER · 4,000 SHELVES · 2,000× SPAN'}
        </span>
        <span className={`font-mono text-label whitespace-nowrap tabular-nums
                          ${halted ? 'text-danger' : 'text-text-tertiary'}`}>
          {halted
            ? 'LADDER HALTED · BREAKER'
            : unlocked ? 'GATE OPEN' : 'GATE LOCKED · 105%'}
        </span>
      </div>

      {/* `stack`, not the default `row`. Four cells across an already-narrow
          card leaves roughly 90px each, and a label pinned left with a price
          pinned right cannot share that — the price ends up breaking at the
          hyphen in its own exponent. Stacked, the label gets its own line and
          the figure gets the full cell width. */}
      <div className="grid grid-cols-2 @lg:grid-cols-4 gap-4 px-4 py-3">
        <Readout layout="stack" label="ACTIVE SHELF" value={`#${tierIndex.toString()} / ${TIER_COUNT}`} />
        <Readout layout="stack" label="SHELF PRICE"  value={`${fmt(tierPrice)} ETH`} hint="per whole token" />
        <Readout layout="stack" label="REMAINING"    value={fmt(remaining)} hint="tokens on this rung" />
        <Readout
          layout="stack"
          label="105% CEILING"
          value={`${fmt(ceiling)} ETH`}
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
              <span>{fmt(t.price)} ETH</span>
              <span>{soldPct.toFixed(1)}%</span>
              <span className="text-right">{active ? 'LIVE' : idx < tierIndex ? 'CLEARED' : 'QUEUED'}</span>
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-border-subtle
                      font-mono text-label text-text-tertiary tabular-nums">
        <span>opening = <span className="text-text-primary">{fmt(p0)} ETH</span></span>
        <span>now = <span className="text-text-primary">{fmt(spotPrice)}</span></span>
        {/* A zero average is the contract's "no full window yet" signal, not a
            price of zero — the ceiling caps against the opening price until the
            window matures, which is what the fallback text has to say. */}
        <span>
          average ={' '}
          {twapPrice > 0n
            ? <span className="text-text-primary">{fmt(twapPrice)}</span>
            : <span className="text-text-tertiary">SETTLING · {TWAP_WINDOW_LABEL} WINDOW · CEILING HELD AT OPENING</span>}
        </span>
      </div>
    </div>
  )
}
