'use client'

import { Suspense, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowUpRight, Search } from 'lucide-react'
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

const PARAM = 'project'

/**
 * Every v2 bid book in a picker, and the book of the one picked: projects
 * before launch first, then launched ones, whose books only take cancellations
 * and are shown nowhere else. Bids only: selling happens on the project page.
 */
export function MarketList() {
  const t = useT().x
  return (
    <section aria-labelledby="market-title" className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 id="market-title" className="text-gold-shimmer w-fit text-section font-bold md:text-hero">{t.marketTitle}</h1>
        <p className="text-pretty text-body text-text-tertiary">{t.marketLede}</p>
      </header>
      <Suspense fallback={<Skeleton className="h-96" radius="card" />}>
        <MarketBody />
      </Suspense>
    </section>
  )
}

/** The pick lives in `?project=<hook>`, so a link or a reload lands on the same book. */
function MarketBody() {
  const t = useT().x
  const { projects, loading } = useDirectoryProjects()
  const items = [
    ...projects.filter(p => isV2Factory(p.factory) && (p.tab === 'live' || p.tab === 'launching')),
    ...projects.filter(p => isV2Factory(p.factory) && p.tab === 'completed'),
  ]
  const summaries = useV2Summaries(items)
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const picked = params.get(PARAM)?.toLowerCase() ?? null
  const [query, setQuery] = useState('')

  const pick = (hook: string) => {
    const next = new URLSearchParams(params.toString())
    next.set(PARAM, hook)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }

  const selected = items.find(p => p.hook.toLowerCase() === picked) ?? items[0]
  const q = query.trim().toLowerCase()
  const shown = q
    ? items.filter(p => p.symbol.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.hook.toLowerCase() === q)
    : items
  const price = (p: (typeof items)[number]) => {
    const s = summaryOf(summaries, p.hook)
    return s ? `${fmtPrice(toNum(s.currentPrice, p.quote.decimals))} ${p.quote.symbol}` : '—'
  }

  return loading && items.length === 0 ? (
    <Skeleton className="h-96" radius="card" />
  ) : items.length === 0 || !selected ? (
    <p className="rounded-panel bg-surface-card p-10 text-center text-text-tertiary">{t.marketEmpty}</p>
  ) : (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start">
      <nav aria-label={t.marketPick} className="flex flex-col gap-3 rounded-panel border border-border-subtle bg-surface-card/80 p-3 lg:sticky lg:top-24">
        <label className="flex items-center gap-2 rounded-input border border-border-subtle bg-bg-base/60 px-3 py-2 focus-within:border-brand">
          <Search className="size-4 shrink-0 text-text-tertiary" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t.marketSearch}
            aria-label={t.marketSearch}
            className="w-full bg-transparent text-body text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </label>
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto lg:max-h-[60vh]">
          {shown.map(p => {
            const active = p.hook === selected.hook
            return (
              <li key={p.hook}>
                <button
                  type="button"
                  onClick={() => pick(p.hook)}
                  aria-current={active ? 'true' : undefined}
                  className={`flex w-full items-center gap-3 rounded-card px-3 py-2 text-left transition-colors ${
                    active ? 'bg-brand/10 ring-1 ring-brand/60' : 'hover:bg-surface-hover'
                  }`}
                >
                  <ProjectLogo src={p.logoUrl} name={p.name || p.symbol} className="size-9 shrink-0 rounded-card" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate text-body font-bold ${active ? 'text-brand' : 'text-text-primary'}`}>{`$${p.symbol}`}</span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      {p.tab === 'completed' && (
                        <span className="shrink-0 rounded-pill bg-surface-hover px-1.5 text-label text-text-tertiary">{t.marketLaunchedTag}</span>
                      )}
                      <span className="truncate text-note text-text-tertiary">{p.name}</span>
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-note text-text-secondary">{price(p)}</span>
                </button>
              </li>
            )
          })}
          {shown.length === 0 && <li className="px-3 py-6 text-center text-note text-text-tertiary">{t.marketNoMatch}</li>}
        </ul>
      </nav>

      <Panel key={selected.hook}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <ProjectLogo src={selected.logoUrl} name={selected.name || selected.symbol} className="size-12 rounded-card" />
            <div className="flex flex-col">
              <h2 className="text-title font-bold text-text-primary">{`$${selected.symbol}`}</h2>
              <span className="text-body text-text-tertiary">{selected.name}</span>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex flex-col items-end">
              <span className="text-label uppercase text-text-tertiary">{t.marketPrice}</span>
              <span className="font-mono text-title font-bold text-brand">{price(selected)}</span>
            </div>
            <ProjectLink
              project={selected}
              className="flex items-center gap-1 rounded-pill border border-border-subtle px-4 py-2 text-body text-text-primary transition-colors hover:border-brand hover:text-brand"
            >
              {t.marketDetails}
              <ArrowUpRight className="size-4" aria-hidden />
            </ProjectLink>
          </div>
        </div>
        <BidMarket hook={selected.hook as Address} symbol={selected.symbol} buyOnly />
      </Panel>
    </div>
  )
}
