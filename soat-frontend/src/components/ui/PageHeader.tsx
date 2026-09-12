'use client'

/**
 * Page and section headings.
 *
 * One job: own the two largest type steps, so `text-hero` and `text-section`
 * appear in exactly one place each and a page cannot invent a third size.
 *
 * NON-OBVIOUS CONSTRAINT — `accent` is a substring of the title, not a colour
 * prop.  Every page in this app renders its headline as "Protocol *Control*" /
 * "Launch an *agent*" with the tail in the brand colour; passing the two
 * halves separately is what keeps that from being re-hand-rolled as a nested
 * <span> with a different value each time.  It says "the brand colour" rather
 * than naming a hue because the brand stopped being green in 50bc9a7 and this
 * sentence outlived it by naming one.
 *
 * REPLACES: the admin console's page header and `GroupHeader` in admin/page.tsx
 * (as `SectionHeader`).
 *
 * `/launch` IS NO LONGER A CALLER, and this line used to claim it was. The v0
 * port gave that page a single flat mono headline over a `border-b` rule, with
 * no accent tail to split — so it went back to hand-written markup rather than
 * growing this component a "no accent, different type, own rule" mode for one
 * route. Anything that wants the two-tone headline still belongs here.
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
        'flex flex-wrap items-end justify-between gap-card border-b border-border-subtle pb-card-lg',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-gap-tight">
        {(eyebrow !== undefined || status !== undefined) && (
          <div className="flex flex-wrap items-center gap-gap-tight">
            {eyebrow !== undefined && (
              <span className="font-mono text-label text-text-tertiary">{eyebrow}</span>
            )}
            {status}
          </div>
        )}
        <h1 className="text-hero text-text-primary">
          {title}
          {accent !== undefined && <span className="text-brand"> {accent}</span>}
        </h1>
        {subtitle !== undefined && (
          <p className="max-w-2xl text-body text-text-tertiary">{subtitle}</p>
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
    <div className={cn('flex flex-col gap-gap-tight border-t border-border-subtle pt-card', className)}>
      {index !== undefined && (
        <span
          className={cn(
            'font-mono text-label',
            tone === 'admin' ? 'text-admin' : 'text-brand',
          )}
        >
          {index}
        </span>
      )}
      <h2 className="text-section text-text-primary">{title}</h2>
      {blurb !== undefined && <p className="max-w-2xl text-body text-text-tertiary">{blurb}</p>}
    </div>
  )
}
