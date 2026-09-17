'use client'

/**
 * Admin console · shared surface.
 *
 * The minimal primitives every governance panel renders through, and the
 * parsing helpers they share.  Split out of the former 2.4k-line page.tsx so a
 * panel is editable without scrolling past eighteen others.
 *
 * Buttons and transaction feedback are deliberately NOT here: they come from
 * `@/components/ui` (`ActionButton` + `useActionGate` + `useTxAction`), which is
 * the same mechanism the rest of the app uses.  The page's owner verdict rides
 * on that mechanism's ambient gate, set once in page.tsx.
 */

import { useEffect } from 'react'
import { parseUnits, formatUnits, isAddress, getAddress } from 'viem'
import { ADMIN_BATCH_MAX, testnetExplorerAddress } from '@/lib/contracts'
import { NATIVE_SYMBOL } from '@/lib/chain'

// ─────────────────────────────────────────────────────────────────────────────
// MINIMAL PRIMITIVES — every visual is a 1 px line or a typeface contrast
// ─────────────────────────────────────────────────────────────────────────────

export function Line({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`h-px bg-surface-hover ${className}`} />
}

/**
 * Group heading — separates the five governance domains.
 *
 * `anchor` is what the jump bar targets.  `scroll-mt-20` keeps the sticky bar
 * from parking on top of the heading it just scrolled to, which is the usual
 * way an anchor lands a reader one line below where they aimed.
 */
export function GroupHeader({
  index, title, blurb, anchor,
}: {
  index:   string
  title:   string
  blurb:   string
  anchor?: string
}) {
  return (
    <div id={anchor} className="mt-12 first:mt-4 scroll-mt-20">
      <Line />
      <div className="pt-5 flex flex-col gap-1">
        <span className="text-label font-mono tracking-[0.4em] uppercase text-brand">
          {index}
        </span>
        <h2 className="text-xl font-black text-text-primary tracking-tight">{title}</h2>
        <p className="text-xs text-text-tertiary leading-relaxed max-w-2xl">{blurb}</p>
      </div>
    </div>
  )
}

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
    <section className="tosh-panel p-card-lg flex flex-col gap-4 mt-6">
      <header className="flex items-start justify-between gap-4 flex-wrap border-b border-border-subtle pb-4">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="font-mono text-label text-text-tertiary uppercase">
            {id ? `/// ${id}` : '/// SYS'}
          </div>
          <h3 className="text-title text-text-primary">{title}</h3>
          {subtitle && (
            <p className="text-xs text-text-tertiary leading-relaxed max-w-2xl">{subtitle}</p>
          )}
        </div>
        {action}
      </header>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

export const labelCls = 'text-label tracking-[0.32em] uppercase text-text-tertiary font-light'

/** Governance-boundary note — states what a control does NOT reach. */
export function ScopeNote({ tone = 'mute', children }: { tone?: 'mute' | 'warn'; children: React.ReactNode }) {
  const cls = tone === 'warn'
    ? 'border-danger/40 text-danger'
    : 'border-border-subtle text-text-tertiary'
  return (
    <p className={`border-l-2 ${cls} pl-3 text-note leading-relaxed font-mono`}>
      {children}
    </p>
  )
}

export function Field({
  label, hint, value, onChange, placeholder, disabled, type = 'text',
  inputMode, pattern, errored, fluo,
}: {
  label:        string
  hint?:        React.ReactNode
  value:        string
  onChange:     (v: string) => void
  placeholder?: string
  disabled?:    boolean
  type?:        string
  inputMode?:   'numeric' | 'decimal'
  pattern?:     string
  errored?:     boolean
  fluo?:        boolean
}) {
  const borderCls = fluo
    ? 'border-brand'
    : errored
      ? 'border-border-strong focus:border-brand'
      : 'border-border-subtle focus:border-brand'
  return (
    <label className="flex flex-col gap-1.5">
      <span className={labelCls}>{label}</span>
      <input
        type={type} value={value} placeholder={placeholder} disabled={disabled}
        inputMode={inputMode} pattern={pattern}
        onChange={e => onChange(e.target.value)}
        className={`bg-surface-card/50 border ${borderCls} rounded-lg px-3 py-2.5 font-mono text-sm
                    text-text-primary placeholder:text-text-quiet tabular-nums
                    disabled:opacity-40 disabled:cursor-not-allowed
                    transition-colors duration-150`}
      />
      {hint && <span className="text-label text-text-tertiary tracking-wider">{hint}</span>}
    </label>
  )
}

