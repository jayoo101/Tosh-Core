'use client'

const STEPS = [
  {
    step: '01', tag: 'DEFENSE', tagColor: 'text-success',
    title: 'PoG Gas-Gated Quota',
    description: 'Proof-of-Gas attestation binds wallet gas history to an ETH genesis headroom. Oracle-signed registerPoG() — no bots, no Sybil mints.',
    chassis: 'bg-gradient-to-br from-surface-card via-bg-base to-surface-card border-border-strong/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_4px_24px_rgba(0,0,0,0.5)] hover:border-success/50',
    ledStrip: 'bg-gradient-to-r from-transparent via-success/60 to-transparent',
    led: 'bg-success shadow-[0_0_6px_rgba(52,211,153,0.8)]',
    glow: '#10b981',
  },
  {
    step: '02', tag: 'FACTORY', tagColor: 'text-brand',
    title: 'Hook-Anchored Launch',
    description: 'Permissionless ERC-20 + ToshLaunchpadHook via CREATE2 salt mining. Pay native ETH launch fee — zero pre-mine, 55/45 genesis split at P₀: 4.62M claimable by depositors, 3.78M locked as LP.',
    chassis: 'bg-surface-card border-brand/20 shadow-[inset_0_1px_0_rgba(0,255,163,0.06),0_4px_24px_rgba(0,0,0,0.5)] hover:border-brand/40',
    ledStrip: 'bg-gradient-to-r from-transparent via-brand/60 to-transparent',
    led: 'bg-brand shadow-[0_0_6px_rgba(0,255,163,0.8)]',
    glow: '#00FFA3',
  },
  {
    step: '03', tag: 'GENESIS', tagColor: 'text-warning',
    title: 'Genesis Deposit Window',
    description: 'Phase-1 ETH deposits with PoG quota (H-01), over a 3h / 24h / 72h window the creator picks at launch. Deposits stay open for the whole window. Window closes with the cap met → creator calls launch(). Missed cap or 7d zombie window → refund() unlocks.',
    chassis: 'bg-gradient-to-br from-bg-base via-bg-subtle to-bg-base border-warning/25 hover:border-warning/40',
    ledStrip: 'bg-gradient-to-r from-transparent via-warning/60 to-transparent',
    led: 'bg-warning shadow-[0_0_6px_rgba(251,191,36,0.8)]',
    glow: '#f59e0b',
  },
  {
    step: '04', tag: 'CURVE', tagColor: 'text-admin',
    title: '4000-Rung Shelf Ladder',
    description: 'Phase-2 discrete 4000-shelf ladder spanning 2000× from the open (getTiers / tierPriceAt), with a 105% anti-spike gate: min(spot, TWAP) once the window matures, min(spot, p0) until then. claimGenesis() for depositors; 99% of shelf proceeds to the project admin.',
    chassis: 'bg-bg-base border-admin/25 hover:border-admin/40',
    ledStrip: 'bg-gradient-to-r from-transparent via-admin/60 to-transparent',
    led: 'bg-admin shadow-[0_0_6px_rgba(192,132,252,0.8)]',
    glow: '#a855f7',
  },
  {
    step: '05', tag: 'AUDIT', tagColor: 'text-success',
    title: 'Audit-Cliff Hardened',
    description: 'H-01 PoG ledger, M-01 soft-cap floor (≥0.01 ETH), L-01 dust gate — enforced on-chain and mirrored in the client terminal.',
    chassis: 'bg-gradient-to-br from-bg-subtle via-bg-base to-bg-subtle border-success/25 hover:border-success/40',
    ledStrip: 'bg-gradient-to-r from-transparent via-success/60 to-transparent',
    led: 'bg-success shadow-[0_0_6px_rgba(163,230,53,0.8)]',
    glow: '#84cc16',
  },
] as const

export function TrustPipeline() {
  return (
    <section className="relative z-10 pt-28 md:pt-36 pb-12 md:pb-16 overflow-hidden">
      <div className="mb-16 md:mb-20">
        <h3 className="text-label font-mono text-text-quiet uppercase mb-4">
          {`// PROTOCOL_WORKFLOW`}
        </h3>
        <h2 className="text-3xl md:text-5xl font-medium text-text-primary tracking-tight leading-tight">
          The Trust Pipeline.
        </h2>
      </div>

      <div className="hidden md:block">
        <div className="grid grid-cols-5 gap-0">
          {STEPS.map((s, i) => (
            <div key={s.step} className="relative group flex flex-col items-center">
              {i < 4 && (
                <div className="absolute top-[130px] left-1/2 w-full h-[6px] z-0 flex flex-col justify-center gap-[2px] pointer-events-none">
                  <div className="h-px cable-flow bg-gradient-to-r from-surface-hover via-surface-hover/40 to-surface-hover" />
                  <div className="h-0.5 bg-surface-elevated/80" />
                </div>
              )}
              <div className={`relative w-full mx-2 rounded-panel border overflow-hidden transition-all duration-500 md:min-h-[320px] flex flex-col ${s.chassis} group-hover:scale-[1.01]`}>
                <div className={`h-1 w-full ${s.ledStrip}`} />
                <div className="absolute top-4 right-4 flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-pill ${s.led} led-breathe`} />
                  <span className="text-micro font-mono text-text-quiet uppercase">Active</span>
                </div>
                <div className="flex-1 flex flex-col p-6 pt-8">
                  <div className="flex items-center gap-2 mb-5">
                    <span className="text-micro font-mono text-text-tertiary bg-bg-base/60 border border-border-subtle px-2 py-0.5 rounded">STEP {s.step}</span>
                    <span className="text-micro font-mono text-text-quiet">|</span>
                    <span className={`text-micro font-mono font-bold ${s.tagColor}`}>{s.tag}</span>
                  </div>
                  <h4 className="text-title text-text-primary mb-3 group-hover:text-text-primary transition-colors">{s.title}</h4>
                  <p className="text-body text-text-secondary leading-relaxed mt-auto">{s.description}</p>
                </div>
                <div className="h-px mx-4 mb-3 bg-gradient-to-r from-transparent via-surface-elevated to-transparent" />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="md:hidden space-y-8 pl-4 pr-2">
        {STEPS.map(s => (
          <div key={s.step} className={`rounded-card border overflow-hidden ${s.chassis}`}>
            <div className={`h-0.5 w-full ${s.ledStrip}`} />
            <div className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-micro font-mono text-text-tertiary bg-bg-base/60 border border-border-subtle px-2 py-0.5 rounded">STEP {s.step}</span>
                <span className={`text-micro font-mono font-bold ${s.tagColor}`}>{s.tag}</span>
              </div>
              <h4 className="text-title text-text-primary mb-2">{s.title}</h4>
              <p className="text-body text-text-secondary leading-relaxed">{s.description}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
