'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { DirectoryProject } from './useDirectoryProjects'
import { fmtEth } from './useDirectoryProjects'
import { LAUNCH_WINDOW_SECONDS } from '@/lib/contracts'

function statusBadge(tab: DirectoryProject['tab']) {
  switch (tab) {
    case 'live':
      return { text: '[GENESIS] FUNDING', color: 'text-tosh-fluo bg-tosh-fluo/10 border-tosh-fluo/20' }
    case 'launching':
      return { text: '[PREP] AWAITING LAUNCH', color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' }
    case 'completed':
      return { text: '[LIVE] CURVE_ACTIVE', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' }
    case 'archived':
      return { text: '[REFUND] ELIGIBLE', color: 'text-red-400 bg-red-500/10 border-red-500/20' }
  }
}

function CardCountdown({ deadline, tab }: { deadline: bigint; tab: DirectoryProject['tab'] }) {
  const [text, setText] = useState('--:--:--')
  useEffect(() => {
    if (tab !== 'live' && tab !== 'launching') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText(tab === 'archived' ? 'EXPIRED' : 'LIVE')
      return
    }
    // A `launching` card is already PAST its genesis deadline, so counting to
    // that would just pin it at 00:00:00.  The clock that still matters is the
    // creator's launch window; when it runs out, refunds open instead.
    const target = tab === 'launching'
      ? deadline + LAUNCH_WINDOW_SECONDS
      : deadline
    const tick = () => {
      const diff = Number(target) * 1000 - Date.now()
      if (diff <= 0) { setText('00:00:00'); return }
      const h = String(Math.floor(diff / 3_600_000)).padStart(2, '0')
      const m = String(Math.floor((diff % 3_600_000) / 60_000)).padStart(2, '0')
      const s = String(Math.floor((diff % 60_000) / 1000)).padStart(2, '0')
      setText(`${h}:${m}:${s}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [deadline, tab])
  return <span className="text-[10px] font-mono tabular-nums text-zinc-500">{text}</span>
}

function ctaLabel(tab: DirectoryProject['tab']) {
  switch (tab) {
    case 'live': return 'DEPOSIT GENESIS'
    case 'launching': return 'AWAITING LAUNCH'
    case 'completed': return 'VIEW AGENT'
    case 'archived': return 'VIEW REFUND'
  }
}

function ctaCls(tab: DirectoryProject['tab']) {
  switch (tab) {
    case 'live': return 'text-black bg-tosh-fluo hover:shadow-[0_0_16px_rgba(0,255,163,0.35)]'
    case 'launching': return 'text-white bg-purple-600 hover:bg-purple-500'
    case 'completed': return 'text-white bg-emerald-600 hover:bg-emerald-500'
    default: return 'text-zinc-400 bg-zinc-800'
  }
}

export function MeritXProjectCard({ project: p }: { project: DirectoryProject }) {
  const badge = statusBadge(p.tab)
  const sigil = (p.symbol || p.name || '?').charAt(0).toUpperCase()
  const desc = p.description?.trim()
    || `${p.name} ($${p.symbol}) — Proof-of-Gas gated genesis on Tosh Protocol. Deposit ETH before soft cap, claim tokens after the shelf ladder launches.`
  const barCls = p.tab === 'completed'
    ? 'bg-gradient-to-r from-emerald-500 to-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.6)]'
    : p.tab === 'archived'
      ? 'bg-red-500/80'
      : 'bar-glow'

  return (
    <Link
      href={`/projects/${p.token}`}
      className={`block relative group p-6 rounded-2xl transition-all duration-500 bg-zinc-900/20 backdrop-blur-md border hover:shadow-[0_0_30px_rgba(0,255,163,0.08)]
        ${p.tab === 'completed' ? 'border-emerald-500/30 hover:border-emerald-500/50' : 'border-zinc-800 hover:border-tosh-fluo/40'}`}
    >
      <div className="flex justify-between items-start mb-6">
        <div className="w-12 h-12 rounded-xl bg-black border border-zinc-800 flex items-center justify-center overflow-hidden shrink-0">
          {p.logoUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={p.logoUrl} alt={p.name} className="w-full h-full object-cover" />
            : <span className="text-2xl font-black text-tosh-fluo">{sigil}</span>}
        </div>
        <span className={`flex items-center gap-1.5 text-[9px] font-bold px-2 py-1 rounded border uppercase tracking-widest ${badge.color}`}>
          {(p.tab === 'live' || p.tab === 'completed') && (
            <span className="w-1.5 h-1.5 rounded-full bg-current dot-breathe" />
          )}
          {badge.text}
        </span>
      </div>

      <h3 className="text-xl font-bold text-white mb-1 tracking-tight group-hover:text-tosh-fluo transition-colors truncate">
        {p.name}
      </h3>
      <p className="text-xs text-zinc-500 font-mono mb-4 uppercase tracking-tighter">
        ${p.symbol} · {p.token.slice(0, 6)}…{p.token.slice(-4)}
      </p>

      <p className="text-sm text-zinc-400 line-clamp-3 min-h-[40px] mb-6 leading-relaxed">
        {desc}
      </p>

      <div className="space-y-3">
        <div className="flex justify-between text-xs font-mono">
          <span className="text-zinc-500 uppercase">Genesis Progress</span>
          <span className="text-white font-bold">{Math.min(p.progress, 100).toFixed(1)}%</span>
        </div>
        <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-1000 ${barCls}`} style={{ width: `${Math.min(100, p.progress)}%` }} />
        </div>
        <div className="flex justify-between text-[10px] font-mono text-zinc-500">
          <span>Raised: {fmtEth(p.totalEth)} ETH</span>
          <span>Target: {fmtEth(p.softCap)} ETH</span>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <CardCountdown deadline={p.genesisDeadline} tab={p.tab} />
        <span className={`text-xs font-bold px-4 py-2 rounded-lg transition-all ${ctaCls(p.tab)}`}>
          {ctaLabel(p.tab)}
        </span>
      </div>
    </Link>
  )
}

export function SkeletonCard() {
  return (
    <div className="relative p-6 rounded-2xl bg-zinc-900/20 backdrop-blur-md border border-zinc-800 overflow-hidden">
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/[0.03] to-transparent" />
      <div className="flex justify-between items-start mb-6">
        <div className="w-12 h-12 rounded-xl bg-zinc-800/80" />
        <div className="w-32 h-5 rounded bg-zinc-800/60" />
      </div>
      <div className="w-40 h-6 rounded bg-zinc-800/80 mb-2" />
      <div className="w-48 h-3 rounded bg-zinc-800/40 mb-4" />
      <div className="w-full h-3 rounded bg-zinc-800/30 mb-2" />
      <div className="w-3/4 h-3 rounded bg-zinc-800/20 mb-6" />
      <div className="w-full h-1.5 rounded-full bg-zinc-800" />
    </div>
  )
}
