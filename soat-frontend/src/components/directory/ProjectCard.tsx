'use client'

/**
 * A launch, as one card in the directory grid.
 *
 * ── PORTED FROM THE v0 REDESIGN, WITH THREE COLUMNS MISSING ────────────────
 *
 * The frame, the density and the per-phase body are the mock's, measured off
 * the live prototype: one sigil-and-ticker header row with a phase pill, two
 * clamped lines of description, a body that changes with the phase, and a
 * bordered footer strip. What the mock puts in that footer is `holders · MC ·
 * Vol`, and it puts a price and a 24h delta in the trading body.
 *
 * None of those five figures exist behind this app. There is no price oracle,
 * no volume index and no holder index; `DirectoryProject` carries exactly what
 * the factory and the hook return, which is the ETH deposited, the cap it is
 * measured against, the deadline, and whether the pool is open. Rather than
 * stub them — a market cap is not the kind of number to invent on a page
 * people spend money from — the slots keep their layout and say what they
 * actually hold. See `docs/` v0 audit §A for the list and for what each phase
 * has instead.
 *
 * The one place a figure is genuinely absent rather than substituted is the
 * trading body's delta, which is marked in place.
 */

import { memo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowUpRight } from 'lucide-react'
import type { DirectoryProject } from './useDirectoryProjects'
import { fmtEth } from './useDirectoryProjects'
import { LAUNCH_WINDOW_SECONDS, TARGET_CHAIN_ID } from '@/lib/contracts'
import type { ProjectRow } from '@/app/lib/supabase'
import { CLOCK_UNSYNCED, formatCountdown, useNowSec } from '@/components/ui'
import { ProjectLogo } from '@/components/ProjectLogo'
import { rememberProject, prefetchProject } from '@/lib/projectCache'

function directoryToRow(p: DirectoryProject): ProjectRow {
  return {
    id:            p.token,
    // The directory this card came from only ever lists this deployment's
    // chain, so the row it synthesises belongs to it too. Annotating the return
    // type rather than leaving it inferred is the point: this is the third
    // place that builds a ProjectRow by hand, and the two before it were found
    // by the compiler only because `ProjectRow` was named somewhere downstream.
    chain_id:      TARGET_CHAIN_ID,
    tx_hash:       '',
    token_address: p.token,
    hook_address:  p.hook,
    name:          p.name,
    symbol:        p.symbol,
    logo_url:      p.logoUrl,
    website:       p.website,
    twitter:       p.twitter,
    telegram:      null,
    description:   p.description,
    created_at:    new Date(Number(p.createdAt) * 1000).toISOString(),
  }
}

/**
 * Shown when the creator wrote no description.
 *
 * BOTH CARDS USED TO SYNTHESISE ONE: `${name} ($${symbol}) — Proof-of-Gas
 * gated genesis on Tosh Protocol.` That sentence is invented, it is presented
 * in the creator's voice, and it says something about the project that nobody
 * with authority over the project ever wrote. It read as real because it is
 * well-formed and because every launch would carry it, which is exactly what
 * made it worse than an empty slot — the live launch has no description and
 * the card claimed otherwise while the detail page correctly showed nothing.
 *
 * A muted line rather than an omission: the card clamps this paragraph to two
 * lines and the phase body below it is positioned against that, so dropping
 * the element would reflow every card that does have a description.
 */
const NO_DESCRIPTION = 'No description provided.'

/**
 * The phase pill.
 *
 * The mock's four tones, and they are the right four: `FUNDING` is the brand
 * colour because a funding round is the one thing on this card a visitor can
 * act on, `TRADING` is success, `AWAITING LAUNCH` is warning because it is a
 * deadline, and `ARCHIVED` is neutral rather than danger — the project is over,
 * which is not an error.
 *
 * `pulse` only on the two phases that are genuinely counting down. A breathing
 * pip on an archived row claims something is still happening.
 */
const PHASE: Record<DirectoryProject['tab'], {
  label: string
  cls: string
  pip: string
  pulse: boolean
}> = {
  live: {
    label: 'FUNDING',
    cls: 'border-brand/40 bg-brand/10 text-brand',
    pip: 'bg-brand',
    pulse: true,
  },
  launching: {
    label: 'AWAITING LAUNCH',
    cls: 'border-warning/40 bg-warning/10 text-warning',
    pip: 'bg-warning',
    pulse: true,
  },
  completed: {
    label: 'TRADING',
    cls: 'border-success/40 bg-success/10 text-success',
    pip: 'bg-success',
    pulse: false,
  },
  archived: {
    label: 'ARCHIVED',
    cls: 'border-border-subtle bg-surface-hover text-text-secondary',
    pip: 'bg-text-secondary',
    pulse: false,
  },
}

