'use client'

/**
 * UserDrawer — Tosh personal sovereignty console.
 *
 * A right-anchored slide-in panel that mounts to the homepage WalletPip.
 * Pure-black canvas, hairline #1F1F2E dividers, JetBrains Mono everywhere,
 * fluorescent #00FFA3 reserved for unlock guards and primary call-to-action.
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
 *   [03] PARTICIPATED       For every hook where hook.ethDeposited(user) > 0:
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
 *     C. hook.ethDeposited(user)                      (N calls, filter > 0)
 *     D. (cooldown + phase + total + softCap + hasClaimed + claimSupply +
 *         erc20.symbol)                              (7 calls × M participated)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  useAccount,
  useDisconnect,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { formatUnits, type Address } from 'viem'

import {
  TARGET_CHAIN_ID,
  ERC20_ABI,
  FACTORY_ABI,
  FACTORY_ADDRESS,
  HOOK_ABI,
  MAINNET_CHAIN_LABEL,
  TESTNET_CHAIN_LABEL,
  ZERO_ADDRESS,
} from '@/lib/contracts'
import { classifyHorizon, formatHorizonLabel, formatHorizonUtc } from '@/components/ui'

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTERS
// ─────────────────────────────────────────────────────────────────────────────

const ETH_DECIMALS   = 18
const TOKEN_DECIMALS = 18

function formatEth(wei: bigint | undefined | null): string {
  if (wei === undefined || wei === null) return '—'
  const n = Number(formatUnits(wei, ETH_DECIMALS))
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
// rAF CLOCK — only ticks while the drawer is open AND a cooldown is active
// ─────────────────────────────────────────────────────────────────────────────

function useRafClock(active: boolean): number {
  // Initialised to 0 so SSR and the first client paint agree (no hydration
  // mismatch).  The first rAF callback patches the real wall-clock in.
  const [now, setNow] = useState(0)

  useEffect(() => {
    if (!active) return
    let raf = 0
    const tick = () => {
      // setState here is deferred inside the rAF callback (not synchronous
      // inside the effect body), so the react-hooks/set-state-in-effect rule
      // is satisfied.
      setNow(Date.now())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])

  return now
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
  ethDeposited: bigint
}

interface HookSnapshot {
  row:             ParticipatedRow
  cooldownEnd:     bigint
  launched:        boolean
  totalEth:        bigint
  softCap:         bigint
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
  const launchIds = useMemo(
    () => Array.from({ length: launchCount }, (_, i) => BigInt(i)),
    [launchCount],
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
      functionName: 'ethDeposited' as const,
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
      if (sd > 0n) out.push({ ...launches[i], ethDeposited: sd })
    }
    return out
  }, [ethDepositedQuery.data, launches])

  // ── Stage D: full per-hook snapshot (7 reads × M participated) ──────────
  const fullDataQuery = useReadContracts({
    contracts: address ? participated.flatMap(p => [
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'userLaunchCooldownEnd' as const, args: [address, p.hook] as const },
      { address: p.hook,          abi: HOOK_ABI,    functionName: 'launched'              as const },
      { address: p.hook,          abi: HOOK_ABI,    functionName: 'totalEthDeposited'     as const },
      { address: p.hook,          abi: HOOK_ABI,    functionName: 'softCap'               as const },
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
      const off = i * 7
      const d   = fullDataQuery.data
      const row = participated[i]
      const cooldownEnd     = d[off    ]?.status === 'success' ? d[off    ].result as bigint  : 0n
      const launched        = d[off + 1]?.status === 'success' ? d[off + 1].result as boolean : false
      const totalEth        = d[off + 2]?.status === 'success' ? d[off + 2].result as bigint  : 0n
      const softCap         = d[off + 3]?.status === 'success' ? d[off + 3].result as bigint  : 0n
      const hasClaimed      = d[off + 4]?.status === 'success' ? d[off + 4].result as boolean : false
      const genesisClaimSup = d[off + 5]?.status === 'success' ? d[off + 5].result as bigint  : 0n
      const symbol          = d[off + 6]?.status === 'success' ? d[off + 6].result as string  : '???'
      const claimable       =
        launched && !hasClaimed && totalEth > 0n
          ? (genesisClaimSup * row.ethDeposited) / totalEth
          : 0n
      out.push({ row, cooldownEnd, launched, totalEth, softCap, hasClaimed, genesisClaimSup, symbol, claimable })
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
  const now              = useRafClock(clockActive)
  const knowsWallTime    = now > 0
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
    unbounded: 'PERMANENT · NO EXPIRY',
    elapsed:   'LAPSED',
    pending:   () => `LIFTS ${formatHorizonUtc(banHorizon) ?? '—'}`,
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
        aria-label="close drawer"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/70 transition-opacity duration-200
                    ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
      />

      {/* Drawer panel — right-anchored, slides 100% off-screen when closed. */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-50 w-full sm:w-80 max-w-[100vw]
                    bg-zinc-950 border-l border-zinc-800/80 shadow-[0_0_80px_rgba(0,0,0,0.6)]
                    text-zinc-100 font-sans
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

  return (
    <header className="p-5 pb-4 border-b border-zinc-800/60 shrink-0">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-black text-white uppercase tracking-widest">My Profile</h2>
          <p className="text-[10px] text-zinc-600 font-mono mt-0.5">{MAINNET_CHAIN_LABEL} · testnet {TESTNET_CHAIN_LABEL}</p>
        </div>
        <button
          type="button"
          aria-label="close"
          onClick={onClose}
          className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 hover:text-white hover:border-zinc-600 transition-all"
        >
          ×
        </button>
      </div>

      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand/20 to-admin/20 border border-brand/20 flex items-center justify-center shrink-0">
          <span className="text-brand font-black text-sm">{initials}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-mono text-zinc-300 truncate">
            {address ? shortAddr(address) : '—'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onSwitchAccount}
          title="Re-open wallet account picker (EIP-2255)"
          className="group flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                     border border-zinc-800 bg-zinc-900/50
                     text-[10px] tracking-[0.32em] uppercase font-mono text-zinc-400
                     hover:border-brand/40 hover:text-brand hover:bg-brand/5
                     transition-all"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          <span>Switch</span>
        </button>

        <button
          type="button"
          onClick={onDisconnect}
          title="Terminate wagmi session for this address"
          className="group flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                     border border-zinc-800 bg-zinc-900/50
                     text-[10px] tracking-[0.32em] uppercase font-mono text-zinc-400
                     hover:border-red-500/40 hover:text-red-400 hover:bg-red-500/5
                     transition-all"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
          <span>Disconnect</span>
        </button>
      </div>
    </header>
  )
}

