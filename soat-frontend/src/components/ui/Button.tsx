'use client'

/**
 * The button.
 *
 * One job: render an action with a variant, a size, and the three states every
 * write button in this codebase hand-rolls — armed, locked-with-a-reason, and
 * busy.
 *
 * NON-OBVIOUS CONSTRAINT — `busy` and `disabledLabel` are mutually exclusive
 * in the type, because they were mutually exclusive in behaviour and the
 * hand-rolled versions kept getting it wrong: a busy button that also swaps in
 * `[quota_exceeded]` tells the user the transaction they just signed is
 * invalid.  Busy always wins and always says so.
 *
 * REPLACES: `WriteButton` in admin/page.tsx, `WriteButton` in
 * ProjectTerminal.tsx, the `tosh-nuke-btn` CTA in launch/page.tsx, and the
 * bespoke `[ CLAIM_TOKENS ]` / `Withdraw` buttons in UserDrawer.tsx.
 *
 * For any button whose enabled state depends on wallet, network or on-chain
 * preconditions, do not reach for this directly — use <ActionButton/>, which
 * derives all of that and renders this.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

export type ButtonVariant = 'primary' | 'danger' | 'ghost' | 'quiet'
export type ButtonSize = 'sm' | 'md' | 'lg'

/** Busy carries its own label; a locked button carries a swapped-in one. */
type ButtonStateProps =
  | {
      busy?: false
      busyLabel?: never
      /** Shown instead of `label` while `disabled`, e.g. `[cooldown 00:12:31]`. */
      disabledLabel?: ReactNode
    }
  | {
      busy: true
      /** Default `'transmitting…'`. */
      busyLabel?: ReactNode
      disabledLabel?: never
    }

type NativeButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'type' | 'className'
>

export type ButtonProps = NativeButtonProps &
  ButtonStateProps & {
    label: ReactNode
    variant?: ButtonVariant
    size?: ButtonSize
    /** Stretch to the container width. */
    full?: boolean
    /** Leading icon; sized by the caller. */
    icon?: ReactNode
    /**
     * Why the button is disabled.  Rendered as the native tooltip and exposed
     * to assistive tech — never swallowed.
     */
    reason?: string | null
    type?: 'button' | 'submit'
    /** Additive only — layout, not padding or colour. See `cn`. */
    className?: string
  }

const BASE =
  'inline-flex items-center justify-center gap-gap-tight ' +
  'font-mono uppercase font-bold whitespace-nowrap ' +
  'rounded-input border ' +
  'transition-[background-color,border-color,color,box-shadow] ' +
  'focus-visible:outline-1 focus-visible:outline-offset-2 ' +
  'disabled:cursor-not-allowed'

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-label',
  md: 'px-5 py-2.5 text-label',
  lg: 'px-6 py-3.5 text-[0.6875rem] tracking-[0.24em]',
}

const ARMED: Record<ButtonVariant, string> = {
  primary:
    'border-tosh-fluo/45 bg-tosh-fluo/10 text-tosh-fluo ' +
    'hover:bg-tosh-fluo hover:text-tosh-canvas hover:border-tosh-fluo ' +
    'hover:shadow-armed active:bg-tosh-fluo-dim',
  danger:
    'border-tosh-rust/45 bg-tosh-rust/10 text-tosh-rust ' +
    'hover:bg-tosh-rust hover:text-tosh-canvas hover:border-tosh-rust ' +
    'active:bg-tosh-rust-dim',
  ghost:
    'border-tosh-line bg-transparent text-tosh-mute ' +
    'hover:border-tosh-fluo hover:text-tosh-fluo',
  quiet:
    'border-transparent bg-transparent text-tosh-mute ' +
    'hover:text-tosh-ink',
}

/** Locked and busy look the same on purpose: neither is a thing to click. */
const INERT = 'border-tosh-line bg-transparent text-tosh-faint'

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  full = false,
  icon,
  reason,
  busy,
  busyLabel,
  disabledLabel,
  disabled,
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  const inert = busy === true || disabled === true
  const content = busy === true
    ? (busyLabel ?? 'transmitting…')
    : disabled === true && disabledLabel !== undefined
      ? disabledLabel
      : label

  return (
    <button
      {...rest}
      type={type}
      disabled={inert}
      title={inert && reason ? reason : rest.title}
      aria-busy={busy === true || undefined}
      aria-describedby={undefined}
      className={cn(
        BASE,
        SIZES[size],
        inert ? INERT : ARMED[variant],
        busy === true && 'animate-pulse',
        full && 'w-full',
        className,
      )}
    >
      {icon !== undefined && !busy && <span aria-hidden>{icon}</span>}
      <span>{content}</span>
    </button>
  )
}
