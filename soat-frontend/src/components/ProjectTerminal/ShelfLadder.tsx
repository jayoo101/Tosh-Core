'use client'
import { useReadContract } from 'wagmi'
import type { Address } from 'viem'

import { HOOK_ABI, TIER_COUNT, TIER_SIZE, TWAP_WINDOW_LABEL } from '@/lib/contracts'
import { fmt } from './format'
import { Readout, ProgressBar } from './primitives'

// ─────────────────────────────────────────────────────────────────────────────
// SHELF LADDER  ·  4000 discrete rungs, 105 % price gate
// ─────────────────────────────────────────────────────────────────────────────

export type TierRow = { price: bigint; totalAmount: bigint; soldAmount: bigint }

export function ShelfLadder({
  hookAddress, p0, halted,
}: {
  hookAddress: Address
  p0:          bigint
  /// The protocol circuit breaker, lifted from the panel that already reads it
  /// rather than polled a second time here.  It is orthogonal to the 105% price
  /// gate — the gate can be wide open while the hook refuses every mint — so it
  /// gets its own badge state instead of being folded into `unlocked`.
  halted:      boolean
}) {
  const { data: statusRaw } = useReadContract({
    address:      hookAddress,
    abi:          HOOK_ABI,
    functionName: 'tierStatus',
    query:        { refetchInterval: 8_000 },
  })
  const status = statusRaw as
    | readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean]
    | undefined

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
    <div className="border border-[#1F1F2E]">
      <div className="flex items-baseline justify-between px-4 py-2 border-b border-[#1F1F2E]">
        <span className="text-[10px] tracking-[0.4em] uppercase text-[#888] font-bold">
          {'// DISCRETE SHELF LADDER · 4000 RUNGS · 2000× SPAN'}
        </span>
        <span className={`font-mono text-[10px] tabular-nums
                          ${halted ? 'text-tosh-rust' : 'text-[#666]'}`}>
          {halted
            ? 'LADDER HALTED · BREAKER'
            : unlocked ? 'GATE OPEN' : 'GATE LOCKED · 105%'}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 px-4 py-3">
        <Readout label="ACTIVE SHELF" value={`#${tierIndex.toString()} / ${TIER_COUNT}`} />
        <Readout label="SHELF PRICE"  value={`${fmt(tierPrice)} ETH`} hint="per whole token" />
        <Readout label="REMAINING"    value={fmt(remaining)} hint="tokens on this rung" />
        <Readout
          label="105% CEILING"
          value={`${fmt(ceiling)} ETH`}
          hint={unlocked ? 'min(spot, twap) · unlocked' : 'wait for spot/TWAP'}
          tone={unlocked ? 'fluo' : 'mute'}
        />
      </div>

      <div className="px-4 pb-3">
        <ProgressBar
          pct={fillPct}
          label={`SHELF #${tierIndex.toString()} FILL`}
          totalLabel={`${fmt(TIER_SIZE - remaining)} / ${fmt(TIER_SIZE)}`}
        />
      </div>

      <div className="border-t border-[#1F1F2E] divide-y divide-[#1F1F2E]/60">
        {window.map((t, i) => {
          const idx = windowStart + BigInt(i)
          const active = idx === tierIndex
          const soldPct = t.totalAmount > 0n
            ? Number((t.soldAmount * 10_000n) / t.totalAmount) / 100
            : 0
          return (
            <div
              key={idx.toString()}
              className={`grid grid-cols-[4rem_1fr_6rem_5rem] gap-3 px-4 py-1.5 font-mono text-[11px] tabular-nums
                          ${active ? 'text-white bg-white/[0.03]' : 'text-[#888]'}`}
            >
              <span>#{idx.toString()}</span>
              <span>{fmt(t.price)} ETH</span>
              <span>{soldPct.toFixed(1)}%</span>
              <span className="text-right">{active ? 'LIVE' : idx < tierIndex ? 'CLEARED' : 'QUEUED'}</span>
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-[#1F1F2E]
                      font-mono text-[10px] text-[#666] tabular-nums">
        <span>P₀ = <span className="text-white">{fmt(p0)} ETH</span></span>
        <span>spot = <span className="text-white">{fmt(spotPrice)}</span></span>
        {/* A zero TWAP is the hook's "no full window yet" signal, not a price of
            zero — the ceiling caps against P₀ until the window matures. */}
        <span>
          twap ={' '}
          {twapPrice > 0n
            ? <span className="text-white">{fmt(twapPrice)}</span>
            : <span className="text-[#888]">MATURING · {TWAP_WINDOW_LABEL} WINDOW · CEILING ON P₀</span>}
        </span>
      </div>
    </div>
  )
}
