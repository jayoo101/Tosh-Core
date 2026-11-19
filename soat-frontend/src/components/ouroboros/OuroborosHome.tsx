'use client'

import Link from 'next/link'
import { ArrowRight, ShieldCheck } from 'lucide-react'

import { Badge } from '@/components/ui'
import { ACTIVE_CHAIN_LABEL } from '@/lib/chain'
import { OURO_ENABLED } from '@/lib/ouroboros/config'

import { useOuroCopy } from './copy'
import { OuroborosMark } from './OuroborosMark'
import { Countdown } from './Countdown'
import { useOuroState } from './useOuro'

/** The home page: Ouroboros first. The live phase and countdown need the contracts configured. */
export function OuroborosHome() {
  const c = useOuroCopy()
  const steps = [c.howAgent, c.tlL1, c.tlLaunch, c.tlL15, c.tlL2]

  return (
    <div className="flex flex-col gap-12">
      <section
        aria-labelledby="home-title"
        className="glow-frame glow-flow relative isolate overflow-hidden rounded-[1.5rem] bg-surface-card/85"
      >
        <div aria-hidden="true" className="hero-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="grid gap-8 p-6 md:p-10 lg:grid-cols-[3fr_2fr] lg:items-center lg:p-12">
          <div className="flex flex-col gap-6">
            <span className="flex w-fit items-center gap-2 rounded-pill border border-brand/40 bg-brand/10 px-3 py-1 font-mono text-label uppercase text-brand">
              <ShieldCheck className="size-3.5" aria-hidden />
              {ACTIVE_CHAIN_LABEL} · {c.homeKicker}
            </span>
            <div className="flex flex-col gap-4">
              <h1 id="home-title" className="font-mono text-4xl font-bold leading-tight tracking-tight text-text-primary md:text-5xl">
                {c.title}
              </h1>
              <p className="max-w-xl text-pretty text-lede text-text-tertiary">{c.homeLede}</p>
            </div>
            {OURO_ENABLED && <LivePhase />}
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/ouroboros"
                className="flex items-center gap-2 rounded-pill bg-brand px-6 py-3 font-bold text-bg-base transition-opacity hover:opacity-90"
              >
                {c.homeCta}
                <ArrowRight className="size-4" aria-hidden />
              </Link>
              <Link
                href="/ouroboros/partners"
                className="flex items-center gap-2 rounded-pill border border-border-subtle px-6 py-3 font-bold text-text-primary transition-colors hover:border-brand hover:text-brand"
              >
                {c.homePartners}
              </Link>
            </div>
          </div>
          <div className="flex justify-center">
            <OuroborosMark className="w-full max-w-[280px] text-brand drop-shadow-[0_0_40px_var(--tosh-brand)]" />
          </div>
        </div>
        <dl className="grid grid-cols-2 border-t border-border-subtle md:grid-cols-4">
          {c.facts.map(([k, v], i) => (
            <div
              key={k}
              className={`flex flex-col gap-1 border-border-subtle p-6 md:px-10 ${i % 2 ? 'border-l' : ''} ${i >= 2 ? 'border-t md:border-t-0' : ''} ${i === 2 ? 'md:border-l' : ''}`}
            >
              <dt className="text-note text-text-tertiary">{k}</dt>
              <dd className="font-mono text-xl font-bold text-text-primary">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="home-how" className="flex flex-col gap-4">
        <h2 id="home-how" className="text-section font-bold text-brand">{c.howTitle}</h2>
        <ol className="grid gap-3 md:grid-cols-5">
          {steps.map((text, i) => (
            <li key={text} className="flex flex-col gap-2 rounded-card border border-border-subtle bg-surface-card/60 p-4">
              <span className="font-mono text-label text-brand">{String(i + 1).padStart(2, '0')}</span>
              <span className="text-note text-text-secondary">{text}</span>
            </li>
          ))}
        </ol>
        <p className="text-note text-text-tertiary">{c.howMintNote}</p>
      </section>

      <section aria-labelledby="home-trust" className="flex flex-col gap-4">
        <h2 id="home-trust" className="text-section font-bold text-brand">{c.trustTitle}</h2>
        <ul className="grid gap-3 md:grid-cols-3">
          {c.trust.map(text => (
            <li key={text} className="rounded-card border border-border-subtle bg-surface-card/60 p-4 text-note text-text-secondary">
              {text}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function LivePhase() {
  const c = useOuroCopy()
  const { state } = useOuroState()
  const p = state.phase
  if (!p) return null
  return (
    <div className="flex flex-col items-start gap-3">
      <Badge tone={p === 'Failed' ? 'danger' : 'info'} pip live={p === 'L1' || p === 'L2'}>{c.phase[p]}</Badge>
      <Countdown state={state} />
    </div>
  )
}
