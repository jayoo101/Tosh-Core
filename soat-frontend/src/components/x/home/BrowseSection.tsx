'use client'

import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'

import type { DirectoryProject } from '@/components/directory/useDirectoryProjects'
import { Skeleton } from '@/components/ui/Skeleton'
import { useT } from '@/i18n'
import { ProjectCover, ProjectLink, StatusPill, raisedLine, statusOf } from '../ProjectBits'
import { summaryOf, type GenesisSummary } from '../useV2Summaries'

type Filter = 'all' | 'live' | 'launched'
type Sort = 'new' | 'name'

/** Every listed project, newest first, filterable by stage and searchable by name or description. */
export function BrowseSection({ projects, summaries, loading }: {
  projects: readonly DirectoryProject[]
  summaries: Map<string, GenesisSummary>
  loading: boolean
}) {
  const t = useT().x
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('new')

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = projects.filter(p => {
      const st = statusOf(p)
      if (filter === 'live' && st !== 'live' && st !== 'pending') return false
      if (filter === 'launched' && st !== 'trading') return false
      if (!q) return true
      return [p.symbol, p.name, p.description ?? ''].some(s => s.toLowerCase().includes(q))
    })
    return sort === 'name'
      ? [...out].sort((a, b) => a.symbol.localeCompare(b.symbol))
      : [...out].sort((a, b) => Number(b.createdAt - a.createdAt))
  }, [projects, filter, query, sort])

  const tabs: [Filter, string][] = [['all', t.browseAll], ['live', t.browseLive], ['launched', t.browseLaunched]]

  return (
    <section id="browse" aria-labelledby="browse-title" className="flex scroll-mt-24 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="browse-title" className="text-section font-black text-text-primary">{t.browseTitle}</h2>
        <div className="flex rounded-pill bg-surface-card p-1" role="tablist" aria-label={t.browseStageLabel}>
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              onClick={() => setFilter(id)}
              className={`rounded-pill px-4 py-1.5 text-body transition-colors ${
                filter === id ? 'bg-surface-hover text-brand' : 'text-text-tertiary hover:text-text-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="flex flex-1 items-center gap-3 rounded-pill bg-surface-card px-5 py-3 focus-within:ring-1 focus-within:ring-brand">
          <Search className="size-4 text-text-tertiary" aria-hidden />
          <span className="sr-only">{t.browseSearchLabel}</span>
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t.browseSearch}
            className="w-full bg-transparent text-body text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </label>
        <label className="flex items-center gap-2 text-body text-text-tertiary">
          {t.browseSort}
          <select
            value={sort}
            onChange={e => setSort(e.target.value as Sort)}
            className="rounded-pill bg-surface-card px-4 py-3 text-text-primary outline-none focus:ring-1 focus:ring-brand"
          >
            <option value="new">{t.browseSortNew}</option>
            <option value="name">{t.browseSortName}</option>
          </select>
        </label>
      </div>

      {loading && projects.length === 0 ? (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map(i => <li key={i}><Skeleton className="h-72" radius="card" /></li>)}
        </ul>
      ) : items.length === 0 ? (
        <p className="rounded-panel bg-surface-card p-10 text-center text-text-tertiary">{t.browseEmpty}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map(p => (
            <li key={p.hook}>
              <ProjectLink project={p} className="group flex h-full flex-col overflow-hidden rounded-panel bg-surface-card">
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
              </ProjectLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
