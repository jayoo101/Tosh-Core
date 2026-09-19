'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { ArrowRight, Rocket } from 'lucide-react'

import {
  MAINNET_CHAIN_LABEL,
  ACTIVE_CHAIN_LABEL,
  CHAIN_STATUS_BADGE,
  BADGE_NAMES_SETTLEMENT_CHAIN,
  CHAIN_STAGING_NOTE,
} from '@/lib/contracts'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { HeroFeedPanel } from './HeroFeedPanel'
import {
  FeatureCard,
  ProjectCard,
  SkeletonCard,
  SkeletonFeatureCard,
} from './ProjectCard'
import { TrustPipeline } from './TrustPipeline'
import { useDirectoryProjects } from './useDirectoryProjects'

/* The four-tab `TABS` list, the per-phase `EMPTY_COPY` and the `EmptyTab`
 * component all lived here and are gone. They served the phase tabs, and the
 * phase tabs are now the sidebar on `/projects` — which has its own empty
 * states written against the filter the reader actually set, including the
 * search term, which this version could not see. Nothing imported them from
 * outside this file. */

export default function AgentDirectoryHome() {
  const { projects, loading } = useDirectoryProjects()

  /**
   * The three launches the teaser shows: one feature and two beside it.
   *
   * NO TAB STATE ANY MORE. Choosing a phase, and remembering whether the
   * reader chose it or the page defaulted to it, was the most intricate part
   * of this component — and all of it moved to `/projects`, where it belongs
   * alongside the search and sort controls it was always missing.
   *
   * `archived` and `launching` are excluded. The reference project filters to
   * trading and funding for the same reason: this block is an invitation, and
   * a refundable raise or one waiting on its creator is not something a
   * visitor can act on. They are one click away under the phase sidebar.
   *
   * ORDERED BY AMOUNT RAISED, where the mock orders by 24h volume. There is no
   * volume index behind this app, and of the numbers there are, the size of
   * the raise is the closest thing to "this one has the most behind it".
   */
  const { feature, rest } = useMemo(() => {
    const trending = projects
      .filter(p => p.tab === 'completed' || p.tab === 'live')
      .sort((a, b) => (a.totalNative === b.totalNative ? 0 : a.totalNative > b.totalNative ? -1 : 1))
      .slice(0, 3)
    const [first, ...others] = trending
    return { feature: first, rest: others }
  }, [projects])

  const isFirstLoad = loading && projects.length === 0

  return (
    <div className="font-sans selection:bg-brand/30">
      {/* FULL-BLEED SECTIONS, EACH WITH ITS OWN COLUMN INSIDE.
          This used to be one `max-w-7xl mx-auto px-4` main wrapping every
          section, which is the arrangement the reference project inverts: its
          sections span the viewport and the `max-w-7xl` lives one level down.
          The difference only shows on the things that are supposed to reach
          the edges — the hero's bottom rule stopped at the content column and
          read as an underline under the copy rather than as a band across the
          page, and the hero glow was clipped to the same box. */}
      <main className="text-text-secondary">

        {/* ── HERO ──────────────────────────────────────────────────────────
            Two columns above the fold: the claim on the left, live chain state
            on the right. The single column it replaced put the feed BELOW the
            headline, so the first evidence that anything was actually running
            sat under a scroll on every laptop. */}
        {/* `1.15fr_1fr` AND `self-center`, both straight from the reference.
            The feed was previously capped at 24rem and top-aligned, on the
            argument that a panel whose height depends on how many launches
            exist should not be centred in a tall hero — with one launch on the
            factory, `self-center` parks a single row in the middle of a 400px
            column. That argument is still true and the reference still wins:
            at 1.15fr/1fr the feed is a column of the hero rather than a widget
            parked beside it, which is the whole point of the asymmetric split.
            If the one-row case needs fixing later, fix it by giving the panel a
            min-height, not by re-capping the column. */}
        <section className="relative overflow-hidden border-b border-border-subtle">
          {/* `.tosh-glow` is the reference project's, and it is an overlay on
              the hero rather than a layer on the page backdrop — only the
              landing page gets it. `overflow-hidden` on the section keeps its
              bottom-left lobe inside the band. */}
          <div className="tosh-glow pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative mx-auto grid max-w-7xl gap-page px-4 py-16 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:gap-section lg:py-24">
          {/* `gap-card-lg` on the column, not margins on each child: the
              reference spaces these four blocks uniformly, and four margins
              that have to stay equal is four places to get it wrong. */}
          <div className="flex min-w-0 flex-col items-start justify-center gap-card-lg">
            <div className="flex flex-wrap items-center gap-gap-tight">
              {/* One pill, naming the chain once. The headline below used to end
                  in `MAINNET_CHAIN_LABEL` and the paragraph opened by naming it
                  again; see `CHAIN_STAGING_NOTE` in lib/chain.ts for the four
                  times it appeared above the fold before. "Infinity" is a
                  literal because it is not a chain and cannot drift with one. */}
              <span className="inline-flex items-center gap-1.5 rounded-pill border border-brand/30 bg-brand/10 px-2.5 py-1 font-mono text-micro uppercase text-brand">
                <span className="dot-breathe h-1.5 w-1.5 rounded-pill bg-brand text-brand" />
                {CHAIN_STATUS_BADGE} · Infinity
              </span>
              {/* Only when the pill does not already name the settlement chain,
                  which on every arm but the devnet one it does. This matters
                  MORE now than it did: the headline no longer carries the
                  chain's name, so on a devnet this line is the only thing above
                  the fold that says where Tosh settles. */}
              {!BADGE_NAMES_SETTLEMENT_CHAIN && (
                <span className="font-mono text-micro uppercase text-text-tertiary">
                  Settles on {MAINNET_CHAIN_LABEL}
                </span>
              )}
            </div>

            {/* HARD LINE BREAKS, as in the reference. At 72px this headline
                wraps to three lines in the 1.15fr column at every desktop
                width, and letting it wrap on its own moved the break between
                "for" and "agent" by a word or two as the viewport changed —
                which moved the gradient with it. The breaks are what put
                "agent tokens." alone on its own line, and that line being the
                gradient one is the design.

                `text-balance` still applies below `sm:`, where the breaks are
                suppressed and the browser wraps. The explicit `{' '}` are for
                that arm: JSX drops the whitespace around a tag on its own
                line, so with the breaks hidden the words would run together.
                CSS trims leading and trailing spaces on a line, so they cost
                nothing on the arm that does break. */}
            <h1 className="text-balance font-mono text-hero text-text-primary sm:text-display">
              Fair-launch
              <br className="hidden sm:inline" />
              {' '}terminal for{' '}
              <br className="hidden sm:inline" />
              {/* `.tosh-gradient-text`, not `bg-gradient-to-r from-brand
                  to-brand-violet`: same two stops, but the reference sweeps
                  them at 100deg and `to-r` is 90deg. On one short line that is
                  a subtle difference; it is the same class the CTA and the
                  progress bars use, so spelling it out per call site is how
                  the four of them drift apart. */}
              <span className="tosh-gradient-text">agent tokens.</span>
            </h1>

            <p className="max-w-md text-lede text-text-secondary">
              {CHAIN_STAGING_NOTE && `${CHAIN_STAGING_NOTE} `}
              Fund a launch in {QUOTE_SYMBOL} through a window your gas history unlocks, then trade it on a 4,000-shelf price ladder. Every launch deploys its own PancakeSwap Infinity pool.
            </p>

            {/* `min-h-11` is 44px, the touch floor. The base rule in globals.css
                cannot reach these: it is scoped to header / nav / footer so that
                an inline link inside a paragraph does not get a 44px box and
                tear a hole in the prose around it. A button-shaped link in main
                asks for the floor explicitly. */}
            {/* SENTENCE CASE AND UNTRACKED, per the reference. These were
                `uppercase tracking-wider text-note` — the terminal signature
                the rest of the app's captions carry. On a 72px headline it
                read as a third caption rather than as the page's primary
                action, and the reference sets both buttons in plain sentence
                case at `text-sm font-semibold`. The signature stays on the
                labels and status pills, which is where it does its work. */}
            <div className="flex flex-wrap items-center gap-gap pt-1">
              <Link
                href="/launch"
                className="tosh-gradient-bg inline-flex min-h-11 items-center gap-2 rounded-input px-5 py-3 text-readout font-semibold text-bg-base shadow-lift transition-opacity hover:opacity-90"
              >
                <Rocket size={16} />
                Launch a token
              </Link>
              {/* A route now, not the `#directory` anchor into the section
                  below. The anchor was correct while this page was the only
                  directory; `/projects` is where the filtering, search and
                  sorting live, and sending the hero's second button to a
                  scroll position instead of to that page is sending it to the
                  smaller half of the same thing. */}
              <Link
                href="/projects"
                className="inline-flex min-h-11 items-center gap-2 rounded-input border border-border-subtle bg-surface-card px-5 py-3 text-readout font-semibold text-text-primary transition-colors hover:border-brand/50"
              >
                Agent directory
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>

          {/* `self-center` is the reference's; see the note on the section. */}
          <div className="flex min-w-0 flex-col self-center">
            <HeroFeedPanel projects={projects} loading={loading} />
          </div>
          </div>
        </section>

        {/* ── ACTIVE MARKETS ──────────────────────────────────────────────
            A TEASER, NOT A DIRECTORY. This section used to be the directory:
            four phase tabs with counts, a live status line, a Refresh button
            and per-tab empty copy. All of that was right while `/projects`
            redirected here and this was the only place to browse from.
            `/projects` is a real page now, with the tabs promoted to a phase
            sidebar, plus search and sorting this section never had — so the
            controls here were a worse second copy of a better screen, and
            the reference design does not have them. Three cards and a way
            through to the full list is the whole job.

            The tab state, the refresh handler and the per-tab empty copy went
            with them; `EmptyTab` and `TABS` are gone from this file entirely
            rather than left behind unreferenced. */}
        <section id="directory" className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <div className="mb-section flex items-end justify-between gap-gap">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-mono text-label uppercase text-brand">Trending now</span>
              <h2 className="font-mono text-section text-text-primary">Active markets</h2>
            </div>
            <Link
              href="/projects"
              className="inline-flex shrink-0 items-center gap-1.5 text-readout font-medium text-text-secondary transition-colors hover:text-brand"
            >
              View all
              <ArrowRight aria-hidden className="h-3.5 w-3.5" />
            </Link>
          </div>

          {/* ONE FEATURE PLUS TWO STACKED, which is the reference layout and
              also the reason `trending` is capped at three: the right column
              holds exactly two standard cards at the feature's height. A
              fourth would either stretch the column or orphan a row. */}
          {isFirstLoad ? (
            <div className="grid gap-card lg:grid-cols-2">
              <SkeletonFeatureCard />
              <div className="grid gap-card">
                <SkeletonCard />
                <SkeletonCard />
              </div>
            </div>
          ) : feature === undefined ? (
            <div className="flex flex-col items-center gap-gap rounded-panel border border-border-subtle bg-surface-card px-card py-24 text-center">
              <h3 className="text-title text-text-primary">Nothing is trading or raising yet</h3>
              <p className="max-w-sm text-body leading-relaxed text-text-secondary">
                The first launch appears here the moment its factory event lands.
                Until then, {ACTIVE_CHAIN_LABEL} has nothing open.
              </p>
              <Link
                href="/launch"
                className="mt-gap-tight inline-flex min-h-11 items-center rounded-input bg-brand px-card py-gap-tight text-note font-bold text-bg-base shadow-armed transition-colors hover:bg-brand-hover"
              >
                Open the first launch
              </Link>
            </div>
          ) : (
            <div className="grid gap-card lg:grid-cols-2">
              <FeatureCard project={feature} />
              {rest.length > 0 && (
                <div className="grid gap-card">
                  {rest.map(p => <ProjectCard key={p.hook} project={p} />)}
                </div>
              )}
            </div>
          )}
        </section>

        <TrustPipeline />
      </main>
    </div>
  )
}
