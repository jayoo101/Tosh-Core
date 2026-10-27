'use client'

import Link from 'next/link'
import { Rocket } from 'lucide-react'

import { useDirectoryProjects, type DirectoryProject } from '@/components/directory/useDirectoryProjects'
import { Skeleton } from '@/components/ui/Skeleton'
import { fill, useT } from '@/i18n'
import { Bar } from '../Panel'
import { ProjectCover, ProjectLink, StatusPill, raisedLine, statusOf } from '../ProjectBits'
import { fmtPrice, pct, toNum } from '../curve'
import { summaryOf, useV2Summaries, type GenesisSummary } from '../useV2Summaries'

/** Raises still selling, then sold-out raises waiting for their launch time. */
export function LaunchingList() {
  const t = useT().x
  const { projects, loading } = useDirectoryProjects()
  const items = projects.filter(p => p.tab === 'live' || p.tab === 'launching')
  const summaries = useV2Summaries(items)

  return (
    <section aria-labelledby="launching-title" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 id="launching-title" className="flex items-center gap-3 text-section font-black text-text-primary">
          <span className="flex size-10 items-center justify-center rounded-card bg-surface-hover text-brand">
            <Rocket className="size-5" aria-hidden />
          </span>
          {t.launchingTitle}
        </h1>
        <span className="text-body text-text-tertiary">{t.launchingSub}</span>
      </div>

      {loading && items.length === 0 ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {[0, 1, 2].map(i => <li key={i}><Skeleton className="h-80" radius="card" /></li>)}
        </ul>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-panel bg-surface-card p-10 text-center">
          <p className="text-text-tertiary">{t.launchingEmpty}</p>
          <Link href="/launched" className="text-body text-brand hover:underline">{t.heroNoLiveLink}</Link>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {items.map(p => <LaunchingCard key={p.hook} project={p} summary={summaryOf(summaries, p.hook)} />)}
        </ul>
      )}
    </section>
  )
}

function LaunchingCard({ project: p, summary: s }: { project: DirectoryProject; summary: GenesisSummary | undefined }) {
  const t = useT().x
  const d = p.quote.decimals
  const progress = s ? pct(s.raised, s.hardCap) : null
  return (
    <li>
      <ProjectLink
        project={p}
        className="group flex h-full flex-col overflow-hidden rounded-panel border border-transparent bg-surface-card transition-colors hover:border-brand"
      >
        <ProjectCover project={p}>
          <StatusPill status={statusOf(p)} className="absolute left-3 top-3" />
        </ProjectCover>
        <div className="flex flex-1 flex-col gap-4 p-5">
          <div className="flex flex-col gap-1">
            <span className="text-note text-text-tertiary">{p.name}</span>
            <h2 className="font-mono text-title font-bold text-text-primary">${p.symbol}</h2>
            <p className="line-clamp-2 text-body text-text-tertiary">{p.description || t.noDescription}</p>
          </div>
          <div className="mt-auto flex flex-col gap-2">
            {progress !== null && <Bar pct={progress} label={t.raisedVsCap} />}
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-note">
              <span className="flex items-center gap-1.5 text-text-tertiary">
                <span className="size-1.5 rounded-pill bg-brand" aria-hidden />
                {progress !== null ? `${progress.toFixed(0)}% · ${raisedLine(p, s, t)}` : raisedLine(p, s, t)}
              </span>
              {s && (
                <span className="text-brand">
                  {fill(t.priceTo2P, { price: fmtPrice(toNum(s.currentPrice, d)), quote: p.quote.symbol })}
                </span>
              )}
            </div>
          </div>
        </div>
      </ProjectLink>
    </li>
  )
}
