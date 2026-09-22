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
   * Draw the track as a burning fuse: ash behind a flickering flame, and the
   * unburnt cord still lit ahead of it.
   *
   * ⚠ THE LIT PART IS WHAT REMAINS, NOT WHAT HAS GONE, and it is the one thing
   *   here that is easy to get backwards — both directions render, both
   *   animate, and the difference is invisible in a diff.
   *
   *   `pct` is still what has ELAPSED, unchanged, because that is what the
   *   caller can state without ambiguity. What moved is which side of it gets
   *   the light: the flame sits at `pct`, everything left of it is spent and
   *   falls back to the bare track, and everything right of it is the cord not
   *   yet reached. So the bright band is anchored to the right edge and
   *   SHRINKS as the window runs out, ending as a sliver under the flame.
   *
   *   The first version lit the other side — a bright trail growing out of the
   *   left edge, ash nowhere. It read as a meter filling toward something,
   *   which is the exact misreading the genesis clock has to avoid now that
   *   there is no cap to fill toward, and it had the physics backwards besides:
   *   what a fire leaves behind is dark.
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
          // The bare track doubles as the ash. Nothing paints the spent side,
          // because a fuse that has burnt leaves the cord's own shadow and the
          // empty-meter colour already reads as "nothing here" — a second,
          // darker ash tone would only be distinguishable from this one on a
          // calibrated screen, and the flame is what marks the boundary anyway.
          'relative w-full bg-border-subtle',
          // The flame is the one thing here that is allowed outside the track:
          // its glow is half the effect and a 2px box would clip all of it. The
          // cord is rounded on its own, so nothing else needed the clip.
          burn ? '' : 'overflow-hidden',
          variant === 'bar' ? 'h-2 rounded-pill' : 'h-0.5',
        )}
      >
        {burn ? (
          /* Pinned to the right edge and opened leftward to the flame, rather
             than given a width: the cord's far end is a fixed point and the
             flame is what moves, so `left` is the one value that changes and
             the transition has something single to follow. Driving this by
             width would need `100 - clamped` in two places and get the
             direction wrong in one of them. */
          <div
            className="fuse-cord absolute inset-y-0 right-0 rounded-pill transition-[left] duration-300"
            style={{ left: `${clamped}%` }}
          />
        ) : (
          <div
            className={cn(
              'absolute inset-y-0 left-0 transition-[width] duration-300',
              variant === 'bar' ? 'bar-glow rounded-pill' : FILL[tone],
            )}
            style={{ width: `${clamped}%` }}
          />
        )}
        {/* Gone at 100 %, because a flame sitting on a spent fuse is the one
            state the metaphor cannot describe — and by then there is no cord
            left under it either. Callers drawing a clock stop rendering the
            track at all by then; this is here so the component does not depend
            on that. */}
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
