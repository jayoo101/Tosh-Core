'use client'

/**
 * What is left of the terminal's local primitives.
 *
 * `Section`, `Readout`, `ProgressBar` and `Field` moved to `@/components/ui` as
 * `Card`, `Readout`, `Progress` and `Field`.  These three have not:
 *
 *   • `WriteButton` — its `lockedLabel` cascades are the blocker lists that
 *     `useActionGate` exists to hold, and converting them is a behavioural
 *     change (blocker precedence) rather than a swap.
 *   • `AlarmLine` / `TxLine` — belong to the toast and `AddressLink` surfaces.
 */

import type * as React from 'react'
import { useWaitForTransactionReceipt } from 'wagmi'

import { basescanTx } from './format'

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
