'use client'

/**
 * UserDrawer — Tosh personal sovereignty console.
 *
 * A right-anchored slide-in panel that mounts to the homepage WalletPip.
 * Canvas, hairline dividers and accent all come from the tokens in
 * `globals.css` and are named here rather than quoted: this comment used to
 * spell out "#1F1F2E" and "#00FFA3", and the v0 recolour moved both without
 * touching a line of this file. JetBrains Mono everywhere; `brand` is reserved
 * for unlock guards and the primary call-to-action.
 *
 * Three stacked telemetry blocks:
 *
 *   [01] PoG QUOTA          factory.eligibility(user, 0x0).remainingQuota
 *                           = headroom left in the CURRENT quota window.
 *                           The quota refills every `quotaWindowDuration`
 *                           (24 h by default), so it is never the lifetime
 *                           `totalGenesisDeposited` subtracted from
 *                           `pogQuota` — that reading pins a wallet at zero
 *                           forever once it has cumulatively spent its
 *                           allowance.  Only the factory can tell whether a
 *                           lapsed window has been credited back, so the
 *                           figure is read, not derived.
 *
 *   [02] COOLDOWN MATRIX    MAX( factory.userLaunchCooldownEnd(user, hook) )
 *                           across the hooks the user has touched.  rAF-driven
 *                           HH:MM:SS_cs counter that snaps to a fluo
 *                           [ ● ACTIVE_READY ] pip the instant it crosses 0.
 *
 *   [03] PARTICIPATED       For every hook where hook.nativeDeposited(user) > 0:
 *        ASSETS               • genesis phase → deposit + raise progress bar
 *                             • curve  phase → claimable pro-rata + lever
 *                                            [ CLAIM_TOKENS ] (→ claimGenesis)
 *                                            [ TRANSFERRED_CLOSED ] (post-claim)
 *
 * Read pipeline (4 RPC stages, each gated on `open` to spare bandwidth when
 * the drawer is collapsed):
 *
 *     A. factory.launchCount                          (1 call)
 *     B. factory.launches(i)                          (N calls)
 *     C. hook.nativeDeposited(user)                      (N calls, filter > 0)
 *     D. (cooldown + phase + total + hasClaimed + claimSupply +
 *         erc20.symbol)                              (6 calls × M participated)
 */

