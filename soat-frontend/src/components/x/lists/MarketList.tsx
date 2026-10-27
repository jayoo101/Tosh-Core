'use client'

import { ArrowUpRight } from 'lucide-react'
import type { Address } from 'viem'

import { useDirectoryProjects } from '@/components/directory/useDirectoryProjects'
import { ProjectLogo } from '@/components/ProjectLogo'
import { Skeleton } from '@/components/ui/Skeleton'
import { BidMarket } from '@/components/v2/BidMarket'
import { useT } from '@/i18n'
import { isV2Factory } from '@/lib/v2/config'
import { Panel } from '../Panel'
import { ProjectLink } from '../ProjectBits'
import { fmtPrice, toNum } from '../curve'
import { summaryOf, useV2Summaries } from '../useV2Summaries'

/** Every v2 project still before launch, each with its bid book. Bids only: selling happens on the project page. */
export function MarketList() {
  const t = useT().x
  const { projects, loading } = useDirectoryProjects()
  const items = projects.filter(p => isV2Factory(p.factory) && (p.tab === 'live' || p.tab === 'launching'))
  const summaries = useV2Summaries(items)

  return (
    <section aria-labelledby="market-title" className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 id="market-title" className="text-gold-shimmer w-fit text-section font-bold md:text-hero">{t.marketTitle}</h1>
        <p className="text-pretty text-body text-text-tertiary">{t.marketLede}</p>
      </header>

      {loading && items.length === 0 ? (
        <Skeleton className="h-96" radius="card" />
      ) : items.length === 0 ? (
        <p className="rounded-panel bg-surface-card p-10 text-center text-text-tertiary">{t.marketEmpty}</p>
      ) : (
        items.map(p => {
          const s = summaryOf(summaries, p.hook)
          return (
            <Panel key={p.hook}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <ProjectLogo src={p.logoUrl} name={p.name || p.symbol} className="size-12 rounded-card" />
                  <div className="flex flex-col">
                    <h2 className="text-title font-bold text-text-primary">{`$${p.symbol}`}</h2>
                    <span className="text-body text-text-tertiary">{p.name}</span>
                  </div>
                </div>
                <div className="flex items-center gap-6">
                  <div className="flex flex-col items-end">
                    <span className="text-label uppercase text-text-tertiary">{t.marketPrice}</span>
                    <span className="font-mono text-title font-bold text-brand">
                      {s ? `${fmtPrice(toNum(s.currentPrice, p.quote.decimals))} ${p.quote.symbol}` : '—'}
                    </span>
                  </div>
                  <ProjectLink
                    project={p}
                    className="flex items-center gap-1 rounded-pill border border-border-subtle px-4 py-2 text-body text-text-primary transition-colors hover:border-brand hover:text-brand"
                  >
                    {t.marketDetails}
                    <ArrowUpRight className="size-4" aria-hidden />
                  </ProjectLink>
                </div>
              </div>
              <BidMarket hook={p.hook as Address} symbol={p.symbol} buyOnly />
            </Panel>
          )
        })
      )}
    </section>
  )
}
