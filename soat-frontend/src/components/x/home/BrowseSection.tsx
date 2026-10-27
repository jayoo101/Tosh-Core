'use client'

import { useMemo } from 'react'

import type { DirectoryProject } from '@/components/directory/useDirectoryProjects'
import { Skeleton } from '@/components/ui/Skeleton'
import { useT } from '@/i18n'
import { ProjectCover, ProjectLink, StatusPill, raisedLine, statusOf } from '../ProjectBits'
import { summaryOf, type GenesisSummary } from '../useV2Summaries'

/** The raises that are selling right now, most raised first. */
export function BrowseSection({ projects, summaries, loading }: {
  projects: readonly DirectoryProject[]
  summaries: Map<string, GenesisSummary>
  loading: boolean
}) {
  const t = useT().x

  const items = useMemo(() => {
    const raised = (p: DirectoryProject) => summaryOf(summaries, p.hook)?.raised ?? p.totalNative
    return projects
      .filter(p => p.tab === 'live')
      .sort((a, b) => (raised(b) > raised(a) ? 1 : raised(b) < raised(a) ? -1 : 0))
  }, [projects, summaries])

  return (
    <section id="browse" aria-labelledby="browse-title" className="flex scroll-mt-24 flex-col gap-6">
      <h2 id="browse-title" className="text-gold-shimmer w-fit text-section font-black">{t.launchingTitle}</h2>

      {loading && items.length === 0 ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map(i => <li key={i}><Skeleton className="h-72" radius="card" /></li>)}
        </ul>
      ) : items.length === 0 ? (
        <p className="rounded-panel bg-surface-card p-10 text-center text-text-tertiary">{t.launchingEmpty}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((p, idx) => (
            <li key={p.hook}>
              <ProjectLink
                project={p}
                className={`glow-frame group flex h-full flex-col rounded-panel bg-surface-card p-px ${idx % 2 ? 'glow-delay' : ''}`}
              >
                <div className="flex flex-1 flex-col overflow-hidden rounded-panel bg-surface-card">
                  <ProjectCover project={p} />
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="truncate font-bold text-text-primary group-hover:text-brand">{`$${p.symbol} · ${p.name}`}</h3>
                      <StatusPill status={statusOf(p)} />
                    </div>
                    <p className="line-clamp-2 text-body text-text-tertiary">{p.description || t.noDescription}</p>
                    <div className="mt-auto flex items-center justify-between pt-2 font-mono text-note">
                      <span className="text-text-tertiary">{p.quote.symbol}</span>
                      <span className="text-brand">{raisedLine(p, summaryOf(summaries, p.hook), t)}</span>
                    </div>
                  </div>
                </div>
              </ProjectLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
