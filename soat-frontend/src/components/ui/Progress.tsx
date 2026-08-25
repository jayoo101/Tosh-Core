'use client'

/**
 * Progress meter.
 *
 * One job: show a percentage, with a caption on either side of the track.
 *
 * NON-OBVIOUS CONSTRAINT — `pct` is a percentage (0–100), not a fraction, and
 * it is clamped here.  Genesis raises routinely overshoot their soft cap, so
 * every caller was clamping by hand and one of them forgot; a 140 % bar that
 * runs past its own container is a rendering bug, not a data point.  Show the
 * overshoot in `caption`, not in the track.
 *
 * REPLACES: `ProgressBar` in ProjectTerminal.tsx (including its ASCII echo),
 * the raise-progress bar in UserDrawer's AssetRow, and the `bar-glow` track in
 * meritx/InvestLeftPanel.
 */

import type { ReactNode } from 'react'
import { cn } from './cn'

export type ProgressTone = 'ok' | 'ink' | 'warn' | 'danger' | 'info'

export interface ProgressProps {
  /** 0–100. Clamped. */
  pct: number
  label?: ReactNode
  /** Right-hand figure above the track, e.g. `1.20 / 4.00 ETH`. */
  caption?: ReactNode
  tone?: ProgressTone
  /**
   * `line` — 2px hairline meter, the terminal default.
   * `bar`  — 8px rounded track with the animated `bar-glow` fill; reserve it
   *          for the one headline raise meter per page.
   */
  variant?: 'line' | 'bar'
  /** Fixed-width `[████──────] 42.0%` echo under the track. */
  ascii?: boolean
  /** Additive only — layout, not colour. */
  className?: string
}

const FILL: Record<ProgressTone, string> = {
  ok: 'bg-brand',
  ink: 'bg-text-primary',
  warn: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
}

const ASCII_WIDTH = 28

export function Progress({
  pct,
  label,
  caption,
  tone = 'ok',
  variant = 'line',
  ascii = false,
  className,
}: ProgressProps) {
  const clamped = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0
  const filled = Math.round((clamped / 100) * ASCII_WIDTH)

  return (
    <div className={cn('flex flex-col gap-gap-tight', className)}>
      {(label !== undefined || caption !== undefined) && (
        <div className="flex items-baseline justify-between gap-gap">
          {label !== undefined && (
            <span className="font-mono text-label text-text-tertiary">{label}</span>
          )}
          {caption !== undefined && (
            <span className="font-mono text-label tracking-[0.08em] text-text-secondary">
              {caption}
            </span>
          )}
        </div>
      )}

      <div
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn(
          'relative w-full overflow-hidden bg-border-subtle',
          variant === 'bar' ? 'h-2 rounded-pill' : 'h-0.5',
        )}
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0 transition-[width] duration-300',
            variant === 'bar' ? 'bar-glow rounded-pill' : FILL[tone],
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>

      {ascii && (
        <p className="font-mono text-label tracking-normal text-text-quiet">
          <span>[</span>
          <span className="text-text-primary">
            {'█'.repeat(filled)}
            {'─'.repeat(ASCII_WIDTH - filled)}
          </span>
          <span>]</span> <span className="text-text-primary">{clamped.toFixed(1)}%</span>
        </p>
      )}
    </div>
  )
}
