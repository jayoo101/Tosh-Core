'use client'

/**
 * Tosh Admin · OPERATOR CONSOLE  (v5.0)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pure black canvas, hairline gray dividers, white type, fluorescent green ONLY
 * where a guard engages or where a focused write button takes the wheel.
 *
 * The console is organised as five governance groups that mirror the on-chain
 * authority surface exactly:
 *
 *   G1  FACTORY CONTROL      launchFee · defaultSoftCap · maxPogAllocationLimit
 *                            · cooldownDuration · quotaWindowDuration
 *   G2  POG SIGNER           setPogSigner
 *   G3  SAFETY & RISK        pause / unpause · setBlacklist / liftBlacklist
 *   G4  TREASURY CURATION    addLadderToken / removeLadderToken
 *   G5  OWNERSHIP            transferOwnership / acceptOwnership (2-step, both
 *                            the factory AND the ladder treasury)
 *
 * ACCESS MODEL
 * ────────────
 * Every write on this page is `onlyOwner` on-chain, so the UI does not need to
 * hide anything to be safe — it needs to stop a non-owner from burning gas on a
 * transaction the contract will reject.  A non-owner therefore gets the full
 * read-only console with every write lever disabled, rather than a redirect.
 * `WriteAccessContext` carries that verdict; `WriteButton` reads it directly so
 * a new panel cannot forget to honour it.
 *
 * Local guards mirrored from Solidity (so the wallet never opens for a
 * transaction that is already known to revert):
 *
 *   defaultSoftCap  < MIN_SOFT_CAP_PROD (0.01 ETH)  → blocked
 *   cooldown/quota  > MAX_COOLDOWN (7 d)            → blocked
 *   blacklist batch > ADMIN_BATCH_MAX (200)         → truncated on the wire
 *   addLadderToken  → token must be factory-launched AND its hook must have
 *                     launched (an unlaunched hook has no pool key, and the
 *                     treasury's `InvalidPoolKey` arm would reject it)
 */

