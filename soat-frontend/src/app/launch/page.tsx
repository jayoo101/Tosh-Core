'use client'

/**
 * /launch — Genesis Console (v4.3 MeritX layout)
 * max-w-7xl · zinc-950 · rounded-xl · 2+1 column grid
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react'
import Link from 'next/link'
import {
  useAccount, useBalance, useChainId, useSwitchChain,
  useReadContracts, usePublicClient,
} from 'wagmi'
import { formatUnits, parseEventLogs, isAddress, type Address } from 'viem'
import { Rocket, FileText, Cpu, Shield } from 'lucide-react'

import { useTosh }       from '../lib/useTosh'
import {
  mineHookSalt,
  GENESIS_DURATION_FAST,
  GENESIS_DURATION_STANDARD,
  GENESIS_DURATION_SLOW,
} from '../lib/hookMiner'
import {
  FACTORY_ADDRESS,
  FACTORY_ABI, TARGET_CHAIN_ID,
  MAINNET_CHAIN_LABEL, TESTNET_CHAIN_LABEL,
  CHAIN_STATUS_BADGE, CHAIN_POSITIONING,
  testnetExplorerTx,
  GENESIS_SUPPLY, GENESIS_CLAIM_SUPPLY, GENESIS_LP_SUPPLY,
  BONDING_MAX, TIER_COUNT, LADDER_SPAN,
} from '../lib/contracts'
import type { ProjectPayload } from '../api/projects/route'

// ─── helpers ────────────────────────────────────────────────────────────────
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`
const basescanTx = (h: string) => testnetExplorerTx(h)
const trimEth   = (s: string) =>
  s.includes('.') ? s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '0' : s

// ─── supply arithmetic, off the shared constants ────────────────────────────
// Every headline number in the Immutable Pact is derived here rather than
// typed into a string, so a constants change can never leave the pact quoting
// terms the hook no longer enforces.
const TOTAL_SUPPLY = GENESIS_SUPPLY + BONDING_MAX

const millions = (wei: bigint) => `${trimEth(formatUnits(wei / 1_000_000n, 18))}M`
const shareOf  = (wei: bigint, of: bigint) =>
  of > 0n ? `${Number((wei * 1000n) / of) / 10}%` : '—'

// ─── styling constant ───────────────────────────────────────────────────────
const INPUT_CORE =
  'w-full py-3.5 px-4 rounded-xl font-mono text-sm text-text-primary placeholder:text-text-quiet ' +
  'bg-bg-base/50 border border-border-strong focus:outline-none focus:ring-1 ' +
  'focus:border-brand focus:ring-brand/20 transition-colors'

// ─── sub-components ─────────────────────────────────────────────────────────

function MeritXCard({
  icon: Icon, title, children,
}: {
  icon:     React.ComponentType<{ className?: string }>
  title:    string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface-card/50 p-6">
      <div className="flex items-center gap-2 mb-5">
        <Icon className="w-5 h-5 text-brand" />
        <h2 className="text-[10px] font-bold text-text-secondary uppercase tracking-[0.2em]">{title}</h2>
      </div>
      {children}
    </div>
  )
}

function MeritXField({
  label, hint, value, onChange, placeholder, readOnly, autoUpper, locked,
}: {
  label:        string
  hint?:        string
  value:        string
  onChange?:    (v: string) => void
  placeholder?: string
  readOnly?:    boolean
  autoUpper?:   boolean
  locked?:      boolean
}) {
  const borderCls = locked
    ? 'border-brand focus:border-brand focus:ring-brand/20'
    : 'border-border-strong focus:border-brand focus:ring-brand/20'

  return (
    <div>
      <label className="flex items-center gap-2 text-[10px] font-semibold text-text-secondary uppercase tracking-widest mb-2">
        {label}
        {hint && <span className="ml-auto normal-case text-[9px] text-text-quiet font-normal tracking-normal">{hint}</span>}
        {locked && <span className="ml-auto text-[9px] text-brand font-bold tracking-wider">● LOCKED</span>}
      </label>
      <input
        type="text"
        value={value}
        readOnly={readOnly}
        onChange={e => onChange?.(autoUpper ? e.target.value.toUpperCase() : e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCorrect="off"
        className={`${INPUT_CORE} ${borderCls} ${readOnly ? 'cursor-default' : ''} ${locked ? 'bg-brand/5' : ''}`}
      />
    </div>
  )
}

// The three windows the hook's constructor accepts.  `blurb` is what the
// creator is actually choosing between — the trade-off is urgency vs. reach.
const GENESIS_WINDOWS = [
  { seconds: GENESIS_DURATION_FAST,     label: '3 Hours',  tag: 'Fast',     blurb: 'Momentum play — hits the cap fast or fails fast.' },
  { seconds: GENESIS_DURATION_STANDARD, label: '24 Hours', tag: 'Standard', blurb: 'Covers every timezone once. The default.' },
  { seconds: GENESIS_DURATION_SLOW,     label: '72 Hours', tag: 'Slow',     blurb: 'Maximum reach for a wider raise.' },
] as const

function GenesisWindowSelect({
  value, onChange,
}: {
  value:    bigint
  onChange: (seconds: bigint) => void
}) {
  const active = GENESIS_WINDOWS.find(w => w.seconds === value) ?? GENESIS_WINDOWS[1]

  return (
    <div>
      <label className="flex items-center gap-2 text-[10px] font-semibold text-text-secondary uppercase tracking-widest mb-2">
        Genesis Window
        <span className="ml-auto normal-case text-[9px] text-text-quiet font-normal tracking-normal">
          immutable once deployed
        </span>
      </label>

      <div
        role="radiogroup"
        aria-label="Genesis window"
        className="grid grid-cols-3 gap-1 rounded-xl border border-border-strong bg-bg-base/50 p-1"
      >
        {GENESIS_WINDOWS.map(w => {
          const selected = w.seconds === active.seconds
          return (
            <button
              key={w.label}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(w.seconds)}
              className={
                'rounded-lg py-2.5 px-2 font-mono transition-colors ' +
                (selected
                  ? 'bg-brand/10 border border-brand text-text-primary'
                  : 'border border-transparent text-text-tertiary hover:text-text-secondary hover:bg-white/5')
              }
            >
              <span className="block text-sm font-bold tabular-nums">{w.label}</span>
              <span
                className={
                  'block text-[9px] uppercase tracking-widest mt-0.5 ' +
                  (selected ? 'text-brand' : 'text-text-quiet')
                }
              >
                {w.tag}
              </span>
            </button>
          )
        })}
      </div>

      <p className="mt-1.5 text-[10px] font-mono text-text-tertiary">{active.blurb}</p>
      <p className="mt-1 text-[10px] font-mono text-warning/80 leading-relaxed">
        The window must run to completion — even if the soft cap fills in minutes,
        launch() cannot be called early. Pick the shortest window you can live with.
      </p>
    </div>
  )
}

function MeritXTextarea({
  label, hint, value, onChange, placeholder,
}: {
  label:        string
  hint?:        string
  value:        string
  onChange:     (v: string) => void
  placeholder?: string
}) {
  return (
    <div>
      <label className="flex items-center gap-2 text-[10px] font-semibold text-text-secondary uppercase tracking-widest mb-2">
        {label}
        {hint && <span className="ml-auto normal-case text-[9px] text-text-quiet font-normal tracking-normal">{hint}</span>}
      </label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        spellCheck={false}
        className={`${INPUT_CORE} resize-none`}
      />
    </div>
  )
}

function ImmutablePact({ rules }: { rules: { key: string; label: string; value: string }[] }) {
  return (
    <div className="sticky top-24">
      <div className="rounded-xl border border-border-subtle bg-surface-card/50 p-6">
        <div className="flex items-center gap-2 mb-5">
          <Shield className="w-5 h-5 text-brand" />
          <h2 className="text-[10px] font-bold text-text-secondary uppercase tracking-[0.2em]">
            The Immutable Pact
          </h2>
        </div>
        <p className="text-[10px] text-text-tertiary font-mono mb-4 leading-relaxed">
          Protocol mechanics — unalterable rules you agree to by initializing:
        </p>
        <ul className="space-y-3 font-mono text-xs">
          {rules.map(({ key, label, value }) => (
            <li key={key} className="flex justify-between gap-4 py-2 border-b border-border-subtle/60 last:border-0">
              <span className="text-text-tertiary shrink-0">{label}:</span>
              <span className="text-text-primary font-bold text-right tabular-nums">{value}</span>
            </li>
          ))}
        </ul>
        <div className="mt-5 rounded-lg border border-brand/30 bg-brand/5 p-3">
          <p className="text-[10px] font-bold text-brand uppercase tracking-[0.18em] mb-1.5">
            Decentralization invariant
          </p>
          <p className="text-[10px] text-text-secondary font-mono leading-relaxed">
            No proxy, no admin key, no upgrade. <span className="text-text-primary">MINTER_ROLE</span> is
            granted once to this project&apos;s Hook and <span className="text-text-primary">DEFAULT_ADMIN_ROLE</span> is
            left permanently vacant. The token cannot migrate to a v5.1 Hook; unsold ladder
            supply can never be reminted elsewhere.
          </p>
        </div>
        <div className="mt-6 pt-4 border-t border-border-subtle">
          <p className="text-[10px] text-warning/80 font-mono leading-relaxed">
            If genesis fails (soft cap not met) or the 7-day launch window expires without curve
            activation, depositors can call{' '}
            <span className="text-warning">refund()</span> for full ETH return — no penalty.
          </p>
        </div>
      </div>
      <div className="mt-4 p-3 rounded-lg border border-border-subtle/60 bg-surface-card/20">
        <p className="text-[9px] text-text-quiet font-mono break-all">
          Factory: {FACTORY_ADDRESS}
        </p>
      </div>
    </div>
  )
}

function CryptoEngine({
  isMining, salt, mineError, onMine, canMine, predictedHook,
}: {
  isMining:       boolean
  salt:           string
  mineError:      string
  onMine:         () => void
  canMine:        boolean
  predictedHook:  string
}) {
  const locked = Boolean(salt) && !isMining

  // hex stream animation
  const [stream, setStream] = useState('')
  const rollHex = useCallback((): `0x${string}` => {
    const b = new Uint8Array(32)
    crypto.getRandomValues(b)
    return ('0x' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')) as `0x${string}`
  }, [])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isMining) { setStream(''); return }
    setStream(rollHex())
    const id = setInterval(() => setStream(rollHex()), 50)
    return () => clearInterval(id)
  }, [isMining, rollHex])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onMine}
          disabled={!canMine || isMining}
          className={`px-4 py-2.5 rounded-xl border text-[10px] tracking-widest uppercase font-bold transition-all
            ${canMine && !isMining
              ? 'border-brand text-brand hover:bg-brand hover:text-bg-base'
              : 'border-border-strong text-text-quiet cursor-not-allowed'}`}
        >
          {isMining ? '⌛ Mining…' : '[ Mine Salt ]'}
        </button>
        {locked && (
          <span className="flex items-center gap-1.5 text-[10px] font-bold text-brand border border-brand/30 px-2 py-1 rounded">
            <span className="w-1.5 h-1.5 rounded-full bg-brand dot-breathe" />
            ENGINE LOCKED
          </span>
        )}
      </div>

      <div className={`rounded-xl border px-4 py-3 font-mono text-xs break-all leading-relaxed
        ${locked ? 'border-brand/50 bg-brand/5 text-brand' : 'border-border-subtle bg-bg-base/40 text-text-tertiary'}`}>
        {locked ? salt : isMining ? (stream || '0x' + '0'.repeat(64)) : '0x' + '—'.repeat(16)}
      </div>

      {predictedHook && (
        <div className="rounded-xl border border-border-subtle bg-surface-card/30 px-4 py-3">
          <p className="text-[9px] text-text-tertiary font-mono mb-1 uppercase tracking-wider">Predicted Hook Address:</p>
          <p className="text-[11px] text-brand/80 font-mono break-all">{predictedHook}</p>
        </div>
      )}

      {mineError && (
        <p className="text-xs text-danger font-mono">Error: {mineError}</p>
      )}
    </div>
  )
}

// ─── LaunchCTA types ─────────────────────────────────────────────────────────
type FeeMode = 'loading'|'insufficient'|'launch'|'broadcasting'|'confirmed'

function LaunchCTA({
  feeMode, feeDisplay, identityComplete, saltLocked, ack, isWrongNetwork, isConnected,
  onLaunch, onSwitchChain, hash, errorMessage, syncState,
}: {
  feeMode:          FeeMode
  feeDisplay:       string
  identityComplete: boolean
  saltLocked:       boolean
  ack:              boolean
  isWrongNetwork:   boolean
  isConnected:      boolean
  onLaunch:         () => void
  onSwitchChain:    () => void
  hash:             string | undefined
  errorMessage:     string
  syncState:        'idle'|'syncing'|'done'|'error'
}) {
  const [hydrated, setHydrated] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setHydrated(true) }, [])

  const broadcasting = feeMode === 'broadcasting'
  const confirmed    = feeMode === 'confirmed'

  type Action = { label: string; action: (() => void) | null; armed: boolean; readyToFire?: boolean }

  const { label: displayLabel, action, armed, readyToFire }: Action = (() => {
    if (!isConnected)     return { label: 'Connect wallet to continue', action: null, armed: false }
    if (isWrongNetwork)   return { label: `Switch to ${TESTNET_CHAIN_LABEL}`, action: onSwitchChain, armed: true }
    if (!identityComplete) return { label: 'Fill in Agent Name, Ticker & valid Admin first', action: null, armed: false }
    if (!saltLocked)       return { label: 'Mine a hook salt first', action: null, armed: false }
    if (!ack)              return { label: 'Acknowledge the Immutable Pact first', action: null, armed: false }
    switch (feeMode) {
      case 'loading':       return { label: 'Reading fee…', action: null, armed: false }
      case 'insufficient':  return { label: `Insufficient ETH (need ${feeDisplay} ETH)`, action: null, armed: false }
      case 'broadcasting':  return { label: '⌛ Broadcasting transaction…', action: null, armed: false }
      case 'confirmed':     return { label: `✓ Launch confirmed! ${hash ? shortHash(hash) : ''}`, action: null, armed: true, readyToFire: true }
      case 'launch':        return { label: `Create Launch — pay ${feeDisplay} ETH`, action: onLaunch, armed: true, readyToFire: true }
      default:              return { label: 'Create Launch', action: onLaunch, armed: true }
    }
  })()

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-4">
        <Link
          href="/"
          className="order-2 sm:order-1 shrink-0 px-8 py-4 rounded-xl flex items-center justify-center font-bold text-sm border border-border-strong bg-surface-card/50 text-text-secondary hover:bg-surface-elevated/50 hover:text-text-secondary hover:border-border-strong transition-colors"
        >
          Cancel
        </Link>
        <button
          type="button"
          onClick={hydrated ? (action ?? undefined) : undefined}
          disabled={!hydrated || !action}
          className={[
            'order-1 sm:order-2 relative flex-1 min-w-[200px] py-4 rounded-xl font-black text-sm uppercase tracking-wider transition-all overflow-hidden',
            confirmed
              ? 'text-brand bg-brand/10 border border-brand/40'
              : readyToFire || (armed && action)
                ? 'text-bg-base bg-brand hover:bg-brand/90 border border-brand hover:shadow-[0_0_24px_rgba(0,255,163,0.25)]'
                : broadcasting
                  ? 'text-text-primary bg-brand/80 border border-brand/50 cursor-wait'
                  : 'text-text-tertiary bg-surface-elevated border border-border-strong cursor-not-allowed opacity-60',
          ].join(' ')}
        >
          {broadcasting && (
            <span aria-hidden className="absolute inset-0 tosh-shimmer pointer-events-none" />
          )}
          <span className="relative" suppressHydrationWarning>{hydrated ? displayLabel : 'Create Launch'}</span>
        </button>
      </div>

      {/* tx / sync status row */}
      {(hash || errorMessage || syncState !== 'idle') && (
        <div className="flex flex-wrap items-center gap-4 text-xs font-mono px-1">
          {hash && (
            <a href={basescanTx(hash)} target="_blank" rel="noopener noreferrer"
               className="text-brand hover:underline">
              TX {shortHash(hash)} ↗
            </a>
          )}
          {errorMessage  && <span className="text-danger">Error: {errorMessage}</span>}
          {syncState === 'syncing' && <span className="text-text-tertiary animate-pulse">Syncing to directory…</span>}
          {syncState === 'done'    && <span className="text-brand">✓ Directory synced</span>}
          {syncState === 'error'   && <span className="text-warning">Directory sync deferred</span>}
        </div>
      )}
    </div>
  )
}

