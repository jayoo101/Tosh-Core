'use client'

/**
 * Loading placeholder.
 *
 * One job: occupy the space a value will take, and shimmer while it does.
 *
 * NON-OBVIOUS CONSTRAINT — the shimmer is the existing `.tosh-shimmer` class,
 * not `animate-pulse`.  It paints through an `::after` pseudo-element, so a
 * Skeleton cannot also carry `::after` content of its own, and it needs a
 * height from either `className` or the surrounding layout.
 */

import { cn } from './cn'

export type SkeletonRadius = 'none' | 'input' | 'card' | 'pill'

export interface SkeletonProps {
  /** Give it a size — `h-4 w-24`, `h-full w-full`, etc. */
  className?: string
  radius?: SkeletonRadius
}

const RADIUS: Record<SkeletonRadius, string> = {
  none: '',
  input: 'rounded-input',
  card: 'rounded-card',
  pill: 'rounded-pill',
}

export function Skeleton({ className, radius = 'input' }: SkeletonProps) {
  return (
    <span
      aria-hidden
      className={cn('tosh-shimmer block bg-surface-elevated', RADIUS[radius], className)}
    />
  )
}

/** A stack of shimmer lines, last one short, the way real prose wraps. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-gap-tight', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}

/** Placeholder shaped like a <Readout layout="row">, hairline included. */
export function SkeletonReadout({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-baseline justify-between gap-gap border-b border-border-subtle/60 py-2"
        >
          <Skeleton className="h-2.5 w-28" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  )
}
