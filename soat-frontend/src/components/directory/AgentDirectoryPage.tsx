'use client'

/**
 * /projects — the standalone Agent Directory.
 *
 * ── WHY THIS ROUTE EXISTS AGAIN ────────────────────────────────────────────
 *
 * `/projects` was a `redirect('/#directory')`, because the directory lived
 * inline on the landing page and there was only one of it. The v0 redesign
 * separates them, and the separation is the point rather than a side effect:
 * the home page's copy of the grid is a teaser that shows three cards and a
 * "View all", and this is the one you filter, search and sort in. A single
 * grid cannot be both without the landing page growing a sidebar.
 *
 * ── WHAT THE MOCK'S TOOLBAR ASKED FOR ──────────────────────────────────────
 *
 * Four sort pills: Volume, Newest, Holders, 24h %. Three of those four are not
 * computable here — there is no volume index, no holder index and no price
 * feed, so no delta. Rather than render three controls that do nothing, the
 * group keeps the mock's exact shape and pill count and spends it on four
 * orderings this app can actually produce. `Newest` is the mock's own and is
 * unchanged; the other three are replacements, and they are deliberately
 * orderings a directory reader wants: how big, how urgent, how old.
 *
 * See the v0 audit §A for the full list of invented columns.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'

import { ACTIVE_CHAIN_LABEL, MAINNET_CHAIN_LABEL } from '@/lib/contracts'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { CLOCK_UNSYNCED, useNowSec } from '@/components/ui'
import { Emph, fill, useT, type Dictionary } from '@/i18n'
import { ProjectCard, SkeletonCard } from './ProjectCard'
import { useDirectoryProjects, type DirectoryTab } from './useDirectoryProjects'

/**
 * `null` is "every phase", and it is a separate value rather than a fifth tab
 * key so that `counts` stays keyed by the four real phases the hook buckets
 * into. The mock's sidebar leads with "All launches" for the same reason a
 * directory should: a visitor who has not chosen a phase has not asked to be
 * shown one phase.
 */
type PhaseFilter = DirectoryTab | null

function phases(t: Dictionary): {
  key: PhaseFilter
  label: string
  blurb: string
  pip: string
}[] {
  const d = t.directory
  return [
    {
      key: null,
      label: d.phaseAll,
      blurb: d.phaseAllBlurb,
      pip: 'bg-text-secondary',
    },
    {
      key: 'live',
      label: d.phaseLive,
      blurb: fill(d.phaseLiveBlurb, { quote: QUOTE_SYMBOL }),
      pip: 'bg-brand',
    },
    {
      key: 'launching',
      label: d.phaseLaunching,
      // The mock reads "Floor cleared · ladder deploying". Nothing deploys by
      // itself: `launch()` is creator-only, and no raise target gates it — this
      // phase is "genesis window closed, a launch is still possible, creator has
      // not called it". See v0 audit §D2. A raise that CANNOT launch never lands
      // here; it goes straight to `archived`, because `canRefund()` opens for it
      // at genesis close.
      blurb: d.phaseLaunchingBlurb,
      pip: 'bg-warning',
    },
    {
      key: 'completed',
      label: d.phaseCompleted,
      blurb: d.phaseCompletedBlurb,
      pip: 'bg-success',
    },
    {
      key: 'archived',
      label: d.phaseArchived,
      // NOT "launch window expired". Two failures land here and only one of them
      // ran out of time: a raise too small to open a pool is archived at genesis
      // close, with six days of window still on the clock. The refund is the
      // half that is true of both.
      blurb: d.phaseArchivedBlurb,
      pip: 'bg-text-secondary',
    },
  ]
}

type SortKey = 'newest' | 'raised' | 'closing' | 'oldest'

function sorts(t: Dictionary): { key: SortKey; label: string }[] {
  return [
    { key: 'newest',  label: t.directory.sortNewest },
    { key: 'raised',  label: t.directory.sortRaised },
    { key: 'closing', label: t.directory.sortClosing },
    { key: 'oldest',  label: t.directory.sortOldest },
  ]
}

