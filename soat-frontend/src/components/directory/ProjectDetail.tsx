'use client'

/**
 * Project page shell: back link, identity header, About section.
 *
 * ── PORTED FROM THE v0 REDESIGN ──────────────────────────────────────────────
 *
 * This was a 768px single column — breadcrumb, header, then a terminal that
 * stacked every panel down the page. The mock is 1280px and splits into a wide
 * reading column and a 360px sticky action sidebar. That 512px and the missing
 * sidebar were the whole complaint; `ProjectTerminal` owns the grid, this file
 * owns everything above it.
 *
 * WHAT THIS FILE NO LONGER DOES: print the description. The mock gives it a
 * dedicated `About` section in the main column, so it is built here (the row is
 * registry data and this is where the row lives) and handed to the terminal as
 * a slot. It appears once, not twice.
 *
 * WHERE THE MOCK PUTS A PRICE AND A 24H DELTA in the top right, this has one
 * real number and one hole. `currentBondingPrice` is the live shelf and is on
 * chain; a 24h change needs a price history and nothing indexes one. The slot
 * keeps its place in the layout and says there is no feed — see the note on it
 * below, and `ProjectCard` for the same decision on the directory grid.
 */

import Link from 'next/link'
import { ArrowLeft, AtSign, Globe, Send } from 'lucide-react'

import type { ProjectRow } from '@/app/lib/supabase'
import ProjectTerminal, { type TerminalHeaderState } from '@/components/ProjectTerminal'
import { PHASE_BADGE } from '@/components/ProjectTerminal/HeroStats'
import { fmt } from '@/components/ProjectTerminal/format'
import { ProjectLogo } from '@/components/ProjectLogo'
import { AddressLink, Badge, Card } from '@/components/ui'
import { TIER_COUNT } from '@/lib/contracts'
import { QUOTE_SYMBOL } from '@/lib/contracts'

function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  const t = url.trim()
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

const SOCIAL_CLS =
  'flex h-7 w-7 items-center justify-center rounded-input border border-border-subtle ' +
  'text-text-tertiary transition-colors hover:border-brand/40 hover:text-brand'

export function ProjectDetail({ project: p }: { project: ProjectRow }) {
  const tw = safeHref(p.twitter)
  const tg = safeHref(p.telegram)
  const web = safeHref(p.website)
  const desc = p.description?.trim()

  /**
   * The mock's `About` card, minus its tag row.
   *
   * There are no tags to render: the `projects` table has no tags column and
   * nothing on chain carries any, so the row is omitted rather than filled with
   * something plausible. A blank is honest; a invented tag row would not be.
   */
  const about = desc ? (
    <Card interactive={false}>
      <h2 className="text-title text-text-primary">About</h2>
      <p className="text-readout leading-relaxed text-text-primary">{desc}</p>
    </Card>
  ) : undefined

  /**
   * The identity header, as a function of the terminal's chain state.
   *
   * The phase badge and the live shelf price both come off reads that
   * `ProjectTerminal` owns, and the port is not allowed to move a read — so the
   * terminal calls this back with the two values instead. `live === null` is
   * "nothing chain-derived is printable yet" (pre-clock-sync), which is why the
   * badge and the price render nothing rather than a zero.
   */
  const header = (live: TerminalHeaderState | null) => {
    const meta = live ? PHASE_BADGE[live.phase] : null
    const tradable = live?.phase === 'bonding'

    return (
      <>
        {/* Replaces the old `Directory / SYMBOL` breadcrumb rather than sitting
            beside it. Two ways back to the same page, stacked, is the kind of
            chrome the redesign exists to remove — and the mock's version says
            where it goes in words. */}
        <Link
          href="/projects"
          className="inline-flex items-center gap-1.5 text-note text-text-secondary transition-colors hover:text-text-primary"
        >
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          All projects
        </Link>

        <div className="mt-5 flex flex-col gap-5 border-b border-border-subtle pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            {/* 64px, the mock's sigil size. `ProjectLogo` owns its own fill and
                radius — our `cn` does not resolve Tailwind conflicts, so its
                background is not overridable from here, and it renders the
                creator's uploaded logo when there is one rather than always
                showing initials. */}
            <ProjectLogo src={p.logo_url} name={p.name || p.symbol} className="h-16 w-16" />

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-mono text-section font-bold tracking-tight text-text-primary sm:text-hero">
                  ${p.symbol}
                </h1>
                {meta && (
                  <Badge tone={meta.tone} pip live={meta.live} size="sm">{meta.label}</Badge>
                )}
              </div>

              <p className="mt-0.5 text-readout text-text-secondary">{p.name}</p>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-note text-text-secondary">
                {p.token_address && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-text-quiet">token</span>
                    <AddressLink value={p.token_address} className="text-note text-text-primary" />
                  </span>
                )}
                {live?.creator && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-text-quiet">by</span>
                    <AddressLink
                      value={live.creator}
                      copyable={false}
                      className="text-note text-text-primary"
                    />
                  </span>
                )}
                {/* Ours, not the mock's — it has no social links. Folded into
                    this row rather than given one of their own. */}
                {tw && (
                  <a href={tw} target="_blank" rel="noopener noreferrer"
                     className={SOCIAL_CLS} aria-label="X / Twitter">
                    <AtSign aria-hidden className="h-3.5 w-3.5" />
                  </a>
                )}
                {tg && (
                  <a href={tg} target="_blank" rel="noopener noreferrer"
                     className={SOCIAL_CLS} aria-label="Telegram">
                    <Send aria-hidden className="h-3.5 w-3.5" />
                  </a>
                )}
                {web && (
                  <a href={web} target="_blank" rel="noopener noreferrer"
                     className={SOCIAL_CLS} aria-label="Website">
                    <Globe aria-hidden className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          </div>

          {tradable && live && (
            <div className="flex items-end gap-6 sm:flex-col sm:items-end sm:gap-1">
              <span className="font-mono text-section font-bold tabular-nums tracking-tight text-text-primary sm:text-hero">
                {live.currentPrice > 0n ? fmt(live.currentPrice) : '—'}
                <span className="ml-1.5 text-readout font-normal text-text-secondary">
                  {QUOTE_SYMBOL} · active shelf
                </span>
              </span>
              {/* WAS A PERMANENT "no price feed · 24h". The mock prints a 24h
                  delta here; nothing indexes trades, so the slot explained its
                  own emptiness — directly under the largest number on the page,
                  on every visit, forever. A caption that will never say
                  anything else is not a placeholder, it is furniture.

                  The shelf index answers what that line was reaching for. A
                  delta tells you how the price moved; on a fixed ladder, where
                  it sits tells you the same thing and more, because the rungs
                  above and below are known in advance. It is also real. */}
              <span className="font-mono text-micro uppercase text-text-tertiary tabular-nums">
                shelf #{live.shelfIndex.toLocaleString()} / {TIER_COUNT.toLocaleString()}
              </span>
            </div>
          )}
        </div>
      </>
    )
  }

  return (
    <div className="font-sans text-text-primary">
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <ProjectTerminal project={p} about={about} header={header} />
      </main>
    </div>
  )
}
