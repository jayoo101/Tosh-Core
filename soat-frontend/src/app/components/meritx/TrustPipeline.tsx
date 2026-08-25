'use client'

const STEPS = [
  {
    step: '01', tag: 'DEFENSE', tagColor: 'text-emerald-400',
    title: 'PoG Gas-Gated Quota',
    description: 'Proof-of-Gas attestation binds wallet gas history to an ETH genesis headroom. Oracle-signed registerPoG() — no bots, no Sybil mints.',
    chassis: 'bg-gradient-to-br from-zinc-900 via-zinc-950 to-zinc-900 border-zinc-700/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_4px_24px_rgba(0,0,0,0.5)] hover:border-emerald-800/50',
    ledStrip: 'bg-gradient-to-r from-transparent via-emerald-500/60 to-transparent',
    led: 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]',
    glow: '#10b981',
  },
  {
    step: '02', tag: 'FACTORY', tagColor: 'text-tosh-fluo',
    title: 'Hook-Anchored Launch',
    description: 'Permissionless ERC-20 + ToshLaunchpadHook via CREATE2 salt mining. Pay native ETH launch fee — zero pre-mine, 50/50 genesis pricing at P₀.',
    chassis: 'bg-[#0a0a0a] border-tosh-fluo/20 shadow-[inset_0_1px_0_rgba(0,255,163,0.06),0_4px_24px_rgba(0,0,0,0.5)] hover:border-tosh-fluo/40',
    ledStrip: 'bg-gradient-to-r from-transparent via-tosh-fluo/60 to-transparent',
    led: 'bg-tosh-fluo shadow-[0_0_6px_rgba(0,255,163,0.8)]',
    glow: '#00FFA3',
  },
  {
    step: '03', tag: 'GENESIS', tagColor: 'text-amber-400',
    title: 'Genesis Deposit Window',
    description: 'Phase-1 ETH deposits with PoG quota (H-01), over a 3h / 24h / 72h window the creator picks at launch. Deposits stay open for the whole window. Window closes with the cap met → creator calls launch(). Missed cap or 7d zombie window → refund() unlocks.',
    chassis: 'bg-gradient-to-br from-zinc-950 via-[#0d0a07] to-zinc-950 border-amber-900/25 hover:border-amber-700/40',
    ledStrip: 'bg-gradient-to-r from-transparent via-amber-500/60 to-transparent',
    led: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]',
    glow: '#f59e0b',
  },
  {
    step: '04', tag: 'CURVE', tagColor: 'text-purple-400',
    title: '4000-Rung Shelf Ladder',
    description: 'Phase-2 discrete 4000-shelf ladder spanning 2000× from the open (getTiers / tierPriceAt), with a 105% anti-spike gate: min(spot, TWAP) once the window matures, min(spot, p0) until then. claimGenesis() for depositors; 99% of shelf proceeds to the project admin.',
    chassis: 'bg-zinc-950 border-purple-900/25 hover:border-purple-700/40',
    ledStrip: 'bg-gradient-to-r from-transparent via-purple-500/60 to-transparent',
    led: 'bg-purple-400 shadow-[0_0_6px_rgba(192,132,252,0.8)]',
    glow: '#a855f7',
  },
  {
    step: '05', tag: 'AUDIT', tagColor: 'text-lime-400',
    title: 'Audit-Cliff Hardened',
    description: 'H-01 PoG ledger, M-01 soft-cap floor (≥0.01 ETH), L-01 dust gate — enforced on-chain and mirrored in the client terminal.',
    chassis: 'bg-gradient-to-br from-[#070a05] via-zinc-950 to-[#070a05] border-lime-900/25 hover:border-lime-700/40',
    ledStrip: 'bg-gradient-to-r from-transparent via-lime-500/60 to-transparent',
    led: 'bg-lime-400 shadow-[0_0_6px_rgba(163,230,53,0.8)]',
    glow: '#84cc16',
  },
] as const

export function TrustPipeline() {
  return (
    <section className="relative z-10 pt-28 md:pt-36 pb-12 md:pb-16 overflow-hidden">
      <div className="mb-16 md:mb-20">
        <h3 className="text-xs font-mono text-zinc-600 tracking-widest uppercase mb-4">
          {`// PROTOCOL_WORKFLOW`}
        </h3>
        <h2 className="text-3xl md:text-5xl font-medium text-zinc-100 tracking-tight leading-tight">
          The Trust Pipeline.
        </h2>
      </div>

      <div className="hidden md:block">
        <div className="grid grid-cols-5 gap-0">
          {STEPS.map((s, i) => (
            <div key={s.step} className="relative group flex flex-col items-center">
              {i < 4 && (
                <div className="absolute top-[130px] left-1/2 w-full h-[6px] z-0 flex flex-col justify-center gap-[2px] pointer-events-none">
                  <div className="h-px cable-flow bg-gradient-to-r from-zinc-700 via-zinc-600/40 to-zinc-700" />
                  <div className="h-0.5 bg-zinc-800/80" />
                </div>
              )}
              <div className={`relative w-full mx-2 rounded-2xl border overflow-hidden transition-all duration-500 md:min-h-[320px] flex flex-col ${s.chassis} group-hover:scale-[1.01]`}>
                <div className={`h-1 w-full ${s.ledStrip}`} />
                <div className="absolute top-4 right-4 flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${s.led} led-breathe`} />
                  <span className="text-[7px] font-mono text-zinc-600 uppercase">Active</span>
                </div>
                <div className="flex-1 flex flex-col p-6 pt-8">
                  <div className="flex items-center gap-2 mb-5">
                    <span className="text-[9px] font-mono text-zinc-500 bg-black/60 border border-zinc-800 px-2 py-0.5 rounded">STEP {s.step}</span>
                    <span className="text-[9px] font-mono text-zinc-700">|</span>
                    <span className={`text-[9px] font-mono font-bold ${s.tagColor}`}>{s.tag}</span>
                  </div>
                  <h4 className="text-lg font-bold text-zinc-100 mb-3 tracking-tight group-hover:text-white transition-colors">{s.title}</h4>
                  <p className="text-[12px] text-zinc-400 leading-relaxed mt-auto">{s.description}</p>
                </div>
                <div className="h-px mx-4 mb-3 bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="md:hidden space-y-8 pl-4 pr-2">
        {STEPS.map(s => (
          <div key={s.step} className={`rounded-xl border overflow-hidden ${s.chassis}`}>
            <div className={`h-0.5 w-full ${s.ledStrip}`} />
            <div className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[9px] font-mono text-zinc-500 bg-black/60 border border-zinc-800 px-2 py-0.5 rounded">STEP {s.step}</span>
                <span className={`text-[9px] font-mono font-bold ${s.tagColor}`}>{s.tag}</span>
              </div>
              <h4 className="text-base font-bold text-zinc-100 mb-2">{s.title}</h4>
              <p className="text-[12px] text-zinc-400 leading-relaxed">{s.description}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