import {
  useState, useCallback, useEffect, useMemo, useRef, createContext, useContext,
} from 'react'
import {
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  useReadContract,
  useReadContracts,
  useSignMessage,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { parseUnits, formatUnits, isAddress, getAddress, type Abi, type Address } from 'viem'
import { injected } from 'wagmi/connectors'
import {
  FACTORY_ABI,
  FACTORY_ADDRESS,
  HOOK_ABI,
  TREASURY_ABI,
  LADDER_TREASURY_ADDRESS,
  hasLadderTreasury,
  TARGET_CHAIN_ID,
  MIN_SOFT_CAP_PROD,
  MIN_SOFT_CAP_PROD_LABEL,
  ADMIN_BATCH_MAX,
  MAX_COOLDOWN_SECONDS,
  BAN_DURATIONS,
  type BanDurationKey,
  DEAD_ADDRESS,
  ZERO_ADDRESS,
  MAINNET_CHAIN_LABEL,
  TESTNET_CHAIN_LABEL,
  testnetExplorerTx,
  testnetExplorerAddress,
} from '@/lib/contracts'
import { useProtocolOwner } from '@/lib/useProtocolOwner'
import { classifyHorizon, formatHorizonLabel, formatHorizonUtc } from '@/components/ui'

// ─────────────────────────────────────────────────────────────────────────────
// WRITE ACCESS  —  one verdict, consumed by every lever on the page
// ─────────────────────────────────────────────────────────────────────────────

interface WriteAccess {
  /** True only when the connected wallet is the on-chain factory owner. */
  canWrite: boolean
  /** Why writes are disabled, rendered on hover / in the banner. */
  reason: string | null
}

const WriteAccessContext = createContext<WriteAccess>({
  canWrite: false,
  reason:   'resolving owner',
})

function useWriteAccess(): WriteAccess {
  return useContext(WriteAccessContext)
}

// ─────────────────────────────────────────────────────────────────────────────
// MINIMAL PRIMITIVES — every visual is a 1 px line or a typeface contrast
// ─────────────────────────────────────────────────────────────────────────────

function Line({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`h-px bg-[#1F1F2E] ${className}`} />
}

/** Group heading — separates the five governance domains. */
function GroupHeader({
  index, title, blurb,
}: {
  index: string
  title: string
  blurb: string
}) {
  return (
    <div className="mt-12 first:mt-4">
      <Line />
      <div className="pt-5 flex flex-col gap-1">
        <span className="text-[10px] font-mono tracking-[0.4em] uppercase text-brand">
          {index}
        </span>
        <h2 className="text-xl font-black text-white tracking-tight">{title}</h2>
        <p className="text-xs text-zinc-500 leading-relaxed max-w-2xl">{blurb}</p>
      </div>
    </div>
  )
}

function Section({
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
            <p className="text-xs text-zinc-500 leading-relaxed max-w-2xl">{subtitle}</p>
          )}
        </div>
        {action}
      </header>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

const labelCls = 'text-[10px] tracking-[0.32em] uppercase text-[#888] font-light'

/** Governance-boundary note — states what a control does NOT reach. */
function ScopeNote({ tone = 'mute', children }: { tone?: 'mute' | 'warn'; children: React.ReactNode }) {
  const cls = tone === 'warn'
    ? 'border-danger/40 text-danger'
    : 'border-[#1F1F2E] text-[#888]'
  return (
    <p className={`border-l-2 ${cls} pl-3 text-[11px] leading-relaxed font-mono`}>
      {children}
    </p>
  )
}

function Field({
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
      ? 'border-[#444] focus:border-brand'
      : 'border-[#1F1F2E] focus:border-brand'
  return (
    <label className="flex flex-col gap-1.5">
      <span className={labelCls}>{label}</span>
      <input
        type={type} value={value} placeholder={placeholder} disabled={disabled}
        inputMode={inputMode} pattern={pattern}
        onChange={e => onChange(e.target.value)}
        className={`bg-zinc-900/50 border ${borderCls} rounded-lg px-3 py-2.5 font-mono text-sm
                    text-white placeholder:text-zinc-600 tabular-nums
                    disabled:opacity-40 disabled:cursor-not-allowed
                    transition-colors duration-150`}
      />
      {hint && <span className="text-[10px] text-[#666] tracking-wider">{hint}</span>}
    </label>
  )
}

function TextAreaField({
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
        className="bg-transparent border border-[#1F1F2E] focus:border-brand
                   px-3 py-2 font-mono text-sm text-white placeholder:text-[#3A3A4A]
                   tabular-nums resize-y transition-colors duration-150
                   disabled:opacity-40"
      />
      {hint && <span className="text-[10px] text-[#666] tracking-wider">{hint}</span>}
    </label>
  )
}

/**
 * Write button.  Locks itself whenever the page-level access verdict says the
 * connected wallet is not the owner, so a panel author cannot forget the guard.
 *
 * `bypassOwnerGate` opts a single button out of that verdict.  It exists for
 * writes whose on-chain authority is NOT `factory.owner()` — `acceptOwnership`,
 * which by definition is called by a wallet that is not the owner yet, and the
 * ownership card's own `transferOwnership`, which is authorised against the
 * contract that card is bound to rather than against the factory.  A button
 * that sets it MUST carry its own `locked` predicate.
 */
function WriteButton({
  label, onClick, locked, busy, small, danger, bypassOwnerGate,
}: {
  label:   React.ReactNode
  onClick: () => void
  locked?: boolean
  busy?:   boolean
  small?:  boolean
  danger?: boolean
  bypassOwnerGate?: boolean
}) {
  const { canWrite, reason } = useWriteAccess()
  const ownerGated = !bypassOwnerGate && !canWrite
  const hardLocked = !!locked || ownerGated
  const disabled   = hardLocked || !!busy

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={ownerGated ? (reason ?? 'read-only') : undefined}
      className={`inline-flex items-center justify-center
                  ${small ? 'px-4 py-2 text-[10px]' : 'px-5 py-2.5 text-xs'}
                  font-mono uppercase tracking-wider font-bold rounded-input
                  transition-colors disabled:cursor-not-allowed
                  ${hardLocked
                    ? 'border border-border-subtle text-text-quiet bg-transparent'
                    : danger
                      ? 'border border-danger text-danger hover:bg-danger hover:text-bg-base'
                      : 'border border-brand/40 bg-brand/10 text-brand hover:bg-brand hover:text-bg-base'}
                  disabled:opacity-40`}
    >
      {busy ? 'transmitting…' : label}
    </button>
  )
}

function Readout({
  label, value, tone = 'ink', hint,
}: {
  label: string
  value: React.ReactNode
  tone?: 'ink' | 'mute' | 'fluo'
  hint?: React.ReactNode
}) {
  const valCls = tone === 'fluo'
    ? 'text-brand'
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

function AlarmLine({ msg }: { msg: string | null }) {
  if (!msg) return null
  return (
    <p className="text-[10px] font-mono text-[#888] tracking-wider leading-relaxed">
      <span className="text-danger">[REVERT]</span> {msg}
    </p>
  )
}

/** Minimal tx status line — state + explorer link for the broadcast hash. */
function TxLine({ hash, label }: { hash?: `0x${string}`; label: string }) {
  const { isLoading, isSuccess, isError } = useWaitForTransactionReceipt({ hash })
  if (!hash) return null
  const stateTxt = isLoading
    ? 'CONFIRMING'
    : isSuccess ? 'ACKNOWLEDGED'
    : isError ? 'REVERTED'
    : 'PENDING'
  const tone = isSuccess ? 'text-brand' : isError ? 'text-danger' : 'text-[#888]'
  return (
    <p className="text-[10px] font-mono tracking-wider flex items-center gap-3 flex-wrap">
      <span className={tone}>[TX]</span>
      <span className="text-[#888]">{label}</span>
      <span className={tone}>{stateTxt}</span>
      <a
        href={testnetExplorerTx(hash)}
        target="_blank" rel="noopener noreferrer"
        className="text-[#555] hover:text-brand break-all underline decoration-dotted"
      >
        {hash.slice(0, 10)}…{hash.slice(-6)} ↗
      </a>
    </p>
  )
}

function AddressLink({ addr }: { addr?: string }) {
  if (!addr) return <>—</>
  return (
    <a
      href={testnetExplorerAddress(addr)}
      target="_blank" rel="noopener noreferrer"
      className="hover:text-brand underline decoration-dotted break-all"
    >
      {addr}
    </a>
  )
}

/** Two-state pill used for paused / live and listed / unlisted. */
function StatusBadge({ ok, okLabel, badLabel }: { ok: boolean; okLabel: string; badLabel: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border
                  font-mono text-[10px] tracking-[0.32em] uppercase
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
function ConfirmDialog({
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-6"
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
            className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider
                       border border-zinc-800 text-zinc-400 rounded-xl
                       hover:text-white hover:border-zinc-600 transition-colors"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 text-[10px] font-mono uppercase tracking-wider font-bold
                        rounded-xl border transition-colors
                        ${danger
                          ? 'border-danger text-danger hover:bg-danger hover:text-black'
                          : 'border-brand text-brand hover:bg-brand hover:text-black'}`}
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

type AddressRowStatus = 'valid' | 'duplicate' | 'invalid' | 'over-cap'

interface ParsedAddressRow {
  index:   number
  raw:     string
  status:  AddressRowStatus
  display: string
}

function parseAddressGrid(raw: string): ParsedAddressRow[] {
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

function trimEthDisplay(units: string): string {
  if (!units.includes('.')) return units
  return units.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '0'
}

function fmtEth(wei: bigint | undefined): string {
  if (wei === undefined) return '—'
  return `${trimEthDisplay(formatUnits(wei, 18))} ETH`
}

function fmtDuration(sec: bigint, zeroHint: string): string {
  const n = Number(sec)
  if (n === 0)   return zeroHint
  if (n < 60)    return `${n} s`
  if (n < 3600)  return `${(n / 60).toFixed(2)} min`
  if (n < 86400) return `${(n / 3600).toFixed(2)} h`
  return `${(n / 86400).toFixed(2)} d`
}

/** Parse an ETH-denominated field.  Zero is a legitimate value for fees. */
function parseEthInput(raw: string): { ok: true; value: bigint } | { ok: false; reason: string | null } {
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

function shortErr(e: { message?: string } | null | undefined): string | null {
  if (!e?.message) return null
  return e.message.split('\n')[0]!.slice(0, 200)
}

/**
 * External-clock pattern used throughout this app: `Date.now()` is impure and
 * must not be read during render, so the wall clock is pulled into state and
 * ticked from an effect instead.
 */
function useNowSec(intervalMs = 15_000): number {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return nowSec
}

// ─────────────────────────────────────────────────────────────────────────────
// G1 · FACTORY CONTROL
// ─────────────────────────────────────────────────────────────────────────────

function LaunchFeePanel() {
  const [feeInput, setFeeInput] = useState('')
  const [error, setError]       = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const {
    data: launchFeeWei, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launchFee',
  })

  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const parsed = parseEthInput(feeInput)
  const txBusy = isPending || isConfirming

  const submit = useCallback(() => {
    setConfirming(false)
    if (!parsed.ok) { setError(parsed.reason ?? 'Invalid number format'); return }
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: 'setLaunchFee', args: [parsed.value],
      chainId: TARGET_CHAIN_ID,
    })
  }, [parsed, writeContract])

  return (
    <Section
      id="G1-A" title="LAUNCH FEE"
      subtitle="setLaunchFee · native ETH charged on every createLaunch · anti-spam toll, forwarded to the ladder treasury"
    >
      <Readout
        label="CURRENT FEE"
        value={isLoading && launchFeeWei === undefined ? 'reading…' : fmtEth(launchFeeWei as bigint | undefined)}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label="NEW FEE · ETH · 0 ALLOWED"
        value={feeInput}
        onChange={v => { setFeeInput(v); setError(null) }}
        placeholder="e.g. 0.1"
        inputMode="decimal"
        disabled={txBusy}
        fluo={parsed.ok}
      />
      <ScopeNote>
        A zero fee is legal and disables the anti-spam toll entirely. The change
        applies to the next createLaunch onward; launches already in flight paid
        the old fee and are unaffected.
      </ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label="update launch fee"
          onClick={() => { setError(null); if (parsed.ok) setConfirming(true) }}
          locked={!parsed.ok}
          busy={txBusy}
        />
      </div>
      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label="setLaunchFee" />

      <ConfirmDialog
        open={confirming}
        title="Confirm launch-fee change"
        body={
          <>
            <p>
              {fmtEth(launchFeeWei as bigint | undefined)}
              {' → '}
              <span className="text-brand">
                {parsed.ok ? fmtEth(parsed.value) : '—'}
              </span>
            </p>
            <p className="mt-3 text-zinc-500">
              Every createLaunch after this block must attach the new amount as
              msg.value. A UI still holding the old figure will revert.
            </p>
          </>
        }
        confirmLabel="commit fee"
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
      />
    </Section>
  )
}

function SoftCapPanel() {
  const [capInput, setCapInput] = useState('')
  const [error, setError]       = useState<string | null>(null)

  const {
    data: currentCapWei, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'defaultSoftCap',
  })
  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const parsed     = parseEthInput(capInput)
  const belowFloor = parsed.ok && parsed.value < MIN_SOFT_CAP_PROD
  const txBusy     = isPending || isConfirming

  const handleSet = useCallback(() => {
    setError(null)
    if (!parsed.ok) { setError(parsed.reason ?? 'Enter a valid ETH amount'); return }
    if (parsed.value < MIN_SOFT_CAP_PROD) return
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: 'setDefaultSoftCap', args: [parsed.value],
      chainId: TARGET_CHAIN_ID,
    })
  }, [parsed, writeContract])

  return (
    <Section
      id="G1-B" title="DEFAULT SOFT CAP"
      subtitle={`setDefaultSoftCap · frozen into every new hook's constructor · floor ${MIN_SOFT_CAP_PROD_LABEL} ETH`}
    >
      <Readout
        label="LIVE CAP (NEXT LAUNCH)"
        value={isLoading && currentCapWei === undefined ? 'reading…' : fmtEth(currentCapWei as bigint | undefined)}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label={`NEW CAP · ETH ≥ ${MIN_SOFT_CAP_PROD_LABEL}`}
        value={capInput}
        onChange={v => { setCapInput(v); setError(null) }}
        placeholder="e.g. 10"
        inputMode="decimal"
        disabled={txBusy}
        errored={belowFloor}
        fluo={parsed.ok && !belowFloor}
      />
      {belowFloor && (
        <p className="font-mono text-[10px] tracking-[0.32em] text-brand uppercase">
          → GUARD LOCKED · MIN_SOFT_CAP_VIOLATION
        </p>
      )}
      <ScopeNote tone={belowFloor ? 'warn' : 'mute'}>
        The 0.01 ETH floor is a price-truncation guard, not a business rule:
        p0 = lpEth × 1e18 / GENESIS_LP_SUPPLY, and with 3.78 M LP tokens a raise
        below the floor rounds p0 toward zero. The contract reverts InvalidSoftCap
        below it, so this button stays inert rather than burning gas.
      </ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label="set default cap"
          onClick={handleSet}
          locked={!parsed.ok || belowFloor}
          busy={txBusy}
        />
      </div>
      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label="setDefaultSoftCap" />
    </Section>
  )
}

function PogLimitPanel() {
  const [limitInput, setLimitInput] = useState('')
  const [error, setError]           = useState<string | null>(null)

  const {
    data: currentLimitWei, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'maxPogAllocationLimit',
  })
  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const parsed = parseEthInput(limitInput)
  const txBusy = isPending || isConfirming

  const zero = parsed.ok && parsed.value === 0n

  const handleSet = useCallback(() => {
    setError(null)
    if (!parsed.ok) { setError(parsed.reason ?? 'Invalid number format'); return }
    if (parsed.value === 0n) {
      setError('Zero is rejected on-chain (InvalidPogLimit). It is snapshotted into every new hook constructor, which requires a non-zero per-wallet cap — at zero createLaunch reverts for every creator. Use PAUSE to stop taking on projects.')
      return
    }
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: 'setMaxPogAllocationLimit', args: [parsed.value],
      chainId: TARGET_CHAIN_ID,
    })
  }, [parsed, writeContract])

  return (
    <Section
      id="G1-C" title="POG ALLOCATION CEILING"
      subtitle="setMaxPogAllocationLimit · caps the maxAlloc an oracle attestation may grant, and is snapshotted as each new project's per-wallet deposit cap"
    >
      <Readout
        label="LIVE CEILING"
        value={isLoading && currentLimitWei === undefined ? 'reading…' : fmtEth(currentLimitWei as bigint | undefined)}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label="NEW CEILING · ETH · MUST BE NON-ZERO"
        value={limitInput}
        onChange={v => { setLimitInput(v); setError(null) }}
        placeholder="e.g. 0.1"
        inputMode="decimal"
        disabled={txBusy}
        fluo={parsed.ok && !zero}
      />
      <ScopeNote>
        Forward-looking only. Projects already deployed keep the per-wallet cap
        baked into their hook constructor, and PoG quotas already registered keep
        their granted allowance — a depositor&apos;s terms cannot be rewritten under
        them after they commit.
        <br /><br />
        <span className="text-[#c88]">
          Zero is not &ldquo;freeze registrations&rdquo;.
        </span>{' '}
        This value is snapshotted into every new hook&apos;s constructor, which
        requires a non-zero per-wallet cap, so a zero ceiling made{' '}
        <code>createLaunch</code> revert for every creator platform-wide. The
        factory now rejects it outright — use the circuit breaker in G3 to stop
        taking on new projects.
      </ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label="update pog ceiling"
          onClick={handleSet}
          locked={!parsed.ok || zero}
          busy={txBusy}
        />
      </div>
      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label="setMaxPogAllocationLimit" />
    </Section>
  )
}

function DurationSetterPanel({
  id, title, subtitle, readoutLabel, buttonLabel,
  readFn, writeFn, zeroHint, zeroNote,
}: {
  id:           string
  title:        string
  subtitle:     string
  readoutLabel: string
  buttonLabel:  string
  readFn:       'cooldownDuration' | 'quotaWindowDuration'
  writeFn:      'setCooldownDuration' | 'setQuotaWindowDuration'
  zeroHint:     string
  zeroNote:     React.ReactNode
}) {
  const [secInput, setSecInput] = useState('')
  const [error, setError]       = useState<string | null>(null)

  const {
    data: currentSec, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: readFn,
  })
  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const parsed = (() => {
    const trimmed = secInput.trim()
    if (!trimmed) return { ok: false as const }
    if (!/^\d+$/.test(trimmed)) return { ok: false as const }
    return { ok: true as const, value: BigInt(trimmed) }
  })()
  const overMax    = parsed.ok && parsed.value > BigInt(MAX_COOLDOWN_SECONDS)
  const settingZero = parsed.ok && parsed.value === 0n
  const txBusy     = isPending || isConfirming

  const handleSet = useCallback(() => {
    setError(null)
    if (!parsed.ok) { setError('Enter a non-negative integer (seconds)'); return }
    if (parsed.value > BigInt(MAX_COOLDOWN_SECONDS)) {
      setError(`Exceeds MAX_COOLDOWN (${MAX_COOLDOWN_SECONDS} s = 7 d) — would revert.`)
      return
    }
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: writeFn, args: [parsed.value],
      chainId: TARGET_CHAIN_ID,
    })
  }, [parsed, writeContract, writeFn])

  return (
    <Section id={id} title={title} subtitle={subtitle}>
      <Readout
        label={readoutLabel}
        value={
          isLoading && currentSec === undefined
            ? 'reading…'
            : currentSec !== undefined
              ? <>{fmtDuration(currentSec as bigint, zeroHint)}{' '}
                  <span className="text-[#555]">({(currentSec as bigint).toString()} s)</span></>
              : '—'
        }
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label={`NEW VALUE · SECONDS · MAX ${MAX_COOLDOWN_SECONDS} (7 d)`}
        value={secInput}
        onChange={v => { setSecInput(v); setError(null) }}
        placeholder="e.g. 86400"
        inputMode="numeric"
        pattern="[0-9]*"
        disabled={txBusy}
        errored={overMax}
        fluo={parsed.ok && !overMax}
        hint={overMax
          ? <span className="text-danger">→ ABOVE_MAX_COOLDOWN (WOULD_REVERT)</span>
          : null}
      />
      <ScopeNote tone={settingZero ? 'warn' : 'mute'}>{zeroNote}</ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label={buttonLabel}
          onClick={handleSet}
          locked={!parsed.ok || overMax}
          busy={txBusy}
        />
      </div>
      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label={writeFn} />
    </Section>
  )
}

