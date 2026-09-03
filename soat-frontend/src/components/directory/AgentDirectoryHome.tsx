'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { GitBranch } from 'lucide-react'

import {
  MAINNET_CHAIN_LABEL,
  ACTIVE_CHAIN_LABEL,
  IS_TESTNET,
  CHAIN_STATUS_BADGE,
  CHAIN_POSITIONING,
} from '@/lib/contracts'
import { A2AFeed } from './A2AFeed'
import { MeritXProjectCard, SkeletonCard } from './MeritXProjectCard'
import { TrustPipeline } from './TrustPipeline'
import { useDirectoryProjects, type DirectoryTab } from './useDirectoryProjects'

const TABS: { key: DirectoryTab; label: string }[] = [
  { key: 'live',      label: 'Funding' },
  { key: 'launching', label: 'Awaiting launch' },
  { key: 'completed', label: 'Trading' },
  { key: 'archived',  label: 'Archived' },
]

/**
 * Per-tab empty copy.
 *
 * One shared "No active agents detected" used to cover all four, which made
 * three of them wrong: an empty Archived tab is the healthy state, not a
 * detection failure. Each tab now says what would put a card here, because
 * that is the only thing the reader can act on.
 */
const EMPTY_COPY: Record<DirectoryTab, { title: string; body: string }> = {
  live: {
    title: 'Nothing is raising right now',
    body: 'A funding window appears here the moment someone opens one. It stays open for the full 3, 24 or 72 hours the creator picked.',
  },
  launching: {
    title: 'Nothing is waiting to open',
    body: 'Raises that reached their floor wait here until the creator opens trading. They move to Trading as soon as that happens.',
  },
  completed: {
    title: 'No agents are trading yet',
    body: 'Once a raise opens its pool, the agent lands here and its price ladder starts climbing shelf by shelf.',
  },
  archived: {
    title: 'Nothing archived',
    body: 'Raises that missed their floor end up here, along with anything still refundable. An empty tab is the good outcome.',
  },
}

function EmptyTab({
  tab,
  liveCount,
  onBrowseLive,
}: {
  tab: DirectoryTab
  liveCount: number
  onBrowseLive: () => void
}) {
  const { title, body } = EMPTY_COPY[tab]
  // Offering "create the first launch" under Archived is a non-sequitur, so the
  // other tabs point at whatever is actually happening instead.
  const offerLaunch = tab === 'live' || liveCount === 0

  return (
    <div className="flex flex-col items-center gap-gap py-24 text-center">
      <span
        aria-hidden
        className="mb-gap flex h-16 w-16 items-center justify-center rounded-pill border border-border-subtle"
      >
        <span className="dot-breathe h-2 w-2 rounded-pill bg-brand-muted text-brand-muted" />
      </span>

      <h3 className="text-title text-text-primary">{title}</h3>
      <p className="max-w-sm text-body leading-relaxed text-text-secondary">{body}</p>

      {offerLaunch ? (
        <Link
          href="/launch"
          className="mt-gap-tight inline-flex items-center rounded-input bg-brand px-card py-gap-tight text-note font-bold text-bg-base shadow-armed transition-colors hover:bg-brand-hover"
        >
          Open the first launch
        </Link>
      ) : (
        <button
          type="button"
          onClick={onBrowseLive}
          className="mt-gap-tight inline-flex items-center rounded-input border border-border-strong px-card py-gap-tight text-note font-bold text-text-secondary transition-colors hover:border-border-accent hover:text-text-primary"
        >
          See the {liveCount} raising now
        </button>
      )}
    </div>
  )
}

