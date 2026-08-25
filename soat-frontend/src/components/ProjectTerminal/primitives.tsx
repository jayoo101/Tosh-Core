'use client'
import type * as React from 'react'
import { useWaitForTransactionReceipt } from 'wagmi'

import { basescanTx } from './format'

// ─────────────────────────────────────────────────────────────────────────────
// MINIMAL PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────


export const labelCls = 'text-[10px] tracking-[0.32em] uppercase text-[#888] font-light'

export function Section({
  id, title, subtitle, action, children,
}: {
  id?:       string
  title:     string
  subtitle?: string
  action?:   React.ReactNode
  children:  React.ReactNode
}) {
  return (
    <section className="glass-card rounded-2xl p-6 flex flex-col gap-4 mt-6">
      <header className="flex items-start justify-between gap-4 flex-wrap border-b border-zinc-800/60 pb-4">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest font-mono">
            {id ? `/// ${id}` : '/// TERMINAL'}
          </div>
          <h3 className="text-lg font-black text-white tracking-tight">{title}</h3>
          {subtitle && (
            <p className="text-xs text-zinc-500 leading-relaxed max-w-2xl">{subtitle}</p>
          )}
        </div>
        {action}
      </header>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

export function Readout({
  label, value, hint, tone = 'ink',
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: 'ink' | 'mute' | 'fluo'
}) {
  const valCls = tone === 'fluo'
    ? 'text-tosh-fluo'
    : tone === 'mute' ? 'text-[#888]'
    : 'text-white'
  return (
    <div className="flex flex-col gap-1 py-2 border-b border-[#1F1F2E]/60">
      <div className="flex items-baseline justify-between gap-4">
        <span className={labelCls}>{label}</span>
        <span className={`font-mono text-sm tabular-nums break-all text-right ${valCls}`}>
          {value}
        </span>
      </div>
      {hint && <div className="text-[10px] text-[#555] tracking-wider text-right">{hint}</div>}
    </div>
  )
}

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
      : 'border-[#1F1F2E] focus:border-tosh-fluo'
  return (
    <label className="flex flex-col gap-1.5">
      <span className={labelCls}>{label}</span>
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

// ─────────────────────────────────────────────────────────────────────────────
// PROGRESS BAR  ·  ASCII line meter
// ─────────────────────────────────────────────────────────────────────────────
//
// Two-track meter: top is a 2 px high gray base line with a white overlay
// segment whose width tracks `pct`.  Below the line, a single fixed-width
// ASCII rendering of the same progress for readability at any zoom level:
//
//     [───████████──────────] 50.0%
//
// No gradient.  No glow.  Just a line.
//

export function ProgressBar({
  pct, label, totalLabel,
}: {
  pct:        number
  label:      string
  totalLabel: string
}) {
  const clamped = Math.max(0, Math.min(100, pct))
  const WIDTH   = 28
  const filled  = Math.round((clamped / 100) * WIDTH)
  const ascii   = '─'.repeat(WIDTH - filled).padStart(WIDTH, '█') // pre-render so '█' fills from left
  const bar     = '█'.repeat(filled) + '─'.repeat(WIDTH - filled)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className={labelCls}>{label}</span>
        <span className="font-mono text-[11px] text-[#888] tabular-nums">
          {totalLabel}
        </span>
      </div>
      {/* 2 px line meter */}
      <div className="relative h-[2px] bg-[#1F1F2E] w-full" aria-hidden>
        <div
          className="absolute inset-y-0 left-0 bg-white"
          style={{ width: `${clamped}%` }}
        />
      </div>
      {/* ASCII echo so the meter is legible even when zoomed out / printed */}
      <p className="font-mono text-[11px] text-[#666] tabular-nums">
        <span className="text-[#555]">[</span>
        <span className="text-white">{bar}</span>
        <span className="text-[#555]">]</span>{' '}
        <span className="text-white">{clamped.toFixed(1)}%</span>
        <span className="text-[#333] text-[9px] ml-2">{ascii}</span>
      </p>
    </div>
  )
}