function CooldownDurationPanel() {
  return (
    <DurationSetterPanel
      id="G1-D"
      title="RE-DEPOSIT COOLDOWN"
      subtitle="setCooldownDuration · per-(wallet, hook) throttle between deposits"
      readoutLabel="LIVE COOLDOWN"
      buttonLabel="set cooldown"
      readFn="cooldownDuration"
      writeFn="setCooldownDuration"
      zeroHint="0 (throttle disabled)"
      zeroNote={
        <>
          Setting 0 disables the re-deposit throttle only. It does NOT touch PoG
          quotas — the two knobs were deliberately split into separate storage
          slots precisely so a cool-off can be run without freezing allowances.
          The lifetime-budget behaviour lives on the quota window below.
        </>
      }
    />
  )
}

function QuotaWindowPanel() {
  return (
    <DurationSetterPanel
      id="G1-E"
      title="POG QUOTA WINDOW"
      subtitle="setQuotaWindowDuration · how long a wallet's PoG spend ledger lasts before it refills"
      readoutLabel="LIVE WINDOW"
      buttonLabel="set quota window"
      readFn="quotaWindowDuration"
      writeFn="setQuotaWindowDuration"
      zeroHint="0 (lifetime budget)"
      zeroNote={
        <>
          HIGH IMPACT · Setting 0 is a semantic shift, not an off switch: with no
          window to anchor a refill to, quotaSpent never resets and every
          wallet&apos;s PoG allowance degrades into a one-shot lifetime budget that
          can never be replenished.
        </>
      }
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// G2 · POG SIGNER
// ─────────────────────────────────────────────────────────────────────────────

function AddressRotationPanel({
  id, title, subtitle, readFn, writeFn, txLabel, placeholder, note, confirmBody,
}: {
  id:          string
  title:       string
  subtitle:    string
  readFn:      'platformTreasury' | 'pogSigner'
  writeFn:     'setPlatformTreasury' | 'setPogSigner'
  txLabel:     string
  placeholder: string
  note:        React.ReactNode
  confirmBody: React.ReactNode
}) {
  const [addrInput, setAddrInput]   = useState('')
  const [error, setError]           = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const {
    data: currentAddr, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: readFn,
  })
  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const trimmed    = addrInput.trim()
  const validAddr  = !!trimmed && isAddress(trimmed)
  const sameAsLive = validAddr && typeof currentAddr === 'string'
                  && trimmed.toLowerCase() === (currentAddr as string).toLowerCase()
  const zeroAddr   = trimmed.toLowerCase() === ZERO_ADDRESS.toLowerCase()
  const locked     = !validAddr || sameAsLive || zeroAddr
  const txBusy     = isPending || isConfirming

  const submit = useCallback(() => {
    setConfirming(false)
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: writeFn,
      args: [getAddress(trimmed)],
      chainId: TARGET_CHAIN_ID,
    })
  }, [trimmed, writeFn, writeContract])

  return (
    <Section id={id} title={title} subtitle={subtitle}>
      <Readout
        label="LIVE ON-CHAIN"
        value={isLoading && currentAddr === undefined
          ? 'reading…'
          : <AddressLink addr={currentAddr as string | undefined} />}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label="NEW ADDRESS"
        value={addrInput}
        onChange={v => { setAddrInput(v); setError(null) }}
        placeholder={placeholder}
        disabled={txBusy}
        errored={trimmed.length > 0 && !validAddr}
        fluo={!locked}
        hint={
          trimmed.length > 0 && !validAddr
            ? <span className="text-danger">→ NOT_A_VALID_ADDRESS</span>
            : sameAsLive
              ? <span className="text-[#888]">→ EQUALS_LIVE_VALUE (NO_OP)</span>
              : zeroAddr
                ? <span className="text-danger">→ ZERO_ADDRESS_REFUSED</span>
                : null
        }
      />
      <ScopeNote>{note}</ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label={`rotate ${txLabel.toLowerCase()}`}
          onClick={() => { setError(null); if (!locked) setConfirming(true) }}
          locked={locked}
          busy={txBusy}
        />
      </div>
      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label={writeFn} />

      <ConfirmDialog
        open={confirming}
        title={`Confirm ${txLabel.toLowerCase()} rotation`}
        body={
          <>
            <p className="break-all text-zinc-400">{String(currentAddr ?? '—')}</p>
            <p className="break-all text-brand mt-1">↓ {trimmed}</p>
            <p className="mt-3 text-zinc-500">{confirmBody}</p>
          </>
        }
        confirmLabel="commit rotation"
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
        danger
      />
    </Section>
  )
}

function PogSignerPanel() {
  return (
    <AddressRotationPanel
      id="G2-A"
      title="POG SIGNER ROTATION"
      subtitle="setPogSigner · the EOA whose ECDSA signatures registerPoG() will accept"
      readFn="pogSigner" writeFn="setPogSigner"
      txLabel="SIGNER"
      placeholder="0x… new oracle signer EOA"
      note={
        <>
          Rotation is immediate and retroactive against anything unspent: every
          attestation the previous signer issued but that has not yet landed
          on-chain stops verifying the moment this transaction confirms. Drain the
          signing queue before rotating, or re-issue afterwards.
        </>
      }
      confirmBody="Unmined signatures from the old signer are invalidated the instant this confirms."
    />
  )
}

