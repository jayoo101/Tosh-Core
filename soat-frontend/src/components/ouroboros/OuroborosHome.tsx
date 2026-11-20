'use client'

import Link from 'next/link'
import { ArrowDown, ArrowRight, Cpu, Lock, ShieldCheck, Sparkles } from 'lucide-react'

import { Badge, cn } from '@/components/ui'
import { ACTIVE_CHAIN_LABEL } from '@/lib/chain'
import { OURO_ENABLED } from '@/lib/ouroboros/config'

import { useOuroCopy } from './copy'
import { Countdown, CountdownClock } from './Countdown'
import { OuroborosOrbit } from './OuroborosMark'
import { PriceFlywheel } from './PriceFlywheel'
import { useOuroState } from './useOuro'

const L2_SCHEDULE_SEC = Math.floor(Date.UTC(2026, 10, 20, 12, 0, 0) / 1000)

export function OuroborosHome() {
  const c = useOuroCopy()

  return (
    <div className="flex flex-col gap-12 md:gap-16">
      <section
        aria-labelledby="home-title"
        className="glow-frame glow-flow relative isolate overflow-hidden rounded-panel bg-surface-card/85"
      >
        <div aria-hidden="true" className="hero-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="grid gap-10 p-6 md:p-10 lg:grid-cols-[3fr_2fr] lg:items-center">
          <div className="flex flex-col gap-6">
            <span className="flex w-fit items-center gap-2 rounded-pill border border-brand/35 bg-brand/10 px-3.5 py-1 font-mono text-label uppercase text-brand">
              <ShieldCheck className="size-3.5" aria-hidden />
              {ACTIVE_CHAIN_LABEL} · {c.homeKicker}
            </span>

            <div className="flex flex-col gap-3">
              <h1 id="home-title" className="font-mono text-hero text-text-primary">
                {c.title}
              </h1>
              <p className="max-w-xl text-pretty text-lede font-semibold text-gold-shimmer">
                {c.homeSlogan}
              </p>
              <p className="max-w-xl text-body text-text-tertiary">
                {c.homeLede}
              </p>
            </div>

            {OURO_ENABLED ? (
              <LivePhase />
            ) : (
              <CountdownClock label={c.l2In} targetSec={L2_SCHEDULE_SEC} />
            )}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Link
                href="/"
                className="ouro-cta-shine flex items-center gap-2 rounded-pill bg-brand px-6 py-3 font-mono text-body font-bold text-bg-base shadow-armed transition-all hover:bg-brand-hover"
              >
                {c.homeCta}
                <ArrowRight className="size-4" aria-hidden />
              </Link>
              <a
                href="#flywheel"
                className="flex items-center gap-2 rounded-pill border border-border-strong px-6 py-3 font-mono text-body font-medium text-text-primary transition-colors hover:border-brand hover:text-brand"
              >
                {c.homeExploreFlywheel}
                <ArrowDown className="size-4" aria-hidden />
              </a>
              <Link
                href="/rewards"
                className="px-2 py-2 text-note text-text-tertiary transition-colors hover:text-brand"
              >
                {c.homePartners}
              </Link>
            </div>
          </div>

          <div className="flex justify-center py-2">
            <OuroborosOrbit badges={c.orbitBadges} />
          </div>
        </div>

        <dl className="grid grid-cols-2 border-t border-border-subtle bg-bg-subtle/40 md:grid-cols-4">
          {c.facts.map(([k, v], i) => (
            <div
              key={k}
              className={cn(
                'flex flex-col gap-1.5 border-border-subtle px-6 py-5 md:px-8 md:py-6',
                i % 2 === 1 && 'border-l',
                i >= 2 && 'border-t md:border-t-0',
                i === 2 && 'md:border-l',
              )}
            >
              <dt className="font-mono text-label uppercase text-text-tertiary">{k}</dt>
              <dd className={cn('font-mono text-figure', i === 2 ? 'text-brand' : 'text-text-primary')}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <PriceFlywheel id="flywheel" />

      <section aria-labelledby="home-stages" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-label uppercase text-brand">{c.stagesKicker}</span>
          <h2 id="home-stages" className="text-section text-text-primary">
            {c.stagesTitle}
          </h2>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          {c.stages.map((stage, i) => {
            const isL2 = i === 2
            return (
              <article
                key={stage.id}
                className={cn(
                  'flex flex-col justify-between gap-6 rounded-panel border p-6 md:p-8 transition-colors',
                  isL2
                    ? 'glow-frame border-brand/45 bg-surface-card/90'
                    : 'border-border-subtle bg-surface-card/65 hover:border-border-strong',
                )}
              >
                <div className="flex flex-col gap-4">
                  <span className={cn(
                    'w-fit font-mono text-label uppercase',
                    isL2 ? 'text-brand' : i === 0 ? 'text-success' : 'text-info',
                  )}>
                    {stage.badge}
                  </span>

                  <div className="flex flex-col gap-2">
                    <span className={cn('font-mono text-3xl font-bold', isL2 ? 'text-brand' : 'text-text-primary')}>
                      {stage.metric}
                    </span>
                    <h3 className="text-title text-text-primary">{stage.title}</h3>
                  </div>

                  <p className="text-body text-text-secondary">{stage.highlight}</p>
                </div>

                <p className="border-t border-border-subtle pt-4 text-note text-text-tertiary">
                  {stage.points[0]}
                </p>
              </article>
            )
          })}
        </div>
      </section>

      <section aria-labelledby="home-how" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h2 id="home-how" className="text-section text-text-primary">
            {c.howTitle}
          </h2>
          <p className="text-body text-text-tertiary">{c.howSubtitle}</p>
        </div>

        <div className="grid max-w-2xl gap-5">
          {c.howPaths.map(path => (
            <div
              key={path.title}
              className="flex flex-col justify-between gap-6 rounded-panel border border-border-subtle bg-surface-card/70 p-6 md:p-8 transition-colors hover:border-brand/45"
            >
              <div className="flex flex-col gap-3">
                <span className="inline-flex w-fit items-center gap-2 font-mono text-label uppercase text-brand">
                  <Cpu className="size-4" aria-hidden />
                  {path.badge}
                </span>
                <h3 className="text-title text-text-primary">{path.title}</h3>
                <p className="text-body text-text-secondary">{path.desc}</p>
              </div>

              <Link
                href="/"
                className="inline-flex w-fit items-center gap-2 rounded-pill bg-brand px-6 py-3 font-mono text-note font-bold text-bg-base transition-colors hover:bg-brand-hover"
              >
                {path.cta}
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="home-edge" className="glow-frame relative overflow-hidden rounded-panel bg-surface-card/90 p-6 md:p-10">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="flex flex-col gap-2">
              <span className="font-mono text-label uppercase text-brand">{c.edgeKicker}</span>
              <h2 id="home-edge" className="text-section text-text-primary">{c.edgeTitle}</h2>
            </div>
            <Link
              href="/"
              className="ouro-cta-shine inline-flex w-fit shrink-0 items-center gap-2 rounded-pill bg-brand px-6 py-3 font-mono text-body font-bold text-bg-base shadow-armed transition-all hover:bg-brand-hover"
            >
              {c.edgeCta}
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>

          <div className="relative flex flex-col gap-5">
            <div className="h-2 overflow-hidden rounded-pill bg-surface-hover">
              <div className="bar-glow h-full w-full rounded-pill" />
            </div>

            <div className="grid gap-6 md:grid-cols-3">
              {c.edgeItems.map((item, idx) => (
                <div
                  key={item.tag}
                  className={cn(
                    'flex flex-col gap-1.5',
                    idx > 0 && 'md:border-l md:border-border-subtle md:pl-6',
                  )}
                >
                  <span className={cn(
                    'font-mono text-label uppercase',
                    idx === 0 ? 'text-success' : idx === 1 ? 'text-brand' : 'text-warning',
                  )}>
                    {item.tag}
                  </span>
                  <span className={cn(
                    'font-mono text-3xl font-bold',
                    idx === 1 ? 'text-brand' : idx === 2 ? 'text-warning' : 'text-text-primary',
                  )}>
                    {item.price}
                  </span>
                  <span className="text-note text-text-tertiary">{item.sub}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="home-trust" className="flex flex-col gap-6 border-t border-border-subtle pt-10">
        <h2 id="home-trust" className="text-section text-text-primary">
          {c.trustTitle}
        </h2>
        <div className="grid gap-8 md:grid-cols-3">
          {c.trustCards.map((item, i) => {
            const Icon = i === 0 ? ShieldCheck : i === 1 ? Sparkles : Lock
            return (
              <div key={item.title} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-brand">
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <h3 className="text-title text-text-primary">{item.title}</h3>
                </div>
                <p className="text-body text-text-tertiary">{item.body}</p>
              </div>
            )
          })}
        </div>
        <p className="text-micro text-text-quiet">{c.riskFooter}</p>
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
      <Badge tone={p === 'Failed' ? 'danger' : p === 'L1' || p === 'L2' ? 'ok' : 'info'} pip live={p === 'L1' || p === 'L2'}>
        {c.phase[p]}
      </Badge>
      <Countdown state={state} />
    </div>
  )
}
