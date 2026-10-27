'use client'

/* eslint-disable @next/next/no-img-element -- creator-supplied logo URLs on arbitrary hosts */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'

import { directoryToRow } from '@/components/directory/ProjectCard'
import { fmtQuote, type DirectoryProject } from '@/components/directory/useDirectoryProjects'
import { ProjectLogo } from '@/components/ProjectLogo'
import { cn } from '@/components/ui/cn'
import { fmtSig } from '@/components/v2/fmt'
import { fill, useT } from '@/i18n'
import { prefetchProject, rememberProject } from '@/lib/projectCache'
import type { GenesisSummary } from './useV2Summaries'

export type CardStatus = 'live' | 'pending' | 'trading' | 'refund'

export function statusOf(p: DirectoryProject): CardStatus {
  if (p.tab === 'completed') return 'trading'
  if (p.tab === 'archived') return 'refund'
  if (p.tab === 'launching') return 'pending'
  return 'live'
}

export function StatusPill({ status, className }: { status: CardStatus; className?: string }) {
  const t = useT().x
  const label = { live: t.statusLive, pending: t.statusPending, trading: t.statusTrading, refund: t.statusRefund }[status]
  return (
    <span
      className={cn(
        'shrink-0 rounded-input px-1.5 py-0.5 font-mono text-micro uppercase',
        status === 'live' ? 'bg-brand text-bg-base' : status === 'refund' ? 'bg-danger/15 text-danger' : 'bg-surface-hover text-brand',
        className,
      )}
    >
      {label}
    </span>
  )
}

/** Raised so far, against the hard cap when the project is v2 and the lens answered. */
export function raisedLine(p: DirectoryProject, s: GenesisSummary | undefined, t: ReturnType<typeof useT>['x']): string {
  const d = p.quote.decimals
  if (s) return fill(t.raisedOfCap, { raised: fmtSig(s.raised, d), cap: fmtSig(s.hardCap, d), quote: p.quote.symbol })
  return fill(t.raisedOnly, { raised: fmtQuote(p.totalNative, p.quote.decimals), quote: p.quote.symbol })
}

/** A project link that hands the row to the detail page so it paints on the click. */
export function ProjectLink({ project: p, className, children, label }: {
  project: DirectoryProject
  className?: string
  children: ReactNode
  label?: string
}) {
  const router = useRouter()
  const href = `/projects/${p.token}`
  return (
    <Link
      href={href}
      aria-label={label}
      onMouseEnter={() => {
        rememberProject(directoryToRow(p))
        prefetchProject(p.token)
        router.prefetch(href)
      }}
      onClick={() => rememberProject(directoryToRow(p))}
      className={className}
    >
      {children}
    </Link>
  )
}

/**
 * The 16:9 header of a card. Projects have a logo and no cover image, so the
 * cover is the logo twice: blurred to fill the frame, and sharp in the middle.
 */
export function ProjectCover({ project: p, children }: { project: DirectoryProject; children?: ReactNode }) {
  return (
    <div className="relative aspect-[16/9] w-full overflow-hidden bg-bg-subtle">
      <div className="hero-grid absolute inset-0 opacity-70" aria-hidden />
      {p.logoUrl && (
        <img src={p.logoUrl} alt="" aria-hidden className="absolute inset-0 size-full scale-125 object-cover opacity-30 blur-2xl" />
      )}
      <div className="absolute inset-0 flex items-center justify-center transition-transform duration-500 group-hover:scale-105">
        <ProjectLogo src={p.logoUrl} name={p.name || p.symbol} className="size-20 rounded-panel ring-1 ring-brand/40" />
      </div>
      {children}
    </div>
  )
}