function PlatformTreasuryPanel() {
  return (
    <AddressRotationPanel
      id="G2-B"
      title="PLATFORM TREASURY (LEGACY · NO FUNDS)"
      subtitle="setPlatformTreasury · v4.x leftover kept for metadata compatibility"
      readFn="platformTreasury" writeFn="setPlatformTreasury"
      txLabel="TREASURY"
      placeholder="0x… metadata only, not a payout address"
      note={
        <>
          This address receives nothing in v5.0. All platform revenue — the 1 %
          shelf-mint cut, the 0.7 % buy tax, launch fees and orphaned referral
          commission — routes to the ladder treasury, which is an immutable
          constructor argument on every hook and cannot be retargeted from here.
        </>
      }
      confirmBody="Metadata only — this rotation moves no funds and changes no revenue routing."
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// G3 · SAFETY & RISK
// ─────────────────────────────────────────────────────────────────────────────

function CircuitBreakerPanel() {
  const [confirming, setConfirming] = useState(false)

  const { data: paused, isLoading, refetch } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'paused',
    query: { refetchInterval: 10_000 },
  })
  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const isPaused = paused === true
  const txBusy   = isPending || isConfirming

  const submit = useCallback(() => {
    setConfirming(false)
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: isPaused ? 'unpause' : 'pause',
      args: [],
      chainId: TARGET_CHAIN_ID,
    })
  }, [isPaused, writeContract])

  return (
    <Section
      id="G3-A" title="PLATFORM CIRCUIT BREAKER"
      subtitle="pause / unpause · Pausable guard on the factory's entry points"
      action={isLoading && paused === undefined
        ? <span className="text-[10px] font-mono text-[#666]">reading…</span>
        : <StatusBadge ok={!isPaused} okLabel="live" badLabel="paused" />}
    >
      <ScopeNote tone={isPaused ? 'warn' : 'mute'}>
        Scope is deliberately narrow. Pausing halts new project creation and PoG
        registration and nothing else. Secondary trading on launched pools, shelf
        minting, genesis claims and depositor refunds all keep working — those
        live in the hooks, which the factory has no authority over once deployed.
        This is a spam and incident brake, not a kill switch. To stop shelf
        minting on a project that has already launched, use the ladder halt in
        G3-B — it is a separate switch precisely so this one keeps meaning what
        it says.
      </ScopeNote>
      <ScopeNote tone="warn">
        <span className="text-[#c88]">Deposits are not paused.</span>{' '}
        <code>deposit</code> carries no <code>whenNotPaused</code>, so a genesis
        round that is already open goes on taking ETH for its full window while
        the platform is paused. That is the same promise that keeps refunds
        working — once the platform has taken money for a round it cannot starve
        it — but it cuts both ways: if an incident requires stopping the inflow,
        this button is not sufficient and you need the blacklist below.
      </ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label={isPaused ? 'resume platform' : 'engage circuit breaker'}
          onClick={() => setConfirming(true)}
          busy={txBusy}
          danger={!isPaused}
        />
      </div>
      <AlarmLine msg={shortErr(writeError)} />
      <TxLine hash={txHash} label={isPaused ? 'unpause' : 'pause'} />

      <ConfirmDialog
        open={confirming}
        title={isPaused ? 'Resume the platform?' : 'Engage the circuit breaker?'}
        body={isPaused
          ? 'createLaunch and registerPoG reopen immediately on confirmation.'
          : 'createLaunch and registerPoG stop accepting transactions. Deposits into rounds that are already open, live pools, shelf mints and refunds are all unaffected.'}
        confirmLabel={isPaused ? 'resume' : 'pause platform'}
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
        danger={!isPaused}
      />
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// G3-B · LADDER HALT — the only platform brake that reaches a launched project
// ─────────────────────────────────────────────────────────────────────────────
//
// Kept visually separate from the circuit breaker above because the two answer
// different questions: `pause()` stops the platform GROWING, this stops the
// ladder SELLING.  Folding them into one toggle would have made "paused" mean
// something quietly larger than what the factory's own natspec promises.
//
// The halt expires on its own, so the panel leads with the deadline rather than
// with a boolean: an operator's next question after "is it halted" is always
// "for how much longer", and a halt that lapses unnoticed mid-incident is the
// failure mode worth designing against.

const HALT_PRESETS = [
  { label: '1 h',  secs: 3_600n },
  { label: '24 h', secs: 86_400n },
  { label: '72 h', secs: 259_200n },
  { label: '7 d',  secs: 604_800n },
] as const

function LadderHaltPanel() {
  const nowSec = useNowSec()
  const [scope, setScope]           = useState<'global' | 'hook'>('global')
  const [hookInput, setHookInput]   = useState('')
  const [duration, setDuration]     = useState<bigint>(86_400n)
  const [confirming, setConfirming] = useState(false)
  const [error, setError]           = useState<string | null>(null)

  const { data: globalUntil, refetch } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'globalLadderHaltedUntil',
    query: { refetchInterval: 10_000 },
  })

  const targeted = scope === 'hook' && isAddress(hookInput.trim())
    ? (getAddress(hookInput.trim()) as Address)
    : undefined

  const { data: hookUntil, refetch: refetchHook } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'hookLadderHaltedUntil',
    args: targeted ? [targeted] : undefined,
    query: { enabled: !!targeted, refetchInterval: 10_000 },
  })

  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => {
    if (!isSuccess) return
    void refetch(); void refetchHook()
  }, [isSuccess, refetch, refetchHook])

  const activeUntil  = scope === 'global' ? (globalUntil as bigint | undefined) : (hookUntil as bigint | undefined)
  // `haltLadderMinting` caps a halt at MAX_HALT_DURATION, so this stamp is
  // always representable — but reading it through the horizon means the panel
  // does not depend on that cap holding forever.
  const haltHorizon  = classifyHorizon(activeUntil ?? 0n, nowSec)
  const isHalted     = haltHorizon.kind === 'pending' || haltHorizon.kind === 'unbounded'
  const txBusy       = isPending || isConfirming
  const targetArg    = scope === 'global' ? ZERO_ADDRESS : targeted
  const targetReady  = scope === 'global' || !!targeted

  const submit = useCallback((resume: boolean) => {
    setConfirming(false); setError(null)
    if (!targetArg) { setError('Enter a valid hook address, or switch to platform-wide'); return }
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: resume ? 'resumeLadderMinting' : 'haltLadderMinting',
      args: resume ? [targetArg] : [targetArg, duration],
      chainId: TARGET_CHAIN_ID,
    })
  }, [targetArg, duration, writeContract])

  return (
    <Section
      id="G3-B" title="LADDER HALT"
      subtitle="haltLadderMinting / resumeLadderMinting · suspends shelf minting on projects that have already launched"
      action={<StatusBadge ok={!isHalted} okLabel="ladder live" badLabel="halted" />}
    >
      <div className="flex gap-2">
        {(['global', 'hook'] as const).map(s => (
          <button
            key={s} type="button" onClick={() => { setScope(s); setError(null) }}
            className={'px-3 py-1.5 text-[10px] tracking-[0.28em] uppercase font-bold border transition-colors ' +
              (scope === s
                ? 'border-brand text-brand'
                : 'border-[#1F1F2E] text-[#666] hover:text-[#AAA]')}
          >
            {s === 'global' ? 'platform-wide' : 'single project'}
          </button>
        ))}
      </div>

      {scope === 'hook' && (
        <Field
          label="HOOK ADDRESS"
          value={hookInput}
          onChange={v => { setHookInput(v); setError(null) }}
          placeholder="0x… the project's hook, not its token"
          disabled={txBusy}
          fluo={!!targeted}
        />
      )}

      <Readout
        label="HALTED UNTIL"
        value={isHalted ? (formatHorizonUtc(haltHorizon, 'second') ?? 'halted') : 'not halted'}
        hint={isHalted
          ? formatHorizonLabel(haltHorizon, {
              unbounded: 'no representable expiry',
              elapsed:   'lapsed',
              pending:   d => `${d} remaining`,
            })
          : null}
        tone={isHalted ? 'fluo' : 'mute'}
      />

      <div className="flex flex-col gap-1.5">
        <span className={labelCls}>HALT DURATION</span>
        <div className="flex gap-2 flex-wrap">
          {HALT_PRESETS.map(p => (
            <button
              key={p.label} type="button" onClick={() => setDuration(p.secs)}
              disabled={txBusy}
              className={'px-3 py-1.5 text-[10px] tracking-[0.28em] uppercase font-bold border transition-colors ' +
                (duration === p.secs
                  ? 'border-brand text-brand'
                  : 'border-[#1F1F2E] text-[#666] hover:text-[#AAA]')}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <ScopeNote tone="warn">
        Reaches <code>mintBondingCurve</code> and nothing else. Pool swaps, LP
        add/remove, genesis claims, referral claims and depositor refunds all
        keep working, so a halt can cancel an opportunity but can never strand a
        balance.
        <br /><br />
        <span className="text-[#CCC]">It expires by itself.</span> A halt is a
        deadline, capped at 7 days, not a flag — so an owner who is compromised
        or simply unavailable cannot brick Phase 2 permanently. Re-arm before the
        deadline to extend an ongoing incident; the worst case is a rolling
        outage that has to be renewed on-chain, in public, every week.
      </ScopeNote>

      <div className="flex justify-start gap-2 flex-wrap">
        <WriteButton
          label={`halt ladder · ${HALT_PRESETS.find(p => p.secs === duration)?.label ?? ''}`}
          onClick={() => setConfirming(true)}
          locked={!targetReady}
          busy={txBusy}
          danger
        />
        {isHalted && (
          <WriteButton
            label="resume now"
            onClick={() => submit(true)}
            locked={!targetReady}
            busy={txBusy}
          />
        )}
      </div>

      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label="haltLadderMinting" />

      <ConfirmDialog
        open={confirming}
        title={scope === 'global' ? 'Halt every ladder?' : 'Halt this project\u2019s ladder?'}
        body={
          `Shelf minting stops immediately and resumes automatically after ` +
          `${HALT_PRESETS.find(p => p.secs === duration)?.label ?? ''}. ` +
          `Trading, LP, claims and refunds are unaffected. ` +
          (scope === 'global'
            ? 'This applies to every launched project on the platform.'
            : `Scoped to ${targeted ?? '—'} only.`)
        }
        confirmLabel="halt ladder"
        onConfirm={() => submit(false)}
        onCancel={() => setConfirming(false)}
        danger
      />
    </Section>
  )
}

const ROW_TAG: Record<AddressRowStatus, { tag: string; cls: string }> = {
  'valid':     { tag: '[OK]  ', cls: 'text-white' },
  'duplicate': { tag: '[DUP] ', cls: 'text-[#888]' },
  'invalid':   { tag: '[ERR] ', cls: 'text-danger' },
  'over-cap':  { tag: '[CAP] ', cls: 'text-[#888]' },
}

function BlacklistRowList({ rows }: { rows: ParsedAddressRow[] }) {
  const RENDER_CAP   = 250
  const renderedRows = rows.slice(0, RENDER_CAP)
  const truncated    = rows.length - renderedRows.length

  return (
    <div className="border border-[#1F1F2E] rounded-lg overflow-hidden">
      <div className="grid grid-cols-[3rem_5rem_1fr] gap-3 px-3 py-1.5 border-b border-[#1F1F2E]
                      text-[10px] tracking-[0.32em] uppercase text-[#666]">
        <span>idx</span>
        <span>state</span>
        <span>address</span>
      </div>
      <div className="max-h-72 overflow-y-auto divide-y divide-[#1F1F2E]/60 font-mono">
        {renderedRows.map(row => {
          const t = ROW_TAG[row.status]
          return (
            <div
              key={`${row.index}-${row.raw}`}
              className="grid grid-cols-[3rem_5rem_1fr] gap-3 items-center px-3 py-1 text-[11px] tabular-nums"
            >
              <span className="text-[#555]">
                {row.index.toString(16).toUpperCase().padStart(3, '0')}
              </span>
              <span className={t.cls}>{t.tag}</span>
              <span className={`break-all ${row.status === 'invalid' ? 'text-danger' : 'text-[#CCC]'}`}>
                {row.display}
              </span>
            </div>
          )
        })}
      </div>
      {truncated > 0 && (
        <p className="px-3 py-1.5 text-center text-[10px] text-[#666] border-t border-[#1F1F2E] tracking-wider">
          +{truncated} ROWS BUFFERED · DUMP CAPPED AT {RENDER_CAP}
        </p>
      )}
    </div>
  )
}

/** Single-address lift, kept separate from the batch textarea. */
function SingleLiftRow() {
  const [addr, setAddr] = useState('')
  const [error, setError] = useState<string | null>(null)
  const nowSec = useNowSec()

  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash })

  const trimmed = addr.trim()
  const valid   = !!trimmed && isAddress(trimmed)
  const txBusy  = isPending || isConfirming

  const { data: bannedUntil, refetch } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'blacklistedUntil',
    args: valid ? [getAddress(trimmed)] : undefined,
    query: { enabled: valid },
  })

  const until    = bannedUntil as bigint | undefined
  // `setBlacklist` stores `type(uint256).max` verbatim but any other duration as
  // `block.timestamp + duration`, so an unreachable ban need not equal the
  // sentinel.  Testing for the sentinel alone let such a stamp reach `Date` and
  // take the panel down with a RangeError.
  const banHorizon  = classifyHorizon(until ?? 0n, nowSec)
  const isBanned    = banHorizon.kind === 'pending' || banHorizon.kind === 'unbounded'
  const bannedUntilTxt = banHorizon.kind === 'pending'
    ? (formatHorizonUtc(banHorizon, 'second') ?? 'PERMANENT')
    : 'PERMANENT'

  const handleLift = useCallback(() => {
    setError(null)
    if (!valid) { setError('Not a valid Ethereum address'); return }
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'liftBlacklist',
      args: [[getAddress(trimmed)]],
      chainId: TARGET_CHAIN_ID,
    })
    void refetch()
  }, [valid, trimmed, writeContract, refetch])

  return (
    <div className="flex flex-col gap-3 pt-2">
      <Field
        label="SINGLE-ADDRESS LIFT · LOOKUP + RELEASE"
        value={addr}
        onChange={v => { setAddr(v); setError(null) }}
        placeholder="0x… one wallet to release"
        disabled={txBusy}
        errored={trimmed.length > 0 && !valid}
        fluo={valid && isBanned}
        hint={
          !valid
            ? (trimmed.length > 0 ? <span className="text-danger">→ NOT_A_VALID_ADDRESS</span> : null)
            : until === undefined
              ? <span className="text-[#666]">→ reading blacklistedUntil…</span>
              : isBanned
                ? <span className="text-danger">→ BANNED UNTIL {bannedUntilTxt}</span>
                : <span className="text-brand">→ NOT CURRENTLY BANNED</span>
        }
      />
      <div className="flex justify-start">
        <WriteButton
          label="lift single ban"
          onClick={handleLift}
          locked={!valid || !isBanned}
          busy={txBusy}
          small
        />
      </div>
      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label="liftBlacklist (single)" />
    </div>
  )
}

