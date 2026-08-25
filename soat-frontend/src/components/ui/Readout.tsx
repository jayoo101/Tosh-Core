'use client'

/**
 * Label + value + optional hint.
 *
 * One job: the single most duplicated pattern in this codebase — an uppercase
 * caption on the left, a monospace figure on the right, a dimmer explanation
 * underneath.
 *
 * NON-OBVIOUS CONSTRAINT — nothing here sets `tabular-nums`.  `<body>` sets
 * `font-variant-numeric: tabular-nums` globally in globals.css, which is the
 * single source of that rule; re-declaring it per component is how the two
 * mechanisms ("tnum" feature settings vs. the property) drifted apart before.
 *
 * REPLACES: `Readout` in ProjectTerminal.tsx, `Readout` in admin/page.tsx,
 * `Row` in UserDrawer.tsx, `QuotaLedger`'s internal `row()` closure, and the
 * `<div className="flex justify-between"><span>label</span><span>value</span>`
 * literal in PoGQuotaPanel and ImmutablePact.
 */

import type { ReactNode } from 'react'
import { cn } from './cn'
import { Skeleton } from './Skeleton'

export type ReadoutTone = 'ink' | 'mute' | 'ok' | 'warn' | 'danger' | 'info' | 'admin'
export type ReadoutSize = 'sm' | 'md' | 'figure'

export interface ReadoutProps {
  label: ReactNode
  value: ReactNode
  /** Secondary line under the value — exact figure, unit, caveat. */
  hint?: ReactNode
  tone?: ReadoutTone
  size?: ReadoutSize
  /**
   * `row`   — label left, value right, hairline underneath (the default).
   * `stack` — label above value, no rule; for stat grids and big figures.
   */
  layout?: 'row' | 'stack'
  /** Swaps the value for a shimmer block. */
  loading?: boolean
  /** Drops the bottom hairline in `row` layout. */
  flush?: boolean
  /** Sans instead of mono. For values that are prose, not data. */
  prose?: boolean
  /** Additive only — layout, not colour. */
  className?: string
}

const VALUE_TONE: Record<ReadoutTone, string> = {
  ink: 'text-tosh-ink',
  mute: 'text-tosh-mute',
  ok: 'text-tosh-fluo',
  warn: 'text-tosh-amber',
  danger: 'text-tosh-rust',
  info: 'text-tosh-curve',
  admin: 'text-tosh-admin',
}

const VALUE_SIZE: Record<ReadoutSize, string> = {
  sm: 'text-label tracking-[0.06em] normal-case',
  md: 'text-readout',
  figure: 'text-figure',
}

export function Readout({
  label,
  value,
  hint,
  tone = 'ink',
  size = 'md',
  layout = 'row',
  loading = false,
  flush = false,
  prose = false,
  className,
}: ReadoutProps) {
  const valueNode = loading ? (
    <Skeleton className="h-4 w-24" />
  ) : (
    <span
      className={cn(
        prose ? 'font-sans' : 'font-mono',
        VALUE_SIZE[size],
        VALUE_TONE[tone],
        'break-all',
        layout === 'row' && 'text-right',
      )}
    >
      {value}
    </span>
  )

  if (layout === 'stack') {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <span className="font-mono text-label text-tosh-mute">{label}</span>
        {valueNode}
        {hint !== undefined && (
          <span className="font-mono text-label tracking-[0.12em] text-tosh-faint">{hint}</span>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-1 py-2',
        !flush && 'border-b border-tosh-line/60',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-gap">
        <span className="shrink-0 font-mono text-label text-tosh-mute">{label}</span>
        {valueNode}
      </div>
      {hint !== undefined && (
        <div className="text-right font-mono text-label tracking-[0.12em] text-tosh-faint">
          {hint}
        </div>
      )}
    </div>
  )
}

/**
 * Responsive grid of stacked Readouts — the `grid grid-cols-2 sm:grid-cols-4`
 * block that ShelfLadder, BondingPanel and LiquidityPanel each rebuild.
 */
export function ReadoutGrid({
  columns = 4,
  children,
  className,
}: {
  columns?: 2 | 3 | 4
  children: ReactNode
  className?: string
}) {
  const cols =
    columns === 2
      ? 'grid-cols-1 sm:grid-cols-2'
      : columns === 3
        ? 'grid-cols-2 sm:grid-cols-3'
        : 'grid-cols-2 sm:grid-cols-4'
  return <div className={cn('grid gap-gap', cols, className)}>{children}</div>
}