function DrawerFooter() {
  return (
    <footer className="px-5 py-3 border-t border-[#1F1F2E]
                       text-[9px] tracking-[0.32em] uppercase text-[#444]
                       flex items-center justify-between gap-3">
      <span>v4.3 · {MAINNET_CHAIN_LABEL} · testnet {TESTNET_CHAIN_LABEL}</span>
      <span>esc · click_outside</span>
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
  return (
    <section className="px-4 pt-4 pb-2">
      <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/50 p-4">
        <div className="text-brand/70 font-mono text-[9px] font-bold tracking-widest mb-1">
          POG REMAINING · THIS WINDOW
        </div>
        {banned ? (
          <div className="text-danger font-mono text-xl font-black tracking-tight leading-none">
            BLACKLISTED
          </div>
        ) : unattested ? (
          <div className="text-warning font-mono text-xl font-black tracking-tight leading-none">
            NO ATTESTATION
          </div>
        ) : (
          <div className="text-brand font-mono text-3xl font-black tabular-nums tracking-tight leading-none">
            {formatEth(remaining)}
            <span className="text-sm text-brand/60 ml-1">ETH</span>
          </div>
        )}
        <div className="border-t border-zinc-800/50 pt-3 mt-3 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-zinc-500 font-mono text-[10px] uppercase">Per-window Allocation</span>
            <span className="text-white font-mono text-xs font-bold tabular-nums">
              {unattested ? '—' : `${formatEth(pogQuota)} ETH`}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-zinc-500 font-mono text-[10px] uppercase">Spent This Window</span>
            <span className="text-zinc-400 font-mono text-xs font-bold tabular-nums">
              {blocked ? '—' : `${formatEth(windowSpent)} ETH`}
            </span>
          </div>
        </div>
        <p className={`mt-3 text-[9px] font-mono leading-relaxed
                       ${banned ? 'text-danger' : unattested ? 'text-warning' : 'text-zinc-600'}`}>
          {banned
            ? `${'// '}every deposit is rejected while the ban stands · ${banTxt.toLowerCase()}`
            : unattested
              ? `${'// '}no quota was ever issued to this wallet · register proof-of-gas to receive one`
              : `${'// '}refills every 24h · refunds never credit it back`}
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
  return (
    <section className="px-4 py-3">
      <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-2">Cooldown Matrix</p>
      <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/30 px-4 py-3">
      {!cooldownPresent ? (
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="w-2 h-2 rounded-full bg-brand dot-breathe" />
          <span className="text-brand font-bold tracking-wider text-[9px]">READY TO DEPOSIT</span>
        </div>
      ) : cooldownReady ? (
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="w-2 h-2 rounded-full bg-brand dot-breathe" />
          <span className="text-brand font-bold tracking-wider">ACTIVE READY</span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-xs font-mono text-red-400 mb-2">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="font-bold tracking-wider">ON COOLDOWN</span>
          </div>
          <p
            suppressHydrationWarning
            className="text-white text-2xl tabular-nums tracking-wider font-black font-mono leading-none"
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
  return (
    <section className="px-4 pt-2 pb-8">
      <p className="text-emerald-400/80 font-mono text-[10px] font-bold tracking-widest mb-3 px-1">
        {`/// Participated Assets`}
      </p>

      {loading && snapshots.length === 0 && (
        <p className="text-[10px] tracking-wider text-[#666] uppercase">
          / scanning on-chain registry…
        </p>
      )}

      {empty && (
        <p className="text-[10px] tracking-wider text-[#666] uppercase leading-relaxed">
          / no genesis deposits detected ·{' '}
          <span className="text-white">deposit ETH in any live genesis window, then claim after launch()</span>
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
  const { row, launched, totalEth, softCap, hasClaimed, claimable, symbol } = snapshot

  const { writeContract, data: txHash, isPending, reset } = useWriteContract()
  const { isLoading: isMining, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    if (!isConfirmed) return
    onClaimed()
    reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfirmed])

  const handleClaim = () => {
    writeContract({
      address:      row.hook,
      abi:          HOOK_ABI,
      functionName: 'claimGenesis',
      chainId:      TARGET_CHAIN_ID,
    })
  }

  // Raise progress is bounded at 100 % even if totalEth over-shoots softCap
  // (it can in practice — the contract allows the last deposit to push past
  // the soft cap before sealing genesis).
  const progressPct = softCap > 0n
    ? Math.min(100, Number((totalEth * 10000n) / softCap) / 100)
    : 0

  return (
    <li className="rounded-xl border border-zinc-800/70 bg-zinc-900/30 p-4 mb-3">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[12px] text-white font-bold tracking-wider uppercase">
            ${symbol}
          </span>
          <span className="text-[9px] tracking-[0.32em] uppercase text-[#555] truncate">
            / {shortAddr(row.hook)}
          </span>
        </div>
        <span className={`text-[9px] tracking-[0.32em] uppercase
                          ${launched ? 'text-brand' : 'text-[#888]'}`}>
          {launched ? 'CURVE' : 'GENESIS'}
        </span>
      </header>

      <Row label="DEPOSITED" value={`${formatEth(row.ethDeposited)} ETH`} />

      {!launched && (
        <div className="mt-3">
          <div className="relative h-1 bg-[#0A0A0A] border border-[#1F1F2E]">
            <div
              className="absolute inset-y-0 left-0 bg-white"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[9px] tracking-[0.32em] uppercase
                        text-[#666] flex items-baseline justify-between gap-2">
            <span>RAISE_PROGRESS</span>
            <span className="text-white tabular-nums normal-case tracking-wider">
              {formatEth(totalEth)} / {formatEth(softCap)} ({progressPct.toFixed(1)}%)
            </span>
          </p>
        </div>
      )}

      {launched && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[9px] tracking-[0.32em] uppercase text-[#666]">
              CLAIMABLE
            </p>
            <p className="text-[12px] text-white tabular-nums truncate">
              {formatToken(claimable)} {symbol}
            </p>
          </div>

          {hasClaimed ? (
            <span className="text-[10px] tracking-[0.32em] uppercase px-3 py-1.5
                             border border-[#1F1F2E] text-[#555] shrink-0">
              [ TRANSFERRED_CLOSED ]
            </span>
          ) : claimable > 0n ? (
            <button
              type="button"
              onClick={handleClaim}
              disabled={isPending || isMining}
              className="text-[10px] tracking-[0.32em] uppercase px-3 py-1.5
                         border border-brand text-brand
                         hover:bg-brand hover:text-black transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {isPending ? '[ SIGN… ]' : isMining ? '[ MINING… ]' : '[ CLAIM_TOKENS ]'}
            </button>
          ) : (
            <span className="text-[10px] tracking-[0.32em] uppercase px-3 py-1.5
                             border border-[#1F1F2E] text-[#555] shrink-0">
              [ NO_ALLOCATION ]
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function PanelHeader({ index, label }: { index: string, label: string }) {
  return (
    <div className="flex items-center gap-3 text-[10px] tracking-[0.4em] uppercase text-[#888] mb-4">
      <span className="text-[#555]">{'// ['}{index}{']'}</span>
      <span className="text-white">{label}</span>
    </div>
  )
}

function Row({ label, value }: { label: string, value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[9px] tracking-[0.32em] uppercase text-[#666]">
        {label}
      </span>
      <span className="text-[12px] text-white tabular-nums normal-case tracking-wider">
        {value}
      </span>
    </div>
  )
}