import { useCallback, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import {
  useAccount,
  useDisconnect,
  useReadContract,
  useReadContracts,
} from 'wagmi'
import { formatUnits, type Address } from 'viem'

import {
  ERC20_ABI,
  FACTORY_ABI,
  FACTORY_ADDRESS,
  HOOK_ABI,
  CHAIN_BYLINE,
  ZERO_ADDRESS,
} from '@/lib/contracts'
import { QUOTE_DECIMALS, QUOTE_SYMBOL } from '@/lib/contracts'
import {
  classifyHorizon, formatHorizonLabel, formatHorizonUtc, useTxAction,
  useNowMs, CLOCK_UNSYNCED,
} from '@/components/ui'
import { fill, useT } from '@/i18n'

/**
 * How many launches back the drawer walks when rebuilding a wallet's positions.
 * Generous on purpose — this is a ceiling that bounds the multicall and the
 * `Array.from` length, not a display window.
 */
const DRAWER_SCAN_DEPTH = 512

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTERS
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_DECIMALS = 18

/**
 * A quote-asset amount: the PoG quota, what the window has spent, a deposit, a
 * raise, a soft cap. Everything this drawer prints with a currency suffix.
 *
 * WAS `formatEth` AT 18 DECIMALS, which is what it should be as long as the thing
 * being formatted is the chain's own coin. None of the five callers is: they are all
 * quota or deposit figures, all denominated in the quote asset, and all would have
 * rendered ten orders of magnitude small — a 1,750-unit quota shown as `0.0000175`,
 * which a reader takes for a wallet with no allocation rather than for a bug.
 *
 * `ETH_DECIMALS` went with it. It existed only to feed this function and could not
 * be corrected in place without making its own name a lie.
 */
function formatQuote(units: bigint | undefined | null): string {
  if (units === undefined || units === null) return '—'
  const n = Number(formatUnits(units, QUOTE_DECIMALS))
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

function formatToken(wei: bigint | undefined | null): string {
  if (wei === undefined || wei === null) return '—'
  const n = Number(formatUnits(wei, TOKEN_DECIMALS))
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function shortAddr(a: Address): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

/** HH:MM:SS_cs — the spec's `00:00:00_00` two-digit centiseconds layout. */
function formatCooldown(remainingMs: number): string {
  if (remainingMs <= 0) return '00:00:00_00'
  const totalSec = Math.floor(remainingMs / 1000)
  const h  = Math.floor(totalSec / 3600)
  const m  = Math.floor((totalSec % 3600) / 60)
  const s  = totalSec % 60
  const cs = Math.floor((remainingMs % 1000) / 10)
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}_${pad2(cs)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// SIDE EFFECTS — ESC-to-close + body scroll lock
// ─────────────────────────────────────────────────────────────────────────────

function useDrawerSideEffects(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface LaunchRow {
  token:     Address
  hook:      Address
  creator:   Address
  createdAt: bigint
}

interface ParticipatedRow extends LaunchRow {
  nativeDeposited: bigint
}

interface HookSnapshot {
  row:             ParticipatedRow
  /** At least one of the seven reads failed, so every field below is a placeholder. */
  degraded:        boolean
  cooldownEnd:     bigint
  launched:        boolean
  totalNative:        bigint
  hasClaimed:      boolean
  genesisClaimSup: bigint
  symbol:          string
  claimable:       bigint
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAWER
// ─────────────────────────────────────────────────────────────────────────────

export interface UserDrawerProps {
  open:    boolean
  onClose: () => void
}

export function UserDrawer({ open, onClose }: UserDrawerProps) {
  const { address }    = useAccount()
  const { disconnect } = useDisconnect()
  const t = useT().drawer

  useDrawerSideEffects(open, onClose)

  // ── Panel [01]: PoG quota telemetry ────────────────────────────────────
  //
  // `eligibility` is queried against the ZERO hook on purpose.  The quota
  // itself is platform-wide; the hook argument only selects which per-project
  // cooldown to fold in, and no wallet can hold a cooldown against 0x0 — so
  // this returns the raw window headroom without a live raise masking it.
  // Per-project cooldowns are surfaced separately by panel [02] below.
  // `blacklistedUntil` rides along because `eligibility` short-circuits a ban
  // and a never-registered attestation into the same `(false, 0, 0)` a spent
  // window produces — which rendered a banned wallet holding real quota as if
  // it had simply spent the lot.
  const userQuery = useReadContracts({
    contracts: address ? [
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'pogQuota',         args: [address] as const },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'eligibility',      args: [address, ZERO_ADDRESS] as const },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'blacklistedUntil', args: [address] as const },
    ] : [],
    query: { enabled: open && Boolean(address) },
  })

  const pogQuota:       bigint | undefined =
    userQuery.data?.[0]?.status === 'success' ? userQuery.data[0].result as bigint : undefined
  const eligibility =
    userQuery.data?.[1]?.status === 'success'
      ? userQuery.data[1].result as readonly [boolean, bigint, bigint]
      : undefined
  const banStamp:       bigint =
    userQuery.data?.[2]?.status === 'success' ? userQuery.data[2].result as bigint : 0n
  const remainingQuota: bigint | undefined = eligibility?.[1]
  const windowSpent:    bigint | undefined =
    pogQuota !== undefined && remainingQuota !== undefined
      ? (pogQuota > remainingQuota ? pogQuota - remainingQuota : 0n)
      : undefined

  // ── Stage A: how many hooks live on-chain? ─────────────────────────────
  const launchCountQuery = useReadContract({
    address:      FACTORY_ADDRESS,
    abi:          FACTORY_ABI,
    functionName: 'launchCount',
    query:        { enabled: open },
  })
  const launchCount =
    launchCountQuery.data !== undefined ? Number(launchCountQuery.data as bigint) : 0

  // ── Stage B: pull each LaunchRow ────────────────────────────────────────
  // Bounded, unlike the raw `launchCount`. This drawer lists the wallet's own
  // positions, so it walks the newest launches backwards rather than taking the
  // directory's recent-48 window — a depositor's older position must not vanish
  // from their own ledger. The ceiling is what keeps `Array.from` from being
  // handed an unbounded length, and keeps one drawer open from turning into
  // `launchCount * 6` multicall entries.
  const scanDepth = Math.min(launchCount, DRAWER_SCAN_DEPTH)
  const launchIds = useMemo(
    () => Array.from({ length: scanDepth }, (_, i) => BigInt(launchCount - scanDepth + i)),
    [launchCount, scanDepth],
  )
  const launchesQuery = useReadContracts({
    contracts: launchIds.map(id => ({
      address:      FACTORY_ADDRESS,
      abi:          FACTORY_ABI,
      functionName: 'launches' as const,
      args:         [id] as const,
    })),
    query: { enabled: open && launchCount > 0 },
  })

  const launches: LaunchRow[] = useMemo(() => {
    if (!launchesQuery.data) return []
    const out: LaunchRow[] = []
    for (const r of launchesQuery.data) {
      if (r.status !== 'success') continue
      const t = r.result as readonly [Address, Address, Address, bigint]
      out.push({ token: t[0], hook: t[1], creator: t[2], createdAt: t[3] })
    }
    return out
  }, [launchesQuery.data])

  // ── Stage C: filter to hooks where the user has a non-zero deposit ──────
  const ethDepositedQuery = useReadContracts({
    contracts: address ? launches.map(l => ({
      address:      l.hook,
      abi:          HOOK_ABI,
      functionName: 'nativeDeposited' as const,
      args:         [address] as const,
    })) : [],
    query: { enabled: open && Boolean(address) && launches.length > 0 },
  })

  const participated: ParticipatedRow[] = useMemo(() => {
    if (!ethDepositedQuery.data) return []
    const out: ParticipatedRow[] = []
    for (let i = 0; i < launches.length; i++) {
      const r = ethDepositedQuery.data[i]
      if (r?.status !== 'success') continue
      const sd = r.result as bigint
      if (sd > 0n) out.push({ ...launches[i], nativeDeposited: sd })
    }
    return out
  }, [ethDepositedQuery.data, launches])

  // ── Stage D: full per-hook snapshot (7 reads × M participated) ──────────
  const fullDataQuery = useReadContracts({
    contracts: address ? participated.flatMap(p => [
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'userLaunchCooldownEnd' as const, args: [address, p.hook] as const },
      { address: p.hook,          abi: HOOK_ABI,    functionName: 'launched'              as const },
      { address: p.hook,          abi: HOOK_ABI,    functionName: 'totalNativeDeposited'     as const },
      // No `softCap` leg. It was fetched into the row, carried through the
      // snapshot type and rendered nowhere — the percentage it fed was removed
      // when the cap stopped gating anything (see the note further down), and
      // the call outlived its only reader. One chain call per participated
      // project, every time this drawer opened, for a number nobody displayed.
      { address: p.hook,          abi: HOOK_ABI,    functionName: 'hasClaimed'            as const, args: [address] as const },
      { address: p.hook,          abi: HOOK_ABI,    functionName: 'GENESIS_CLAIM_SUPPLY'  as const },
      { address: p.token,         abi: ERC20_ABI,   functionName: 'symbol'                as const },
    ]) : [],
    query: { enabled: open && Boolean(address) && participated.length > 0 },
  })

  const snapshots: HookSnapshot[] = useMemo(() => {
    if (!fullDataQuery.data) return []
    const out: HookSnapshot[] = []
    for (let i = 0; i < participated.length; i++) {
      // Six legs per project, and the stride MUST match the `flatMap` above —
      // it was seven until the unread `softCap` leg came out. Every index
      // below is relative to it, so the two move together or the drawer reads
      // one project's cooldown as the next project's symbol.
      const off = i * 6
      const d   = fullDataQuery.data
      const row = participated[i]
      // `useReadContracts` degrades PER CALL, so these six legs can land in
      // any mix of success and failure. Coalescing a failure to `false`/`0n`
      // turned an RPC hiccup into a confident statement: a failed `launched`
      // leg hid the claim CTA on a launched project, and a failed
      // `GENESIS_CLAIM_SUPPLY` showed a real allocation as `0`. Both read as
      // "you have nothing to claim", which is the worst thing this drawer can
      // say incorrectly.
      //
      // So: all six or none. A row that could not be read fully is marked
      // degraded and renders as unread rather than as empty.
      const legs = [d[off], d[off + 1], d[off + 2], d[off + 3], d[off + 4], d[off + 5]]
      const degraded = legs.some(l => l?.status !== 'success')

      const cooldownEnd     = degraded ? 0n    : d[off    ].result as bigint
      const launched        = degraded ? false : d[off + 1].result as boolean
      const totalNative        = degraded ? 0n    : d[off + 2].result as bigint
      const hasClaimed      = degraded ? false : d[off + 3].result as boolean
      const genesisClaimSup = degraded ? 0n    : d[off + 4].result as bigint
      const symbol          = degraded ? '???' : d[off + 5].result as string
      const claimable       =
        !degraded && launched && !hasClaimed && totalNative > 0n
          ? (genesisClaimSup * row.nativeDeposited) / totalNative
          : 0n
      out.push({ row, degraded, cooldownEnd, launched, totalNative, hasClaimed, genesisClaimSup, symbol, claimable })
    }
    return out
  }, [fullDataQuery.data, participated])

  // ── Global cooldown = MAX(cooldownEnd) across all participated hooks ───
  const globalCooldownEnd = useMemo(() => {
    let max = 0n
    for (const s of snapshots) if (s.cooldownEnd > max) max = s.cooldownEnd
    return max
  }, [snapshots])

  // rAF gating — only spin the clock when the drawer is open AND the on-chain
  // cooldown timestamp is non-zero.  After the snapshot the timer self-pauses
  // because `active` flips to false.
  const cooldownPresent  = globalCooldownEnd > 0n
  const cooldownEndMs    = Number(globalCooldownEnd) * 1000
  // A lapsed ban leaves its stamp behind, so the clock has to run for that too
  // — only a comparison against now tells a live ban from a spent one.
  const clockActive      = open && (cooldownPresent || banStamp > 0n)
  // The shared store's frame cadence, which is what the local rAF clock this
  // replaces was hand-rolling — same per-frame tick, same "0 until the first
  // client tick" contract, and it stays parked while `clockActive` is false.
  const now              = useNowMs('frame', clockActive)
  const knowsWallTime    = now !== CLOCK_UNSYNCED
  const remainingMs      = knowsWallTime ? cooldownEndMs - now : 0
  const cooldownReady    = !cooldownPresent || (knowsWallTime && remainingMs <= 0)

  // Same precedence `factory.deposit` reverts in: the ban outranks a missing
  // attestation, which outranks an exhausted window.
  const banned     = banStamp > 0n && knowsWallTime && Number(banStamp) * 1000 > now
  const unattested = !banned && pogQuota === 0n
  // `now` is 0 while the clock is parked, which `classifyHorizon` reports as
  // 'unsynced' — so this no longer formats a date against a wall time it does
  // not yet know, nor hands an unreachable stamp to `Date`.
  const banHorizon = classifyHorizon(banStamp, Math.floor(now / 1000))
  const banTxt     = formatHorizonLabel(banHorizon, {
    unsynced:  '—',
    unbounded: t.banPermanent,
    elapsed:   t.banLapsed,
    pending:   () => fill(t.banLifts, { date: formatHorizonUtc(banHorizon) ?? '—' }),
  })

  // ── REFETCH bus — claim TXs invalidate every cached read so the drawer
  //    snaps from [ CLAIM_TOKENS ] to [ TRANSFERRED_CLOSED ] without an
  //    explicit close+reopen. ────────────────────────────────────────────
  const refetchAll = useCallback(() => {
    userQuery.refetch()
    ethDepositedQuery.refetch()
    fullDataQuery.refetch()
  }, [userQuery, ethDepositedQuery, fullDataQuery])

  const handleDisconnect = () => {
    disconnect()
    onClose()
  }

  // EIP-2255 — forces the injected wallet (MetaMask / Rabby / Frame) to reopen
  // its account-picker even when an account is already connected, so the user
  // can swap which address feeds the session WITHOUT having to disconnect first
  // and dig through the extension UI.  Silently no-ops on wallets that don't
  // surface `wallet_requestPermissions` (e.g. WalletConnect).
  const handleSwitchAccount = async () => {
    try {
      const eth = (globalThis as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
      if (!eth?.request) return
      await eth.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      })
    } catch {
      /* user cancelled the picker — leave the existing connection intact */
    }
  }

  return (
    <>
      {/* Backdrop — invisible click target that closes the drawer.  A
          <button> (not <div>) so keyboard users can also dismiss it. */}
      <button
        type="button"
        aria-label={t.closeDrawer}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-bg-base/70 transition-opacity duration-200
                    ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
      />

      {/* Drawer panel — right-anchored, slides 100% off-screen when closed. */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-50 w-full sm:w-80 max-w-[100vw]
                    bg-bg-base border-l border-border-subtle/80 shadow-[0_0_80px_rgba(0,0,0,0.6)]
                    text-text-primary font-sans
                    transform transition-transform duration-300 ease-out
                    ${open ? 'translate-x-0' : 'translate-x-full'}
                    flex flex-col`}
      >
        <DrawerHeader
          address={address}
          onClose={onClose}
          onDisconnect={handleDisconnect}
          onSwitchAccount={handleSwitchAccount}
        />

        <div className="flex-1 overflow-y-auto overscroll-contain">
          <PoGQuotaPanel
            pogQuota={pogQuota}
            windowSpent={windowSpent}
            remaining={remainingQuota}
            banned={banned}
            banTxt={banTxt}
            unattested={unattested}
          />
          <CooldownPanel
            cooldownPresent={cooldownPresent}
            cooldownReady={cooldownReady}
            remainingMs={remainingMs}
            knowsWallTime={knowsWallTime}
          />
          <ParticipatedAssetsPanel
            snapshots={snapshots}
            loading={
              (launchCountQuery.isLoading) ||
              (launchCount > 0 && launchesQuery.isLoading) ||
              (launches.length > 0 && ethDepositedQuery.isLoading) ||
              (participated.length > 0 && fullDataQuery.isLoading)
            }
            empty={
              !launchCountQuery.isLoading &&
              !launchesQuery.isLoading &&
              !ethDepositedQuery.isLoading &&
              !fullDataQuery.isLoading &&
              participated.length === 0
            }
            onClaimed={refetchAll}
          />
          <ReferralLedgerLink onNavigate={onClose} />
        </div>

        <DrawerFooter />
      </aside>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAWER CHROME
// ─────────────────────────────────────────────────────────────────────────────

function DrawerHeader({
  address, onClose, onDisconnect, onSwitchAccount,
}: {
  address?:         Address
  onClose:          () => void
  onDisconnect:     () => void
  onSwitchAccount:  () => void
}) {
  const initials = address ? address.slice(2, 4).toUpperCase() : '--'
  const t = useT().drawer

  return (
    <header className="p-5 pb-4 border-b border-border-subtle/60 shrink-0">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-black text-text-primary uppercase tracking-widest">{t.title}</h2>
          <p className="text-label text-text-quiet font-mono mt-0.5">{CHAIN_BYLINE}</p>
        </div>
        <button
          type="button"
          aria-label={t.close}
          onClick={onClose}
          className="w-8 h-8 rounded-lg bg-surface-card border border-border-subtle flex items-center justify-center text-text-tertiary hover:text-text-primary hover:border-border-strong transition-all"
        >
          ×
        </button>
      </div>

      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand/20 to-admin/20 border border-brand/20 flex items-center justify-center shrink-0">
          <span className="text-brand font-black text-sm">{initials}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-mono text-text-secondary truncate">
            {address ? shortAddr(address) : '—'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onSwitchAccount}
          title={t.switchTitle}
          className="group flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                     border border-border-subtle bg-surface-card/50
                     text-label tracking-[0.32em] uppercase font-mono text-text-secondary
                     hover:border-brand/40 hover:text-brand hover:bg-brand/5
                     transition-all"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          <span>{t.switch}</span>
        </button>

        <button
          type="button"
          onClick={onDisconnect}
          title={t.disconnectTitle}
          className="group flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                     border border-border-subtle bg-surface-card/50
                     text-label tracking-[0.32em] uppercase font-mono text-text-secondary
                     hover:border-danger/40 hover:text-danger hover:bg-danger/5
                     transition-all"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
          <span>{t.disconnect}</span>
        </button>
      </div>
    </header>
  )
}

/**
 * The address-keyed way into `/referrals`.
 *
 * The page enumerates every project holding commission for this wallet and
 * claims each one. The navbar now names the route so an unconnected visitor
 * can find it; this row is still here because commission is keyed to an
 * address, and every other panel in the drawer is already about the
 * connected one. Closing the drawer on navigate is the point of `onNavigate`.
 */
function ReferralLedgerLink({ onNavigate }: { onNavigate: () => void }) {
  const t = useT().drawer
  return (
    <section className="px-4 pb-4 pt-2">
      <Link
        href="/referrals"
        onClick={onNavigate}
        className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle/70
                   bg-surface-card/50 p-4 transition-colors hover:border-brand/40"
      >
        <span className="min-w-0">
          <span className="block font-mono text-micro font-bold tracking-widest text-brand/70">
            {t.ledgerEyebrow}
          </span>
          <span className="mt-1 block text-note text-text-secondary">
            {t.ledgerBody}
          </span>
        </span>
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
      </Link>
    </section>
  )
}

function DrawerFooter() {
  const t = useT().drawer
  return (
    <footer className="px-5 py-3 border-t border-border-subtle
                       text-micro tracking-[0.32em] uppercase text-text-quiet
                       flex items-center justify-between gap-3">
      <span>v4.3 · {CHAIN_BYLINE}</span>
      <span>{t.footerHint}</span>
    </footer>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL [01] — POG QUOTA TELEMETRY
// ─────────────────────────────────────────────────────────────────────────────

function PoGQuotaPanel({
  pogQuota, windowSpent, remaining, banned, banTxt, unattested,
}: {
  pogQuota?:    bigint
  windowSpent?: bigint
  remaining?:   bigint
  /// A ban and a missing attestation both zero out `eligibility`, so neither is
  /// allowed to render as a headroom figure — the number would read as a spent
  /// window the user can wait out, which is the one thing it is not.
  banned:       boolean
  banTxt:       string
  unattested:   boolean
}) {
  const blocked = banned || unattested
  const t = useT().drawer
  return (
    <section className="px-4 pt-4 pb-2">
      <div className="rounded-xl border border-border-subtle/70 bg-surface-card/50 p-4">
        <div className="text-brand/70 font-mono text-micro font-bold tracking-widest mb-1">
          {t.quotaEyebrow}
        </div>
        {banned ? (
          <div className="text-danger font-mono text-xl font-black tracking-tight leading-none">
            {t.banned}
          </div>
        ) : unattested ? (
          <div className="text-warning font-mono text-xl font-black tracking-tight leading-none">
            {t.unattested}
          </div>
        ) : (
          <div className="text-brand font-mono text-3xl font-black tabular-nums tracking-tight leading-none">
            {formatQuote(remaining)}
            <span className="text-sm text-brand/60 ml-1">{QUOTE_SYMBOL}</span>
          </div>
        )}
        <div className="border-t border-border-subtle/50 pt-3 mt-3 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-text-tertiary font-mono text-label uppercase">{t.allocation}</span>
            <span className="text-text-primary font-mono text-xs font-bold tabular-nums">
              {unattested ? '—' : `${formatQuote(pogQuota)} ${QUOTE_SYMBOL}`}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-text-tertiary font-mono text-label uppercase">{t.spent}</span>
            <span className="text-text-secondary font-mono text-xs font-bold tabular-nums">
              {blocked ? '—' : `${formatQuote(windowSpent)} ${QUOTE_SYMBOL}`}
            </span>
          </div>
        </div>
        <p className={`mt-3 text-micro font-mono leading-relaxed
                       ${banned ? 'text-danger' : unattested ? 'text-warning' : 'text-text-quiet'}`}>
          {banned
            ? `${'// '}${fill(t.bannedNote, { ban: banTxt.toLowerCase() })}`
            : unattested
              ? `${'// '}${t.unattestedNote}`
              : `${'// '}${t.refillNote}`}
        </p>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL [02] — COOLDOWN MATRIX
// ─────────────────────────────────────────────────────────────────────────────

function CooldownPanel({
  cooldownPresent, cooldownReady, remainingMs, knowsWallTime,
}: {
  cooldownPresent: boolean
  cooldownReady:   boolean
  remainingMs:     number
  knowsWallTime:   boolean
}) {
  const t = useT().drawer
  return (
    <section className="px-4 py-3">
      <p className="text-label font-mono text-text-tertiary uppercase tracking-widest mb-2">{t.cooldownTitle}</p>
      <div className="rounded-xl border border-border-subtle/70 bg-surface-card/30 px-4 py-3">
      {!cooldownPresent ? (
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="w-2 h-2 rounded-full bg-brand dot-breathe" />
          <span className="text-brand font-bold tracking-wider text-micro">{t.readyToDeposit}</span>
        </div>
      ) : cooldownReady ? (
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="w-2 h-2 rounded-full bg-brand dot-breathe" />
          <span className="text-brand font-bold tracking-wider">{t.activeReady}</span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-xs font-mono text-danger mb-2">
            <span className="w-2 h-2 rounded-full bg-danger animate-pulse" />
            <span className="font-bold tracking-wider">{t.onCooldown}</span>
          </div>
          <p
            suppressHydrationWarning
            className="text-text-primary text-2xl tabular-nums tracking-wider font-black font-mono leading-none"
          >
            {knowsWallTime ? formatCooldown(remainingMs) : '--:--:--_--'}
          </p>
        </>
      )}
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL [03] — PARTICIPATED ASSETS (Claim conveyor)
// ─────────────────────────────────────────────────────────────────────────────

function ParticipatedAssetsPanel({
  snapshots, loading, empty, onClaimed,
}: {
  snapshots: HookSnapshot[]
  loading:   boolean
  empty:     boolean
  onClaimed: () => void
}) {
  const t = useT().drawer
  return (
    <section className="px-4 pt-2 pb-8">
      <p className="text-success/80 font-mono text-label font-bold tracking-widest mb-3 px-1">
        {`/// ${t.assetsTitle}`}
      </p>

      {loading && snapshots.length === 0 && (
        <p className="text-label tracking-wider text-text-tertiary uppercase">
          / {t.scanning}
        </p>
      )}

      {empty && (
        <p className="text-label tracking-wider text-text-tertiary uppercase leading-relaxed">
          / {t.emptyLead}{' '}
          <span className="text-text-primary">{fill(t.emptyHow, { quote: QUOTE_SYMBOL })}</span>
        </p>
      )}

      <ul className="flex flex-col">
        {snapshots.map(s => (
          <AssetRow key={s.row.hook} snapshot={s} onClaimed={onClaimed} />
        ))}
      </ul>
    </section>
  )
}

function AssetRow({
  snapshot, onClaimed,
}: {
  snapshot:  HookSnapshot
  onClaimed: () => void
}) {
  const { row, degraded, launched, totalNative, hasClaimed, claimable, symbol } = snapshot
  const t = useT().drawer

  // Routed through useTxAction rather than a bare useWriteContract: this row
  // previously read neither the write error nor the receipt, so a rejected
  // signature or an on-chain revert just returned the button to its idle label
  // with nothing said anywhere.
  const claim = useTxAction({
    action: fill(t.claimTx, { symbol }),
    onConfirmed: onClaimed,
  })

  const handleClaim = () => {
    claim.send({
      address:      row.hook,
      abi:          HOOK_ABI,
      functionName: 'claimGenesis',
      args:         [],
    })
  }

  // ⚠ NO PERCENTAGE. This computed `totalNative / softCap`, clamped at 100%
  //   because raises routinely overshot — which was the tell: a figure that
  //   goes past its own maximum and has to be clipped was never a maximum.
  //   The soft cap gates nothing, so the ratio measured nothing, and a
  //   depositor reading "82%" on their own stake row inferred a target the
  //   project had to hit for their money to be safe. It does not exist.

  return (
    <li className="rounded-xl border border-border-subtle/70 bg-surface-card/30 p-4 mb-3">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-body text-text-primary font-bold tracking-wider uppercase">
            ${symbol}
          </span>
          <span className="text-micro tracking-[0.32em] uppercase text-text-quiet truncate">
            / {shortAddr(row.hook)}
          </span>
        </div>
        <span className={`text-micro tracking-[0.32em] uppercase
                          ${degraded ? 'text-text-quiet' : launched ? 'text-brand' : 'text-text-tertiary'}`}>
          {degraded ? t.unread : launched ? t.curve : t.genesis}
        </span>
      </header>

      {/* `nativeDeposited` came from an earlier read that succeeded, so it stays
          on the degraded row — it is the one number here that is still known. */}
      <Row label={t.deposited} value={`${formatQuote(row.nativeDeposited)} ${QUOTE_SYMBOL}`} />

      {degraded && (
        <p className="mt-3 text-micro tracking-[0.32em] uppercase text-text-tertiary">
          {t.unreadNote}
        </p>
      )}

      {!launched && !degraded && (
        <div className="mt-3">
          <p className="mt-1.5 text-micro tracking-[0.32em] uppercase
                        text-text-tertiary flex items-baseline justify-between gap-2">
            <span>{t.raiseTotal}</span>
            <span className="text-text-primary tabular-nums normal-case tracking-wider">
              {formatQuote(totalNative)}
            </span>
          </p>
        </div>
      )}

      {launched && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-micro tracking-[0.32em] uppercase text-text-tertiary">
              {t.claimable}
            </p>
            <p className="text-body text-text-primary tabular-nums truncate">
              {formatToken(claimable)} {symbol}
            </p>
          </div>

          {hasClaimed ? (
            <span className="text-label tracking-[0.32em] uppercase px-3 py-1.5
                             border border-border-subtle text-text-quiet shrink-0">
              {t.claimed}
            </span>
          ) : claimable > 0n ? (
            <button
              type="button"
              onClick={handleClaim}
              disabled={claim.isBusy}
              className="text-label tracking-[0.32em] uppercase px-3 py-1.5
                         border border-brand text-brand
                         hover:bg-brand hover:text-bg-base transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {claim.isPending ? t.signing : claim.isConfirming ? t.mining : t.claim}
            </button>
          ) : (
            <span className="text-label tracking-[0.32em] uppercase px-3 py-1.5
                             border border-border-subtle text-text-quiet shrink-0">
              {t.noAllocation}
            </span>
          )}
        </div>
      )}
    </li>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

/*
 * `PanelHeader` USED TO BE HERE, and it was never called from anywhere in the
 * tree. It rendered a `// [index] LABEL` eyebrow, which is what `Card`'s own
 * eyebrow does now — so it was not a primitive waiting for a caller, it was
 * one that had been replaced and left behind.
 *
 * What makes it worth a note rather than a silent delete is how it survived:
 * the `@typescript-eslint/no-unused-vars` disable directly above it. Lint was
 * telling the truth, and the directive was added to stop it saying so, which
 * turns a self-clearing warning into something only a reader can find. If a
 * primitive here is genuinely unused, delete it; the disable is for a
 * parameter a signature is obliged to accept, not for a whole component.
 */

function Row({ label, value }: { label: string, value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-micro tracking-[0.32em] uppercase text-text-tertiary">
        {label}
      </span>
      <span className="text-body text-text-primary tabular-nums normal-case tracking-wider">
        {value}
      </span>
    </div>
  )
}