function BlacklistConsole() {
  const [addresses, setAddresses] = useState('')
  const [duration, setDuration]   = useState<BanDurationKey>('24 HOURS')
  const [error, setError]         = useState<string | null>(null)

  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash })

  const rows   = useMemo(() => parseAddressGrid(addresses), [addresses])
  const counts = useMemo(() => {
    const c = { valid: 0, duplicate: 0, invalid: 0, overCap: 0 }
    for (const r of rows) {
      if      (r.status === 'valid')     c.valid++
      else if (r.status === 'duplicate') c.duplicate++
      else if (r.status === 'invalid')   c.invalid++
      else if (r.status === 'over-cap')  c.overCap++
    }
    return c
  }, [rows])

  const sendable = useMemo<Address[]>(
    () => rows.filter(r => r.status === 'valid').map(r => r.display as Address),
    [rows],
  )
  const overBatchLimit = counts.overCap > 0
  const locked = sendable.length === 0
  const txBusy = isPending || isConfirming

  const handleBan = useCallback(() => {
    setError(null)
    if (locked) return
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'setBlacklist',
      args: [sendable, BAN_DURATIONS[duration]],
      chainId: TARGET_CHAIN_ID,
    })
  }, [locked, sendable, duration, writeContract])

  const handleLift = useCallback(() => {
    setError(null)
    if (locked) return
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'liftBlacklist',
      args: [sendable],
      chainId: TARGET_CHAIN_ID,
    })
  }, [locked, sendable, writeContract])

  return (
    <Section
      id="G3-B" title="BLACKLIST BATCH"
      subtitle={`setBlacklist / liftBlacklist · hard cap ${ADMIN_BATCH_MAX} wallets per transaction`}
    >
      <TextAreaField
        label={`TARGET DUMP · ONE PER LINE OR COMMA-SEPARATED (MAX ${ADMIN_BATCH_MAX})`}
        value={addresses}
        onChange={setAddresses}
        placeholder={'0xAbCdEf…\n0x1234567…'}
        rows={4}
        disabled={txBusy}
      />

      <div className="grid grid-cols-4 border border-[#1F1F2E] divide-x divide-[#1F1F2E] rounded-lg overflow-hidden">
        {([
          ['VALID',     counts.valid,     'text-white'],
          ['DUPLICATE', counts.duplicate, 'text-[#888]'],
          ['INVALID',   counts.invalid,   counts.invalid > 0 ? 'text-danger' : 'text-[#555]'],
          ['OVERCAP',   counts.overCap,   counts.overCap > 0 ? 'text-danger' : 'text-[#555]'],
        ] as const).map(([label, value, cls]) => (
          <div key={label} className="px-3 py-2 flex flex-col gap-1">
            <span className={labelCls}>{label}</span>
            <span className={`font-mono text-base font-bold tabular-nums ${cls}`}>
              {value.toString().padStart(3, '0')}
            </span>
          </div>
        ))}
      </div>

      {rows.length > 0 && <BlacklistRowList rows={rows} />}

      {overBatchLimit && (
        <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-danger">
          → BATCH OVER {ADMIN_BATCH_MAX} · rows past index {ADMIN_BATCH_MAX - 1} dropped from the wire
        </p>
      )}

      <label className="flex flex-col gap-1.5">
        <span className={labelCls}>BAN DURATION</span>
        <select
          value={duration}
          onChange={e => setDuration(e.target.value as BanDurationKey)}
          disabled={txBusy}
          className="bg-zinc-900/50 border border-[#1F1F2E] focus:border-brand rounded-lg
                     px-3 py-2.5 font-mono text-sm text-white tabular-nums
                     transition-colors duration-150 disabled:opacity-40"
        >
          {(Object.keys(BAN_DURATIONS) as BanDurationKey[]).map(d => (
            <option key={d} value={d} className="bg-black text-white">{d}</option>
          ))}
        </select>
      </label>

      <ScopeNote>
        Durations are relative: the contract stores block.timestamp + duration.
        PERMANENT is the type(uint256).max sentinel, which the contract writes
        verbatim instead of adding, so it never overflows and never expires.
      </ScopeNote>

      <div className="flex gap-3 flex-wrap">
        <WriteButton
          label={`engage ban · ${sendable.length}`}
          onClick={handleBan}
          locked={locked}
          busy={txBusy}
          danger
        />
        <WriteButton
          label={`lift batch · ${sendable.length}`}
          onClick={handleLift}
          locked={locked}
          busy={txBusy}
        />
      </div>

      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label="setBlacklist / liftBlacklist" />

      <Line className="mt-2" />
      <SingleLiftRow />
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// G4 · LADDER TREASURY CURATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors `ToshLadderTreasury.addLadderToken`'s own admission test before the
 * wallet opens.  Two conditions, in order:
 *
 *   1. `factory.tokenToHook(token) != 0` — this platform launched the token.
 *   2. that hook has already run `launch()` — an unlaunched hook has no pool
 *      key, so the treasury's `InvalidPoolKey` arm would reject it.
 *
 * Checking condition 2 here is what turns an opaque on-chain revert into an
 * explanation the operator can act on.
 */
function useLadderTokenEligibility(raw: string) {
  const trimmed = raw.trim()
  const valid   = !!trimmed && isAddress(trimmed)
  const token   = valid ? getAddress(trimmed) : undefined

  const { data: hookAddr, isLoading: hookLoading } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'tokenToHook',
    args: token ? [token] : undefined,
    query: { enabled: !!token },
  })

  const hook       = hookAddr as Address | undefined
  const knownToken = !!hook && hook !== ZERO_ADDRESS

  const { data: launchedRaw, isLoading: launchedLoading } = useReadContract({
    address: hook, abi: HOOK_ABI, functionName: 'launched',
    query: { enabled: knownToken },
  })

  return {
    trimmed,
    valid,
    token,
    hook,
    knownToken,
    hookLoading,
    launched: launchedRaw === true,
    launchedLoading: knownToken && launchedLoading,
  }
}