export default function AgentDirectoryPage() {
  const t = useT()
  const d = t.directory
  const PHASES = phases(t)
  const SORTS = sorts(t)
  const { projects, counts, loading, launchCount } = useDirectoryProjects()
  const [phase, setPhase] = useState<PhaseFilter>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('newest')
  const nowSec = useNowSec()

  const total = PHASES.reduce(
    (n, p) => (p.key === null ? n : n + counts[p.key]),
    0,
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = projects.filter(p => {
      if (phase !== null && p.tab !== phase) return false
      if (!q) return true
      return p.symbol.toLowerCase().includes(q)
        || p.name.toLowerCase().includes(q)
        || p.token.toLowerCase().includes(q)
    })

    // Copied rather than sorted in place: `projects` is the hook's array and
    // mutating it would reorder the landing page's teaser as a side effect of
    // clicking a pill here.
    const out = [...rows]
    switch (sort) {
      case 'newest':
        break // the hook already hands them back newest-first
      case 'oldest':
        out.reverse()
        break
      case 'raised':
        out.sort((a, b) => (a.totalNative === b.totalNative ? 0 : a.totalNative > b.totalNative ? -1 : 1))
        break
      case 'closing':
        // Phases with no clock sink to the bottom rather than sorting as 0,
        // which would put every finished launch above every open one.
        out.sort((a, b) => {
          const open = (p: typeof a) => p.tab === 'live' || p.tab === 'launching'
          if (open(a) !== open(b)) return open(a) ? -1 : 1
          return Number(a.genesisDeadline - b.genesisDeadline)
        })
        break
    }
    return out
  }, [projects, phase, query, sort])

  const firstLoad = loading && projects.length === 0

  return (
    <main>
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="flex flex-col gap-gap-tight border-b border-border-subtle pb-section">
          <h1 className="font-mono text-hero text-text-primary">{d.title}</h1>
          <p className="max-w-xl text-readout text-text-secondary">
            {fill(d.lede, { chain: MAINNET_CHAIN_LABEL })}
          </p>
        </div>

        <div className="mt-section grid gap-section lg:grid-cols-[268px_minmax(0,1fr)]">
          <aside className="flex flex-col gap-card-lg lg:sticky lg:top-20 lg:self-start">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary"
              />
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={d.searchPlaceholder}
                aria-label={d.searchLabel}
                spellCheck={false}
                className="w-full rounded-input border border-border-subtle bg-surface-card py-2.5 pl-9 pr-3 text-readout text-text-primary placeholder:text-text-quiet transition-colors focus:border-brand focus:outline-none"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="px-1 pb-1 font-mono text-micro uppercase text-text-tertiary">
                {d.phaseHeading}
              </span>
              {PHASES.map(p => {
                const active = phase === p.key
                const n = p.key === null ? total : counts[p.key]
                return (
                  <button
                    key={p.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setPhase(p.key)}
                    className={
                      'flex flex-col gap-1 rounded-card border px-3 py-2.5 text-left transition-colors '
                      + (active
                        ? 'border-brand/40 bg-surface-card shadow-panel'
                        : 'border-transparent hover:bg-surface-hover')
                    }
                  >
                    <span className="flex items-center justify-between gap-gap-tight">
                      <span
                        className={`flex items-center gap-gap-tight text-readout font-bold ${
                          active ? 'text-text-primary' : 'text-text-secondary'
                        }`}
                      >
                        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-pill ${p.pip}`} />
                        {p.label}
                      </span>
                      <span className="font-mono text-note tabular-nums text-text-tertiary">
                        {loading && n === 0 ? '·' : n}
                      </span>
                    </span>
                    <span className="pl-3.5 text-micro leading-snug text-text-tertiary">
                      {p.blurb}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* The mock has no equivalent. It is here because the count in the
                toolbar is a count of what the factory has been scanned for,
                not of what exists — see `SCAN_DEPTH` in the hook — and a
                directory that silently truncates is worse than one that says
                how deep it looked. */}
            <p className="text-micro leading-relaxed text-text-quiet">
              {launchCount !== null
                ? fill(launchCount === 1 ? d.factoryCountOne : d.factoryCountMany, { n: launchCount, chain: ACTIVE_CHAIN_LABEL })
                : ACTIVE_CHAIN_LABEL}
            </p>
          </aside>

          <div className="min-w-0">
            <div className="mb-card flex flex-wrap items-center justify-between gap-gap">
              <span className="text-readout text-text-secondary">
                <span className="font-mono font-bold tabular-nums text-text-primary">
                  {visible.length}
                </span>
                {' '}
                {query.trim() || phase !== null
                  ? (visible.length === 1 ? d.resultsOneFiltered : d.resultsManyFiltered)
                  : (visible.length === 1 ? d.resultsOne : d.resultsMany)}
              </span>

              <div className="inline-flex items-center gap-1 rounded-card border border-border-subtle bg-surface-card p-1">
                {SORTS.map(s => (
                  <button
                    key={s.key}
                    type="button"
                    aria-pressed={sort === s.key}
                    onClick={() => setSort(s.key)}
                    className={
                      'rounded-input px-3 py-1.5 text-note font-bold transition-colors '
                      + (sort === s.key
                        ? 'bg-surface-hover text-text-primary shadow-panel'
                        : 'text-text-tertiary hover:text-text-secondary')
                    }
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {firstLoad ? (
              <div className="grid gap-card sm:grid-cols-2 xl:grid-cols-3">
                {[1, 2, 3, 4, 5, 6].map(i => <SkeletonCard key={`sk-${i}`} />)}
              </div>
            ) : visible.length === 0 ? (
              // Dashed border and centred, per the reference — a dashed box
              // reads as a slot waiting to be filled rather than as a card
              // that happens to contain a sentence. The clear-filters button
              // is ours: the reference's empty state says "Try a different
              // filter or search term" and leaves the reader to find them
              // again, which on this page means scrolling back up a sidebar.
              <div className="flex flex-col items-center justify-center gap-gap-tight rounded-panel border border-dashed border-border-subtle bg-surface-card py-24 text-center">
                <p className="text-lede font-semibold text-text-primary">
                  {query.trim()
                    ? <Emph text={d.nothingMatches} vars={{ query: query.trim() }} className="font-mono text-brand" />
                    : total === 0
                      ? d.emptyTitle
                      : d.emptyPhaseTitle}
                </p>
                <p className="max-w-sm text-readout leading-relaxed text-text-secondary">
                  {total === 0 ? d.emptyBody : d.emptyPhaseBody}
                </p>
                {(query.trim() || phase !== null) && (
                  <button
                    type="button"
                    onClick={() => { setQuery(''); setPhase(null) }}
                    className="mt-gap-tight inline-flex min-h-11 items-center font-mono text-label text-brand hover:underline"
                  >
                    {d.clearFilters}
                  </button>
                )}
              </div>
            ) : (
              <div className="grid gap-card sm:grid-cols-2 xl:grid-cols-3">
                {visible.map(p => <ProjectCard key={p.hook} project={p} />)}
              </div>
            )}

            <p className="mt-card-lg text-micro text-text-quiet">
              {nowSec === CLOCK_UNSYNCED ? ' ' : d.clockNote}
              {' '}
              <Link href="/launch" className="text-brand hover:underline">
                {d.launchCta}
              </Link>
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}
