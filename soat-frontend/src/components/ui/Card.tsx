'use client'

/**
 * The surface every panel sits on.
 *
 * One job: a bordered, elevated block with an optional header (eyebrow, title,
 * subtitle), a status-badge slot and an action slot.
 *
 * NON-OBVIOUS CONSTRAINT — the header renders only if something is passed for
 * it, and the divider under it renders only if the header rendered.  A Card
 * with just children is a plain surface, so nested panels (the quote box, the
 * shelf table) use the same component instead of a fourth hand-rolled
 * `border border-[#1F1F2E]` div.
 *
 * REPLACES: `Section` in ProjectTerminal.tsx, `Section` in admin/page.tsx,
 * `MeritXCard` in launch/page.tsx, and the `rounded-xl border border-zinc-800
 * bg-zinc-900/50 p-4` literal repeated throughout UserDrawer and the meritx
 * components.
 */

import type { ElementType, ReactNode } from 'react'
import { cn } from './cn'

export type CardTone = 'default' | 'ok' | 'warn' | 'danger' | 'admin'
export type CardPadding = 'none' | 'card' | 'lg'

export interface CardProps {
  /** Monospace eyebrow, rendered as `/// P-1`. */
  id?: string
  title?: ReactNode
  subtitle?: ReactNode
  /** Status-badge slot — top-right of the header. */
  status?: ReactNode
  /** Action slot — sits after `status`, for a header-level control. */
  action?: ReactNode
  /** Tints the border only. The fill stays neutral so tone never shouts. */
  tone?: CardTone
  padding?: CardPadding
  /** Hover lift. Off for static/nested surfaces. Default true. */
  interactive?: boolean
  /** `section` by default; use `div` when nesting inside another Card. */
  as?: Extract<ElementType, 'section' | 'div' | 'article' | 'li'>
  children?: ReactNode
  /** Additive only — layout, not padding or colour. */
  className?: string
}

const TONE_BORDER: Record<CardTone, string> = {
  default: '',
  ok: 'border-tosh-fluo/30',
  warn: 'border-tosh-amber/30',
  danger: 'border-tosh-rust/30',
  admin: 'border-tosh-admin/30',
}

const PADDING: Record<CardPadding, string> = {
  none: '',
  card: 'p-card',
  lg: 'p-card-lg',
}

export function Card({
  id,
  title,
  subtitle,
  status,
  action,
  tone = 'default',
  padding = 'card',
  interactive = true,
  as: Tag = 'section',
  children,
  className,
}: CardProps) {
  const hasHeader =
    id !== undefined ||
    title !== undefined ||
    subtitle !== undefined ||
    status !== undefined ||
    action !== undefined

  return (
    <Tag
      className={cn(
        'tosh-panel flex flex-col gap-gap',
        !interactive && 'hover:border-tosh-line hover:shadow-panel',
        PADDING[padding],
        TONE_BORDER[tone],
        className,
      )}
    >
      {hasHeader && (
        <header className="flex flex-wrap items-start justify-between gap-gap border-b border-tosh-line pb-gap">
          <div className="flex min-w-0 flex-col gap-1">
            {id !== undefined && (
              <span className="font-mono text-label text-tosh-faint">{`/// ${id}`}</span>
            )}
            {title !== undefined && (
              <h3 className="text-title text-tosh-ink">{title}</h3>
            )}
            {subtitle !== undefined && (
              <p className="max-w-2xl text-body text-tosh-mute">{subtitle}</p>
            )}
          </div>
          {(status !== undefined || action !== undefined) && (
            <div className="flex shrink-0 items-center gap-gap-tight">
              {status}
              {action}
            </div>
          )}
        </header>
      )}
      {children}
    </Tag>
  )
}

/**
 * A nested well inside a Card — quote boxes, ledger tables, shelf rows.
 * Flat by design: two hover-lifting surfaces stacked read as a bug.
 */
export function CardWell({
  children,
  padding = 'card',
  tone = 'default',
  className,
}: {
  children: ReactNode
  padding?: CardPadding
  tone?: CardTone
  className?: string
}) {
  return (
    <div className={cn('tosh-raised', PADDING[padding], TONE_BORDER[tone], className)}>
      {children}
    </div>
  )
}

/** Footnote strip pinned under a Card's content, above its bottom padding. */
export function CardFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('border-t border-tosh-line pt-gap text-body text-tosh-faint', className)}>
      {children}
    </div>
  )
}