function LadderTreasuryPanel() {
  const [tokenInput, setTokenInput] = useState('')
  const [error, setError]           = useState<string | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<Address | null>(null)

  const treasury = LADDER_TREASURY_ADDRESS as Address

  // ── Treasury state ────────────────────────────────────────────────────────
  const { data: coreData, refetch: refetchCore } = useReadContracts({
    contracts: [
      { address: treasury, abi: TREASURY_ABI, functionName: 'ladderTokenCount' },
      { address: treasury, abi: TREASURY_ABI, functionName: 'currentCursor' },
      { address: treasury, abi: TREASURY_ABI, functionName: 'nextSpendAmount' },
      { address: treasury, abi: TREASURY_ABI, functionName: 'factory' },
    ],
    query: { enabled: hasLadderTreasury, refetchInterval: 12_000 },
  })

  const tokenCount  = (coreData?.[0]?.result as bigint | undefined) ?? 0n
  const cursor      = (coreData?.[1]?.result as bigint | undefined) ?? 0n
  const nextSpend   = coreData?.[2]?.result as bigint | undefined
  const boundFactory = coreData?.[3]?.result as Address | undefined

  const { data: treasuryBalance, refetch: refetchBalance } = useBalance({
    address: treasury,
    query: { enabled: hasLadderTreasury, refetchInterval: 12_000 },
  })

  // ── The listed tokens themselves ──────────────────────────────────────────
  const indices = useMemo(
    () => Array.from({ length: Number(tokenCount) }, (_, i) => BigInt(i)),
    [tokenCount],
  )
  const { data: tokenData, refetch: refetchTokens } = useReadContracts({
    contracts: indices.map(i => ({
      address: treasury, abi: TREASURY_ABI, functionName: 'ladderTokens', args: [i],
    })),
    query: { enabled: hasLadderTreasury && indices.length > 0 },
  })
  const listed = useMemo<Address[]>(
    () => (tokenData ?? [])
      .map(r => r.result as Address | undefined)
      .filter((a): a is Address => !!a),
    [tokenData],
  )

  // ── Add-token precheck ────────────────────────────────────────────────────
  const {
    trimmed, valid, token, hook, knownToken, hookLoading, launched, launchedLoading,
  } = useLadderTokenEligibility(tokenInput)

  const alreadyListed = !!token && listed.some(t => t.toLowerCase() === token.toLowerCase())

  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => {
    if (!isSuccess) return
    void refetchCore()
    void refetchTokens()
    void refetchBalance()
  }, [isSuccess, refetchCore, refetchTokens, refetchBalance])

  const txBusy = isPending || isConfirming

  const eligibility: { ok: boolean; note: React.ReactNode } = (() => {
    if (!trimmed)        return { ok: false, note: null }
    if (!valid)          return { ok: false, note: <span className="text-danger">→ NOT_A_VALID_ADDRESS</span> }
    if (hookLoading)     return { ok: false, note: <span className="text-[#666]">→ resolving factory.tokenToHook…</span> }
    if (!knownToken)     return { ok: false, note: <span className="text-danger">→ NOT_LAUNCHED_HERE · factory.tokenToHook returned 0</span> }
    if (alreadyListed)   return { ok: false, note: <span className="text-[#888]">→ ALREADY_LISTED</span> }
    if (launchedLoading) return { ok: false, note: <span className="text-[#666]">→ reading hook.launched()…</span> }
    if (!launched) {
      return {
        ok: false,
        note: <span className="text-danger">→ HOOK_NOT_LAUNCHED · no pool key yet, treasury would revert InvalidPoolKey</span>,
      }
    }
    return {
      ok: true,
      note: <span className="text-brand">→ HOOK {hook!.slice(0, 10)}… · LAUNCHED · ELIGIBLE</span>,
    }
  })()

  const handleAdd = useCallback(() => {
    setError(null)
    if (!eligibility.ok || !token) return
    writeContract({
      address: treasury, abi: TREASURY_ABI, functionName: 'addLadderToken',
      args: [token],
      chainId: TARGET_CHAIN_ID,
    })
  }, [eligibility.ok, token, treasury, writeContract])

  const handleRemove = useCallback(() => {
    if (!pendingRemoval) return
    const target = pendingRemoval
    setPendingRemoval(null)
    setError(null)
    writeContract({
      address: treasury, abi: TREASURY_ABI, functionName: 'removeLadderToken',
      args: [target],
      chainId: TARGET_CHAIN_ID,
    })
  }, [pendingRemoval, treasury, writeContract])

  if (!hasLadderTreasury) {
    return (
      <Section
        id="G4-A" title="LADDER TREASURY CURATION"
        subtitle="addLadderToken / removeLadderToken · buyback round-robin roster"
      >
        <ScopeNote tone="warn">
          NEXT_PUBLIC_TREASURY_ADDRESS is not set, so this panel has no contract
          to talk to. Add the deployed ToshLadderTreasury address to
          .env.local and restart the dev server.
        </ScopeNote>
      </Section>
    )
  }

  return (
    <Section
      id="G4-A" title="LADDER TREASURY CURATION"
      subtitle="addLadderToken / removeLadderToken · the round-robin roster the piggyback buyback spends against"
      action={<StatusBadge ok={listed.length > 0} okLabel={`${listed.length} listed`} badLabel="empty roster" />}
    >
      <Readout label="TREASURY" value={<AddressLink addr={treasury} />} />
      <Readout label="BOUND FACTORY" value={<AddressLink addr={boundFactory} />}
               hint={boundFactory && boundFactory.toLowerCase() !== FACTORY_ADDRESS.toLowerCase()
                 ? 'MISMATCH — this treasury is bound to a different factory'
                 : null} />
      <Readout label="TREASURY ETH BALANCE" value={fmtEth(treasuryBalance?.value)} tone="fluo" />
      <Readout label="ROUND-ROBIN CURSOR" value={`${cursor.toString()} / ${tokenCount.toString()}`} />
      <Readout label="NEXT SPEND PER TRIGGER" value={fmtEth(nextSpend)} />

      <ScopeNote>
        One-way valve by construction. The treasury has no withdraw, no transfer
        and no owner payout path — the only exit for a wei that lands here is
        _buyAndBurn, which swaps ETH for a listed token and sends the proceeds to{' '}
        <span className="text-[#CCC]">{DEAD_ADDRESS}</span>. Owner authority on
        this contract is curation only.
      </ScopeNote>
      <ScopeNote tone="warn">
        Curation is not neutral, though. That guarantee is about custody, not
        beneficiaries: nobody can take this ETH, but the roster below decides
        which order books absorb it, and buying pressure that ends in a burn is
        still buying pressure. Narrowing the roster to one token points what is
        left of the reservoir at a single price.
        <br /><br />
        Two things bound that, and neither is the valve. Each cycle&apos;s spend is
        divided by the batch size of 3 rather than by the number of listings, so
        a one-token roster deploys a third of the rate a full one does; and the
        buyback&apos;s sqrt floor refuses to fill more than ~10 % above a pool&apos;s
        TWAP, which rate-limits the rest. Treat curation as an economic dial and
        keep it behind the same multisig review as the others.
      </ScopeNote>

      {/* ── Roster ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <span className={labelCls}>LISTED TOKENS</span>
        {listed.length === 0 ? (
          <p className="text-[11px] font-mono text-[#666] py-3">
            roster empty — buybacks are inert until at least one token is listed
          </p>
        ) : (
          <div className="border border-[#1F1F2E] rounded-lg divide-y divide-[#1F1F2E]/60">
            {listed.map((t, i) => (
              <div key={t} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-[10px] text-[#555] tabular-nums">
                    {i.toString().padStart(2, '0')}
                  </span>
                  {BigInt(i) === cursor && (
                    <span className="text-[9px] font-mono tracking-widest text-brand">▸NEXT</span>
                  )}
                  <span className="font-mono text-[11px] text-[#CCC] break-all">
                    <AddressLink addr={t} />
                  </span>
                </div>
                <WriteButton
                  label="remove"
                  onClick={() => setPendingRemoval(t)}
                  busy={txBusy}
                  small
                  danger
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Add ─────────────────────────────────────────────────────────── */}
      <Field
        label="ADD TOKEN · MUST BE LAUNCHED BY THIS FACTORY"
        value={tokenInput}
        onChange={v => { setTokenInput(v); setError(null) }}
        placeholder="0x… project token address"
        disabled={txBusy}
        errored={!!trimmed && !eligibility.ok && !hookLoading}
        fluo={eligibility.ok}
        hint={eligibility.note}
      />
      <div className="flex justify-start">
        <WriteButton
          label="list token"
          onClick={handleAdd}
          locked={!eligibility.ok}
          busy={txBusy}
        />
      </div>

      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label="addLadderToken / removeLadderToken" />

      <ConfirmDialog
        open={!!pendingRemoval}
        title="Delist from the buyback roster?"
        body={
          <>
            <p className="break-all text-zinc-400">{pendingRemoval}</p>
            <p className="mt-3 text-zinc-500">
              Removal is swap-and-pop: the last entry moves into this slot and the
              round-robin cursor is re-modulated against the shorter array. The
              rotation order changes for the remaining tokens — that is expected,
              the cursor only has to stay in range and be eventually fair.
            </p>
          </>
        }
        confirmLabel="delist"
        onConfirm={handleRemove}
        onCancel={() => setPendingRemoval(null)}
        danger
      />
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// G5 · TWO-STEP OWNERSHIP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ownable2Step board for one contract.
 *
 * The ABI is taken as a plain `Abi` rather than the two `as const` literals.
 * Both contracts expose an identical `owner / pendingOwner / transferOwnership
 * / acceptOwnership` surface, and widening here is what lets one component
 * serve both without a union that wagmi's inference cannot narrow.
 */
function OwnershipCard({
  label, contractAddress, abi, connected,
}: {
  label:           string
  contractAddress: Address
  abi:             Abi
  connected:       Address | undefined
}) {
  const [target, setTarget]         = useState('')
  const [error, setError]           = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: contractAddress, abi, functionName: 'owner' },
      { address: contractAddress, abi, functionName: 'pendingOwner' },
    ],
    query: { refetchInterval: 12_000 },
  })

  const owner        = data?.[0]?.result as Address | undefined
  const pendingOwner = data?.[1]?.result as Address | undefined

  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const txBusy = isPending || isConfirming

  const hasPending = !!pendingOwner && pendingOwner !== ZERO_ADDRESS
  const iAmPending = hasPending && !!connected
                  && pendingOwner.toLowerCase() === connected.toLowerCase()
  const iAmOwner   = !!owner && !!connected
                  && owner.toLowerCase() === connected.toLowerCase()

  const trimmed  = target.trim()
  const valid    = !!trimmed && isAddress(trimmed)
  const zeroAddr = trimmed.toLowerCase() === ZERO_ADDRESS.toLowerCase()
  const sameAsOwner = valid && !!owner && trimmed.toLowerCase() === owner.toLowerCase()
  const transferLocked = !valid || zeroAddr || sameAsOwner || !iAmOwner

  const submitTransfer = useCallback(() => {
    setConfirming(false)
    writeContract({
      address: contractAddress, abi, functionName: 'transferOwnership',
      args: [getAddress(trimmed)],
      chainId: TARGET_CHAIN_ID,
    })
  }, [contractAddress, abi, trimmed, writeContract])

  const submitAccept = useCallback(() => {
    setError(null)
    writeContract({
      address: contractAddress, abi, functionName: 'acceptOwnership',
      args: [],
      chainId: TARGET_CHAIN_ID,
    })
  }, [contractAddress, abi, writeContract])

  return (
    <div className="flex flex-col gap-3 border border-[#1F1F2E] rounded-xl p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h4 className="text-sm font-black text-white tracking-tight">{label}</h4>
        <StatusBadge
          ok={!hasPending}
          okLabel="settled"
          badLabel="transfer pending"
        />
      </div>

      <Readout label="OWNER" value={<AddressLink addr={owner} />}
               tone={iAmOwner ? 'fluo' : 'ink'}
               hint={iAmOwner ? 'this is your wallet' : null} />
      <Readout label="PENDING OWNER"
               value={hasPending ? <AddressLink addr={pendingOwner} /> : 'none'}
               tone={hasPending ? 'fluo' : 'mute'} />

      {iAmPending && (
        <div className="flex flex-col gap-2 border border-brand/40 rounded-lg p-3">
          <p className="text-[11px] font-mono text-brand leading-relaxed">
            You are the pending owner of this contract. Ownership does not move
            until you accept it.
          </p>
          <div className="flex justify-start">
            <WriteButton
              label="accept ownership"
              onClick={submitAccept}
              locked={!iAmPending}
              busy={txBusy}
              bypassOwnerGate
              small
            />
          </div>
        </div>
      )}

      <Field
        label="TRANSFER TO · SAFE MULTISIG"
        value={target}
        onChange={v => { setTarget(v); setError(null) }}
        placeholder="0x… receiving Gnosis Safe"
        disabled={txBusy}
        errored={trimmed.length > 0 && (!valid || zeroAddr || sameAsOwner)}
        fluo={!transferLocked}
        hint={
          trimmed.length > 0 && !valid
            ? <span className="text-danger">→ NOT_A_VALID_ADDRESS</span>
            : zeroAddr
              ? <span className="text-danger">→ ZERO_ADDRESS_REFUSED</span>
              : sameAsOwner
                ? <span className="text-[#888]">→ EQUALS_CURRENT_OWNER (NO_OP)</span>
                : !iAmOwner
                  ? <span className="text-[#888]">→ ONLY THE CURRENT OWNER MAY INITIATE</span>
                  : null
        }
      />
      <div className="flex justify-start">
        <WriteButton
          label="initiate transfer"
          onClick={() => { setError(null); if (!transferLocked) setConfirming(true) }}
          locked={transferLocked}
          busy={txBusy}
          bypassOwnerGate
          danger
        />
      </div>

      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label={`${label} ownership`} />

      <ConfirmDialog
        open={confirming}
        title={`Hand over ${label}?`}
        body={
          <>
            <p className="break-all text-zinc-400">{owner ?? '—'}</p>
            <p className="break-all text-brand mt-1">↓ {trimmed}</p>
            <p className="mt-3 text-zinc-500">
              Two-step: you keep full control until the recipient calls
              acceptOwnership(). Verify the recipient can actually transact —
              a Safe that never accepts leaves ownership with you, but an EOA you
              have lost the key to would strand this contract permanently.
            </p>
          </>
        }
        confirmLabel="initiate transfer"
        onConfirm={submitTransfer}
        onCancel={() => setConfirming(false)}
        danger
      />
    </div>
  )
}

