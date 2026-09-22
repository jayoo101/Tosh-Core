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
  /**
   * Draw the track as a burning fuse: a cooling trail behind a flickering
   * flame at the leading edge.
   *
   * ORTHOGONAL TO `variant` ON PURPOSE. `variant` picks the height, and the
   * genesis clock is drawn at both — the hairline in the directory grid, the
   * 8px bar on the feature card and the project page — so this could not be a
   * third variant without either duplicating the heights or letting the two
   * copies of one clock disagree.
   *
   * FOR CLOCKS ONLY. A fuse says "this is being consumed and will run out",
   * which is true of the genesis window and false of every other meter here: a
   * raise or a ladder is filling toward something, and lighting it on fire
   * would claim the opposite. `tone` is ignored while it is set, because the
   * fill is a heat ramp rather than a status colour.
   */
  burn?: boolean
  /** Fixed-width `[████──────] 42.0%` echo under the track. */
  ascii?: boolean
  /** Additive only — layout, not colour. */
  className?: string
}

const FILL: Record<ProgressTone, string> = {
  // A filled meter is a report. See the note in Badge.tsx.
  ok: 'bg-success',
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
  burn = false,
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
          'relative w-full bg-border-subtle',
          // The flame is the one thing here that is allowed outside the track:
          // its glow is half the effect and a 2px box would clip all of it. The
          // trail is rounded on its own, so nothing else needed the clip.
          burn ? '' : 'overflow-hidden',
          variant === 'bar' ? 'h-2 rounded-pill' : 'h-0.5',
        )}
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0 transition-[width] duration-300',
            burn
              ? 'fuse-trail rounded-pill'
              : variant === 'bar' ? 'bar-glow rounded-pill' : FILL[tone],
          )}
          style={{ width: `${clamped}%` }}
        />
        {/* Gone at 100 %, because a flame sitting on a spent fuse is the one
            state the metaphor cannot describe. Callers drawing a clock stop
            rendering the track at all by then; this is here so the component
            does not depend on that. */}
        {burn && clamped > 0 && clamped < 100 && (
          <span
            aria-hidden
            className={cn(
              'fuse-head absolute top-1/2 transition-[left] duration-300',
              variant === 'bar' ? 'size-2.5' : 'size-1.5',
            )}
            style={{ left: `${clamped}%` }}
          />
        )}
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
