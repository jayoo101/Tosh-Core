import type { ReactNode } from 'react'
import { cn } from '@/components/ui/cn'

/** A section on the detail pages: card fill, rotating gold rim, optional caption. */
export function Panel({ title, children, className, id }: {
  title?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section id={id} className={cn('glow-frame flex flex-col gap-5 rounded-panel bg-surface-card/80 p-6 md:p-8', className)}>
      {title && <h2 className="text-label uppercase text-text-tertiary">{title}</h2>}
      {children}
    </section>
  )
}

/** The headline numbers, one row on desktop, two columns below. */
export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="glow-frame glow-delay grid grid-cols-1 overflow-hidden rounded-panel bg-surface-card/80 sm:grid-cols-2 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none">
      {children}
    </div>
  )
}

export function Stat({ label, value, sub, highlight, children }: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  highlight?: boolean
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border-subtle p-6 last:border-b-0 sm:border-r lg:border-b-0 lg:last:border-r-0">
      <span className="text-label uppercase text-text-tertiary">{label}</span>
      <span className={cn('font-mono text-3xl font-bold', highlight ? 'text-brand' : 'text-text-primary')}>{value}</span>
      {children}
      {sub && <span className="font-mono text-note text-text-tertiary">{sub}</span>}
    </div>
  )
}

export function Bar({ pct, label, thick = false }: { pct: number; label: string; thick?: boolean }) {
  const v = Math.min(Math.max(pct, 0), 100)
  return (
    <div
      className={cn('overflow-hidden rounded-pill bg-surface-hover', thick ? 'h-2' : 'h-1.5')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
    >
      <div className="h-full rounded-pill bg-brand" style={{ width: `${v}%` }} />
    </div>
  )
}

/** Key/value row for the quote boxes. */
export function Row({ k, v, strong }: { k: ReactNode; v: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-text-tertiary">{k}</dt>
      <dd className={cn('text-right font-mono', strong ? 'text-readout font-bold text-brand' : 'text-text-primary')}>{v}</dd>
    </div>
  )
}