// ─── PAGE ────────────────────────────────────────────────────────────────────
export default function GenesisConsole() {
  const { address, isConnected } = useAccount()
  const chainId                  = useChainId()
  const { switchChainAsync }     = useSwitchChain()
  const publicClient             = usePublicClient()

  const {
    createLaunch,
    hash, receipt, isPending, isConfirming, isConfirmed, error, reset,
  } = useTosh()

  // form state
  const [name,        setName]        = useState('')
  const [symbol,      setSymbol]      = useState('')
  const [description, setDescription] = useState('')
  const [genesisDuration, setGenesisDuration] = useState<bigint>(GENESIS_DURATION_STANDARD)
  const [logoUrl,     setLogoUrl]     = useState('')
  const [website,     setWebsite]     = useState('')
  const [twitter,     setTwitter]     = useState('')
  const [telegram,    setTelegram]    = useState('')
  const [ack,         setAck]         = useState(false)
  const [projectAdmin, setProjectAdmin] = useState('')

  // salt state
  const [salt,          setSalt]          = useState('')
  const [predictedHook, setPredictedHook] = useState('')
  const [isMining,      setIsMining]      = useState(false)
  const [mineError,     setMineError]     = useState('')

  // The factory bakes its CURRENT `defaultSoftCap` and `maxPogAllocationLimit`
  // into the hook initcode at createLaunch time, so a salt is only valid for
  // the values that were live when it was mined.  Remember them; if the owner
  // retunes either dial in between, the salt is silently dead and the launch
  // would revert with the opaque `InvalidHookSalt`.
  const [saltCaps, setSaltCaps] = useState<{ soft: bigint; wallet: bigint } | null>(null)

  const [syncState, setSyncState] = useState<'idle'|'syncing'|'done'|'error'>('idle')
  const [hydrated,  setHydrated]  = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setHydrated(true) }, [])

  // Auto-fill projectAdmin with the connected wallet the first time it's available.
  // Deliberately not overwriting if the user has already typed a custom address.
  //
  // CRITICAL: also wipe any cached salt when `address` changes.  `address` is
  // passed as `creator_` to hookInitcodeHash — a different wallet produces a
  // different initcode hash, so any previously mined salt is invalid and would
  // cause createLaunch to revert with InvalidHookSalt.
  useEffect(() => {
    if (!address) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!projectAdmin) setProjectAdmin(address)
    setSalt('')
    setPredictedHook('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  const pendingRef    = React.useRef<Omit<ProjectPayload,'txHash'>|null>(null)
  const syncedHashRef = React.useRef<string|null>(null)

  const isWrongNetwork = isConnected && chainId !== TARGET_CHAIN_ID
  const isBusy         = isPending || isConfirming || isMining

  // contract reads
  const walletEnabled = Boolean(address) && isConnected && !isWrongNetwork
  const feeRead = useReadContracts({
    contracts: [
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launchFee' },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'defaultSoftCap' },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'maxPogAllocationLimit' },
    ],
  })
  const { data: ethBal } = useBalance({ address, query: { enabled: walletEnabled } })

  const launchFeeWei  = (feeRead.data?.[0]?.result as bigint|undefined) ?? 0n
  const softCapWei    = (feeRead.data?.[1]?.result as bigint|undefined) ?? 0n
  const perWalletCapWei = (feeRead.data?.[2]?.result as bigint|undefined) ?? 0n
  const feeDisplay    = useMemo(() => trimEth(formatUnits(launchFeeWei, 18)), [launchFeeWei])
  const softCapDisplay = useMemo(() => trimEth(formatUnits(softCapWei, 18)), [softCapWei])
  const treasury: Address|undefined = address
  const adminAddr = isAddress(projectAdmin) ? projectAdmin as Address : undefined

  // protocol rules for ImmutablePact
  const protocolRules = useMemo(() => [
    { key: 'fee',      label: 'Launch Fee',       value: `${feeDisplay} ETH` },
    { key: 'softcap',  label: 'Genesis Soft Cap', value: `${softCapDisplay} ETH` },
    { key: 'wallet',   label: 'Per-wallet Cap',   value: `${trimEth(formatUnits(perWalletCapWei, 18))} ETH` },
    { key: 'supply',   label: 'Total Supply',     value: `${millions(TOTAL_SUPPLY)} tokens · fixed` },
    { key: 'genesis',  label: 'Genesis Block',
      value: `${millions(GENESIS_SUPPLY)} (${shareOf(GENESIS_SUPPLY, TOTAL_SUPPLY)}) · ${millions(GENESIS_CLAIM_SUPPLY)} claimable / ${millions(GENESIS_LP_SUPPLY)} locked LP` },
    { key: 'premium',  label: 'Genesis Premium',
      value: '10% — the 55/45 split opens P₀ at 1.10× what depositors paid' },
    { key: 'ladder',   label: 'Ladder Block',
      value: `${millions(BONDING_MAX)} (${shareOf(BONDING_MAX, TOTAL_SUPPLY)}) · ${TIER_COUNT} shelves` },
    { key: 'curve',    label: 'Curve Type',       value: `Discrete shelf ladder · ${LADDER_SPAN}× span` },
    { key: 'window',   label: 'Genesis Window',   value: `${genesisDuration / 3600n} hours` },
    { key: 'refund',   label: 'Refund Mechanism', value: 'refund()' },
    { key: 'upgrade',  label: 'Upgradeability',   value: 'None — immutable' },
    { key: 'minter',   label: 'Minter',           value: 'This Hook only, forever' },
    { key: 'network',  label: 'Deploy Network',   value: TESTNET_CHAIN_LABEL },
    { key: 'mainnet',  label: 'Target Mainnet',   value: MAINNET_CHAIN_LABEL },
  ], [feeDisplay, softCapDisplay, perWalletCapWei, genesisDuration])

  // salt mining — uses adminAddr so the initcode hash matches what the contract will deploy
  const handleMineSalt = useCallback(async () => {
    if (!address || !publicClient || !treasury || !adminAddr) return
    setMineError(''); setSalt(''); setPredictedHook(''); setIsMining(true)
    try {
      const liveSoftCap = await publicClient.readContract({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'defaultSoftCap',
      }) as bigint
      const liveWalletCap = await publicClient.readContract({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'maxPogAllocationLimit',
      }) as bigint
      const initcodeHash = await publicClient.readContract({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'hookInitcodeHash',
        args: [treasury, address, adminAddr, liveSoftCap, liveWalletCap, genesisDuration],
      }) as `0x${string}`
      const { rawSalt, hookAddress } = mineHookSalt(
        FACTORY_ADDRESS as `0x${string}`, address as `0x${string}`, initcodeHash,
      )
      setSalt(rawSalt); setPredictedHook(hookAddress)
      setSaltCaps({ soft: liveSoftCap, wallet: liveWalletCap })
    } catch (e: unknown) {
      setMineError(e instanceof Error ? e.message : 'salt mining failed')
    } finally { setIsMining(false) }
  }, [address, publicClient, treasury, adminAddr, genesisDuration])

  // Drop a salt the moment the polled factory dials move away from what it was
  // mined against, rather than letting the user discover it as a failed tx.
  useEffect(() => {
    if (!saltCaps) return
    if (softCapWei === 0n && perWalletCapWei === 0n) return // not yet loaded
    if (saltCaps.soft === softCapWei && saltCaps.wallet === perWalletCapWei) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSalt(''); setPredictedHook(''); setSaltCaps(null)
    setMineError('Factory soft cap / wallet cap changed — re-mine the salt before launching.')
  }, [saltCaps, softCapWei, perWalletCapWei])

  // validation
  const nameTrimmed    = name.trim()
  const symbolTrimmed  = symbol.trim().toUpperCase()
  const identityComplete = Boolean(nameTrimmed) && Boolean(symbolTrimmed) && Boolean(address) && Boolean(adminAddr)
  const saltLocked       = Boolean(salt) && !isMining
  const canMineSalt      = isConnected && !isWrongNetwork && !isBusy && identityComplete

  // fee mode — native ETH, no ERC-20 approve step
  const ethBalance = ethBal?.value ?? 0n
  const feeMode: FeeMode = isConfirmed ? 'confirmed'
    : isPending||isConfirming ? 'broadcasting'
    : !walletEnabled||feeRead.isPending ? 'loading'
    : ethBalance < launchFeeWei ? 'insufficient'
    : 'launch'

  const handleLaunch = useCallback(async () => {
    if (!address || !adminAddr || feeMode !== 'launch') return
    if (chainId !== TARGET_CHAIN_ID) {
      try { await switchChainAsync({ chainId: TARGET_CHAIN_ID }); await new Promise<void>(r => setTimeout(r, 300)) }
      catch { return }
    }
    pendingRef.current = {
      name: nameTrimmed, symbol: symbolTrimmed,
      logoUrl, website, twitter, telegram, description,
    }
    // Final read-through before spending the fee.  The reactive check above
    // runs off a poll and can be up to one interval stale, which is exactly
    // long enough for an owner retune to land between the last refresh and
    // this click.
    if (publicClient && saltCaps) {
      try {
        const [nowSoft, nowWallet] = await Promise.all([
          publicClient.readContract({
            address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'defaultSoftCap',
          }) as Promise<bigint>,
          publicClient.readContract({
            address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'maxPogAllocationLimit',
          }) as Promise<bigint>,
        ])
        if (nowSoft !== saltCaps.soft || nowWallet !== saltCaps.wallet) {
          setSalt(''); setPredictedHook(''); setSaltCaps(null)
          setMineError('Factory soft cap / wallet cap changed — re-mine the salt before launching.')
          return
        }
      } catch { /* fall through: the contract still rejects a stale salt */ }
    }

    reset(); setSyncState('idle')
    try {
      await createLaunch(
        nameTrimmed, symbolTrimmed, address, adminAddr,
        salt as `0x${string}`, launchFeeWei, genesisDuration,
      )
    } catch { /* wagmi surfaces */ }
  }, [address, adminAddr, feeMode, chainId, switchChainAsync, nameTrimmed, symbolTrimmed, logoUrl, website, twitter, telegram, description, salt, createLaunch, launchFeeWei, genesisDuration, reset, publicClient, saltCaps])

  // error message
  const errorMessage = (() => {
    if (!error) return ''
    const cause = (error as { cause?: { data?: { errorName?: string } } }).cause
    if (cause?.data?.errorName) return cause.data.errorName
    const m = error.message.match(/reason:\s*([^\n.]+)/)
    return m ? m[1].trim() : error.message.split('(')[0].trim()
  })()

  // off-chain sync
  useEffect(() => {
    if (!isConfirmed || !hash || !receipt) return
    if (syncedHashRef.current === hash) return
    syncedHashRef.current = hash
    const snap = pendingRef.current; if (!snap) return
    const sync = async () => {
      let tokenAddress: string|undefined, hookAddress: string|undefined
      try {
        const logs = parseEventLogs({ abi: FACTORY_ABI, eventName: 'LaunchCreated', logs: receipt.logs })
        if (logs.length > 0) { tokenAddress = logs[0].args.token as string; hookAddress = logs[0].args.hook as string }
      } catch { /* fallback */ }
      if ((!tokenAddress || !hookAddress) && publicClient) {
        try {
          const count = await publicClient.readContract({ address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launchCount' }) as bigint
          if (count > 0n) {
            const l = await publicClient.readContract({ address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launches', args: [count-1n] }) as readonly [string,string,string,bigint]
            tokenAddress = tokenAddress ?? l[0]; hookAddress = hookAddress ?? l[1]
          }
        } catch { /* non-fatal */ }
      }
      const payload: ProjectPayload = { ...snap, txHash: hash, tokenAddress, hookAddress }
      setSyncState('syncing')
      try {
        const res = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setSyncState('done')
      } catch { setSyncState('error') }
    }
    sync()
  }, [isConfirmed, hash, receipt, publicClient])

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-bg-base text-text-primary font-sans">
      <div className="max-w-7xl mx-auto px-4 md:px-6 lg:px-8 py-12">

        {/* Header */}
        <header className="mb-10 border-b border-border-subtle pb-8">
          <div className="flex items-center gap-3 mb-4">
            <span className="bg-brand text-bg-base text-[10px] font-bold px-2.5 py-0.5 rounded">{CHAIN_STATUS_BADGE}</span>
            <span className="text-text-tertiary text-[10px] font-mono tracking-widest uppercase">Mainnet: {MAINNET_CHAIN_LABEL}</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-black tracking-tighter text-text-primary leading-tight">
            Create a <span className="text-brand">Tosh Launch</span>
          </h1>
          <p className="text-text-secondary text-sm mt-3 max-w-2xl">
            {CHAIN_POSITIONING} Pay the ETH launch fee, mine a Uniswap V4 hook salt, and open a Proof-of-Gas gated genesis window.
          </p>
        </header>

        {/* 2-col layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">

          {/* Left — forms */}
          <section className="lg:col-span-2 space-y-6">

            <MeritXCard icon={Rocket} title="Agent Identity">
              <div className="space-y-4">
                <MeritXField
                  label="Agent Name"
                  value={name}
                  onChange={setName}
                  placeholder="e.g. QuantMind"
                />
                <MeritXField
                  label="Ticker (Symbol)"
                  value={symbol}
                  onChange={setSymbol}
                  placeholder="e.g. QMT"
                  autoUpper
                />
                <MeritXField
                  label="Declared Multisig (Metadata)"
                  value={hydrated ? (treasury ?? '') : ''}
                  readOnly
                  locked={hydrated && Boolean(treasury)}
                  hint="AUTO-LOCKED · RECEIVES NO FUNDS · CREATE2 SALT INPUT ONLY — REVENUE ROUTES TO PROJECT ADMIN BELOW"
                  placeholder="Connect wallet to bind…"
                />
                <div>
                  <MeritXField
                    label="Project Admin"
                    hint="99% BONDING CURVE REVENUE ROUTE · ROTATIONAL PRIVILEGES LCKD"
                    value={hydrated ? projectAdmin : ''}
                    onChange={v => {
                      setProjectAdmin(v)
                      // projectAdmin is baked into hook initcode — salt is no longer valid
                      if (salt) { setSalt(''); setPredictedHook('') }
                    }}
                    placeholder="0x… (defaults to your wallet)"
                  />
                  {hydrated && projectAdmin && !isAddress(projectAdmin) && (
                    <p className="mt-1.5 text-[10px] font-mono text-danger">
                      Invalid address — must be a valid 0x Ethereum address
                    </p>
                  )}
                  {hydrated && projectAdmin && isAddress(projectAdmin) && projectAdmin.toLowerCase() !== address?.toLowerCase() && (
                    <p className="mt-1.5 text-[10px] font-mono text-warning/80">
                      Custom admin — this address will receive the 99 % Phase-2 shelf cut
                    </p>
                  )}
                </div>
                <GenesisWindowSelect
                  value={genesisDuration}
                  onChange={next => {
                    if (next === genesisDuration) return
                    setGenesisDuration(next)
                    // The window is baked into the hook initcode — salt is no longer valid
                    if (salt) { setSalt(''); setPredictedHook('') }
                  }}
                />
              </div>
            </MeritXCard>

            <MeritXCard icon={FileText} title="Project Details">
              <div className="space-y-4">
                <MeritXTextarea
                  label="Project Manifesto"
                  hint="optional"
                  value={description}
                  onChange={setDescription}
                  placeholder="Describe your agent's utility, economic model, and roadmap — shown on the project page and directory cards."
                />
                <MeritXField label="Image URL"          value={logoUrl}  onChange={setLogoUrl}  placeholder="https://…/logo.png" />
                <MeritXField label="Website"            value={website}  onChange={setWebsite}  placeholder="https://yourproject.xyz" />
                <MeritXField label="Twitter (X)"        value={twitter}  onChange={setTwitter}  placeholder="@handle or x.com/…" />
                <MeritXField label="Telegram / Discord" value={telegram} onChange={setTelegram} placeholder="t.me/… or discord.gg/…" />
              </div>
            </MeritXCard>

            <MeritXCard icon={Cpu} title="Crypto Engine">
              <p className="text-[10px] text-text-quiet font-mono mb-4 leading-relaxed">
                CREATE2 salt grinder — bind name + ticker first, then mine until the engine locks.
              </p>
              <CryptoEngine
                isMining={isMining}
                salt={salt}
                mineError={mineError}
                onMine={() => void handleMineSalt()}
                canMine={canMineSalt}
                predictedHook={predictedHook}
              />
            </MeritXCard>

            {/* Acknowledgement */}
            <div className="rounded-xl border border-warning/30 bg-warning/5 p-5">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={() => setAck(a => !a)}
                  className="mt-1 h-4 w-4 rounded border border-border-strong bg-bg-base/50 accent-warning"
                />
                <div>
                  <span className="text-[10px] font-bold text-warning/90 uppercase tracking-wider">Acknowledgement</span>
                  <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                    I acknowledge the Immutable Pact: ETH launch fee ({feeDisplay} ETH), genesis soft
                    cap ({softCapDisplay} ETH), deposit cooldown per hook, a genesis window that
                    runs in full even after the soft cap is met, and that this Hook and its token
                    are not upgradeable — MINTER_ROLE stays with this Hook forever. Full ETH refund
                    via{' '}
                    <span className="text-warning">refund()</span> if genesis fails or the launch
                    window expires.
                  </p>
                </div>
              </label>
            </div>

            <LaunchCTA
              feeMode={feeMode}
              feeDisplay={feeDisplay}
              identityComplete={identityComplete}
              saltLocked={saltLocked}
              ack={ack}
              isWrongNetwork={isWrongNetwork}
              isConnected={isConnected}
              onLaunch={handleLaunch}
              onSwitchChain={async () => {
                try { await switchChainAsync({ chainId: TARGET_CHAIN_ID }) } catch { /* user cancel */ }
              }}
              hash={hash}
              errorMessage={errorMessage}
              syncState={syncState}
            />

          </section>

          {/* Right — immutable pact rail */}
          <div className="lg:col-span-1">
            <ImmutablePact rules={protocolRules} />
          </div>

        </div>
      </div>

      <footer className="border-t border-border-subtle mt-12 py-6 text-center text-[10px] text-text-quiet font-mono tracking-widest uppercase">
        Tosh Protocol · v4.3 · {MAINNET_CHAIN_LABEL} · testnet: {TESTNET_CHAIN_LABEL}
      </footer>
    </main>
  )
}
