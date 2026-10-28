'use client'

import { BadgeCheck } from 'lucide-react'

import { useDirectoryProjects } from '@/components/directory/useDirectoryProjects'
import { ProjectLogo } from '@/components/ProjectLogo'
import { Skeleton } from '@/components/ui/Skeleton'
import { fill, useT } from '@/i18n'
import { ProjectLink, StatusPill, statusOf } from '../ProjectBits'
import { fmtPrice, toNum } from '../curve'
import { summaryOf, useShelfSummaries } from '../useV2Summaries'

const TIER_COUNT = 4000

/** Every project whose pool is open, with its current shelf where it has one. */
export function LaunchedList() {
  const t = useT().x
  const { projects, loading } = useDirectoryProjects()
  const items = projects.filter(p => p.tab === 'completed')
  const shelves = useShelfSummaries(items)

  return (
    <section aria-labelledby="launched-title" className="flex flex-col gap-6">
      <h1 id="launched-title" className="flex items-center gap-3 text-section font-black text-text-primary">
        <span className="flex size-10 items-center justify-center rounded-card bg-surface-hover text-brand">
          <BadgeCheck className="size-5" aria-hidden />
        </span>
        <span className="text-gold-shimmer">{t.launchedTitle}</span>
        <span className="rounded-pill bg-surface-hover px-2.5 py-0.5 font-mono text-body font-medium text-text-tertiary">
          {items.length}
        </span>
      </h1>

      {loading && items.length === 0 ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map(i => <li key={i}><Skeleton className="h-36" radius="card" /></li>)}
        </ul>
      ) : items.length === 0 ? (
        <p className="rounded-panel bg-surface-card p-10 text-center text-text-tertiary">{t.launchedEmpty}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {items.map((p, idx) => {
            const shelf = summaryOf(shelves, p.hook)
            const d = p.quote.decimals
            return (
              <li key={p.hook} className="min-w-0">
                <ProjectLink
                  project={p}
                  className={`glow-frame flex h-full rounded-panel bg-surface-card p-px ${idx % 2 ? 'glow-delay' : ''}`}
                >
                  <div className="flex min-w-0 flex-1 gap-4 rounded-panel bg-surface-card p-5">
                  <ProjectLogo src={p.logoUrl} name={p.name || p.symbol} className="size-12 shrink-0 rounded-pill" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate font-mono font-bold text-text-primary">${p.symbol}</h2>
                      <StatusPill status={statusOf(p)} />
                    </div>
                    <span className="text-note text-text-tertiary">{p.name}</span>
                    <p className="line-clamp-2 text-body text-text-tertiary">{p.description || t.noDescription}</p>
                    {shelf && (
                      <div className="mt-1 flex items-center justify-between gap-2 font-mono text-body">
                        <span className="text-text-primary">{`${fmtPrice(toNum(shelf.spotPrice, d))} ${p.quote.symbol}`}</span>
                        <span className="text-note text-text-tertiary">
                          {fill(t.shelfStep, { step: Math.min(Number(shelf.tierIndex) + 1, TIER_COUNT).toLocaleString(), total: TIER_COUNT.toLocaleString() })}
                        </span>
                      </div>
                    )}
                    <span className="truncate font-mono text-note text-brand/80">{p.token}</span>
                  </div>
                  </div>
                </ProjectLink>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
