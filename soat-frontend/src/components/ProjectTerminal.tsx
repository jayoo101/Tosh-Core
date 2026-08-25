'use client'

/**
 * Tosh Protocol · CRYPTOGRAPHIC TRADING TERMINAL  (v5.0 — ETH-native)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   PHASE 1 · GENESIS
 *     ▸ Native ETH deposits via factory.deposit{value}(hook, referrer)
 *     ▸ H-01 PoG quota ledger
 *
 *   PHASE 2 · DISCRETE TIER SHELVES
 *     ▸ 4000 fixed-price rungs, 105 % min(spot, TWAP) unlock gate
 *     ▸ hook.mintBondingCurve{value}(tokenAmount)
 *
 *   PHASE 3 · REFUND
 *     ▸ hook.refund() returns 100 % of the ETH deposit
 */

import {
  useState, useEffect, useCallback,
} from 'react'
import {
  useAccount,
  useBalance,
  useBlockNumber,
  useChainId,
  useReadContracts,
  useReadContract,
  useSignMessage,
  useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import {
  parseUnits, formatUnits, parseEventLogs, erc20Abi,
  type Address, type ContractFunctionParameters,
} from 'viem'

import type { ProjectRow } from '@/app/lib/supabase'
import {
  FACTORY_ABI, FACTORY_ADDRESS,
  HOOK_ABI,
  TARGET_CHAIN_ID,
  isSupportedPogChain,
  testnetExplorerTx,
  BONDING_MAX,
  LAUNCH_WINDOW_SECONDS,
  TIER_COUNT,
  TIER_SIZE,
  TWAP_WINDOW_LABEL,
  POG_SESSION_AUTH_TTL_MS,
  buildPoGScanAuthMessage,
  ZERO_ADDRESS,
  POSITION_MANAGER,
  PERMIT2,
} from '@/lib/contracts'
import { POSM_ABI, PERMIT2_ABI } from '@/lib/lpAbis'
import { pairedAmount1, liquidityForAmounts, amountsForLiquidity } from '@/lib/v4Math'
import { encodeMintPayload, encodeBurnPayload } from '@/lib/lpActions'
import { useLpPoolState, useLpPositions, rememberLpPosition } from '@/lib/useLpPosition'
import { useBoundReferrer, buildReferralLink } from '@/lib/useReferral'
import { classifyHorizon, formatHorizonLabel, formatHorizonUtc } from '@/components/ui'

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Buy-side slippage tolerance in basis points (0.5 %).  Padded into the
 *  on-chain quote and sent as `msg.value`; excess ETH is refunded by the hook. */
const SLIPPAGE_BPS = 50n

const LP_SLIPPAGE_PRESETS = [
  { bps: 50n,  label: '0.5%' },
  { bps: 100n, label: '1%' },
  { bps: 200n, label: '2%' },
  { bps: 500n, label: '5%' },
] as const

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function fmt(wei: bigint | undefined, dec = 18, precision = 4): string {
  if (wei === undefined) return '—'
  try {
    const s = formatUnits(wei, dec)
    const n = parseFloat(s)
    if (n === 0)        return '0'
    if (n < 0.0001)     return n.toExponential(2)
    if (n >= 1e9)       return (n / 1e9).toFixed(2) + 'B'
    if (n >= 1e6)       return (n / 1e6).toFixed(2) + 'M'
    if (n >= 1e3)       return (n / 1e3).toFixed(2) + 'K'
    return n.toLocaleString('en-US', { maximumFractionDigits: precision })
  } catch { return '0' }
}

function fmtFull(wei: bigint | undefined, dec = 18): string {
  if (wei === undefined) return '—'
  try { return formatUnits(wei, dec) } catch { return '0' }
}

function basescanTx(hash: string) {
  return testnetExplorerTx(hash)
}

// ── Session auth cache (matches API route's SESSION_AUTH_TTL_MS) ─────────────
interface PogAuthCache { signature: `0x${string}`; timestamp: number }

function pogAuthCacheKey(address: string): string {
  return `tosh_pog_auth_${address.toLowerCase()}`
}

function readPogAuthCache(address: string): PogAuthCache | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(pogAuthCacheKey(address))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PogAuthCache
    if (
      typeof parsed.timestamp !== 'number' ||
      typeof parsed.signature !== 'string' ||
      !parsed.signature.startsWith('0x')
    ) return null
    if (Date.now() - parsed.timestamp >= POG_SESSION_AUTH_TTL_MS) return null
    return parsed
  } catch { return null }
}

