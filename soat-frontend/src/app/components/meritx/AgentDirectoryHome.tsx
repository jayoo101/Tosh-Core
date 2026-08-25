'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { GitBranch } from 'lucide-react'

import {
  MAINNET_CHAIN_LABEL,
  TESTNET_CHAIN_LABEL,
  CHAIN_STATUS_BADGE,
  CHAIN_POSITIONING,
} from '@/lib/contracts'
import { A2AFeed } from './A2AFeed'
import { MeritXProjectCard, SkeletonCard } from './MeritXProjectCard'
import { TrustPipeline } from './TrustPipeline'
import { useDirectoryProjects, type DirectoryTab } from './useDirectoryProjects'

const TABS: { key: DirectoryTab; label: string }[] = [
  { key: 'live',      label: 'Funding Agents' },
  { key: 'launching', label: 'Awaiting Launch' },
  { key: 'completed', label: 'Active Agents' },
  { key: 'archived',  label: 'Archived' },
]

export default function AgentDirectoryHome() {
  const { projects, counts, loading, refetch, launchCount } = useDirectoryProjects()
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
    <div className="min-h-screen font-sans selection:bg-brand/30">
      <main className="max-w-6xl mx-auto px-4 pb-24 text-zinc-300">

        {/* HERO */}
        <section className="pt-10 pb-8 border-b border-zinc-800/60">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3 mb-4">
              <span className="bg-brand text-black text-[10px] font-bold px-2.5 py-0.5 rounded">{CHAIN_STATUS_BADGE}</span>
              <span className="text-zinc-500 text-[10px] font-mono tracking-widest uppercase">Mainnet: {MAINNET_CHAIN_LABEL}</span>
            </div>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tighter text-white leading-[1.08] mb-3">
              Fair-Launch Terminal for{' '}
              <span className="text-brand">Agent Tokens on {MAINNET_CHAIN_LABEL}.</span>
            </h1>
            <p className="text-zinc-400 text-sm max-w-xl leading-relaxed">
              {CHAIN_POSITIONING} Proof-of-Gas gated genesis in native ETH, Uniswap V4 hook launches, and a 4000-rung discrete shelf ladder for every autonomous agent.
            </p>
            <div className="flex items-center gap-4 mt-5 flex-wrap">
              <Link
                href="/launch"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider text-zinc-300 bg-transparent border border-zinc-700 hover:border-brand/50 hover:text-white transition-all"
              >
                Agent Tokenization
              </Link>
              <a
                href="https://github.com/tosh-protocol"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider text-zinc-300 bg-transparent border border-zinc-700 hover:border-brand/50 hover:text-white transition-all"
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
            <span className="text-[10px] font-mono text-zinc-500 tracking-wider flex-1 min-w-0">
              {loading && isFirstLoad
                ? 'Scanning hooks…'
                : `Hook radar — ${counts.live} funding — ${counts.launching} initializing — ${counts.completed} active — testnet ${TESTNET_CHAIN_LABEL}`}
            </span>
            {!isFirstLoad && (
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[9px] font-black font-mono uppercase tracking-wider border transition-all
                  ${refreshing
                    ? 'border-brand/30 bg-brand/10 text-brand cursor-wait'
                    : 'border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-brand/40 hover:text-brand hover:bg-brand/10'}`}
              >
                <span className={`w-2.5 h-2.5 border border-brand/50 border-t-brand rounded-full animate-spin ${refreshing ? '' : 'invisible'}`} />
                {refreshing ? 'SCANNING…' : '[ REFRESH_RADAR ]'}
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 p-1 bg-zinc-900/60 border border-zinc-800/60 rounded-xl mb-6">
            {TABS.map(tab => {
              const count = counts[tab.key]
              const active = activeTab === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`py-2.5 px-3 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-all flex items-center justify-center gap-1.5
                    ${active ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  {tab.label}
                  {count > 0 && (
                    <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[9px] font-black px-1
                      ${active ? 'bg-brand/20 text-brand' : 'bg-zinc-800/80 text-zinc-600'}`}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {tabProjects.length === 0 && !isFirstLoad ? (
            <div className="relative flex flex-col items-center justify-center py-24 text-center">
              <div className="relative w-28 h-28 mb-8">
                <span className="absolute inset-0 rounded-full border border-brand/20 animate-ping" style={{ animationDuration: '3s' }} />
                <span className="absolute inset-6 rounded-full border border-brand/10 animate-ping" style={{ animationDuration: '3s', animationDelay: '0.5s' }} />
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="w-3 h-3 rounded-full bg-brand/60 shadow-[0_0_12px_rgba(0,255,163,0.5)]" />
                </span>
              </div>
              <p className="text-[11px] font-mono font-bold uppercase tracking-[0.25em] text-zinc-500 mb-2">
                No Active Agents Detected
              </p>
              <p className="text-[10px] font-mono text-zinc-600 max-w-xs mb-6">
                {activeTab === 'live'      && `No genesis windows open. Create the first fair-launch hook on ${TESTNET_CHAIN_LABEL} (Ethereum mainnet target).`}
                {activeTab === 'launching' && 'No launches awaiting creator launch() — soft cap met, curve pending.'}
                {activeTab === 'completed' && 'No agents on the shelf ladder yet.'}
                {activeTab === 'archived'  && 'No archived or refund-eligible records found.'}
              </p>
              <Link
                href="/launch"
                className="group relative inline-flex items-center gap-2.5 px-6 py-3 rounded-xl text-xs font-black uppercase tracking-wider text-black overflow-hidden bg-brand hover:shadow-[0_0_24px_rgba(0,255,163,0.35)] transition-all duration-300"
              >
                Create First Launch
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {isFirstLoad && [1, 2, 3].map(i => <SkeletonCard key={`sk-${i}`} />)}
              {!isFirstLoad && tabProjects.map(p => (
                <MeritXProjectCard key={p.hook} project={p} />
              ))}
            </div>
          )}

          {launchCount === 0 && !loading && (
            <p className="mt-6 text-center text-[10px] font-mono text-zinc-600">
              {TESTNET_CHAIN_LABEL} testnet — awaiting first createLaunch() — pay ETH fee, mine hook salt, open genesis
            </p>
          )}
        </section>

        <TrustPipeline />

        <footer className="mt-6 pt-6 pb-8 border-t border-zinc-800/60">
          <div className="flex items-center justify-between">
            <span className="text-sm font-black text-white tracking-tighter">
              Tosh<span className="text-brand"> Protocol</span>
            </span>
            <span className="text-[10px] text-zinc-600 font-mono" suppressHydrationWarning>
              © {new Date().getFullYear()} Tosh Protocol — {MAINNET_CHAIN_LABEL} — testnet: {TESTNET_CHAIN_LABEL}
            </span>
          </div>
        </footer>
      </main>
    </div>
  )
}
