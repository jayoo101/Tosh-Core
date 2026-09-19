'use client'

import Link from 'next/link'

import { ProjectLogo } from '@/components/ProjectLogo'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { fmtQuote, type DirectoryProject } from './useDirectoryProjects'

/** How many launches the panel lists before it stops. */
const ROWS = 5

/**
 * Compact phase labels, deliberately not shared with `ProjectCard`.
 *
 * That component's badges read "GENESIS · FUNDING" and "AWAITING LAUNCH",
 * which are the right length for a card with 320px of width to spend and two
 * words too long for a row that also has to fit a sigil, a ticker, a name and
 * a figure. Sharing one table would mean either truncating on the card or
 * wrapping in the row; the labels are the same four states either way.
 */
const PHASE: Record<DirectoryProject['tab'], { label: string; cls: string }> = {
  live:      { label: 'FUNDING',  cls: 'text-brand bg-brand/10 border-brand/25' },
  launching: { label: 'AWAITING', cls: 'text-text-tertiary bg-surface-elevated border-border-subtle' },
  completed: { label: 'TRADING',  cls: 'text-success bg-success/10 border-success/25' },
  archived:  { label: 'REFUND',   cls: 'text-danger bg-danger/10 border-danger/25' },
}

/**
 * The second line of each row's figure column.
 *
 * The redesign puts a price and a 24h delta here. We publish neither: there is
 * no price feed and no volume index behind this app, and the only numbers the
 * chain hands back per launch are the quote asset deposited and the cap it is measured
 * against. Inventing the other two was the single largest piece of fiction in
 * the mock, so the column states what the figure above it IS instead.
 */
function subFigure(p: DirectoryProject): { text: string; cls: string } {
  switch (p.tab) {
    case 'live':      return { text: `${p.progress.toFixed(0)}% of cap`, cls: 'text-brand' }
    case 'launching': return { text: 'cap met',    cls: 'text-text-tertiary' }
    case 'completed': return { text: 'at genesis', cls: 'text-success' }
    case 'archived':  return { text: 'refundable', cls: 'text-danger' }
  }
}

function Row({ project: p, index }: { project: DirectoryProject; index: number }) {
  const phase = PHASE[p.tab]
  const sub = subFigure(p)

  return (
    <Link
      href={`/projects/${p.token}`}
      className="flex items-center gap-gap px-card py-gap-tight transition-colors hover:bg-surface-hover"
    >
      <span className="w-5 shrink-0 font-mono text-micro text-text-quiet tabular-nums">
        {String(index + 1).padStart(2, '0')}
      </span>

      <ProjectLogo src={p.logoUrl} name={p.name || p.symbol} className="h-7 w-7 shrink-0" />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-gap-tight">
          <span className="truncate font-mono text-note font-bold text-text-primary">
            ${p.symbol}
          </span>
          <span className={`shrink-0 rounded border px-1.5 text-micro font-bold uppercase ${phase.cls}`}>
            {phase.label}
          </span>
        </span>
        <span className="truncate text-micro text-text-tertiary">{p.name}</span>
      </span>

      <span className="flex shrink-0 flex-col items-end">
        <span className="font-mono text-note text-text-primary tabular-nums">
          {fmtQuote(p.totalNative)} {QUOTE_SYMBOL}
        </span>
        <span className={`font-mono text-micro tabular-nums ${sub.cls}`}>{sub.text}</span>
      </span>
    </Link>
  )
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-gap px-card py-gap-tight">
      <span className="h-7 w-7 shrink-0 rounded-card bg-surface-hover" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="h-2.5 w-20 rounded bg-surface-hover" />
        <span className="h-2 w-28 rounded bg-surface-hover/50" />
      </span>
      <span className="h-2.5 w-16 rounded bg-surface-hover/60" />
    </div>
  )
}

/**
 * The hero's right-hand column: the newest launches, as live chain state
 * sitting beside the claim the headline makes about it.
 *
 * This is the redesign's one genuinely new element, and it is also where its
 * fiction was densest: the mock's five rows carried a price and a 24h delta
 * per launch, neither of which exists behind this app. What survives the port
 * is the shape - a ranked, numbered, phase-badged list of real launches - and
 * `subFigure` above is where the two invented columns were replaced.
 */
export function HeroFeedPanel({
  projects,
  loading,
}: {
  projects: DirectoryProject[]
  loading: boolean
}) {
  // `projects` arrives newest-first from the hook, so this is a slice and not
  // a sort. Ranking it by size would need a figure that is comparable across
  // phases, and `totalNative` is not one: a finished raise and an open one are
  // measuring different things.
  const rows = projects.slice(0, ROWS)
  const empty = !loading && rows.length === 0

  return (
    // `bg-surface-card/70` + `backdrop-blur-sm`, which is the reference's
    // `bg-card/70`: the hero glow sits behind this panel and the translucency
    // is what lets it through, so an opaque card reads as a hole punched in
    // the gradient. Only works because the glow is an overlay on the hero —
    // there is nothing behind the panel to blur on any other page.
    <div className="overflow-hidden rounded-panel border border-border-subtle bg-surface-card/70 shadow-lift backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border-subtle px-card py-gap-tight">
        <span className="font-mono text-micro uppercase text-text-tertiary">On-chain feed</span>
        {/* "factory events" with a live pip, restored to the reference's
            wording. This said "newest launches" to avoid colliding with the
            FACTORY EVENTS ticker strip that used to sit below the hero; that
            strip is deleted, so there is nothing left to collide with — and
            these rows are factory events, newest first. */}
        <span className="flex items-center gap-1.5 font-mono text-micro text-success">
          <span className="dot-breathe h-1.5 w-1.5 rounded-pill bg-success text-success" />
          factory events
        </span>
      </div>

      <div className="divide-y divide-border-subtle/60">
        {loading && rows.length === 0
          ? Array.from({ length: 3 }, (_, i) => <SkeletonRow key={`sk-${i}`} />)
          : rows.map((p, i) => <Row key={p.hook} project={p} index={i} />)}

        {empty && (
          <p className="px-card py-8 text-center text-note leading-relaxed text-text-tertiary">
            No launches yet. The first one appears here the moment its factory
            event lands.
          </p>
        )}
      </div>
    </div>
  )
}