export function TextAreaField({
  label, hint, value, onChange, placeholder, disabled, rows = 4,
}: {
  label:        string
  hint?:        React.ReactNode
  value:        string
  onChange:     (v: string) => void
  placeholder?: string
  disabled?:    boolean
  rows?:        number
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={labelCls}>{label}</span>
      <textarea
        rows={rows} value={value} placeholder={placeholder} disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="bg-transparent border border-border-subtle focus:border-brand
                   px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-quiet
                   tabular-nums resize-y transition-colors duration-150
                   disabled:opacity-40"
      />
      {hint && <span className="text-label text-text-tertiary tracking-wider">{hint}</span>}
    </label>
  )
}

export function Readout({
  label, value, tone = 'ink', hint,
}: {
  label: string
  value: React.ReactNode
  tone?: 'ink' | 'mute' | 'fluo'
  hint?: React.ReactNode
}) {
  const valCls = tone === 'fluo'
    ? 'text-brand'
    : tone === 'mute' ? 'text-text-tertiary'
    : 'text-text-primary'
  return (
    <div className="flex flex-col gap-1 py-2 border-b border-border-subtle/60">
      <div className="flex items-baseline justify-between gap-4">
        <span className={labelCls}>{label}</span>
        <span className={`font-mono text-sm tabular-nums break-all text-right ${valCls}`}>
          {value}
        </span>
      </div>
      {hint && <div className="text-label text-text-quiet tracking-wider text-right">{hint}</div>}
    </div>
  )
}

/**
 * A full address, linked to the explorer.
 *
 * The phone-only padding is a tap-target fix, not decoration.  A wrapped
 * address measures 37–38 px tall, which is under the 44 px floor the rest of
 * the app holds to, and these are the links an operator reaches for while
 * checking that a handoff went where they meant it to.  Desktop keeps the
 * tighter row, because a mouse does not need the margin and the console is
 * already fourteen screens long.
 */
export function AddressLink({ addr }: { addr?: string }) {
  if (!addr) return <>—</>
  return (
    <a
      href={testnetExplorerAddress(addr)}
      target="_blank" rel="noopener noreferrer"
      className="hover:text-brand underline decoration-dotted break-all
                 max-md:inline-block max-md:py-1"
    >
      {addr}
    </a>
  )
}

/** Two-state pill used for paused / live and listed / unlisted. */
export function StatusBadge({ ok, okLabel, badLabel }: { ok: boolean; okLabel: string; badLabel: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border
                  font-mono text-label tracking-[0.32em] uppercase
                  ${ok
                    ? 'border-brand/50 text-brand'
                    : 'border-danger/50 text-danger'}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-brand' : 'bg-danger'}`} />
      {ok ? okLabel : badLabel}
    </span>
  )
}

/**
 * Second-look dialog for writes whose blast radius is not obvious from the
 * button alone (fee changes, pausing, ownership handoff).
 */