/** `8h 59m`, or `1d 6h` past a day — the mock's two-unit form. */
function coarse(seconds: number): string {
  if (seconds <= 0) return 'closed'
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3_600)
  const m = Math.floor((seconds % 3_600) / 60)
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`
}

/**
 * The funding body's deadline, or the awaiting-launch body's.
 *
 * Two different clocks, and reading the wrong one is how a healthy raise came
 * to show `00:00:00`. A `launching` card is already past its genesis deadline;
 * what is still ticking for it is the creator's window to call `launch()`,
 * after which refunds open to everyone.
 */
function Remaining({
  deadline, tab, precise = false,
}: {
  deadline: bigint
  tab: DirectoryProject['tab']
  /** Feature card: tick seconds. Grid cards stay at the two-unit form. */
  precise?: boolean
}) {
  const nowSec = useNowSec()
  if (nowSec === CLOCK_UNSYNCED) return <span>&nbsp;</span>

  const target = tab === 'launching' ? deadline + LAUNCH_WINDOW_SECONDS : deadline
  const left = Number(target) - nowSec
  if (precise) {
    return (
      <span className="font-mono tabular-nums text-brand">
        {left <= 0 ? 'closed' : formatCountdown(left)}
      </span>
    )
  }
  return <span>ends in {coarse(left)}</span>
}

function ProjectCardImpl({ project: p }: { project: DirectoryProject }) {
  const router = useRouter()
  const phase = PHASE[p.tab]
  const pct = Math.min(p.progress, 100)
  const desc = p.description?.trim()

  return (
    <Link
      href={`/projects/${p.token}`}
      prefetch
      onMouseEnter={() => {
        rememberProject(directoryToRow(p))
        prefetchProject(p.token)
        router.prefetch(`/projects/${p.token}`)
      }}
      onClick={() => rememberProject(directoryToRow(p))}
      className="group flex flex-col rounded-panel border border-border-subtle bg-surface-card p-card shadow-panel transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lift"
    >
      <div className="flex items-start justify-between gap-gap">
        <div className="flex min-w-0 items-center gap-gap">
          <ProjectLogo
            src={p.logoUrl}
            name={p.name || p.symbol}
            className="h-10 w-10"
          />
          <div className="min-w-0">
            <div className="truncate font-mono text-readout font-bold text-text-primary">
              ${p.symbol}
            </div>
            <span className="truncate text-note text-text-secondary">{p.name}</span>
          </div>
        </div>

        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2.5 py-0.5 font-mono text-micro font-bold ${phase.cls}`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-pill ${phase.pip} ${phase.pulse ? 'dot-breathe' : ''}`}
          />
          {phase.label}
        </span>
      </div>

      <p className="mt-gap line-clamp-2 text-note leading-relaxed text-text-secondary">
        {desc || <span className="text-text-quiet">{NO_DESCRIPTION}</span>}
      </p>

      {/* ── The per-phase body ─────────────────────────────────────────────── */}

      {p.tab === 'live' && (
        <div className="mt-card">
          <div className="flex items-center justify-between font-mono text-micro uppercase text-text-tertiary">
            <span>Funding {pct.toFixed(0)}%</span>
            <Remaining deadline={p.genesisDeadline} tab={p.tab} />
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-pill bg-surface-hover">
            <div
              className="h-full rounded-pill bg-gradient-to-r from-brand to-brand-violet"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1.5 font-mono text-note tabular-nums text-text-primary">
            {fmtEth(p.totalEth)} / {fmtEth(p.softCap)} ETH
          </div>
        </div>
      )}

      {p.tab === 'completed' && (
        <div className="mt-card flex items-end justify-between gap-gap">
          <div>
            {/* The mock's label here is "Price". The only price this app can
                state for a trading launch is the live shelf price, which is a
                per-hook chain read the directory does not make — 48 of them to
                paint one grid. What it does hold is what the genesis raise
                settled at, which is also what the ladder opened from. */}
            <div className="font-mono text-micro uppercase text-text-tertiary">
              Raised at genesis
            </div>
            <div className="font-mono text-readout tabular-nums text-text-primary">
              {fmtEth(p.totalEth)} ETH
            </div>
          </div>
          {/* There is no price feed behind this app, so there is nothing to
              compute a 24h delta from. The slot says that rather than showing
              a number — on a screen about money, a plausible placeholder is
              read as a quote. */}
          <span className="font-mono text-micro text-text-quiet">no price feed</span>
        </div>
      )}

      {p.tab === 'launching' && (
        <div className="mt-card rounded-input border border-warning/30 bg-warning/5 px-3 py-2 font-mono text-micro uppercase text-warning">
          {/* The mock reads "Soft cap cleared · ladder deploying", which
              describes something automatic. Nothing deploys on its own here:
              `launch()` is creator-only and expires after LAUNCH_WINDOW, at
              which point every depositor is refunded instead. See v0 audit §D2. */}
          Waiting on creator
        </div>
      )}

      {p.tab === 'archived' && (
        <div className="mt-card rounded-input border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-micro uppercase text-danger">
          Launch window closed · deposits refundable
        </div>
      )}

      {/* The mock's footer is `holders · MC · Vol`, none of which is indexed.
          The strip stays, because the card's rhythm depends on it, carrying the
          two identifiers a reader can actually use. */}
      <div className="mt-card flex items-center justify-between gap-gap border-t border-border-subtle pt-3 font-mono text-micro text-text-tertiary">
        <span className="truncate">{p.token.slice(0, 6)}…{p.token.slice(-4)}</span>
        <span className="shrink-0 text-text-quiet transition-colors group-hover:text-brand">
          View agent →
        </span>
      </div>
    </Link>
  )
}

/**
 * Memoised on the project object. The directory hook hands back a fresh array
 * whenever it re-buckets, but the rows inside it are referentially stable
 * between chain polls, so untouched cards skip the render entirely.
 */
export const ProjectCard = memo(ProjectCardImpl)

/**
 * The landing page's lead card: one project at roughly twice the area.
 *
 * The reference project pairs this with two standard cards in a
 * `lg:grid-cols-2`, so the feature fills the left column while the other two
 * stack in the right. It is the same information as `ProjectCard` with
 * more room to say it — a 56px sigil instead of 40, prose at reading size
 * instead of note size, and the numbers as a three-across row rather than a
 * single line.
 *
 * It carries `.tosh-glow` at 60%, which is the only place besides the hero
 * that gets it. That is what marks it as the lead rather than a size change
 * alone: at a glance the eye finds the lit card, not the big one.
 *
 * WHERE THE MOCK PUTS PRICE / 24H / VOLUME, this puts raised / target /
 * funded. Same three-column row, same type, real numbers — see the note on
 * `ProjectCard` for why the market stats cannot exist here.
 */
function FeatureCardImpl({ project: p }: { project: DirectoryProject }) {
  const router = useRouter()
  const phase = PHASE[p.tab]
  const pct = Math.min(p.progress, 100)
  const desc = p.description?.trim()

  return (
    <Link
      href={`/projects/${p.token}`}
      prefetch
      onMouseEnter={() => {
        rememberProject(directoryToRow(p))
        prefetchProject(p.token)
        router.prefetch(`/projects/${p.token}`)
      }}
      onClick={() => rememberProject(directoryToRow(p))}
      className="group relative flex flex-col justify-between overflow-hidden rounded-panel border border-border-subtle bg-surface-card p-card-lg shadow-panel transition-all hover:border-brand/40 hover:shadow-lift"
    >
      <div className="tosh-glow pointer-events-none absolute inset-0 opacity-60" aria-hidden />

      <div className="relative flex items-start justify-between gap-gap">
        <div className="flex min-w-0 items-center gap-gap">
          <ProjectLogo src={p.logoUrl} name={p.name || p.symbol} className="h-14 w-14" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-gap-tight">
              <span className="font-mono text-title text-text-primary">${p.symbol}</span>
              <span
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2.5 py-0.5 font-mono text-micro font-bold ${phase.cls}`}
              >
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-pill ${phase.pip} ${phase.pulse ? 'dot-breathe' : ''}`}
                />
                {phase.label}
              </span>
            </div>
            <span className="truncate text-readout text-text-secondary">{p.name}</span>
          </div>
        </div>
        <ArrowUpRight
          aria-hidden
          className="h-5 w-5 shrink-0 text-text-tertiary transition-colors group-hover:text-brand"
        />
      </div>

      <p className="relative mt-5 line-clamp-2 text-readout leading-relaxed text-text-secondary">
        {desc || <span className="text-text-quiet">{NO_DESCRIPTION}</span>}
      </p>

      <div className="relative mt-6">
        {p.tab === 'live' ? (
          <div>
            <div className="flex items-center justify-between gap-gap text-note text-text-tertiary">
              <span className="font-mono tabular-nums text-text-primary">
                {fmtEth(p.totalEth)} ETH
              </span>
              <Remaining deadline={p.genesisDeadline} tab={p.tab} precise />
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-pill bg-surface-hover">
              <div className="tosh-gradient-bg h-full rounded-pill" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 font-mono text-micro text-text-tertiary">
              target {fmtEth(p.softCap)}
            </div>
          </div>
        ) : p.tab === 'launching' ? (
          <div className="flex items-center justify-between gap-gap rounded-input border border-warning/30 bg-warning/5 px-3 py-2 font-mono text-micro uppercase text-warning">
            <span>waiting on creator</span>
            <Remaining deadline={p.genesisDeadline} tab={p.tab} precise />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-card border-t border-border-subtle pt-4">
            <div>
              <div className="font-mono text-figure tabular-nums text-text-primary">
                {fmtEth(p.totalEth)}
              </div>
              <div className="font-mono text-micro uppercase text-text-tertiary">raised eth</div>
            </div>
            <div>
              <div className="font-mono text-figure tabular-nums text-text-primary">
                {fmtEth(p.softCap)}
              </div>
              <div className="font-mono text-micro uppercase text-text-tertiary">target eth</div>
            </div>
            <div>
              <div className="font-mono text-figure tabular-nums text-text-primary">
                {pct.toFixed(0)}%
              </div>
              <div className="font-mono text-micro uppercase text-text-tertiary">funded</div>
            </div>
          </div>
        )}
      </div>
    </Link>
  )
}

export const FeatureCard = memo(FeatureCardImpl)

/** The feature card's skeleton — taller, because the card it stands in for is. */
export function SkeletonFeatureCard() {
  return (
    <div className="tosh-shimmer overflow-hidden rounded-panel border border-border-subtle bg-surface-card p-card-lg">
      <div className="flex items-center gap-gap">
        <div className="h-14 w-14 rounded-card bg-surface-hover" />
        <div className="flex flex-col gap-2">
          <div className="h-4 w-24 rounded bg-surface-hover" />
          <div className="h-3 w-32 rounded bg-surface-hover/50" />
        </div>
      </div>
      <div className="mt-5 h-3 w-full rounded bg-surface-hover/30" />
      <div className="mt-2 h-3 w-2/3 rounded bg-surface-hover/20" />
      <div className="mt-6 grid grid-cols-3 gap-card border-t border-border-subtle pt-4">
        {[1, 2, 3].map(i => (
          <div key={i} className="flex flex-col gap-1.5">
            <div className="h-5 w-14 rounded bg-surface-hover" />
            <div className="h-2.5 w-16 rounded bg-surface-hover/40" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function SkeletonCard() {
  return (
    <div className="tosh-shimmer overflow-hidden rounded-panel border border-border-subtle bg-surface-card p-card">
      <div className="flex items-start justify-between gap-gap">
        <div className="flex items-center gap-gap">
          <div className="h-10 w-10 rounded-card bg-surface-hover" />
          <div className="flex flex-col gap-1.5">
            <div className="h-3 w-20 rounded bg-surface-hover" />
            <div className="h-2.5 w-28 rounded bg-surface-hover/50" />
          </div>
        </div>
        <div className="h-4 w-20 rounded-pill bg-surface-hover/60" />
      </div>
      <div className="mt-gap h-2.5 w-full rounded bg-surface-hover/30" />
      <div className="mt-1.5 h-2.5 w-3/4 rounded bg-surface-hover/20" />
      <div className="mt-card h-1.5 w-full rounded-pill bg-surface-hover" />
      <div className="mt-card h-3 w-full rounded bg-surface-hover/20" />
    </div>
  )
}
