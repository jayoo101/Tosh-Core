'use client'

/**
 * What is left of the terminal's local primitives.
 *
 * `Section`, `Readout` and `ProgressBar` moved to `@/components/ui` as `Card`,
 * `Readout` and `Progress`.  These four have not, because each needs a decision
 * at every call site rather than a rename:
 *
 *   • `Field` — the design-system Field treats `error` and `hint` as mutually
 *     exclusive and takes an error *string*, while this one takes an `errored`
 *     boolean and always shows the hint.  Each call site has to say what its
 *     error actually reads as.
 *   • `WriteButton` — its `lockedLabel` cascades are the blocker lists that
 *     `useActionGate` exists to hold, and converting them is a behavioural
 *     change (blocker precedence) rather than a swap.
 *   • `AlarmLine` / `TxLine` — belong to the toast and `AddressLink` surfaces.
 */

import type * as React from 'react'
import { useWaitForTransactionReceipt } from 'wagmi'

import { basescanTx } from './format'

export function Field({
  label, hint, value, onChange, placeholder, disabled, inputMode,
  errored, fluo, suffix,
}: {
  label:      string
  hint?:      React.ReactNode
  value:      string
  onChange:   (v: string) => void
  placeholder?: string
  disabled?:  boolean
  inputMode?: 'numeric' | 'decimal'
  errored?:   boolean
  fluo?:      boolean
  /** Optional inline suffix button (MAX, etc.) rendered to the right of the
   *  input.  Pass <button>…</button> with .border / .text-* styling. */
  suffix?:    React.ReactNode
}) {
  const borderCls = fluo
    ? 'border-tosh-fluo'
    : errored
      ? 'border-[#444] focus:border-tosh-fluo'
      : 'border-tosh-line focus:border-tosh-fluo'
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-label text-tosh-mute">{label}</span>
      <div className="flex gap-2">
        <input
          type="text" value={value} placeholder={placeholder} disabled={disabled}
          inputMode={inputMode}
          onChange={e => onChange(e.target.value)}
          className={`flex-1 bg-zinc-900/50 border ${borderCls} rounded-lg px-3 py-2.5 font-mono text-sm
                      text-white placeholder:text-zinc-600 tabular-nums
                      disabled:opacity-40 disabled:cursor-not-allowed
                      transition-colors duration-150`}
        />
        {suffix}
      </div>
      {hint && <span className="text-[10px] text-[#666] tracking-wider">{hint}</span>}
    </label>
  )
}

/** The terminal's primary CTA button.  Same three-state pattern as the admin
 *  WriteButton: default white outline, locked gray, busy text swap.
 *
 *  When `lockedLabel` is provided AND `locked` is true, the button's visible
 *  label is replaced with the lockedLabel (e.g. `[INVALID_AMOUNT]` or
 *  `[REVERT: QUOTA_EXCEEDED]`).  This is how the spec wants the L-01 / H-01
 *  cliff to surface — quiet text swap, no glow. */
export function WriteButton({
  label, onClick, locked, busy, full, lockedLabel,
}: {
  label:       React.ReactNode
  onClick:     () => void
  locked?:     boolean
  busy?:       boolean
  full?:       boolean
  lockedLabel?: React.ReactNode
}) {
  const disabled = !!(locked || busy)
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center
                  px-5 py-3 text-xs font-mono uppercase tracking-wider font-bold
                  transition-all duration-150 disabled:cursor-not-allowed rounded-xl
                  ${full ? 'w-full' : ''}
                  ${locked
                    ? 'border border-zinc-800 text-zinc-600 bg-transparent'
                    : 'tosh-nuke-btn'}`}
    >
      {busy
        ? 'transmitting…'
        : locked && lockedLabel
          ? lockedLabel
          : label}
    </button>
  )
}

export function AlarmLine({ msg }: { msg: string | null }) {
  if (!msg) return null
  return (
    <p className="text-[10px] font-mono text-[#888] tracking-wider leading-relaxed">
      <span className="text-tosh-rust">[REVERT]</span> {msg}
    </p>
  )
}

export function TxLine({ hash, label }: { hash?: `0x${string}`; label: string }) {
  const { isLoading, isSuccess } = useWaitForTransactionReceipt({ hash })
  if (!hash) return null
  const stateTxt = isLoading
    ? 'CONFIRMING'
    : isSuccess ? 'ACKNOWLEDGED' : 'PENDING'
  const tone = isSuccess ? 'text-tosh-fluo' : 'text-[#888]'
  return (
    <p className="text-[10px] font-mono tracking-wider flex items-center gap-3 flex-wrap">
      <span className={tone}>[TX]</span>
      <span className="text-[#888]">{label}</span>
      <span className={tone}>{stateTxt}</span>
      <a href={basescanTx(hash)} target="_blank" rel="noopener noreferrer"
         className="text-[#555] hover:text-tosh-fluo break-all">
        {hash.slice(0, 10)}…{hash.slice(-6)}
      </a>
    </p>
  )
}
