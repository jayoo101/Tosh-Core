'use client'

/**
 * Page and section headings.
 *
 * One job: own the two largest type steps, so `text-hero` and `text-section`
 * appear in exactly one place each and a page cannot invent a third size.
 *
 * NON-OBVIOUS CONSTRAINT — `accent` is a substring of the title, not a colour
 * prop.  Every page in this app renders its headline as "Protocol *Control*" /
 * "Create a *Tosh Launch*" with the tail in fluorescent green; passing the two
 * halves separately is what keeps that from being re-hand-rolled as a nested
 * <span> with a different green each time.
 *
 * REPLACES: the `<header>` block in launch/page.tsx, the admin console's page
 * header, and `GroupHeader` in admin/page.tsx (as `SectionHeader`).
 */

import type { ReactNode } from 'react'
import { cn } from './cn'

export interface PageHeaderProps {
  /** Monospace kicker above the title. */
  eyebrow?: ReactNode
  title: ReactNode
  /** Trailing fragment of the title, rendered in the accent colour. */
  accent?: ReactNode
  subtitle?: ReactNode
  /** Badge slot — chain status, read-only warning. */
  status?: ReactNode
  /** Right-hand controls — the wallet bar. */
  actions?: ReactNode
  /** Additive only — layout, not colour. */
  className?: string
}

export function PageHeader({
  eyebrow,
  title,
  accent,
  subtitle,
  status,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        'flex flex-wrap items-end justify-between gap-card border-b border-tosh-line pb-card-lg',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-gap-tight">
        {(eyebrow !== undefined || status !== undefined) && (
          <div className="flex flex-wrap items-center gap-gap-tight">
            {eyebrow !== undefined && (
              <span className="font-mono text-label text-tosh-mute">{eyebrow}</span>
            )}
            {status}
          </div>
        )}
        <h1 className="text-hero text-tosh-ink">
          {title}
          {accent !== undefined && <span className="text-tosh-fluo"> {accent}</span>}
        </h1>
        {subtitle !== undefined && (
          <p className="max-w-2xl text-body text-tosh-mute">{subtitle}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-gap">{actions}</div>}
    </header>
  )
}

export interface SectionHeaderProps {
  /** Governance-group index, e.g. `G3 · SAFETY & RISK`. */
  index?: ReactNode
  title: ReactNode
  /** One paragraph on what this group of cards governs. */
  blurb?: ReactNode
  tone?: 'default' | 'admin'
  className?: string
}

export function SectionHeader({
  index,
  title,
  blurb,
  tone = 'default',
  className,
}: SectionHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-gap-tight border-t border-tosh-line pt-card', className)}>
      {index !== undefined && (
        <span
          className={cn(
            'font-mono text-label',
            tone === 'admin' ? 'text-tosh-admin' : 'text-tosh-fluo',
          )}
        >
          {index}
        </span>
      )}
      <h2 className="text-section text-tosh-ink">{title}</h2>
      {blurb !== undefined && <p className="max-w-2xl text-body text-tosh-mute">{blurb}</p>}
    </div>
  )
}