function writePogAuthCache(address: string, data: PogAuthCache): void {
  if (typeof window === 'undefined') return
  try { sessionStorage.setItem(pogAuthCacheKey(address), JSON.stringify(data)) }
  catch { /* private mode etc — scan still works, just no cache */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// MINIMAL PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────


const labelCls = 'text-[10px] tracking-[0.32em] uppercase text-[#888] font-light'

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

function Readout({
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

function Field({
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
function WriteButton({
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

function AlarmLine({ msg }: { msg: string | null }) {
  if (!msg) return null
  return (
    <p className="text-[10px] font-mono text-[#888] tracking-wider leading-relaxed">
      <span className="text-tosh-rust">[REVERT]</span> {msg}
    </p>
  )
}

function TxLine({ hash, label }: { hash?: `0x${string}`; label: string }) {
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

function ProgressBar({
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

// ─────────────────────────────────────────────────────────────────────────────
// H-01 LEDGER  ·  pure-text reconciliation
// ─────────────────────────────────────────────────────────────────────────────
//
// Account ledger format — left aligned debit, right aligned credit, totals at
// the bottom.  The quota is a per-WINDOW budget (`quotaWindowDuration`, 24 h by
// default), not a lifetime allowance, so everything here is denominated against
// the live `factory.eligibility()` verdict rather than against a cumulative
// deposit total.  While the projected deposit still fits, the final line reads:
//
//     → H-01_GUARD: ACTIVE
//
// On actual breach (a parsed input that exceeds the remaining window budget)
// the guard line flips to:
//
//     → H-01_BREACH: INTERCEPTED
//
// and the DEPOSIT button locks (handled in the GenesisPanel).
//

/// Why `eligibility` reports no headroom, when the reason is not that the
/// window is spent.  A live cooldown, a ban and a never-registered attestation
/// all short-circuit it to `(false, 0, 0)`, and none of the three is the fact
/// "you have none left" — so each is named rather than rendered as a balance.
type QuotaBlock = 'cooldown' | 'banned' | 'unattested' | null

function QuotaLedger({
  quota, remaining, projected, blocked,
}: {
  quota:     bigint
  remaining: bigint
  projected: bigint
  blocked:   QuotaBlock
}) {
  const stale     = blocked !== null
  const spent     = quota > remaining ? quota - remaining : 0n
  const breached  = !stale && projected > 0n && projected > remaining
  const consumed  = quota > 0n
    ? Number((spent * 10_000n) / quota) / 100
    : 0
  const projConsumed = quota > 0n && projected > 0n
    ? Number(((spent + projected) * 10_000n) / quota) / 100
    : consumed
  const statusTxt = blocked === 'cooldown'   ? 'WINDOW UNREADABLE'
                  : blocked === 'banned'     ? 'BLACKLISTED'
                  : blocked === 'unattested' ? 'NO ATTESTATION'
                  : `${consumed.toFixed(1)}% CONSUMED`

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between border-b border-[#1F1F2E]/60 py-1.5">
      <span className={labelCls}>{label}</span>
      <span className="font-mono text-[11px] text-white tabular-nums break-all text-right">
        {value}
      </span>
    </div>
  )

  return (
    <div className="border border-[#1F1F2E] px-4 py-3 flex flex-col gap-1">
      <div className="flex items-center justify-between pb-1">
        <span className="text-[10px] tracking-[0.4em] uppercase text-[#888] font-bold">
          {'// [H-01] QUOTA LEDGER'}
        </span>
        <span className="font-mono text-[10px] text-[#666] tabular-nums">
          {statusTxt}
        </span>
      </div>
      {row(
        'POG QUOTA · PER WINDOW',
        blocked === 'unattested' ? '—' : `${fmt(quota)} ETH`,
      )}
      {row('SPENT THIS WINDOW',      stale ? '—' : `${fmt(spent)} ETH`)}
      {row('REMAINING',              stale ? '—' : `${fmt(remaining)} ETH`)}
      {!stale && projected > 0n && (
        row(
          'PROJECTED (THIS TX)',
          <>
            +{fmt(projected)} ETH{' '}
            <span className="text-[#555]">→ {projConsumed.toFixed(1)}%</span>
          </>
        )
      )}
      <div className="pt-2">
        {breached
          ? (
            <p className="font-mono text-[10px] tracking-[0.4em] uppercase text-tosh-fluo">
              → H-01_BREACH: INTERCEPTED
            </p>
          )
          : (
            <p className="font-mono text-[10px] tracking-[0.4em] uppercase text-[#666]">
              → H-01_GUARD: ACTIVE
            </p>
          )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SHELF LADDER  ·  4000 discrete rungs, 105 % price gate
// ─────────────────────────────────────────────────────────────────────────────

type TierRow = { price: bigint; totalAmount: bigint; soldAmount: bigint }

function ShelfLadder({
  hookAddress, p0, halted,
}: {
  hookAddress: Address
  p0:          bigint
  /// The protocol circuit breaker, lifted from the panel that already reads it
  /// rather than polled a second time here.  It is orthogonal to the 105% price
  /// gate — the gate can be wide open while the hook refuses every mint — so it
  /// gets its own badge state instead of being folded into `unlocked`.
  halted:      boolean
}) {
  const { data: statusRaw } = useReadContract({
    address:      hookAddress,
    abi:          HOOK_ABI,
    functionName: 'tierStatus',
    query:        { refetchInterval: 8_000 },
  })
  const status = statusRaw as
    | readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean]
    | undefined

  const tierIndex = status?.[0] ?? 0n
  const tierPrice = status?.[1] ?? 0n
  const remaining = status?.[2] ?? 0n
  const spotPrice = status?.[3] ?? 0n
  const twapPrice = status?.[4] ?? 0n
  const ceiling   = status?.[5] ?? 0n
  const unlocked  = status?.[6] ?? false

  const windowStart = tierIndex > 2n ? tierIndex - 2n : 0n
  const { data: windowRaw } = useReadContract({
    address:      hookAddress,
    abi:          HOOK_ABI,
    functionName: 'getTiers',
    args:         [windowStart, 5n],
    query:        { refetchInterval: 8_000 },
  })
  const window = (windowRaw as readonly TierRow[] | undefined) ?? []

  const fillPct = TIER_SIZE > 0n
    ? Number(((TIER_SIZE - remaining) * 10_000n) / TIER_SIZE) / 100
    : 0

  return (
    <div className="border border-[#1F1F2E]">
      <div className="flex items-baseline justify-between px-4 py-2 border-b border-[#1F1F2E]">
        <span className="text-[10px] tracking-[0.4em] uppercase text-[#888] font-bold">
          {'// DISCRETE SHELF LADDER · 4000 RUNGS · 2000× SPAN'}
        </span>
        <span className={`font-mono text-[10px] tabular-nums
                          ${halted ? 'text-tosh-rust' : 'text-[#666]'}`}>
          {halted
            ? 'LADDER HALTED · BREAKER'
            : unlocked ? 'GATE OPEN' : 'GATE LOCKED · 105%'}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 px-4 py-3">
        <Readout label="ACTIVE SHELF" value={`#${tierIndex.toString()} / ${TIER_COUNT}`} />
        <Readout label="SHELF PRICE"  value={`${fmt(tierPrice)} ETH`} hint="per whole token" />
        <Readout label="REMAINING"    value={fmt(remaining)} hint="tokens on this rung" />
        <Readout
          label="105% CEILING"
          value={`${fmt(ceiling)} ETH`}
          hint={unlocked ? 'min(spot, twap) · unlocked' : 'wait for spot/TWAP'}
          tone={unlocked ? 'fluo' : 'mute'}
        />
      </div>

      <div className="px-4 pb-3">
        <ProgressBar
          pct={fillPct}
          label={`SHELF #${tierIndex.toString()} FILL`}
          totalLabel={`${fmt(TIER_SIZE - remaining)} / ${fmt(TIER_SIZE)}`}
        />
      </div>

      <div className="border-t border-[#1F1F2E] divide-y divide-[#1F1F2E]/60">
        {window.map((t, i) => {
          const idx = windowStart + BigInt(i)
          const active = idx === tierIndex
          const soldPct = t.totalAmount > 0n
            ? Number((t.soldAmount * 10_000n) / t.totalAmount) / 100
            : 0
          return (
            <div
              key={idx.toString()}
              className={`grid grid-cols-[4rem_1fr_6rem_5rem] gap-3 px-4 py-1.5 font-mono text-[11px] tabular-nums
                          ${active ? 'text-white bg-white/[0.03]' : 'text-[#888]'}`}
            >
              <span>#{idx.toString()}</span>
              <span>{fmt(t.price)} ETH</span>
              <span>{soldPct.toFixed(1)}%</span>
              <span className="text-right">{active ? 'LIVE' : idx < tierIndex ? 'CLEARED' : 'QUEUED'}</span>
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-[#1F1F2E]
                      font-mono text-[10px] text-[#666] tabular-nums">
        <span>P₀ = <span className="text-white">{fmt(p0)} ETH</span></span>
        <span>spot = <span className="text-white">{fmt(spotPrice)}</span></span>
        {/* A zero TWAP is the hook's "no full window yet" signal, not a price of
            zero — the ceiling caps against P₀ until the window matures. */}
        <span>
          twap ={' '}
          {twapPrice > 0n
            ? <span className="text-white">{fmt(twapPrice)}</span>
            : <span className="text-[#888]">MATURING · {TWAP_WINDOW_LABEL} WINDOW · CEILING ON P₀</span>}
        </span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

type Phase = 'genesis' | 'awaiting_launch' | 'bonding' | 'refund'

/// Mirrors the hook's own state machine.  Two rules matter and an earlier
/// revision broke both with one clause (`totalEthDeposited >= softCap` also
/// meaning "bonding"):
///
///   • The shelf ladder does not exist until `launch()` has run.  Reaching the
///     soft cap does NOT open it — the creator still has to call `launch()`,
///     and cannot even do that until the genesis deadline passes.  Showing the
///     bonding panel early handed users a mint button that could only revert.
///   • Deposits stay open for the whole genesis window.  The soft cap is a
///     floor, not a ceiling, so closing the deposit panel on contact with it
///     capped every raise at exactly its minimum.
function resolvePhase({
  totalEthDeposited, softCap, canRefund, launched, genesisDeadline, nowSec,
}: {
  totalEthDeposited: bigint
  softCap:            bigint
  canRefund:          boolean
  launched:           boolean
  genesisDeadline:    bigint
  nowSec:             number
}): Phase {
  if (launched) return 'bonding'
  if (canRefund) return 'refund'

  // Before the first poll resolves, `genesisDeadline` is 0; treat that as
  // "still loading" rather than "expired".
  if (genesisDeadline === 0n || BigInt(nowSec) < genesisDeadline) return 'genesis'

  // Deadline passed and not yet launched.  Re-derive the outcome from the same
  // inputs the contract uses instead of trusting `canRefund`, which is polled
  // and can lag the clock by up to a refetch interval.
  //
  // The soft cap alone is not enough: once the launch window lapses on top of
  // it the hook opens `refund()` to everyone, and reading the cap in isolation
  // parked the user on a launch panel whose own copy said the refund was open
  // while no refund button existed anywhere on the page.
  const zombie = BigInt(nowSec) >= genesisDeadline + LAUNCH_WINDOW_SECONDS
  return totalEthDeposited >= softCap && softCap > 0n && !zombie
    ? 'awaiting_launch'
    : 'refund'
}

// ─────────────────────────────────────────────────────────────────────────────
// GENESIS PANEL  ·  Phase 1
// ─────────────────────────────────────────────────────────────────────────────

interface GenesisProps {
  hookAddress:        Address
  symbol:             string
  userAddress:        Address | undefined
  isConnected:        boolean
  totalEthDeposited:  bigint
  softCap:            bigint
  ethBalance:         bigint
  pogQuota:           bigint
  /// Straight from `factory.eligibility(user, hook)`.  The quota is refilled
  /// once per `quotaWindowDuration`, and only the factory can tell whether a
  /// lapsed window has already been credited back, so this is never derived
  /// client-side from a cumulative deposit total.
  quotaRemaining:     bigint
  /// `eligibility` short-circuits on a ban and on a missing attestation into the
  /// same `(false, 0, 0)` an exhausted window produces, so the ban stamp is read
  /// alongside `pogQuota` to tell the three apart.
  blacklistedUntil:   bigint
  cooldownEnd:        bigint
  nowSec:             number
  /// This project's own deposit ceiling per wallet, snapshotted into the hook
  /// at creation.  Distinct from the platform-wide PoG quota above: the hook
  /// rejects on whichever binds first.
  perWalletCap:       bigint
  userDeposited:      bigint
  genesisDeadline:    bigint
  /// Lifetime referrer bound to this visitor, or the zero sentinel.  Passed
  /// straight through to `factory.deposit`; the factory ignores it when the
  /// wallet is already bound, so a stale link can never brick a deposit.
  referrer:           Address
  refetch:            () => void
}

function GenesisPanel(p: GenesisProps) {
  const [amount, setAmount] = useState('')
  const [error,  setError]  = useState<string | null>(null)

  const amountWei = (() => {
    const t = amount.trim()
    if (!t) return 0n
    try { return parseUnits(t, 18) } catch { return -1n }
  })()
  const amountInvalid = amountWei === -1n

  // `factory.deposit` rejects in a fixed order — IsBlacklisted, then NoPogQuota,
  // then the cooldown, then the window budget — and `eligibility` collapses the
  // first two into the same zero the last one produces.  Mirror that order here
  // so a ban never reads as an allowance the user can simply wait out.
  const banned          = p.blacklistedUntil > 0n && BigInt(p.nowSec) < p.blacklistedUntil
  const unattested      = !banned && p.pogQuota === 0n
  const onCooldown      = !banned && !unattested
                       && p.cooldownEnd > 0n && BigInt(p.nowSec) < p.cooldownEnd
  const quotaBlock: QuotaBlock = banned
    ? 'banned'
    : unattested ? 'unattested'
    : onCooldown ? 'cooldown'
    : null

  // One gateway from the raw stamp to anything that formats it, so a permanent
  // ban cannot reach `Date` and throw.  The horizon decides; the formatters
  // only ever see a value they have been told is representable.
  const banHorizon = classifyHorizon(p.blacklistedUntil, p.nowSec)
  const banTxt = formatHorizonLabel(banHorizon, {
    unbounded: 'PERMANENT · NO EXPIRY',
    elapsed:   'LAPSED',
    pending:   d => `LIFTS IN ${d}`,
  })
  const banLiftsAt = formatHorizonUtc(banHorizon)

  const quotaRemaining  = p.quotaRemaining
  const quotaBreached   = quotaBlock === null && amountWei > 0n && amountWei > quotaRemaining
  const insufficientBal = amountWei > 0n && amountWei > p.ethBalance
  const pctGenesis      = p.softCap > 0n
    ? Number((p.totalEthDeposited * 10_000n) / p.softCap) / 100
    : 0

  // The soft cap is a floor, not a ceiling: the hook keeps accepting deposits
  // right up to the deadline.  Say so, so clearing the cap reads as momentum
  // rather than as a closed door.
  const oversubscribed = p.softCap > 0n && p.totalEthDeposited >= p.softCap

  // The hook rejects `deposit` outright once the window closes, and separately
  // once this wallet's total for THIS project passes the per-project cap.
  // Neither was mirrored here, so both surfaced only as a reverted transaction.
  const windowClosed  = p.genesisDeadline > 0n && BigInt(p.nowSec) >= p.genesisDeadline
  const walletHeadroom = p.perWalletCap > p.userDeposited
    ? p.perWalletCap - p.userDeposited
    : 0n
  const walletCapBreached = p.perWalletCap > 0n && amountWei > 0n && amountWei > walletHeadroom

  // The binding ceiling is whichever of the two runs out first.
  const spendable = (() => {
    let cap = quotaRemaining
    if (p.perWalletCap > 0n && walletHeadroom < cap) cap = walletHeadroom
    return cap < p.ethBalance ? cap : p.ethBalance
  })()

  const {
    writeContract: writeDeposit,
    isPending:     isDepositing,
    data:          depositHash,
    error:         depositError,
  } = useWriteContract()
  const { isLoading: isDepositConfirming, isSuccess: depositedNow } =
    useWaitForTransactionReceipt({ hash: depositHash })
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (depositedNow) { p.refetch(); setAmount('') } }, [depositedNow, p])

  const txBusy = isDepositing || isDepositConfirming

  const handleDeposit = useCallback(() => {
    setError(null)
    if (!p.userAddress)  { setError('Connect wallet'); return }
    if (banned)          { setError(`This wallet is blacklisted — the factory rejects every deposit from it (${banTxt.toLowerCase()})`); return }
    if (unattested)      { setError('No PoG attestation on file — run the gas-proof scan to receive a quota'); return }
    if (windowClosed)    { setError('Genesis window has closed'); return }
    if (amountWei <= 0n) { setError('Enter a positive ETH amount'); return }
    if (insufficientBal) { setError('Insufficient ETH balance'); return }
    if (quotaBreached)   { return }
    if (walletCapBreached) {
      setError(`Exceeds this project's per-wallet cap — ${fmt(walletHeadroom)} ETH left`)
      return
    }
    if (onCooldown)      { setError('Cooldown — wait before re-depositing'); return }
    writeDeposit({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: 'deposit',
      args: [p.hookAddress, p.referrer],
      value: amountWei,
      chainId: TARGET_CHAIN_ID,
    })
  }, [
    p.userAddress, amountWei, insufficientBal, quotaBreached, onCooldown,
    p.hookAddress, p.referrer, writeDeposit, windowClosed, walletCapBreached,
    walletHeadroom, banned, banTxt, unattested,
  ])

  const cooldownTxt = (() => {
    if (p.cooldownEnd === 0n) return '—'
    const rem = Number(p.cooldownEnd) - p.nowSec
    if (rem <= 0) return 'CLEAR'
    const h = Math.floor(rem / 3600)
    const m = Math.floor((rem % 3600) / 60)
    const s = rem % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  })()

  const armed = !quotaBreached
             && amountWei > 0n
             && !amountInvalid
             && !insufficientBal
             && !banned
             && !unattested
             && !onCooldown
             && !windowClosed
             && !walletCapBreached
             && p.isConnected

  return (
    <div className="flex flex-col">
      <Section
        id="P-1"
        title={`GENESIS PULSE · ${p.symbol}`}
        subtitle="factory.deposit{value}(hook, referrer) — collecting genesis ETH until the window closes"
      >
        <ProgressBar
          pct={pctGenesis}
          label={`GENESIS PROGRESS · ${p.symbol}`}
          totalLabel={`${fmt(p.totalEthDeposited)} / ${fmt(p.softCap)} ETH`}
        />

        {oversubscribed && !windowClosed && (
          <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-tosh-fluo leading-relaxed">
            → OVERSUBSCRIBED · SOFT CAP CLEARED, DEPOSITS STAY OPEN UNTIL THE WINDOW ENDS
          </p>
        )}

        {windowClosed && (
          <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-tosh-amber leading-relaxed">
            → WINDOW CLOSED · NO FURTHER DEPOSITS ACCEPTED
          </p>
        )}

        {banned && (
          <div className="border border-tosh-rust/40 px-4 py-3 flex flex-col gap-1">
            <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-tosh-rust">
              → WALLET BLACKLISTED · {banTxt}
            </p>
            <p className="font-mono text-[11px] text-[#888] leading-relaxed">
              The factory rejects every <span className="text-white">deposit</span> from this
              address while the ban stands, whatever quota it holds — so the zero here is a
              ban, not a spent allowance.{' '}
              {banLiftsAt
                ? <>The ban expires on its own at <span className="text-white">{banLiftsAt}</span>, after
                   which the quota is spendable again with nothing to reset.</>
                : <>Only the protocol owner can clear a permanent ban.</>}
            </p>
          </div>
        )}

        {unattested && (
          <div className="border border-tosh-amber/40 px-4 py-3 flex flex-col gap-1">
            <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-tosh-amber">
              → NO POG ATTESTATION ON FILE
            </p>
            <p className="font-mono text-[11px] text-[#888] leading-relaxed">
              This wallet has never registered Proof-of-Gas, so it holds no quota to spend —
              nothing has been consumed here. Run{' '}
              <span className="text-white">EXECUTE_GAS_PROOF_SCAN</span> below to have the
              oracle size an allocation from this address&apos;s gas history and write it
              on-chain; deposits open the moment that lands.
            </p>
          </div>
        )}

        <QuotaLedger
          quota={p.pogQuota}
          remaining={quotaRemaining}
          projected={amountWei > 0n ? amountWei : 0n}
          blocked={quotaBlock}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
          <Readout label="ETH BALANCE"
                   value={`${fmt(p.ethBalance)} ETH`}
                   hint={fmtFull(p.ethBalance, 18)} />
          <Readout label="COOLDOWN"
                   value={cooldownTxt}
                   tone={onCooldown ? 'mute' : 'ink'} />
        </div>

        {p.referrer !== ZERO_ADDRESS && (
          <Readout
            label="REFERRED BY"
            value={`${p.referrer.slice(0, 10)}…${p.referrer.slice(-6)}`}
            hint="bound platform-wide on your first deposit · 10% of it credits them"
            tone="fluo"
          />
        )}

        <Field
          label="DEPOSIT AMOUNT · ETH"
          value={amount}
          onChange={v => { setAmount(v); setError(null) }}
          placeholder="e.g. 0.05"
          inputMode="decimal"
          disabled={txBusy || !p.isConnected || windowClosed || banned || unattested}
          errored={amountInvalid || quotaBreached || insufficientBal || walletCapBreached || banned}
          fluo={armed}
          hint={
            banned
              ? <span className="text-tosh-rust">→ WALLET BLACKLISTED · {banTxt}</span>
              : unattested
              ? <span className="text-tosh-amber">→ NO POG QUOTA — RUN THE GAS-PROOF SCAN FIRST</span>
              : windowClosed
              ? <span className="text-tosh-amber">→ GENESIS WINDOW CLOSED — WAITING ON THE CREATOR&apos;S LAUNCH()</span>
              : p.perWalletCap > 0n
                ? <span className="text-[#555]">
                    → THIS PROJECT ALLOWS {fmt(p.perWalletCap)} ETH PER WALLET · {fmt(walletHeadroom)} ETH LEFT FOR YOU
                  </span>
                : null
          }
          suffix={
            <button
              type="button"
              onClick={() => setAmount(formatUnits(spendable, 18))}
              disabled={txBusy || !p.isConnected || windowClosed || spendable === 0n}
              className="px-3 py-2 border border-[#1F1F2E] text-[#888] text-[10px]
                         tracking-[0.32em] uppercase font-bold
                         hover:border-tosh-fluo hover:text-tosh-fluo
                         disabled:opacity-40 disabled:cursor-not-allowed
                         transition-colors duration-150"
            >
              max
            </button>
          }
        />

        <div className="flex gap-3 flex-wrap items-center">
          <WriteButton
            label="deposit"
            lockedLabel={
              banned
                ? '[wallet_blacklisted]'
                : unattested
                ? '[pog_attestation_required]'
                : windowClosed
                ? '[genesis_window_closed]'
                : quotaBreached
                  ? '[revert: quota_exceeded]'
                  : walletCapBreached
                    ? `[per_wallet_cap · ${fmt(walletHeadroom)} eth left]`
                    : onCooldown
                      ? `[cooldown ${cooldownTxt}]`
                      : insufficientBal
                        ? '[insufficient_balance]'
                        : '[deposit]'
            }
            locked={!armed}
            busy={isDepositing || isDepositConfirming}
            onClick={handleDeposit}
          />
          <PogScanButton
            userAddress={p.userAddress}
            hookAddress={p.hookAddress}
            refetch={p.refetch}
          />
        </div>

        <AlarmLine msg={error ?? (depositError?.message?.slice(0, 200) ?? null)} />
        <TxLine hash={depositHash} label="deposit" />
      </Section>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// REFERRAL PANEL  ·  share a link, claim the commission it earned
// ─────────────────────────────────────────────────────────────────────────────
//
// The hook carves 10 % off every genesis deposit at deposit time and parks it
// in `referralAccrued`.  It only becomes withdrawable once the project has
// launched — a failed genesis refunds depositors in full and simply never pays
// the commission out — which is exactly what `claimableReferral` encodes, so
// the panel reads that rather than deriving eligibility itself.

function ReferralPanel({
  hookAddress, userAddress, isConnected, refetch,
}: {
  hookAddress: Address
  userAddress: Address | undefined
  isConnected: boolean
  refetch:     () => void
}) {
  const [copied, setCopied] = useState(false)

  const { data: claimableRaw, refetch: refetchClaimable } = useReadContract({
    address:      hookAddress,
    abi:          HOOK_ABI,
    functionName: 'claimableReferral',
    args:         userAddress ? [userAddress] : undefined,
    query:        { enabled: !!userAddress, refetchInterval: 15_000 },
  })
  const claimable = (claimableRaw as bigint | undefined) ?? 0n

  // A referrer must hold their own PoG attestation for `_recordReferral` to
  // bind — the guard that stops the programme being a self-rebate for anyone
  // with a second wallet.  Rejection is silent on-chain (the depositor's
  // transaction still succeeds, the commission just becomes buyback fuel), so
  // an unattested sharer would otherwise watch their link earn nothing with no
  // explanation anywhere.
  const { data: ownQuotaRaw } = useReadContract({
    address:      FACTORY_ADDRESS,
    abi:          FACTORY_ABI,
    functionName: 'pogQuota',
    args:         userAddress ? [userAddress] : undefined,
    query:        { enabled: !!userAddress },
  })
  const linkIsLive = ((ownQuotaRaw as bigint | undefined) ?? 0n) > 0n

  const {
    writeContract, isPending, data: txHash, error: writeError,
  } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } =
    useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => {
    if (!isSuccess) return
    refetch(); void refetchClaimable()
  }, [isSuccess, refetch, refetchClaimable])

  const handleClaim = useCallback(() => {
    writeContract({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'claimReferralReward', args: [],
      chainId: TARGET_CHAIN_ID,
    })
  }, [hookAddress, writeContract])

  const link = userAddress ? buildReferralLink(userAddress) : ''

  const handleCopy = useCallback(() => {
    if (!link) return
    void navigator.clipboard?.writeText(link).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }, [link])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2_000)
    return () => clearTimeout(id)
  }, [copied])

  const txBusy = isPending || isConfirming

  return (
    <Section
      id="REF"
      title="REFERRAL DESK"
      subtitle="10% of every genesis deposit made through your link · payable once the project launches"
    >
      <Readout
        label="CLAIMABLE COMMISSION"
        value={`${fmt(claimable)} ETH`}
        hint={claimable === 0n
          ? 'accrues on deposit · unlocks at launch()'
          : fmtFull(claimable, 18)}
        tone={claimable > 0n ? 'fluo' : 'mute'}
      />

      <WriteButton
        label="claim commission"
        lockedLabel={isConnected ? '[nothing_to_claim]' : '[connect_wallet]'}
        locked={!isConnected || claimable === 0n}
        busy={txBusy}
        onClick={handleClaim}
        full
      />

      {link && (
        <div className="border border-[#1F1F2E] flex flex-col gap-2 px-4 py-3">
          <span className={labelCls}>YOUR REFERRAL LINK</span>
          <p className="font-mono text-[11px] text-[#CCC] break-all leading-relaxed">{link}</p>
          <button
            type="button"
            onClick={handleCopy}
            className="self-start px-3 py-1.5 border border-[#1F1F2E] text-[#888] text-[10px]
                       tracking-[0.32em] uppercase font-bold
                       hover:border-tosh-fluo hover:text-tosh-fluo
                       transition-colors duration-150"
          >
            {copied ? 'copied' : 'copy'}
          </button>
          <p className="text-[10px] text-[#555] tracking-wider leading-relaxed">
            {'// '}The first link a wallet arrives on binds it to you permanently, across every
            project on the platform. Self-referral is ignored by the factory.
          </p>
          {!linkIsLive && (
            <p className="text-[10px] text-tosh-rust tracking-wider leading-relaxed">
              {'// '}This link will not pay yet. A referrer needs their own PoG
              attestation, so register PoG before sharing — until then a deposit
              made through it still goes through, but the 10 % falls through to
              the buyback reservoir instead of accruing to you, and the binding
              is not made.
            </p>
          )}
        </div>
      )}

      <AlarmLine msg={writeError?.message?.slice(0, 200) ?? null} />
      <TxLine hash={txHash} label="claimReferralReward" />
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// GENESIS CLAIM PANEL  ·  pro-rata token allocation, post-launch
// ─────────────────────────────────────────────────────────────────────────────

/// Genesis depositors are owed a pro-rata slice of GENESIS_CLAIM_SUPPLY the
/// moment `launch()` lands.  The only entry point used to live in the user
/// drawer, which meant a depositor sitting on the project page had no way to
/// see — let alone take — the tokens their ETH had already bought.
function GenesisClaimPanel({
  hookAddress, symbol, userAddress, ethDeposited, refetch,
}: {
  hookAddress:  Address
  symbol:       string
  userAddress:  Address | undefined
  ethDeposited: bigint
  refetch:      () => void
}) {
  const { data: hasClaimedRaw, refetch: refetchClaimed } = useReadContract({
    address:      hookAddress,
    abi:          HOOK_ABI,
    functionName: 'hasClaimed',
    args:         userAddress ? [userAddress] : undefined,
    query:        { enabled: !!userAddress, refetchInterval: 15_000 },
  })
  const hasClaimed = (hasClaimedRaw as boolean | undefined) ?? false

  const {
    writeContract, isPending, data: txHash, error: writeError,
  } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } =
    useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => {
    if (!isSuccess) return
    refetch(); void refetchClaimed()
  }, [isSuccess, refetch, refetchClaimed])

  const handleClaim = useCallback(() => {
    writeContract({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'claimGenesis', args: [],
      chainId: TARGET_CHAIN_ID,
    })
  }, [hookAddress, writeContract])

  if (ethDeposited === 0n || hasClaimed) return null

  return (
    <Section
      id="P-1.9"
      title={`GENESIS ALLOCATION · ${symbol}`}
      subtitle="hook.claimGenesis() — your pro-rata share of the genesis block, one claim per wallet"
    >
      <Readout label="YOUR GENESIS DEPOSIT" value={`${fmt(ethDeposited)} ETH`} />
      <WriteButton
        label={`claim ${symbol}`}
        lockedLabel="[claim]"
        locked={false}
        busy={isPending || isConfirming}
        onClick={handleClaim}
        full
      />
      <AlarmLine msg={writeError?.message?.slice(0, 200) ?? null} />
      <TxLine hash={txHash} label="claimGenesis" />
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// POG SCAN BUTTON
// ─────────────────────────────────────────────────────────────────────────────

function PogScanButton({
  userAddress, hookAddress, refetch,
}: {
  userAddress: Address | undefined
  hookAddress: Address | undefined
  refetch:     () => void
}) {
  const chainId = useChainId()
  const { signMessageAsync } = useSignMessage()
  const [busy, setBusy] = useState(false)
  const [msg,  setMsg]  = useState<string | null>(null)
  const [tone, setTone] = useState<'fluo' | 'mute' | 'rust'>('fluo')

  const {
    writeContract: writeRegister,
    isPending:     isRegistering,
    data:          regHash,
  } = useWriteContract()
  const { isLoading: isRegConfirming, isSuccess: regOk } =
    useWaitForTransactionReceipt({ hash: regHash })
  useEffect(() => { if (regOk) refetch() }, [regOk, refetch])

  const run = useCallback(async () => {
    setMsg(null)
    if (!userAddress) { setTone('rust'); setMsg('Connect wallet'); return }
    if (!hookAddress) { setTone('rust'); setMsg('No hook bound'); return }
    if (!isSupportedPogChain(chainId)) {
      setTone('rust'); setMsg(`Unsupported chain (got ${chainId})`); return
    }

    setBusy(true)
    try {
      let auth = readPogAuthCache(userAddress)
      let ts   = auth?.timestamp ?? Date.now()
      if (!auth) {
        ts = Date.now()
        const sig = await signMessageAsync({
          message: buildPoGScanAuthMessage(userAddress, ts),
        })
        auth = { signature: sig as `0x${string}`, timestamp: ts }
        writePogAuthCache(userAddress, auth)
      }

      const res = await fetch('/api/sign-allocation', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userAddress, contractAddress: FACTORY_ADDRESS,
          chainId, timestamp: ts, signature: auth.signature,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)

      const { maxAlloc, nonce, deadline, signature } = data
      setTone('mute')
      setMsg(`GAS_TELEMETRY_LOGGED · ALLOC=${fmt(BigInt(maxAlloc))} ETH · NONCE=${nonce}`)

      writeRegister({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI,
        functionName: 'registerPoG',
        args: [BigInt(maxAlloc), BigInt(deadline), BigInt(nonce), signature as `0x${string}`],
      })
    } catch (err) {
      setTone('rust')
      setMsg(err instanceof Error ? err.message.slice(0, 160) : 'Scan failed')
    } finally {
      setBusy(false)
    }
  }, [userAddress, hookAddress, chainId, signMessageAsync, writeRegister])

  return (
    <div className="flex flex-col items-end gap-1">
      <WriteButton
        label="EXECUTE_GAS_PROOF_SCAN"
        onClick={() => void run()}
        busy={busy || isRegistering || isRegConfirming}
      />
      {msg && (
        <span className={`font-mono text-[10px] tracking-wider
                          ${tone === 'rust'
                            ? 'text-tosh-rust'
                            : tone === 'mute' ? 'text-[#888]' : 'text-tosh-fluo'}`}>
          {tone === 'rust' ? '⛔' : '→'} {msg}
        </span>
      )}
      {regHash && <TxLine hash={regHash} label="registerPoG" />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// BONDING PANEL  ·  Phase 2
// ─────────────────────────────────────────────────────────────────────────────

interface BondingProps {
  hookAddress:  Address
  symbol:       string
  userAddress:  Address | undefined
  isConnected:  boolean
  p0:           bigint
  shelfP0:     bigint
  currentPrice: bigint
  phase2Minted: bigint
  bondingMax:   bigint
  ethBalance:   bigint
  nowSec:       number
  refetch:      () => void
}

function BondingPanel(p: BondingProps) {
  const [tokenAmount, setTokenAmount] = useState('')
  const [error,       setError]       = useState<string | null>(null)

  const tokenAmountWei = (() => {
    const t = tokenAmount.trim()
    if (!t) return 0n
    try { return parseUnits(t, 18) } catch { return -1n }
  })()
  const tokenAmountInvalid = tokenAmountWei === -1n

  const { data: statusRaw } = useReadContract({
    address:      p.hookAddress,
    abi:          HOOK_ABI,
    functionName: 'tierStatus',
    query:        { refetchInterval: 8_000 },
  })
  const status = statusRaw as
    | readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean]
    | undefined
  const unlocked = status?.[6] ?? false

  // An order may sweep several shelves, so the ceiling on a single mint is not
  // TIER_SIZE — it is whatever the hook will still serve in one call, folding
  // in the 105% gate, the end of the ladder and MAX_TIERS_PER_TX.
  const { data: maxMintableRaw } = useReadContract({
    address:      p.hookAddress,
    abi:          HOOK_ABI,
    functionName: 'maxMintable',
    query:        { refetchInterval: 8_000 },
  })
  const maxMintable = (maxMintableRaw as bigint | undefined) ?? 0n
  const exceedsMax = maxMintable > 0n && tokenAmountWei > maxMintable

  // `exceedsMax` is silent at zero, which is exactly the value `maxMintable`
  // reports when the hook will not serve ANY size right now — halted, sold out,
  // or priced out.  Without this the button stayed armed and handed the user a
  // raw revert.
  const noCapacity = maxMintableRaw !== undefined && maxMintable === 0n

  // Owner-triggered circuit breaker.  `ladderMintingHalted` already folds the
  // platform-wide halt and this project's own together — the hook reverts
  // `LadderMintingHalted()` on either — so the two expiry stamps are read
  // alongside it only to say which one is biting and when it lifts.
  const haltContracts: ContractFunctionParameters[] = [
    { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'ladderMintingHalted',    args: [p.hookAddress] },
    { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'globalLadderHaltedUntil' },
    { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'hookLadderHaltedUntil',  args: [p.hookAddress] },
  ]
  const { data: haltData } = useReadContracts({
    contracts: haltContracts,
    query: { refetchInterval: 8_000 },
  })
  const halted        = (haltData?.[0]?.result as boolean | undefined) ?? false
  const globalHaltEnd = (haltData?.[1]?.result as bigint  | undefined) ?? 0n
  const hookHaltEnd   = (haltData?.[2]?.result as bigint  | undefined) ?? 0n
  const haltIsGlobal  = BigInt(p.nowSec) < globalHaltEnd
  const haltEndsAt    = haltIsGlobal ? globalHaltEnd : hookHaltEnd
  const haltTxt = (() => {
    const rem = Number(haltEndsAt) - p.nowSec
    if (rem <= 0) return 'PENDING RESUME'
    const h = Math.floor(rem / 3600)
    const m = Math.floor((rem % 3600) / 60)
    const s = rem % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  })()

  // Any swap on this pool stamps `lastSwapBlock`, and the hook refuses to mint
  // in that same block so a flash-pumped price can never be observed by the
  // 105% gate before it unwinds.  Polled together with the block height at the
  // same cadence, otherwise the two reads disagree about what "now" is.
  const { data: lastSwapBlockRaw } = useReadContract({
    address:      p.hookAddress,
    abi:          HOOK_ABI,
    functionName: 'lastSwapBlock',
    query:        { refetchInterval: 4_000 },
  })
  const lastSwapBlock = (lastSwapBlockRaw as bigint | undefined) ?? 0n
  const { data: blockNumber } = useBlockNumber({
    query: { refetchInterval: 4_000 },
  })
  const sameBlockLock =
    lastSwapBlock > 0n && blockNumber !== undefined && lastSwapBlock >= blockNumber

  const quotable = tokenAmountWei > 0n && !exceedsMax && !halted && !noCapacity

  const { data: quoteData, isFetching: isQuoting, isError: quoteFailed } = useReadContract({
    address:      p.hookAddress,
    abi:          HOOK_ABI,
    functionName: 'quoteMint',
    args:         quotable ? [tokenAmountWei] : undefined,
    query: {
      enabled:         quotable,
      refetchInterval: 8_000,
    },
  })
  const ethCost = (quoteData as bigint | undefined) ?? 0n
  const isDust = quotable && !quoteFailed && ethCost === 0n
  const maxEthCost = ethCost === 0n ? 0n : ethCost + (ethCost * SLIPPAGE_BPS) / 10_000n
  const insufficientBal = maxEthCost > 0n && maxEthCost > p.ethBalance
  const gateLocked = tokenAmountWei > 0n && !unlocked

  // Before anyone has minted, a shut gate is the DESIGNED opening state, not a
  // fault: shelf 0 sits 5% over the pool, so the ladder lifts only once the
  // market holds at or above the genesis price.  Say that instead of alarming.
  const awaitingFirstUnlock = gateLocked && p.phase2Minted === 0n

  const {
    writeContract: writeMint,
    isPending:     isMinting,
    data:          mintHash,
    error:         mintError,
  } = useWriteContract()
  const { isLoading: isMintConfirming, isSuccess: mintedNow } =
    useWaitForTransactionReceipt({ hash: mintHash })
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (mintedNow) { p.refetch(); setTokenAmount('') } }, [mintedNow, p])

  const txBusy = isMinting || isMintConfirming

  const handleMint = useCallback(() => {
    setError(null)
    if (!p.userAddress)       { setError('Connect wallet'); return }
    if (halted)               { setError(`Shelf minting is suspended by the protocol circuit breaker${haltIsGlobal ? ' (platform-wide)' : ''} — it lifts on its own in ${haltTxt}`); return }
    if (tokenAmountWei <= 0n) { setError('Enter a positive token amount'); return }
    if (exceedsMax)           { setError(`Exceeds what one call can serve — max ${fmt(maxMintable)} right now`); return }
    if (sameBlockLock)        { setError('Minting is shut for this block — the ladder reopens on the next one'); return }
    if (awaitingFirstUnlock)  { setError('Shelf 0 sits 5% over the pool — the ladder opens once the market holds at or above P₀'); return }
    if (gateLocked)           { setError('105% price gate is locked — wait for spot/TWAP'); return }
    if (noCapacity)           { setError('The hook will serve no size in one call right now — the ladder is fully sold or priced out at the margin'); return }
    if (isDust)               { return }
    if (insufficientBal)      { setError('Insufficient ETH for quoted cost + slippage'); return }
    writeMint({
      address: p.hookAddress, abi: HOOK_ABI,
      functionName: 'mintBondingCurve',
      args: [tokenAmountWei],
      value: maxEthCost,
      chainId: TARGET_CHAIN_ID,
    })
  }, [
    p.userAddress, p.hookAddress, tokenAmountWei, exceedsMax, maxMintable,
    awaitingFirstUnlock, gateLocked, isDust, insufficientBal, maxEthCost,
    sameBlockLock, halted, haltIsGlobal, haltTxt, noCapacity, writeMint,
  ])

  // Rungs climbed since shelf 0, i.e. STEP^index.  Measured against the LADDER
  // base rather than the pool's opening price, so the flat 5% mint premium
  // does not masquerade as ladder progress.
  const premiumRaw =
    p.shelfP0 > 0n && p.currentPrice > 0n
      ? Number(p.currentPrice * 1000n / p.shelfP0) / 1000
      : 1

  const armed = !isDust
             && tokenAmountWei > 0n
             && !tokenAmountInvalid
             && !exceedsMax
             && !insufficientBal
             && !gateLocked
             && !sameBlockLock
             && !halted
             && !noCapacity
             && p.isConnected

  return (
    <Section
      id="P-2"
      title={`SHELF LADDER · ${p.symbol}`}
      subtitle="hook.mintBondingCurve{value}(tokenAmount) · 4000 rungs to 2000× · sweeps shelves · 105% min(spot, TWAP) gate"
    >
      <ShelfLadder hookAddress={p.hookAddress} p0={p.p0} halted={halted} />

      {halted && (
        <div className="border border-tosh-rust/40 px-4 py-3 flex flex-col gap-1">
          <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-tosh-rust">
            → LADDER SUSPENDED · {haltIsGlobal ? 'PLATFORM-WIDE' : 'THIS PROJECT'} · LIFTS IN {haltTxt}
          </p>
          <p className="font-mono text-[11px] text-[#888] leading-relaxed">
            The protocol owner has tripped the circuit breaker, so the hook
            rejects every <span className="text-white">mintBondingCurve</span> call
            until it expires. The pool itself is untouched — the token still
            trades on Uniswap, existing balances are unaffected, and the halt
            lapses on its own without any further action.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6">
        <Readout label="P₀ · POOL OPEN"
                 value={`${fmt(p.p0)} ETH`}
                 hint="genesis LP price" />
        <Readout label="SHELF 0 · +5%"
                 value={`${fmt(p.shelfP0)} ETH`}
                 hint="mint premium over market" />
        <Readout label="ACTIVE SHELF"
                 value={`${fmt(p.currentPrice)} ETH`}
                 hint={`${premiumRaw.toFixed(2)}× ladder base`} />
        <Readout label="PHASE-2 MINTED"
                 value={`${fmt(p.phase2Minted)} / ${fmt(p.bondingMax)}`}
                 hint={`${TIER_COUNT} shelves × ${fmt(TIER_SIZE)}`} />
      </div>

      <Field
        label="TOKEN AMOUNT TO MINT"
        value={tokenAmount}
        onChange={v => { setTokenAmount(v); setError(null) }}
        placeholder="e.g. 1000"
        inputMode="decimal"
        disabled={txBusy || !p.isConnected || halted}
        errored={tokenAmountInvalid || exceedsMax || isDust || insufficientBal || gateLocked || halted}
        fluo={armed}
        hint={
          halted
            ? <span className="text-tosh-rust">→ CIRCUIT BREAKER ENGAGED — SHELF MINTING RESUMES IN {haltTxt}</span>
            : sameBlockLock
            ? <span className="text-tosh-amber">→ MINTING IS SHUT FOR THIS BLOCK — THE LADDER REOPENS NEXT BLOCK</span>
            : awaitingFirstUnlock
            ? <span className="text-[#888]">→ LADDER OPENS ONCE THE MARKET HOLDS AT OR ABOVE P₀</span>
            : gateLocked
            ? <span className="text-tosh-rust">→ 105% PRICE GATE LOCKED</span>
            : exceedsMax
              ? <span className="text-tosh-rust">→ EXCEEDS MAX PER CALL ({fmt(maxMintable)}) — SEND A SECOND TX FOR THE REST</span>
              : noCapacity && unlocked
                ? <span className="text-tosh-rust">→ NO SIZE AVAILABLE IN ONE CALL RIGHT NOW — THE LADDER IS FULLY SOLD OR PRICED OUT AT THE MARGIN</span>
                : maxMintable > 0n
                  ? <span className="text-[#555]">→ UP TO {fmt(maxMintable)} IN ONE CALL · SWEEPS SHELVES</span>
                  : null
        }
      />

      {quotable && (
        <div className="border border-[#1F1F2E]">
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-x divide-[#1F1F2E]">
            <div className="px-4 py-3 flex flex-col gap-1">
              <span className={labelCls}>QUOTED COST</span>
              <span className="font-mono text-base text-white tabular-nums">
                {isQuoting ? '…' : `${fmt(ethCost)} ETH`}
              </span>
            </div>
            <div className="px-4 py-3 flex flex-col gap-1">
              <span className={labelCls}>MAX W/ 0.5% SLIPPAGE</span>
              <span className="font-mono text-base text-white tabular-nums">
                {fmt(maxEthCost)} ETH
              </span>
            </div>
            <div className="px-4 py-3 flex flex-col gap-1">
              <span className={labelCls}>L-01 GUARD</span>
              {isDust
                ? <span className="font-mono text-base text-tosh-fluo">→ L-01_LOCKED</span>
                : <span className="font-mono text-base text-tosh-fluo">L-01_invariant: verified.</span>}
            </div>
          </div>
          <p className="px-4 py-2 border-t border-[#1F1F2E] text-[10px] font-mono text-[#555] tracking-wider break-all">
            msg.value = {maxEthCost.toString()} wei · excess refunded
          </p>
        </div>
      )}

      <WriteButton
        label={`buy ${p.symbol}`}
        lockedLabel={
          halted
            ? `[ladder_halted · resumes ${haltTxt}]`
            : isDust
            ? '[invalid_amount]'
            : exceedsMax
              ? '[exceeds_max_per_call]'
              : sameBlockLock
                ? '[minting_shut_this_block · wait_one_block]'
              : awaitingFirstUnlock
                ? '[awaiting_market_above_p0]'
              : gateLocked
                ? '[gate_locked]'
                : noCapacity && unlocked
                  ? '[no_size_available]'
                : insufficientBal
                  ? '[insufficient_eth]'
                  : tokenAmountWei <= 0n
                    ? '[enter_amount]'
                    : `[buy ${p.symbol.toLowerCase()}]`
        }
        locked={!armed}
        busy={isMinting || isMintConfirming}
        onClick={handleMint}
        full
      />

      <AlarmLine msg={error ?? (mintError?.message?.slice(0, 200) ?? null)} />
      <TxLine hash={mintHash} label="mintBondingCurve" />
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// LIQUIDITY PANEL  ·  retail market making
//
// The hook deliberately leaves BEFORE_REMOVE_LIQUIDITY off its address mask, so
// third-party LPs add and remove freely — V4 never even calls into Tosh code on
// those paths.  What was missing was a front door: posm positions are ERC-721s
// behind a Permit2 approval dance, which is not something a retail user is
// going to hand-assemble.
//
// Scope is deliberately ONE range: the same full range the genesis position
// uses.  A range picker would mean teaching ticks, and concentrated LPs are
// already served by dedicated tooling.
// ─────────────────────────────────────────────────────────────────────────────

/** Permit2 allowances are uint160 and carry their own expiry. */
const MAX_UINT160 = (1n << 160n) - 1n
const PERMIT2_TTL_SECONDS = 60n * 60n * 24n * 30n
const TX_DEADLINE_SECONDS = 60n * 20n

function LiquidityPanel({
  hookAddress, tokenAddress, symbol, userAddress, isConnected, ethBalance, nowSec,
}: {
  hookAddress:  Address
  tokenAddress: Address | undefined
  symbol:       string
  userAddress:  Address | undefined
  isConnected:  boolean
  ethBalance:   bigint
  /** Ticking clock lifted to the parent, so render stays pure. */
  nowSec:       number
}) {
  const [ethAmount, setEthAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [slippageBps, setSlippageBps] = useState(100n)

  const { sqrtPriceX96, totalLiquidity } = useLpPoolState(tokenAddress, hookAddress)
  const { positions, totals, degraded, refresh } =
    useLpPositions(userAddress, hookAddress, sqrtPriceX96)

  const poolAmounts = amountsForLiquidity(sqrtPriceX96, totalLiquidity)

  const ethWei = (() => {
    const t = ethAmount.trim()
    if (!t) return 0n
    try { return parseUnits(t, 18) } catch { return -1n }
  })()
  const ethInvalid = ethWei === -1n

  // What the pool will pull for the token leg, plus the same 0.5% headroom the
  // shelf mint uses.  posm reverts on `amountNMax`, so under-quoting is fatal
  // while over-quoting is refunded by SWEEP / left unspent.
  const tokenNeeded = ethWei > 0n ? pairedAmount1(sqrtPriceX96, ethWei) : 0n
  const ethMax   = ethWei   + (ethWei   * slippageBps) / 10_000n
  const tokenMax = tokenNeeded + (tokenNeeded * slippageBps) / 10_000n

  const { data: tokenBalance } = useReadContract({
    address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf',
    args: userAddress ? [userAddress] : undefined,
    query: { enabled: !!tokenAddress && !!userAddress, refetchInterval: 12_000 },
  })
  const { data: permit2Allowance, refetch: refetchErc20 } = useReadContract({
    address: tokenAddress, abi: erc20Abi, functionName: 'allowance',
    args: userAddress ? [userAddress, PERMIT2] : undefined,
    query: { enabled: !!tokenAddress && !!userAddress, refetchInterval: 12_000 },
  })
  const { data: posmAllowance, refetch: refetchPermit2 } = useReadContract({
    address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance',
    args: userAddress && tokenAddress ? [userAddress, tokenAddress, POSITION_MANAGER] : undefined,
    query: { enabled: !!tokenAddress && !!userAddress, refetchInterval: 12_000 },
  })

  const nowSeconds = BigInt(nowSec)
  const needsErc20Approval = tokenMax > 0n && (permit2Allowance ?? 0n) < tokenMax
  const needsPermit2Approval =
    tokenMax > 0n &&
    (!posmAllowance || posmAllowance[0] < tokenMax || BigInt(posmAllowance[1]) <= nowSeconds)

  const insufficientEth   = ethMax > 0n && ethMax > ethBalance
  const insufficientToken = tokenMax > 0n && tokenMax > (tokenBalance ?? 0n)

  const { writeContract, isPending, data: txHash, error: txError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess, data: receipt } =
    useWaitForTransactionReceipt({ hash: txHash })
  const busy = isPending || isConfirming

  // Cache the minted tokenId so the position shows up even when the RPC's log
  // index lags or `eth_getLogs` is unavailable on this endpoint.
  useEffect(() => {
    if (!isSuccess || !receipt || !userAddress) return
    try {
      const events = parseEventLogs({
        abi: POSM_ABI, eventName: 'Transfer', logs: receipt.logs,
      })
      for (const ev of events) {
        if (ev.args.to.toLowerCase() === userAddress.toLowerCase()) {
          rememberLpPosition(userAddress, hookAddress, ev.args.id)
        }
      }
    } catch { /* nothing to cache — the scan will still find it */ }
    void refetchErc20(); void refetchPermit2(); void refresh()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEthAmount('')
  }, [isSuccess, receipt, userAddress, hookAddress, refetchErc20, refetchPermit2, refresh])

  const approveErc20 = useCallback(() => {
    if (!tokenAddress) return
    setError(null)
    writeContract({
      address: tokenAddress, abi: erc20Abi, functionName: 'approve',
      args: [PERMIT2, MAX_UINT160], chainId: TARGET_CHAIN_ID,
    })
  }, [tokenAddress, writeContract])

  const approvePermit2 = useCallback(() => {
    if (!tokenAddress) return
    setError(null)
    writeContract({
      address: PERMIT2, abi: PERMIT2_ABI, functionName: 'approve',
      args: [
        tokenAddress, POSITION_MANAGER, MAX_UINT160,
        Number(nowSeconds + PERMIT2_TTL_SECONDS),
      ],
      chainId: TARGET_CHAIN_ID,
    })
  }, [tokenAddress, nowSeconds, writeContract])

  const addLiquidity = useCallback(() => {
    setError(null)
    if (!userAddress || !tokenAddress) { setError('Connect wallet'); return }
    if (ethWei <= 0n)      { setError('Enter a positive ETH amount'); return }
    if (sqrtPriceX96 === 0n) { setError('Pool price unavailable — retry in a moment'); return }
    if (insufficientEth)   { setError(`Insufficient ETH for the deposit + ${Number(slippageBps) / 100}% headroom`); return }
    if (insufficientToken) { setError(`Insufficient ${symbol} — full-range LPs must fund both legs`); return }

    const liquidity = liquidityForAmounts(sqrtPriceX96, ethWei, tokenNeeded)
    if (liquidity === 0n) { setError('Deposit too small to mint any liquidity'); return }

    const unlockData = encodeMintPayload({
      token: tokenAddress,
      hook: hookAddress,
      owner: userAddress,
      liquidity,
      amount0Max: ethMax,
      amount1Max: tokenMax,
    })

    writeContract({
      address: POSITION_MANAGER, abi: POSM_ABI, functionName: 'modifyLiquidities',
      args: [unlockData, nowSeconds + TX_DEADLINE_SECONDS],
      value: ethMax,
      chainId: TARGET_CHAIN_ID,
    })
  }, [
    userAddress, tokenAddress, hookAddress, ethWei, tokenNeeded, ethMax, tokenMax,
    sqrtPriceX96, insufficientEth, insufficientToken, symbol, nowSeconds, writeContract, slippageBps,
  ])

  const withdraw = useCallback((tokenId: bigint, amount0: bigint, amount1: bigint) => {
    setError(null)
    if (!userAddress || !tokenAddress) { setError('Connect wallet'); return }

    const unlockData = encodeBurnPayload({
      token: tokenAddress,
      recipient: userAddress,
      tokenId,
      amount0Min: amount0 - (amount0 * slippageBps) / 10_000n,
      amount1Min: amount1 - (amount1 * slippageBps) / 10_000n,
    })

    writeContract({
      address: POSITION_MANAGER, abi: POSM_ABI, functionName: 'modifyLiquidities',
      args: [unlockData, nowSeconds + TX_DEADLINE_SECONDS],
      chainId: TARGET_CHAIN_ID,
    })
  }, [userAddress, tokenAddress, nowSeconds, writeContract, slippageBps])

  // One live step at a time, so the CTA always says exactly what the next
  // signature does rather than dumping three buttons on the user at once.
  const step: { label: string; run: (() => void) | null } = (() => {
    if (!isConnected)        return { label: 'Connect wallet to provide liquidity', run: null }
    if (!tokenAddress)       return { label: 'Token not resolved yet', run: null }
    if (ethWei <= 0n)        return { label: 'Enter an ETH amount', run: null }
    if (ethInvalid)          return { label: 'Invalid amount', run: null }
    if (insufficientEth)     return { label: 'Insufficient ETH', run: null }
    if (insufficientToken)   return { label: `Insufficient ${symbol}`, run: null }
    if (needsErc20Approval)  return { label: `Step 1 of 3 — approve ${symbol} for Permit2`, run: approveErc20 }
    if (needsPermit2Approval) return { label: 'Step 2 of 3 — let Permit2 fund the position manager', run: approvePermit2 }
    return { label: 'Step 3 of 3 — deposit into the pool', run: addLiquidity }
  })()

  return (
    <Section
      id="P-3"
      title={`MARKET MAKING · ${symbol}/ETH`}
      subtitle="Uniswap V4 PositionManager · full range · 0.30% pool fee accrues to LPs"
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6">
        <Readout label="POOL DEPTH · ETH"
                 value={fmt(poolAmounts.amount0)}
                 hint="all LPs incl. genesis" />
        <Readout label={`POOL DEPTH · ${symbol}`}
                 value={fmt(poolAmounts.amount1)}
                 hint="all LPs incl. genesis" />
        <Readout label="MY POSITION · ETH"
                 value={fmt(totals.amount0)}
                 hint={`${positions.length} position${positions.length === 1 ? '' : 's'}`} />
        <Readout label={`MY POSITION · ${symbol}`}
                 value={fmt(totals.amount1)}
                 hint="withdrawable any time" />
      </div>

      <Field
        label="ETH TO DEPOSIT"
        value={ethAmount}
        onChange={v => { setEthAmount(v); setError(null) }}
        placeholder="e.g. 0.05"
        inputMode="decimal"
        disabled={busy || !isConnected}
        errored={ethInvalid || insufficientEth || insufficientToken}
        fluo={!!step.run && !busy}
        hint={
          ethWei > 0n && sqrtPriceX96 > 0n
            ? insufficientToken
              ? <span className="text-tosh-rust">→ NEEDS {fmt(tokenNeeded)} {symbol} — YOU HOLD {fmt(tokenBalance ?? 0n)}</span>
              : <span className="text-[#555]">→ PAIRS WITH {fmt(tokenNeeded)} {symbol} AT THE CURRENT PRICE</span>
            : <span className="text-[#555]">→ FULL RANGE · BOTH LEGS REQUIRED · WITHDRAW ANY TIME</span>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
          Slippage
        </span>
        <div role="radiogroup" aria-label="LP slippage tolerance" className="flex gap-1">
          {LP_SLIPPAGE_PRESETS.map(p => {
            const selected = p.bps === slippageBps
            return (
              <button
                key={p.label}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setSlippageBps(p.bps)}
                disabled={busy}
                className={
                  'text-[10px] font-mono px-2 py-1 rounded-md border transition-colors ' +
                  (selected
                    ? 'border-tosh-fluo text-white bg-tosh-fluo/10'
                    : 'border-zinc-700 text-zinc-500 hover:text-zinc-300')
                }
              >
                {p.label}
              </button>
            )
          })}
        </div>
      </div>

      <WriteButton
        label={step.label}
        lockedLabel={`[${step.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}]`}
        locked={!step.run}
        busy={busy}
        onClick={() => step.run?.()}
        full
      />

      {positions.length > 0 && (
        <div className="border border-[#1F1F2E]">
          <div className="px-4 py-2 border-b border-[#1F1F2E]">
            <span className={labelCls}>{'// OPEN POSITIONS'}</span>
          </div>
          {positions.map(pos => (
            <div
              key={pos.tokenId.toString()}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[#1F1F2E] last:border-b-0"
            >
              <div className="font-mono text-[11px] text-[#888] tabular-nums">
                <span className="text-white">#{pos.tokenId.toString()}</span>
                {' · '}{fmt(pos.amount0)} ETH{' + '}{fmt(pos.amount1)} {symbol}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => withdraw(pos.tokenId, pos.amount0, pos.amount1)}
                className="text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded-md
                           border border-zinc-600 text-zinc-300 hover:bg-zinc-800/60
                           disabled:opacity-40 transition-colors"
              >
                Withdraw
              </button>
            </div>
          ))}
        </div>
      )}

      {degraded && (
        <p className="text-[10px] font-mono text-[#888] tracking-wider leading-relaxed">
          {'// '}This RPC would not serve position logs, so only positions minted from this
          browser are listed. Your other positions are safe on-chain and remain withdrawable
          through any Uniswap V4 interface.
        </p>
      )}

      <AlarmLine msg={error ?? (txError?.message?.slice(0, 200) ?? null)} />
      <TxLine hash={txHash} label="modifyLiquidities" />
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// REFUND PANEL  ·  Phase 3
// ─────────────────────────────────────────────────────────────────────────────

function RefundPanel({
  hookAddress, ethDeposited, isConnected, refetch,
}: {
  hookAddress:   Address
  ethDeposited:  bigint
  isConnected:   boolean
  refetch:       () => void
}) {
  const {
    writeContract, isPending, data: txHash, error: writeError,
  } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } =
    useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) refetch() }, [isSuccess, refetch])

  const handleRefund = useCallback(() => {
    writeContract({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'refund', args: [],
      chainId: TARGET_CHAIN_ID,
    })
  }, [hookAddress, writeContract])

  const txBusy = isPending || isConfirming
  const locked = !isConnected || ethDeposited === 0n

  return (
    <Section
      id="P-3"
      title="REFUND TERMINAL"
      subtitle="hook.refund() — soft-cap not met OR zombie window elapsed · full claim, no penalty"
    >
      <Readout label="YOUR DEPOSIT" value={`${fmt(ethDeposited)} ETH`} />
      <p className="font-mono text-[10px] tracking-[0.4em] uppercase text-tosh-fluo">
        → REFUND_GATE: OPEN
      </p>
      <WriteButton
        label="claim refund"
        lockedLabel={ethDeposited === 0n ? '[no_deposit]' : '[claim_refund]'}
        locked={locked}
        busy={txBusy}
        onClick={handleRefund}
        full
      />
      <AlarmLine msg={writeError?.message?.slice(0, 200) ?? null} />
      <TxLine hash={txHash} label="refund" />
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// AWAITING LAUNCH PANEL  ·  soft cap met, creator has not opened the pool yet
// ─────────────────────────────────────────────────────────────────────────────

/// The genesis succeeded but nothing is tradeable until the creator calls
/// `launch()`, which seeds the V4 pool and opens the shelf ladder.  There was
/// previously no way to do that from the UI at all, so every raise stalled here
/// and eventually decayed into a zombie refund once the 7-day window lapsed.
function AwaitingLaunchPanel({
  hookAddress, symbol, isCreator, totalEthDeposited, genesisDeadline, nowSec, refetch,
}: {
  hookAddress:       Address
  symbol:            string
  isCreator:         boolean
  totalEthDeposited: bigint
  genesisDeadline:   bigint
  nowSec:            number
  refetch:           () => void
}) {
  const {
    writeContract, isPending, data: txHash, error: writeError,
  } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } =
    useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) refetch() }, [isSuccess, refetch])

  const handleLaunch = useCallback(() => {
    writeContract({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'launch', args: [],
      chainId: TARGET_CHAIN_ID,
    })
  }, [hookAddress, writeContract])

  // `launch()` reverts with LaunchWindowExpired past this point, after which
  // every depositor can pull their ETH back out instead.  `resolvePhase` routes
  // to `refund` on the same clock and the same deadline, so this panel is never
  // mounted past the expiry and carries no expired branch of its own.
  const expiresAt = genesisDeadline + LAUNCH_WINDOW_SECONDS
  const hoursLeft = Math.max(0, Math.floor((Number(expiresAt) - nowSec) / 3600))

  const txBusy = isPending || isConfirming

  return (
    <Section
      id="P-1.5"
      title="LAUNCH TERMINAL"
      subtitle="hook.launch() — seeds the V4 pool, mints genesis LP, opens the shelf ladder"
    >
      <Readout label="RAISED" value={`${fmt(totalEthDeposited)} ETH`} />
      <Readout label="SOFT CAP" value="MET" />
      <Readout label="LAUNCH WINDOW" value={`${hoursLeft}h REMAINING`} />

      {isCreator ? (
        <>
          <p className="font-mono text-[11px] text-[#888] leading-relaxed">
            You are the creator of {symbol}. Calling <span className="text-tosh-fluo">launch()</span> is
            irreversible: it pairs the raised ETH with the genesis LP allocation, hands
            the position to the hook, and starts the ladder. Depositors can claim their
            pro-rata share immediately afterwards.
          </p>
          <p className="font-mono text-[11px] text-tosh-amber leading-relaxed">
            You have {hoursLeft}h left. If you do not open the pool within 7 days of the
            genesis deadline, the raise is written off: <span className="text-white">launch()</span> stops
            working permanently and every depositor reclaims their ETH in full.
          </p>
          <WriteButton
            label="open the pool"
            lockedLabel="[launch]"
            locked={false}
            busy={txBusy}
            onClick={handleLaunch}
            full
          />
        </>
      ) : (
        <p className="font-mono text-[11px] text-[#888] leading-relaxed">
          The raise cleared its soft cap and is waiting on the creator to open the
          pool. Your deposit is safe: if the pool is not opened within the launch
          window, the refund terminal unlocks automatically and returns 100% of it.
        </p>
      )}

      <AlarmLine msg={writeError?.message?.slice(0, 200) ?? null} />
      <TxLine hash={txHash} label="launch" />
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECT GATE
// ─────────────────────────────────────────────────────────────────────────────

function ConnectGate() {
  return (
    <Section id="GATE" title="ACCESS GATE" subtitle="Wallet not connected">
      <p className="text-sm text-[#CCC] leading-relaxed max-w-prose">
        Connect your wallet to deposit ETH into this genesis, mint from the
        4000-rung shelf ladder, or claim a refund.  Audit-cliff guards
        (<span className="text-tosh-fluo">H-01</span>, <span className="text-tosh-fluo">M-01</span>,
        <span className="text-tosh-fluo"> L-01</span>) are mirrored client-side once a
        wallet is bound.
      </p>
    </Section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT  ·  ProjectTerminal
// ─────────────────────────────────────────────────────────────────────────────

export default function ProjectTerminal({ project }: { project: ProjectRow }) {
  const { address, isConnected } = useAccount()
  const [mounted, setMounted] = useState(false)
  // SSR/CSR mount guard — defers wagmi-dependent state to the client paint.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setMounted(true) }, [])
  const userAddress = mounted ? (address as Address | undefined) : undefined
  const wConnected  = mounted ? isConnected : false

  const hookAddress = project.hook_address as Address | undefined
  const symbol      = project.symbol || 'TOK'

  const { data: ethBal } = useBalance({
    address: userAddress,
    query:   { enabled: !!userAddress },
  })
  const ethBalance = ethBal?.value ?? 0n

  // External-clock pattern — single ticking second used by Genesis countdown
  // and cooldown logic.  Lifted to the top of the component so React's purity
  // rule never sees Date.now() called from render.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  // Bulk chain reads.
  //
  // Typed as a plain `ContractFunctionParameters[]` rather than left to
  // inference: wagmi builds a per-entry mapped type over the whole ABI, and
  // with HOOK_ABI at ~130 entries that tuple blows past TypeScript's
  // instantiation depth limit.  Every result below is cast explicitly anyway,
  // so the precise inference was buying nothing.
  const bulkContracts: ContractFunctionParameters[] = hookAddress ? [
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'totalEthDeposited' },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'launched'           },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'p0'                 },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'phase2Minted'       },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'canRefund'          },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'genesisDeadline'    },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'softCap'            },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'BONDING_MAX'        },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'currentBondingPrice'},
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'ethDeposited',
        args: userAddress ? [userAddress] : undefined },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'pogQuota',
        args: userAddress ? [userAddress] : undefined },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'eligibility',
        args: userAddress ? [userAddress, hookAddress] : undefined },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'userLaunchCooldownEnd',
        args: userAddress ? [userAddress, hookAddress] : undefined },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'shelfP0'           },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'blacklistedUntil',
        args: userAddress ? [userAddress] : undefined },
    ] : []

  const { data, refetch } = useReadContracts({
    contracts: bulkContracts,
    query: { enabled: !!hookAddress, refetchInterval: 12_000 },
  })

  const totalEthDeposited  = (data?.[0]?.result  as bigint  | undefined) ?? 0n
  const launched           = (data?.[1]?.result  as boolean | undefined) ?? false
  const p0                 = (data?.[2]?.result  as bigint  | undefined) ?? 0n
  const phase2Minted       = (data?.[3]?.result  as bigint  | undefined) ?? 0n
  const canRefund          = (data?.[4]?.result  as boolean | undefined) ?? false
  const genesisDeadline    = (data?.[5]?.result  as bigint  | undefined) ?? 0n
  const softCap            = (data?.[6]?.result  as bigint  | undefined) ?? 0n
  const bondingMax         = (data?.[7]?.result  as bigint  | undefined) ?? BONDING_MAX
  const currentPrice       = (data?.[8]?.result  as bigint  | undefined) ?? 0n
  const userEthDeposited   = (data?.[9]?.result  as bigint  | undefined) ?? 0n
  const pogQuota           = (data?.[10]?.result as bigint  | undefined) ?? 0n
  const cooldownEnd        = (data?.[12]?.result as bigint  | undefined) ?? 0n
  const shelfP0           = (data?.[13]?.result as bigint  | undefined) ?? 0n
  const blacklistedUntil   = (data?.[14]?.result as bigint  | undefined) ?? 0n

  // (eligible, remainingQuota, cooldownRemaining) — the factory's own verdict,
  // which is the only place that knows whether a lapsed quota window has been
  // credited back yet.  `cooldownEnd` above still drives the ticking countdown;
  // this tuple only supplies the spendable headroom.
  const eligibility        = data?.[11]?.result as readonly [boolean, bigint, bigint] | undefined
  const quotaRemaining     = eligibility?.[1] ?? 0n

  // Read separately rather than appended to the bulk call above: the token
  // address is fixed at deploy, so polling it every 12s would be waste.
  const { data: tokenAddress } = useReadContract({
    address: hookAddress, abi: HOOK_ABI, functionName: 'projectToken',
    query: { enabled: !!hookAddress, staleTime: Infinity },
  })

  // Immutable, and only needed to decide whether to offer the launch button —
  // so it is read once here rather than added to the 12s bulk poll.
  const { data: creatorAddress } = useReadContract({
    address: hookAddress, abi: HOOK_ABI, functionName: 'creator',
    query: { enabled: !!hookAddress, staleTime: Infinity },
  })
  const isCreator = !!userAddress && !!creatorAddress
    && (creatorAddress as Address).toLowerCase() === userAddress.toLowerCase()

  // Snapshotted into the hook at creation and never written again, so it rides
  // outside the 12s bulk poll — which also keeps that contracts tuple from
  // growing any deeper.
  const { data: perWalletCapRaw } = useReadContract({
    address: hookAddress, abi: HOOK_ABI, functionName: 'perWalletCap',
    query: { enabled: !!hookAddress, staleTime: Infinity },
  })
  const perWalletCap = (perWalletCapRaw as bigint | undefined) ?? 0n

  const referrer = useBoundReferrer(userAddress)

  const phase: Phase = resolvePhase({
    totalEthDeposited, softCap, canRefund, launched, genesisDeadline, nowSec,
  })



  if (!hookAddress) {
    return (
      <div className="flex flex-col">
        <Section id="ERR" title="HOOK BINDING MISSING">
          <p className="font-mono text-[11px] text-[#888] leading-relaxed">
            This project row has no <span className="text-tosh-fluo">hook_address</span> on file.
            Deploy may still be pending — refresh after the createLaunch tx confirms.
          </p>
        </Section>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/20 p-6 shadow-2xl backdrop-blur-md font-sans">
      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-4 font-mono">{`/// Action Terminal`}</p>
      {!wConnected ? (
        <ConnectGate />
      ) : phase === 'genesis' ? (
        <GenesisPanel
          hookAddress={hookAddress}
          symbol={symbol}
          userAddress={userAddress}
          isConnected={wConnected}
          totalEthDeposited={totalEthDeposited}
          softCap={softCap}
          ethBalance={ethBalance}
          pogQuota={pogQuota}
          quotaRemaining={quotaRemaining}
          blacklistedUntil={blacklistedUntil}
          cooldownEnd={cooldownEnd}
          nowSec={nowSec}
          perWalletCap={perWalletCap}
          userDeposited={userEthDeposited}
          genesisDeadline={genesisDeadline}
          referrer={referrer}
          refetch={() => { void refetch() }}
        />
      ) : phase === 'awaiting_launch' ? (
        <AwaitingLaunchPanel
          hookAddress={hookAddress}
          symbol={symbol}
          isCreator={isCreator}
          totalEthDeposited={totalEthDeposited}
          genesisDeadline={genesisDeadline}
          nowSec={nowSec}
          refetch={() => { void refetch() }}
        />
      ) : phase === 'bonding' ? (
        <>
          <GenesisClaimPanel
            hookAddress={hookAddress}
            symbol={symbol}
            userAddress={userAddress}
            ethDeposited={userEthDeposited}
            refetch={() => { void refetch() }}
          />
          <BondingPanel
            hookAddress={hookAddress}
            symbol={symbol}
            userAddress={userAddress}
            isConnected={wConnected}
            p0={p0}
            shelfP0={shelfP0}
            currentPrice={currentPrice}
            phase2Minted={phase2Minted}
            bondingMax={bondingMax}
            ethBalance={ethBalance}
            nowSec={nowSec}
            refetch={() => { void refetch() }}
          />
          {launched && (
            <LiquidityPanel
              hookAddress={hookAddress}
              tokenAddress={tokenAddress}
              symbol={symbol}
              userAddress={userAddress}
              isConnected={wConnected}
              ethBalance={ethBalance}
              nowSec={nowSec}
            />
          )}
        </>
      ) : (
        <RefundPanel
          hookAddress={hookAddress}
          ethDeposited={userEthDeposited}
          isConnected={wConnected}
          refetch={() => { void refetch() }}
        />
      )}

      {wConnected && (
        <ReferralPanel
          hookAddress={hookAddress}
          userAddress={userAddress}
          isConnected={wConnected}
          refetch={() => { void refetch() }}
        />
      )}
    </div>
  )
}