export default function AgentDirectoryHome() {
  const { projects, counts, loading, refetch } = useDirectoryProjects()
  const [activeTab, setActiveTab] = useState<DirectoryTab>('live')
  const [refreshing, setRefreshing] = useState(false)

  const tabProjects = useMemo(
    () => projects.filter(p => p.tab === activeTab),
    [projects, activeTab],
  )

  const handleRefresh = async () => {
    setRefreshing(true)
    await refetch()
    setRefreshing(false)
  }

  const isFirstLoad = loading && projects.length === 0

  return (
    <div className="font-sans selection:bg-brand/30">
      <main className="max-w-6xl mx-auto px-4 pb-page text-text-secondary md:px-6">

        {/* HERO */}
        <section className="pt-10 pb-8 border-b border-border-subtle/60">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3 mb-4">
              <span className="bg-brand text-bg-base text-label font-bold px-2.5 py-0.5 rounded">{CHAIN_STATUS_BADGE}</span>
              {/* Redundant once the badge itself reads "MAINNET · ETHEREUM"; it
                  earns its place only while the badge shows somewhere else. */}
              {IS_TESTNET && (
                <span className="text-text-tertiary text-label font-mono tracking-widest uppercase">
                  Settles on {MAINNET_CHAIN_LABEL}
                </span>
              )}
            </div>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tighter text-text-primary leading-[1.08] mb-3">
              Fair-Launch Terminal for{' '}
              <span className="text-brand">Agent Tokens on {MAINNET_CHAIN_LABEL}.</span>
            </h1>
            <p className="text-text-secondary text-body max-w-xl leading-relaxed">
              {CHAIN_POSITIONING} Fund a launch in ETH through a window your gas history unlocks, then trade it on a 4,000-shelf price ladder. Every launch deploys its own Uniswap V4 pool.
            </p>
            <div className="flex items-center gap-4 mt-5 flex-wrap">
              <Link
                href="/launch"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-input text-note font-bold uppercase tracking-wider text-text-secondary bg-transparent border border-border-strong hover:border-brand/50 hover:text-text-primary transition-all"
              >
                Launch a token
              </Link>
              <a
                href="https://github.com/tosh-protocol"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-input text-note font-bold uppercase tracking-wider text-text-secondary bg-transparent border border-border-strong hover:border-brand/50 hover:text-text-primary transition-all"
              >
                <GitBranch size={14} className="text-brand" />
                GitHub
              </a>
            </div>
          </div>
        </section>

        <A2AFeed />

        {/* AGENT DIRECTORY */}
        <section id="directory" className="pt-8">
          <div className="flex items-center gap-2 mb-6">
            <span className={`w-2 h-2 rounded-full ${loading ? 'bg-brand animate-pulse' : 'bg-brand/40'}`} />
            <span className="min-w-0 flex-1 font-mono text-note text-text-secondary">
              {loading && isFirstLoad
                ? 'Looking for launches…'
                : `${counts.live} funding · ${counts.launching} awaiting launch · ${counts.completed} trading · ${ACTIVE_CHAIN_LABEL}`}
            </span>
            {!isFirstLoad && (
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-input font-mono text-note border transition-all
                  ${refreshing
                    ? 'border-brand/30 bg-brand/10 text-brand cursor-wait'
                    : 'border-border-strong bg-surface-card/60 text-text-secondary hover:border-brand/40 hover:text-brand hover:bg-brand/10'}`}
              >
                <span className={`w-2.5 h-2.5 border border-brand/50 border-t-brand rounded-full animate-spin ${refreshing ? '' : 'invisible'}`} />
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 p-1 bg-surface-card/60 border border-border-subtle/60 rounded-card mb-6">
            {TABS.map(tab => {
              const count = counts[tab.key]
              const active = activeTab === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`py-2.5 px-2 text-label font-bold uppercase tracking-widest rounded-input transition-all flex items-center justify-center gap-1.5 text-center sm:px-3
                    ${active ? 'bg-surface-elevated text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-secondary'}`}
                >
                  {tab.label}
                  {count > 0 && (
                    <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-micro font-black px-1
                      ${active ? 'bg-brand/20 text-brand' : 'bg-surface-elevated/80 text-text-quiet'}`}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {tabProjects.length === 0 && !isFirstLoad ? (
            <EmptyTab
              tab={activeTab}
              liveCount={counts.live}
              onBrowseLive={() => setActiveTab('live')}
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {isFirstLoad && [1, 2, 3].map(i => <SkeletonCard key={`sk-${i}`} />)}
              {!isFirstLoad && tabProjects.map(p => (
                <MeritXProjectCard key={p.hook} project={p} />
              ))}
            </div>
          )}

        </section>

        <TrustPipeline />
      </main>
    </div>
  )
}
