'use client'

import dynamic from 'next/dynamic'

// ssr: false — TxFeedMarquee uses useWatchContractEvent (wagmi WebSocket) and
// a requestAnimationFrame-driven ring buffer. Bypassing SSR means React never
// tries to hydrate the marquee's animated DOM, preventing removeChild errors.
const TxFeedMarquee = dynamic(
  () => import('../TxFeedMarquee').then(m => ({ default: m.TxFeedMarquee })),
  {
    ssr: false,
    loading: () => (
      <div className="border-zinc-800 bg-zinc-950/50 rounded-lg border overflow-hidden"
           style={{ minHeight: '2rem' }} />
    ),
  },
)

/** Live on-chain activity ticker — factory LaunchCreated / PoGRegistered / GenesisDeposit. */
export function A2AFeed() {
  return (
    <div className="border-b border-zinc-800/40">
      <div className="flex items-center gap-3 py-2.5 px-1">
        <span className="flex items-center gap-1.5 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-tosh-fluo dot-breathe shadow-[0_0_6px_rgba(0,255,163,0.5)]" />
          <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest">On-Chain Feed</span>
        </span>
        <span className="text-[9px] font-mono text-zinc-700 hidden sm:inline">
          Launch · PoG · GenesisDeposit
        </span>
      </div>
      <TxFeedMarquee compact />
    </div>
  )
}
