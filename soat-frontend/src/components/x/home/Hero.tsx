'use client'

import Image from 'next/image'
import Link from 'next/link'
import { ArrowRight, Coins, Rocket, ShieldCheck, Wallet } from 'lucide-react'

import type { DirectoryProject } from '@/components/directory/useDirectoryProjects'
import { useNowSec } from '@/components/ui'
import { fill, useT } from '@/i18n'
import { ACTIVE_CHAIN_LABEL } from '@/lib/chain'
import { isV2Factory } from '@/lib/v2/config'
import { ProjectLink } from '../ProjectBits'

/** An editorial pin first, then the newest live v2 raise, then any live raise. */
export function pickFeatured(projects: readonly DirectoryProject[], nowMs: number): DirectoryProject | undefined {
  const live = projects.filter(p => p.tab === 'live')
  return (
    live.find(p => p.featuredUntilMs !== null && p.featuredUntilMs > nowMs) ??
    live.find(p => isV2Factory(p.factory)) ??
    live[0]
  )
}

export function Hero({ projects, counts }: {
  projects: readonly DirectoryProject[]
  counts: { live: number; launching: number; completed: number }
}) {
  const t = useT().x
  const now = useNowSec('second')
  const featured = pickFeatured(projects, now * 1000)

  const stats = [
    { label: t.heroStatLaunches, value: projects.length },
    { label: t.heroStatLive, value: counts.live },
    { label: t.heroStatLaunched, value: counts.completed },
  ]
  const steps = [
    { icon: Wallet, title: t.heroStep1, text: t.heroStep1Body },
    { icon: Coins, title: t.heroStep2, text: t.heroStep2Body },
    { icon: Rocket, title: t.heroStep3, text: t.heroStep3Body },
  ]

  return (
    <section aria-labelledby="hero-title" className="glow-frame glow-flow relative isolate overflow-hidden rounded-[1.5rem] bg-surface-card/85">
      <div aria-hidden="true" className="hero-grid pointer-events-none absolute inset-0 -z-10" />
      <div className="grid gap-8 p-6 md:p-10 lg:grid-cols-2 lg:items-center lg:gap-6 lg:p-12">
        <div className="flex flex-col gap-6">
          <span className="flex w-fit items-center gap-2 rounded-pill border border-brand/40 bg-brand/10 px-3 py-1 font-mono text-label uppercase text-brand">
            <ShieldCheck className="size-3.5" aria-hidden />
            {fill(t.heroBadge, { chain: ACTIVE_CHAIN_LABEL })}
          </span>

          <div className="flex flex-col gap-4">
            <h1 id="hero-title" className="text-balance font-mono text-4xl font-bold leading-tight tracking-tight text-text-primary md:text-5xl">
              {t.heroTitleLead} <span className="text-brand">{t.heroTitleEmph}</span>
            </h1>
            <p className="max-w-lg text-pretty text-lede text-text-tertiary">{t.heroLede}</p>
          </div>

          <dl className="flex flex-wrap gap-x-8 gap-y-4">
            {stats.map(st => (
              <div key={st.label} className="flex flex-col gap-1">
                <dt className="text-note text-text-tertiary">{st.label}</dt>
                <dd className="font-mono text-2xl font-bold text-text-primary">{st.value.toLocaleString()}</dd>
              </div>
            ))}
          </dl>

          <div className="flex flex-wrap items-center gap-3">
            {featured ? (
              <ProjectLink
                project={featured}
                className="flex items-center gap-2 rounded-pill bg-brand px-6 py-3 font-bold text-bg-base transition-opacity hover:opacity-90"
              >
                {t.heroCta}
                <ArrowRight className="size-4" aria-hidden />
              </ProjectLink>
            ) : null}
            <Link
              href="/launchpad"
              className="flex items-center gap-2 rounded-pill border border-border-subtle px-6 py-3 font-bold text-text-primary transition-colors hover:border-brand hover:text-brand"
            >
              {t.heroAll}
            </Link>
          </div>
        </div>

        <div className="relative flex justify-center">
          <Image
            src="/images/launch-mascot.png"
            alt=""
            width={642}
            height={681}
            priority
            className="w-full max-w-sm mix-blend-lighten [mask-image:radial-gradient(circle_at_center,#000_55%,transparent_72%)]"
          />
        </div>
      </div>

      <ol className="grid border-t border-border-subtle md:grid-cols-3" aria-label={t.heroStepsLabel}>
        {steps.map((step, i) => (
          <li
            key={step.title}
            className="flex items-start gap-4 border-border-subtle p-6 md:border-l md:px-10 md:first:border-l-0 [&:not(:first-child)]:border-t md:[&:not(:first-child)]:border-t-0"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-card bg-brand/10 text-brand">
              <step.icon className="size-5" aria-hidden />
            </span>
            <span className="flex flex-col gap-1">
              <span className="font-bold text-text-primary">
                <span className="sr-only">{`${i + 1}. `}</span>
                {step.title}
              </span>
              <span className="text-body text-text-tertiary">{step.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
