'use client'

/**
 * The one primary button on an action card.
 *
 * One job: render an `ActionVerdict`.  It holds no state, derives nothing, and
 * has no `disabled` or `onClick` prop — if you find yourself wanting either,
 * the condition belongs in the gate's blocker list, where it can also explain
 * itself.
 *
 * NON-OBVIOUS CONSTRAINT — the verdict's `reason` is surfaced twice: as the
 * native tooltip and, by default, as a hint line under the button.  A disabled
 * button with no explanation was the failure this whole mechanism exists to
 * prevent, so `showReason` defaults to on and turning it off should be a
 * deliberate choice made because the reason is already on screen.
 *
 * The `connect` verdict is the one exception, and it is not a judgement call:
 * its label already reads "Connect Wallet", so the hint would restate it.  On a
 * page with sixteen levers — the admin console — that restatement printed the
 * same sentence sixteen times down the page.
 */

import { cn } from './cn'
import { Button, type ButtonSize } from './Button'
import type { ActionGate, VerdictTone } from './actionGate'

export interface ActionButtonProps {
  gate: ActionGate
  size?: ButtonSize
  full?: boolean
  /**
   * Visual weight of the READY state only. `danger` for irreversible writes —
   * halt the ladder, hand over ownership, blacklist a wallet.
   * Blocked, busy and switch states pick their own treatment.
   */
  intent?: 'primary' | 'danger'
  /** Hint line under the button. Default true. */
  showReason?: boolean
  /** Additive only — layout, not padding or colour. */
  className?: string
}

const HINT_TONE: Record<VerdictTone, string> = {
  ok: 'text-brand',
  danger: 'text-danger',
  warn: 'text-warning',
  info: 'text-info',
  neutral: 'text-text-tertiary',
}

export function ActionButton({
  gate,
  size = 'md',
  full = true,
  intent = 'primary',
  showReason = true,
  className,
}: ActionButtonProps) {
  const { verdict } = gate
  const busy = verdict.kind === 'busy'

  const variant =
    verdict.kind === 'ready'
      ? intent
      : verdict.kind === 'switch'
        ? 'primary'
        : verdict.kind === 'connect'
          ? 'ghost'
          : 'ghost'

  // `items-start` matters: a flex column stretches its children, so without it
  // a `full={false}` button still spans the card it sits in.
  return (
    <div
      className={cn(
        'flex flex-col gap-gap-tight',
        full ? 'w-full' : 'items-start',
        className,
      )}
    >
      {busy ? (
        <Button label={verdict.label} busy busyLabel={verdict.label} size={size} full={full} />
      ) : (
        <Button
          label={verdict.label}
          variant={variant}
          size={size}
          full={full}
          disabled={verdict.disabled}
          disabledLabel={verdict.label}
          reason={verdict.reason}
          onClick={verdict.act ?? undefined}
        />
      )}

      {showReason && verdict.reason !== null && verdict.kind !== 'connect' && (
        <p
          className={cn(
            'font-mono text-label leading-relaxed tracking-[0.12em]',
            HINT_TONE[verdict.tone],
          )}
        >
          {`→ ${verdict.reason}`}
        </p>
      )}
    </div>
  )
}