export function ConfirmDialog({
  open, title, body, confirmLabel, onConfirm, onCancel, danger,
}: {
  open:         boolean
  title:        string
  body:         React.ReactNode
  confirmLabel: string
  onConfirm:    () => void
  onCancel:     () => void
  danger?:      boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-base/80 px-6"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md bg-surface-elevated border border-border-strong rounded-panel shadow-overlay p-card-lg flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
      >
        <h4 className="text-title text-text-primary">{title}</h4>
        <div className="font-mono text-body text-text-secondary">{body}</div>
        <div className="flex gap-3 justify-end pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-label font-mono uppercase tracking-wider
                       border border-border-subtle text-text-secondary rounded-xl
                       hover:text-text-primary hover:border-border-strong transition-colors"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 text-label font-mono uppercase tracking-wider font-bold
                        rounded-xl border transition-colors
                        ${danger
                          ? 'border-danger text-danger hover:bg-danger hover:text-bg-base'
                          : 'border-brand text-brand hover:bg-brand hover:text-bg-base'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export type AddressRowStatus = 'valid' | 'duplicate' | 'invalid' | 'over-cap'

export interface ParsedAddressRow {
  index:   number
  raw:     string
  status:  AddressRowStatus
  display: string
}

export function parseAddressGrid(raw: string): ParsedAddressRow[] {
  const tokens = raw.split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean)
  const seen   = new Set<string>()
  return tokens.map((tok, i) => {
    if (!isAddress(tok)) {
      return { index: i, raw: tok, status: 'invalid', display: tok }
    }
    const checksum = getAddress(tok)
    if (i >= ADMIN_BATCH_MAX) {
      return { index: i, raw: tok, status: 'over-cap', display: checksum }
    }
    if (seen.has(checksum)) {
      return { index: i, raw: tok, status: 'duplicate', display: checksum }
    }
    seen.add(checksum)
    return { index: i, raw: tok, status: 'valid', display: checksum }
  })
}

export function trimEthDisplay(units: string): string {
  if (!units.includes('.')) return units
  return units.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '0'
}

/**
 * Every caller formats a SETTLEMENT figure — the launch fee, the default soft
 * cap, the PoG allocation ceiling, the treasury balance and its next spend —
 * so the suffix follows the chain. Nothing here formats a Proof-of-Gas floor
 * or a lifetime-gas total; those stay ETH-denominated and are printed by
 * `Monitors.tsx`, which spells the unit out per row for exactly that reason.
 */
export function fmtEth(wei: bigint | undefined): string {
  if (wei === undefined) return '—'
  return `${trimEthDisplay(formatUnits(wei, 18))} ${NATIVE_SYMBOL}`
}

export function fmtDuration(sec: bigint, zeroHint: string): string {
  const n = Number(sec)
  if (n === 0)   return zeroHint
  if (n < 60)    return `${n} s`
  if (n < 3600)  return `${(n / 60).toFixed(2)} min`
  if (n < 86400) return `${(n / 3600).toFixed(2)} h`
  return `${(n / 86400).toFixed(2)} d`
}

/** Parse a settlement-coin field.  Zero is a legitimate value for fees. */
export function parseEthInput(raw: string): { ok: true; value: bigint } | { ok: false; reason: string | null } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: null }
  try {
    const value = parseUnits(trimmed, 18)
    if (value < 0n) return { ok: false, reason: 'Negative amount' }
    return { ok: true, value }
  } catch {
    return { ok: false, reason: 'Invalid number format' }
  }
}

export function shortErr(e: { message?: string } | null | undefined): string | null {
  if (!e?.message) return null
  return e.message.split('\n')[0]!.slice(0, 200)
}

/**
 * Re-exported so the admin modules keep importing the clock from one place.
 *
 * The local implementation this replaces seeded its state with `Date.now()`,
 * which makes the server snapshot and the hydration snapshot disagree by
 * construction — it only went unnoticed because a dev machine renders both with
 * the same clock. The shared store returns `CLOCK_UNSYNCED` (0) until the first
 * client tick instead, and both call sites here already funnel through
 * `classifyHorizon`, which reads 0 as "wall time not known yet" rather than
 * as 1970.
 */
export { useNowSec } from '@/components/ui'
