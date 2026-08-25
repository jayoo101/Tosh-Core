'use client'

import Link from 'next/link'
import type { DirectoryProject } from './useDirectoryProjects'
import { fmtEth } from './useDirectoryProjects'
import { LAUNCH_WINDOW_SECONDS } from '@/lib/contracts'
import { CLOCK_UNSYNCED, useNowSec } from '@/components/ui'

function statusBadge(tab: DirectoryProject['tab']) {
  switch (tab) {
    case 'live':
      return { text: '[GENESIS] FUNDING', color: 'text-brand bg-brand/10 border-brand/20' }
    case 'launching':
      return { text: '[PREP] AWAITING LAUNCH', color: 'text-admin bg-admin/10 border-admin/20' }
    case 'completed':
      return { text: '[LIVE] CURVE_ACTIVE', color: 'text-success bg-success/10 border-success/20' }
    case 'archived':
      return { text: '[REFUND] ELIGIBLE', color: 'text-danger bg-danger/10 border-danger/20' }
  }
}

function hms(totalSeconds: number): string {
  const h = String(Math.floor(totalSeconds / 3_600)).padStart(2, '0')
  const m = String(Math.floor((totalSeconds % 3_600) / 60)).padStart(2, '0')
  const s = String(Math.floor(totalSeconds % 60)).padStart(2, '0')
  return `${h}:${m}:${s}`
}

/**
 * Derived during render off the shared clock, where it used to be a `setState`
 * inside a per-card interval. One store now drives every card on the page
 * instead of one timer each, and there is no seeded value for the server and
 * the client to disagree about.
 */
function CardCountdown({ deadline, tab }: { deadline: bigint; tab: DirectoryProject['tab'] }) {
  const nowSec = useNowSec()

  let text: string
  if (tab !== 'live' && tab !== 'launching') {
    text = tab === 'archived' ? 'EXPIRED' : 'LIVE'
  } else if (nowSec === CLOCK_UNSYNCED) {
    text = '--:--:--'
  } else {
    // A `launching` card is already PAST its genesis deadline, so counting to
    // that would just pin it at 00:00:00.  The clock that still matters is the
    // creator's launch window; when it runs out, refunds open instead.
    const target = tab === 'launching'
      ? deadline + LAUNCH_WINDOW_SECONDS
      : deadline
    const diff = Number(target) - nowSec
    text = diff <= 0 ? '00:00:00' : hms(diff)
  }

  return <span className="text-label font-mono tabular-nums text-text-tertiary">{text}</span>
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
    case 'live': return 'text-bg-base bg-brand hover:shadow-[0_0_16px_rgba(0,255,163,0.35)]'
    case 'launching': return 'text-text-primary bg-admin hover:bg-admin'
    case 'completed': return 'text-text-primary bg-success hover:bg-success'
    default: return 'text-text-secondary bg-surface-elevated'
  }
}

export function MeritXProjectCard({ project: p }: { project: DirectoryProject }) {
  const badge = statusBadge(p.tab)
  const sigil = (p.symbol || p.name || '?').charAt(0).toUpperCase()
  const desc = p.description?.trim()
    || `${p.name} ($${p.symbol}) — Proof-of-Gas gated genesis on Tosh Protocol. Deposit ETH before soft cap, claim tokens after the shelf ladder launches.`
  const barCls = p.tab === 'completed'
    ? 'bg-gradient-to-r from-success to-success shadow-[0_0_10px_rgba(16,185,129,0.6)]'
    : p.tab === 'archived'
      ? 'bg-danger/80'
      : 'bar-glow'

  return (
    <Link
      href={`/projects/${p.token}`}
      className={`block relative group p-card-lg rounded-panel border bg-surface-card shadow-panel
        transition-colors hover:bg-surface-hover
        ${p.tab === 'completed'
          ? 'border-success/30 hover:border-success/50'
          : 'border-border-subtle hover:border-border-accent'}`}
    >
      <div className="flex justify-between items-start mb-6">
        <div className="w-12 h-12 rounded-card bg-bg-base border border-border-subtle flex items-center justify-center overflow-hidden shrink-0">
          {p.logoUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={p.logoUrl} alt={p.name} className="w-full h-full object-cover" />
            : <span className="text-2xl font-black text-brand">{sigil}</span>}
        </div>
        <span className={`flex items-center gap-1.5 text-micro font-bold px-2 py-1 rounded border uppercase tracking-widest ${badge.color}`}>
          {(p.tab === 'live' || p.tab === 'completed') && (
            <span className="w-1.5 h-1.5 rounded-full bg-current dot-breathe" />
          )}
          {badge.text}
        </span>
      </div>

      <h3 className="text-xl font-bold text-text-primary mb-1 tracking-tight group-hover:text-brand transition-colors truncate">
        {p.name}
      </h3>
      <p className="text-xs text-text-tertiary font-mono mb-4 uppercase tracking-tighter">
        ${p.symbol} · {p.token.slice(0, 6)}…{p.token.slice(-4)}
      </p>

      <p className="text-sm text-text-secondary line-clamp-3 min-h-[40px] mb-6 leading-relaxed">
        {desc}
      </p>

      <div className="space-y-3">
        <div className="flex justify-between text-xs font-mono">
          <span className="text-text-tertiary uppercase">Genesis Progress</span>
          <span className="text-text-primary font-bold">{Math.min(p.progress, 100).toFixed(1)}%</span>
        </div>
        <div className="w-full h-1.5 bg-surface-elevated rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-1000 ${barCls}`} style={{ width: `${Math.min(100, p.progress)}%` }} />
        </div>
        <div className="flex justify-between text-label font-mono text-text-tertiary">
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
    <div className="tosh-shimmer relative p-card-lg rounded-panel bg-surface-card border border-border-subtle overflow-hidden">
      <div className="flex justify-between items-start mb-6">
        <div className="w-12 h-12 rounded-card bg-surface-hover" />
        <div className="w-32 h-5 rounded bg-surface-hover/60" />
      </div>
      <div className="w-40 h-6 rounded bg-surface-hover mb-2" />
      <div className="w-48 h-3 rounded bg-surface-hover/40 mb-4" />
      <div className="w-full h-3 rounded bg-surface-hover/30 mb-2" />
      <div className="w-3/4 h-3 rounded bg-surface-hover/20 mb-6" />
      <div className="w-full h-1.5 rounded-pill bg-surface-hover" />
    </div>
  )
}
