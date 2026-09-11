'use client'

import dynamic from 'next/dynamic'

// ssr: false, and not optional: the marquee is driven by `useWatchContractEvent`
// over a wagmi WebSocket and a rAF ring buffer, so hydrating its animated DOM
// produces removeChild errors.
const TxFeedMarquee = dynamic(
  () => import('../TxFeedMarquee').then(m => ({ default: m.TxFeedMarquee })),
  {
    ssr: false,
    loading: () => (
      <div className="overflow-hidden rounded-card border border-border-subtle bg-bg-base/50"
           style={{ minHeight: '2rem' }} />
    ),
  },
)

/**
 * The live factory-event ticker, full width, directly under the hero.
 *
 * IT LIVED INSIDE THE HERO PANEL FIRST, and that is worth recording because the
 * panel is where it belongs conceptually. At the panel's 24rem the marquee shows
 * one pill at a time, and a ticker narrow enough to hold a single item is a
 * ticker you cannot read - the pills are `[ TYPE ] // payload` strings and some
 * of them are longer than the panel. Full width fits three or four, which is
 * what makes the movement legible rather than just present.
 *
 * The panel above therefore lists launches and this reports events. They are
 * captioned differently for that reason: the redesign labels its launch list
 * "ON-CHAIN FEED", which a list of launches is not.
 */
export function EventTickerStrip() {
  return (
    <div className="border-y border-border-subtle/40">
      <div className="flex items-center gap-3 px-1 py-2.5">
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="dot-breathe h-1.5 w-1.5 rounded-pill bg-brand text-brand shadow-[0_0_6px_var(--tosh-brand-glow)]" />
          <span className="font-mono text-micro uppercase text-text-tertiary">Factory events</span>
        </span>
        <span className="hidden font-mono text-micro text-text-quiet sm:inline">
          Launch · PoG · GenesisDeposit
        </span>
      </div>
      <TxFeedMarquee compact />
    </div>
  )
}
