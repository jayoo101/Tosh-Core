'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

import type { DirectoryProject } from '@/components/directory/useDirectoryProjects'
import { CLOCK_UNSYNCED, formatCountdown, useNowSec } from '@/components/ui'
import { Skeleton } from '@/components/ui/Skeleton'
import { fill, useT } from '@/i18n'
import { Bar } from '../Panel'
import { ProjectCover, ProjectLink, StatusPill, raisedLine, statusOf } from '../ProjectBits'
import { fmtPrice, pct, toNum } from '../curve'
import { summaryOf, type GenesisSummary } from '../useV2Summaries'
import { pickFeatured } from './Hero'

/** The one raise the platform is pushing, the same pick as the hero; the rest live on /launchpad. */
export function BrowseSection({ projects, summaries, loading }: {
  projects: readonly DirectoryProject[]
  summaries: Map<string, GenesisSummary>
  loading: boolean
}) {
  const t = useT().x
  const now = useNowSec('second')
  const featured = pickFeatured(projects, now * 1000)
  const others = projects.filter(p => p.tab === 'live').length - (featured ? 1 : 0)

  return (
    <section id="browse" aria-labelledby="browse-title" className="flex scroll-mt-24 flex-col gap-6">
      <h2 id="browse-title" className="text-gold-shimmer w-fit text-section font-black">{t.launchingTitle}</h2>

      {loading && !featured ? (
        <Skeleton className="h-72" radius="card" />
      ) : !featured ? (
        <p className="rounded-panel bg-surface-card p-10 text-center text-text-tertiary">{t.launchingEmpty}</p>
      ) : (
        <FeaturedRaise project={featured} summary={summaryOf(summaries, featured.hook)} now={now} />
      )}

      {others > 0 && (
        <Link href="/launchpad" className="flex w-fit items-center gap-1.5 text-body text-brand hover:underline">
          {fill(t.browseMore, { n: others })}
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      )}
    </section>
  )
}

function FeaturedRaise({ project: p, summary: s, now }: { project: DirectoryProject; summary: GenesisSummary | undefined; now: number }) {
  const t = useT().x
  const progress = s ? pct(s.raised, s.hardCap) : null
  const deadline = s && s.soldOutAt === 0n ? s.genesisDeadline : p.genesisDeadline
  return (
    <ProjectLink project={p} className="glow-frame group block rounded-panel bg-surface-card p-px">
      <div className="grid overflow-hidden rounded-panel bg-surface-card md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <ProjectCover project={p} className="md:aspect-auto md:h-full md:min-h-64" />
        <div className="flex flex-col gap-5 p-6 md:p-8">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="truncate font-mono text-title font-bold text-text-primary group-hover:text-brand">{`$${p.symbol} · ${p.name}`}</h3>
              <StatusPill status={statusOf(p)} />
            </div>
            <p className="line-clamp-3 text-body text-text-tertiary">{p.description || t.noDescription}</p>
          </div>

          <div className="flex flex-col gap-2">
            {progress !== null && <Bar pct={progress} label={t.raisedVsCap} thick />}
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-note">
              <span className="font-bold text-brand">
                {progress !== null ? `${progress.toFixed(0)}% · ${raisedLine(p, s, t)}` : raisedLine(p, s, t)}
              </span>
              {s && (
                <span className="text-text-tertiary">
                  {fill(t.priceTo2P, { price: fmtPrice(toNum(s.currentPrice, p.quote.decimals)), quote: p.quote.symbol })}
                </span>
              )}
            </div>
          </div>

          <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 font-mono text-note text-text-tertiary">
              {t.endsIn}
              <span className="text-brand">
                {now === CLOCK_UNSYNCED ? '--:--:--' : formatCountdown(Number(deadline) - now)}
              </span>
            </span>
            <span className="flex items-center gap-2 rounded-pill bg-brand px-5 py-2.5 font-bold text-bg-base transition-opacity group-hover:opacity-90">
              {t.heroCta}
              <ArrowRight className="size-4" aria-hidden />
            </span>
          </div>
        </div>
      </div>
    </ProjectLink>
  )
}
