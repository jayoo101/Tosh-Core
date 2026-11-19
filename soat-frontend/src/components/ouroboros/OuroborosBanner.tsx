'use client'

import Link from 'next/link'
import { ArrowRight, Infinity as InfinityIcon } from 'lucide-react'

import { Badge, formatCountdown, useNowSec } from '@/components/ui'
import { OURO_ENABLED } from '@/lib/ouroboros/config'

import { useOuroCopy } from './copy'
import { phaseCountdown, useOuroState } from './useOuro'

/** The home page's lead: the live Ouroboros phase and a way in. Renders nothing until the contracts are configured. */
export function OuroborosBanner() {
  if (!OURO_ENABLED) return null
  return <Live />
}

function Live() {
  const c = useOuroCopy()
  const { state } = useOuroState()
  const now = useNowSec()
  const p = state.phase
  const countdown = phaseCountdown(state, c, now)

  return (
    <section
      aria-labelledby="ouro-banner-title"
      className="glow-frame relative isolate overflow-hidden rounded-[1.5rem] border border-brand/40 bg-surface-card/85"
    >
      <div aria-hidden="true" className="hero-grid pointer-events-none absolute inset-0 -z-10" />
      <div className="flex flex-col gap-6 p-6 md:flex-row md:items-center md:justify-between md:p-8">
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-card bg-brand/10 text-brand">
            <InfinityIcon className="size-6" aria-hidden />
          </span>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-label uppercase text-brand">{c.bannerKicker}</span>
              {p && <Badge tone={p === 'Failed' ? 'danger' : 'info'} pip live={p === 'L1' || p === 'L2'}>{c.phase[p]}</Badge>}
            </div>
            <h2 id="ouro-banner-title" className="font-mono text-2xl font-bold text-text-primary md:text-3xl">{c.title}</h2>
            <p className="text-body text-text-tertiary">{c.tagline}</p>
            {countdown && now > 0 && (
              <p className="font-mono text-readout text-brand">
                {countdown[0]} {formatCountdown(countdown[1])}
              </p>
            )}
          </div>
        </div>
        <Link
          href="/ouroboros"
          className="flex w-fit shrink-0 items-center gap-2 rounded-pill bg-brand px-6 py-3 font-bold text-bg-base transition-opacity hover:opacity-90"
        >
          {c.bannerCta}
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    </section>
  )
}
