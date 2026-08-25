'use client'

/**
 * Status pill.
 *
 * One job: name a state in one or two words, tinted by semantic tone.
 *
 * NON-OBVIOUS CONSTRAINT — the tone vocabulary is closed, and it is the same
 * vocabulary the action gate uses for blocker tones.  A blocker's `tone` can
 * be handed straight to a badge, so the pill on a card and the reason under
 * its button can never disagree about how serious something is.
 *
 * REPLACES: `StatusBadge` in admin/page.tsx (two-state ok/bad only), the
 * inline `GENESIS` / `CURVE` / `[ TRANSFERRED_CLOSED ]` spans in
 * UserDrawer.tsx, the `status.cls` object in meritx/InvestLeftPanel, and the
 * `GATE OPEN` / `LADDER HALTED` spans in ProjectTerminal.
 */

import type { ReactNode } from 'react'
import { cn } from './cn'

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'admin' | 'neutral'

export interface BadgeProps {
  tone?: Tone
  children: ReactNode
  /** Leading dot. Pair with `live` for the breathing pip. */
  pip?: boolean
  /** Animate the pip. Only for states that are genuinely streaming. */
  live?: boolean
  size?: 'sm' | 'md'
  /** Hover explanation — badges are terse by design, so say more here. */
  title?: string
  /** Additive only — layout, not colour. */
  className?: string
}

const TONES: Record<Tone, string> = {
  ok: 'border-brand/40 bg-brand/10 text-brand',
  warn: 'border-warning/40 bg-warning/10 text-warning',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  info: 'border-info/40 bg-info/10 text-info',
  admin: 'border-admin/40 bg-admin/10 text-admin',
  neutral: 'border-border-subtle bg-surface-elevated text-text-tertiary',
}

export function Badge({
  tone = 'neutral',
  children,
  pip = false,
  live = false,
  size = 'md',
  title,
  className,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-gap-tight rounded-pill border font-mono uppercase',
        size === 'sm' ? 'px-2 py-0.5 text-micro tracking-[0.2em]' : 'px-3 py-1 text-label',
        TONES[tone],
        className,
      )}
    >
      {pip && (
        <span
          aria-hidden
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-current', live && 'dot-breathe')}
        />
      )}
      {children}
    </span>
  )
}