function OwnershipPanel({ connected }: { connected: Address | undefined }) {
  return (
    <Section
      id="G5-A" title="OWNERSHIP · TWO-STEP"
      subtitle="Ownable2Step on both the factory and the ladder treasury · ownership only moves once the recipient accepts"
    >
      <ScopeNote>
        The factory and the treasury are owned independently. A production
        handoff has to transfer BOTH and have the Safe accept BOTH — transferring
        only the factory leaves buyback curation behind on the old key.
      </ScopeNote>

      <OwnershipCard
        label="ToshFactory"
        contractAddress={FACTORY_ADDRESS}
        abi={FACTORY_ABI as unknown as Abi}
        connected={connected}
      />

      {hasLadderTreasury ? (
        <OwnershipCard
          label="ToshLadderTreasury"
          contractAddress={LADDER_TREASURY_ADDRESS as Address}
          abi={TREASURY_ABI as unknown as Abi}
          connected={connected}
        />
      ) : (
        <ScopeNote tone="warn">
          Treasury address unset — its ownership card cannot be rendered. Set
          NEXT_PUBLIC_TREASURY_ADDRESS in .env.local.
        </ScopeNote>
      )}
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSTICS  ·  live initcode hash + off-chain rate
// ─────────────────────────────────────────────────────────────────────────────

function InitcodeHashMonitor() {
  const {
    data: liveHash, isLoading, isFetching, error: readError,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'getLiveHookInitcodeHash',
    query: { refetchInterval: 8_000, refetchOnWindowFocus: true },
  })

  const prevHashRef = useRef<string | null>(null)
  const [rotated, setRotated] = useState(false)
  useEffect(() => {
    if (typeof liveHash !== 'string') return
    if (prevHashRef.current === null) { prevHashRef.current = liveHash; return }
    if (prevHashRef.current !== liveHash) {
      prevHashRef.current = liveHash
      setRotated(true)
      const id = setTimeout(() => setRotated(false), 4000)
      return () => clearTimeout(id)
    }
  }, [liveHash])

  const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'
  const hashOk = typeof liveHash === 'string'
    && liveHash.startsWith('0x')
    && liveHash.toLowerCase() !== ZERO_HASH

  const display = isLoading || liveHash === undefined
    ? 'reading…'
    : hashOk ? (liveHash as string) : ZERO_HASH

  const statusLine = readError || (!isLoading && !hashOk)
    ? <span className="text-[#888]">OFFLINE</span>
    : rotated
      ? <span className="text-brand">ROTATED</span>
      : <span className="text-brand">OK</span>

  return (
    <Section
      id="DIAG-A" title="LIVE INITCODE HASH"
      subtitle="factory.getLiveHookInitcodeHash() · build fingerprint · 8 s probe"
    >
      <p className="font-mono text-[11px] text-[#888] tracking-wider break-all leading-relaxed">
        hash{'  '}<span className="text-[#CCCCCC]">{display}</span>
      </p>
      <p className="font-mono text-[10px] tracking-[0.32em] uppercase flex items-center gap-3">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${hashOk ? 'bg-brand' : 'bg-[#1F1F2E]'}`} aria-hidden />
        {statusLine}
        {isFetching && !isLoading && <span className="text-[#555]">· syncing</span>}
      </p>
      <ScopeNote>
        Sentinel-address hash — a fingerprint, not a mining target. It changes iff
        the hook creation code or the factory wiring changed, which is the signal
        that every previously mined salt is now dead. Mine against
        factory.hookInitcodeHash(...) with the creator&apos;s real arguments.
      </ScopeNote>
    </Section>
  )
}

function buildAdminConfigMessage(rate: number, nonce: bigint, expiresAt: number): string {
  return (
    `Tosh Admin Config Update\n` +
    `rate:      ${rate}\n` +
    `nonce:     ${nonce.toString()}\n` +
    `expiresAt: ${expiresAt}`
  )
}

function ExchangeRatePanel() {
  const [rateInput, setRateInput] = useState('')
  const [status, setStatus]   = useState<'idle' | 'signing' | 'submitting' | 'ok' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const { signMessageAsync } = useSignMessage()

  const handleUpdate = useCallback(async () => {
    setMessage('')
    const num = parseFloat(rateInput)
    if (isNaN(num) || num <= 0) {
      setStatus('error'); setMessage('Rate must be a positive number'); return
    }
    const nonce     = BigInt(Date.now())
    const expiresAt = Math.floor(Date.now() / 1000) + 120
    const msg       = buildAdminConfigMessage(num, nonce, expiresAt)

    let signature: `0x${string}`
    setStatus('signing')
    try { signature = await signMessageAsync({ message: msg }) }
    catch (err) {
      setStatus('error')
      setMessage(err instanceof Error ? err.message : 'Signature rejected')
      return
    }
    setStatus('submitting')
    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newRate: num, nonce: nonce.toString(), expiresAt, signature }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setStatus('ok')
      setMessage(`Rate updated: ${data.previous} → ${data.globalGasToSatoRate} (${data.authMethod})`)
    } catch (err) {
      setStatus('error')
      setMessage(err instanceof Error ? err.message : 'Unknown error')
    }
  }, [rateInput, signMessageAsync])

  const busy  = status === 'signing' || status === 'submitting'
  const armed = !isNaN(parseFloat(rateInput)) && parseFloat(rateInput) > 0

  return (
    <Section
      id="DIAG-B" title="POG EXCHANGE RATE (OFF-CHAIN)"
      subtitle="POST /api/admin/config · owner-signed message, not a transaction · 1 ETH gas = N ETH quota"
    >
      <Field
        label="NEW RATE · ETH QUOTA PER 1 ETH GAS"
        value={rateInput}
        onChange={setRateInput}
        placeholder="e.g. 0.1"
        inputMode="decimal"
        disabled={busy}
        fluo={armed}
      />
      <ScopeNote>
        This one never touches the chain. It is an owner-signed instruction to the
        backend, so it costs no gas and leaves no on-chain trace — and it is only
        as trustworthy as the API server holding the other end.
      </ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label={status === 'signing' ? 'sign in wallet…' : status === 'submitting' ? 'submitting…' : 'update rate'}
          onClick={() => void handleUpdate()}
          busy={busy}
          locked={!armed}
        />
      </div>
      {message && (
        <p className={`font-mono text-[10px] tracking-wider leading-relaxed
                       ${status === 'ok' ? 'text-brand' : 'text-danger'}`}>
          {status === 'ok' ? '✓' : '⛔'} {message}
        </p>
      )}
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CHROME
// ─────────────────────────────────────────────────────────────────────────────

function WalletBar() {
  const { address, isConnected } = useAccount()
  const { connect }    = useConnect()
  const { disconnect } = useDisconnect()

  if (!isConnected) {
    return (
      <button
        onClick={() => connect({ connector: injected() })}
        className="px-4 py-1.5 border border-white text-white text-[10px] font-mono
                   tracking-[0.32em] uppercase font-bold rounded-xl
                   hover:border-brand hover:text-brand transition-colors"
      >
        connect wallet
      </button>
    )
  }
  return (
    <div className="flex items-center gap-3 font-mono text-[10px] tracking-wider">
      <span className="text-brand tabular-nums">
        {address?.slice(0, 6)}…{address?.slice(-4)}
      </span>
      <button
        onClick={() => disconnect()}
        className="px-2 py-1 text-[#888] hover:text-danger transition-colors
                   tracking-[0.32em] uppercase"
      >
        disc
      </button>
    </div>
  )
}

/** Page-wide verdict banner shown whenever writes are unavailable. */
function AccessBanner({
  isConnected, ownerLoading, owner, isOwner,
}: {
  isConnected:  boolean
  ownerLoading: boolean
  owner:        Address | undefined
  isOwner:      boolean
}) {
  if (isOwner) return null

  const [title, body] = ownerLoading
    ? ['RESOLVING AUTHORITY', 'Reading factory.owner() — levers stay locked until it resolves.']
    : !isConnected
      ? ['VIEW ONLY · WALLET DISCONNECTED',
         'Every value below is live on-chain and safe to read. Connect the owner wallet to unlock writes.']
      : ['VIEW ONLY · NOT THE OWNER',
         'This wallet is not the factory owner. Every write on this page is onlyOwner on-chain and would revert, so the levers are disabled rather than left to burn gas.']

  return (
    <div className="mt-6 border border-danger/40 rounded-2xl p-5 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-danger" aria-hidden />
        <span className="text-[10px] font-mono tracking-[0.4em] uppercase text-danger">
          {title}
        </span>
      </div>
      <p className="text-xs text-zinc-400 leading-relaxed max-w-2xl">{body}</p>
      {owner && (
        <p className="text-[11px] font-mono text-[#666] break-all">
          owner <AddressLink addr={owner} />
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { address, isConnected } = useAccount()
  const { owner, isOwner, isLoading: ownerLoading } = useProtocolOwner()

  const access = useMemo<WriteAccess>(() => {
    if (ownerLoading)  return { canWrite: false, reason: 'resolving factory.owner()' }
    if (!isConnected)  return { canWrite: false, reason: 'wallet not connected' }
    if (!isOwner)      return { canWrite: false, reason: 'connected wallet is not the factory owner' }
    return { canWrite: true, reason: null }
  }, [ownerLoading, isConnected, isOwner])

  return (
    <WriteAccessContext.Provider value={access}>
      <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans">
        <header className="border-b border-zinc-800/60 px-6 py-6">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-admin dot-breathe" />
                <span className="text-[10px] font-mono text-admin uppercase tracking-widest">
                  Operator Console
                </span>
                {!access.canWrite && (
                  <span className="text-[10px] font-mono text-danger uppercase tracking-widest">
                    · read-only
                  </span>
                )}
              </div>
              <h1 className="text-2xl font-black tracking-tight text-white">
                Protocol <span className="text-brand">Control</span>
              </h1>
              <p className="text-xs text-zinc-500 mt-1 font-mono">
                {MAINNET_CHAIN_LABEL} · testnet {TESTNET_CHAIN_LABEL} ·{' '}
                {FACTORY_ADDRESS.slice(0, 10)}…{FACTORY_ADDRESS.slice(-6)}
              </p>
            </div>
            <WalletBar />
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-6 pb-24 pt-4">
          <AccessBanner
            isConnected={isConnected}
            ownerLoading={ownerLoading}
            owner={owner}
            isOwner={isOwner}
          />

          <GroupHeader
            index="G1 · FACTORY CONTROL"
            title="Platform parameters"
            blurb="Global dials on ToshFactory. Every one of these is forward-looking: a live raise keeps the terms frozen into its hook at construction, so retuning here governs the next launch, never the current one."
          />
          <LaunchFeePanel />
          <SoftCapPanel />
          <PogLimitPanel />
          <CooldownDurationPanel />
          <QuotaWindowPanel />

          <GroupHeader
            index="G2 · POG AUTHORITY"
            title="Oracle signer"
            blurb="The single EOA whose signatures the PoG registration path trusts, plus the legacy treasury pointer kept for metadata compatibility."
          />
          <PogSignerPanel />
          <PlatformTreasuryPanel />

          <GroupHeader
            index="G3 · SAFETY & RISK"
            title="Circuit breaker and blacklist"
            blurb="Incident controls. The circuit breaker and the blacklist are scoped to the factory's own entry points; the ladder halt is the single exception that reaches a launched project, and it expires on its own."
          />
          <CircuitBreakerPanel />
          <LadderHaltPanel />
          <BlacklistConsole />

          <GroupHeader
            index="G4 · TREASURY CURATION"
            title="Buyback ladder roster"
            blurb="The only owner authority the ladder treasury exposes. Curation decides which launched tokens the burn engine rotates through; it cannot move funds."
          />
          <LadderTreasuryPanel />

          <GroupHeader
            index="G5 · OWNERSHIP"
            title="Two-step handoff"
            blurb="Ownable2Step on both contracts. Initiating a transfer changes nothing until the recipient accepts, which is what makes a mistyped address recoverable."
          />
          <OwnershipPanel connected={address} />

          <GroupHeader
            index="DIAG · DIAGNOSTICS"
            title="Build fingerprint and off-chain config"
            blurb="Read-only telemetry plus the one control on this page that is a signed API call rather than a transaction."
          />
          <InitcodeHashMonitor />
          <ExchangeRatePanel />

          <div className="pt-12">
            <Line />
            <p className="text-[10px] text-[#555] tracking-[0.4em] uppercase text-center pt-6">
              every on-chain write here is onlyOwner · chain {TARGET_CHAIN_ID}
            </p>
          </div>
        </main>
      </div>
    </WriteAccessContext.Provider>
  )
}
