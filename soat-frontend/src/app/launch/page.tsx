'use client'

/**
 * /launch — three beats, then one signature.
 *
 *   1. Identity     name, ticker, who receives the 99 % shelf cut
 *   2. Window       3 h / 24 h / 72 h, baked into the hook initcode
 *   3. Deploy       CREATE2 salt is ground inside the button, then createLaunch
 *
 * The CREATE2 grind is not a separate click. A salt is only valid for the
 * factory dials and genesis window it was mined against, so mining on the
 * same click that spends the fee is the only sequence that cannot go stale
 * between the two.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import {
  useAccount, useBalance, useChainId, useSwitchChain,
  useReadContracts, usePublicClient,
} from 'wagmi'
import { formatUnits, parseEventLogs, isAddress, type Address } from 'viem'

import { useTosh } from '../lib/useTosh'
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
  LAUNCH_WINDOW_SECONDS,
} from '@/lib/contracts'
import type { ProjectPayload } from '../api/projects/route'
import {
  Badge, Card, CardWell, Field, PageHeader,
  ActionButton, useActionGate, revertOrder, useTxLifecycleToast,
} from '@/components/ui'

const trimEth = (s: string) =>
  s.includes('.') ? s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '0' : s

const TOTAL_SUPPLY = GENESIS_SUPPLY + BONDING_MAX
const millions = (wei: bigint) => `${trimEth(formatUnits(wei / 1_000_000n, 18))}M`
const shareOf = (wei: bigint, of: bigint) =>
  of > 0n ? `${Number((wei * 1000n) / of) / 10}%` : '—'

const GENESIS_WINDOWS = [
  {
    seconds: GENESIS_DURATION_FAST,
    label: '3 hours',
    tag: 'Fast',
    blurb: 'Hits the cap or fails in one sitting. For a raise that already has an audience.',
  },
  {
    seconds: GENESIS_DURATION_STANDARD,
    label: '24 hours',
    tag: 'Standard',
    blurb: 'One full rotation of timezones. The default.',
  },
  {
    seconds: GENESIS_DURATION_SLOW,
    label: '72 hours',
    tag: 'Slow',
    blurb: 'Maximum reach. The window still cannot close early, even if the cap fills in minutes.',
  },
] as const

function PactRule({ kicker, title, body }: { kicker: string; title: string; body: string }) {
  return (
    <li className="flex flex-col gap-1 border-b border-border-subtle pb-gap last:border-0 last:pb-0">
      <span className="font-mono text-label text-brand">{kicker}</span>
      <span className="text-title text-text-primary">{title}</span>
      <span className="text-note text-text-tertiary leading-relaxed">{body}</span>
    </li>
  )
}

export default function GenesisConsole() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const publicClient = usePublicClient()

  const {
    createLaunch,
    hash, receipt, isPending, isConfirming, isConfirmed, error, reset,
  } = useTosh()

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [genesisDuration, setGenesisDuration] = useState<bigint>(GENESIS_DURATION_STANDARD)
  const [logoUrl, setLogoUrl] = useState('')
  const [website, setWebsite] = useState('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  const [ack, setAck] = useState(false)
  const [projectAdmin, setProjectAdmin] = useState('')

  const [salt, setSalt] = useState('')
  const [predictedHook, setPredictedHook] = useState('')
  const [isMining, setIsMining] = useState(false)
  const [mineError, setMineError] = useState('')
  const [saltCaps, setSaltCaps] = useState<{ soft: bigint; wallet: bigint } | null>(null)

  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle')

  useTxLifecycleToast({
    labels: { action: 'create launch' },
    hash,
    isPending,
    isConfirming,
    isConfirmed,
    error,
  })

  useEffect(() => {
    if (!address) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!projectAdmin) setProjectAdmin(address)
    setSalt('')
    setPredictedHook('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  const pendingRef = useRef<Omit<ProjectPayload, 'txHash'> | null>(null)
  const syncedHashRef = useRef<string | null>(null)

  const isWrongNetwork = isConnected && chainId !== TARGET_CHAIN_ID

  const walletEnabled = Boolean(address) && isConnected && !isWrongNetwork
  const feeRead = useReadContracts({
    contracts: [
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launchFee' },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'defaultSoftCap' },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'maxPogAllocationLimit' },
    ],
  })
  const { data: ethBal } = useBalance({ address, query: { enabled: walletEnabled } })

  const launchFeeWei = (feeRead.data?.[0]?.result as bigint | undefined) ?? 0n
  const softCapWei = (feeRead.data?.[1]?.result as bigint | undefined) ?? 0n
  const perWalletCapWei = (feeRead.data?.[2]?.result as bigint | undefined) ?? 0n
  const feeDisplay = useMemo(() => trimEth(formatUnits(launchFeeWei, 18)), [launchFeeWei])
  const softCapDisplay = useMemo(() => trimEth(formatUnits(softCapWei, 18)), [softCapWei])
  const adminAddr = isAddress(projectAdmin) ? projectAdmin as Address : undefined

  const mineSalt = useCallback(async (): Promise<`0x${string}` | null> => {
    if (!address || !publicClient || !adminAddr) return null
    setMineError('')
    setIsMining(true)
    try {
      const liveSoftCap = await publicClient.readContract({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'defaultSoftCap',
      }) as bigint
      const liveWalletCap = await publicClient.readContract({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'maxPogAllocationLimit',
      }) as bigint
      const initcodeHash = await publicClient.readContract({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'hookInitcodeHash',
        args: [address, address, adminAddr, liveSoftCap, liveWalletCap, genesisDuration],
      }) as `0x${string}`
      const { rawSalt, hookAddress } = mineHookSalt(
        FACTORY_ADDRESS as `0x${string}`, address as `0x${string}`, initcodeHash,
      )
      setSalt(rawSalt)
      setPredictedHook(hookAddress)
      setSaltCaps({ soft: liveSoftCap, wallet: liveWalletCap })
      return rawSalt
    } catch (e: unknown) {
      setMineError(e instanceof Error ? e.message : 'salt mining failed')
      return null
    } finally {
      setIsMining(false)
    }
  }, [address, publicClient, adminAddr, genesisDuration])

  useEffect(() => {
    if (!saltCaps) return
    if (softCapWei === 0n && perWalletCapWei === 0n) return
    if (saltCaps.soft === softCapWei && saltCaps.wallet === perWalletCapWei) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSalt(''); setPredictedHook(''); setSaltCaps(null)
    setMineError('Factory soft cap / wallet cap changed — the next deploy will grind a fresh salt.')
  }, [saltCaps, softCapWei, perWalletCapWei])

  const nameTrimmed = name.trim()
  const symbolTrimmed = symbol.trim().toUpperCase()
  const identityComplete = Boolean(nameTrimmed) && Boolean(symbolTrimmed) && Boolean(address) && Boolean(adminAddr)
  const ethBalance = ethBal?.value ?? 0n
  const insufficientFee = walletEnabled && !feeRead.isPending && ethBalance < launchFeeWei
  const feeLoading = !walletEnabled || feeRead.isPending

  const handleLaunch = useCallback(async () => {
    if (!address || !adminAddr) return
    if (chainId !== TARGET_CHAIN_ID) {
      try {
        await switchChainAsync({ chainId: TARGET_CHAIN_ID })
        await new Promise<void>(r => setTimeout(r, 300))
      } catch { return }
    }

    pendingRef.current = {
      name: nameTrimmed, symbol: symbolTrimmed,
      logoUrl, website, twitter, telegram, description,
    }

    let saltToUse = salt as `0x${string}` | ''
    if (!saltToUse) {
      const mined = await mineSalt()
      if (!mined) return
      saltToUse = mined
    } else if (publicClient && saltCaps) {
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
          const mined = await mineSalt()
          if (!mined) return
          saltToUse = mined
        }
      } catch { /* contract still rejects a stale salt */ }
    }

    reset(); setSyncState('idle')
    try {
      await createLaunch(
        nameTrimmed, symbolTrimmed, address, adminAddr,
        saltToUse as `0x${string}`, launchFeeWei, genesisDuration,
      )
    } catch { /* wagmi + toast */ }
  }, [
    address, adminAddr, chainId, switchChainAsync, nameTrimmed, symbolTrimmed,
    logoUrl, website, twitter, telegram, description, salt, mineSalt,
    createLaunch, launchFeeWei, genesisDuration, reset, publicClient, saltCaps,
  ])

  useEffect(() => {
    if (!isConfirmed || !hash || !receipt) return
    if (syncedHashRef.current === hash) return
    syncedHashRef.current = hash
    const snap = pendingRef.current
    if (!snap) return
    const sync = async () => {
      let tokenAddress: string | undefined
      let hookAddress: string | undefined
      try {
        const logs = parseEventLogs({ abi: FACTORY_ABI, eventName: 'LaunchCreated', logs: receipt.logs })
        if (logs.length > 0) {
          tokenAddress = logs[0].args.token as string
          hookAddress = logs[0].args.hook as string
        }
      } catch { /* fallback */ }
      if ((!tokenAddress || !hookAddress) && publicClient) {
        try {
          const count = await publicClient.readContract({
            address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launchCount',
          }) as bigint
          if (count > 0n) {
            const l = await publicClient.readContract({
              address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launches', args: [count - 1n],
            }) as readonly [string, string, string, bigint]
            tokenAddress = tokenAddress ?? l[0]
            hookAddress = hookAddress ?? l[1]
          }
        } catch { /* non-fatal */ }
      }
      const payload: ProjectPayload = { ...snap, txHash: hash, tokenAddress, hookAddress }
      setSyncState('syncing')
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setSyncState('done')
      } catch { setSyncState('error') }
    }
    void sync()
  }, [isConfirmed, hash, receipt, publicClient])

  const pickWindow = (next: bigint) => {
    if (next === genesisDuration) return
    setGenesisDuration(next)
    if (salt) { setSalt(''); setPredictedHook('') }
  }

  const gate = useActionGate({
    action: `Deploy — ${feeDisplay} ETH`,
    onAct: () => { void handleLaunch() },
    tx: { isPending, isConfirming },
    blockersInRevertOrder: revertOrder(
      {
        id: 'identity',
        active: !identityComplete,
        label: 'Name the token first',
        reason: 'Agent name, ticker and a valid project-admin address are baked into the hook initcode.',
        tone: 'neutral',
      },
      {
        id: 'ack',
        active: !ack,
        label: 'Acknowledge the pact',
        reason: 'The rules on the right are immutable once this transaction lands. Tick the box to proceed.',
        tone: 'warn',
      },
      {
        id: 'fee-loading',
        active: feeLoading,
        label: 'Reading launch fee…',
        reason: 'Waiting on factory.launchFee() before quoting the payable.',
        tone: 'neutral',
      },
      {
        id: 'insufficient-fee',
        active: insufficientFee,
        label: `Need ${feeDisplay} ETH`,
        reason: `The factory takes ${feeDisplay} ETH as the launch fee. This wallet does not hold that much.`,
        tone: 'warn',
      },
      {
        id: 'mining',
        active: isMining,
        label: 'Mining CREATE2 salt…',
        reason: `Grinding until the predicted hook address carries the 0x20CC flag for a ${genesisDuration / 3600n}h window.`,
        tone: 'info',
      },
      {
        id: 'confirmed',
        active: isConfirmed,
        label: 'Launch confirmed',
        reason: 'The hook is on-chain. Directory sync runs in the background.',
        tone: 'info',
      },
    ),
  })

  const activeWindow = GENESIS_WINDOWS.find(w => w.seconds === genesisDuration) ?? GENESIS_WINDOWS[1]

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-6xl px-4 py-page md:px-6">
        <PageHeader
          eyebrow={`Mainnet · ${MAINNET_CHAIN_LABEL}`}
          status={<Badge tone="ok" pip>{CHAIN_STATUS_BADGE}</Badge>}
          title="Create a"
          accent="Tosh Launch"
          subtitle={`${CHAIN_POSITIONING} One signature mines a Uniswap V4 hook salt and opens a Proof-of-Gas gated genesis.`}
        />

        <div className="mt-section grid grid-cols-1 items-start gap-section lg:grid-cols-3">
          <section className="flex flex-col gap-section lg:col-span-2">

            <Card id="01" title="Token" subtitle="What the directory and the ticker tape will call this.">
              <div className="grid grid-cols-1 gap-gap sm:grid-cols-2">
                <Field
                  label="Name"
                  value={name}
                  onValueChange={setName}
                  placeholder="QuantMind"
                />
                <Field
                  label="Ticker"
                  value={symbol}
                  onValueChange={setSymbol}
                  placeholder="QMT"
                  uppercase
                />
              </div>
              <Field
                label="Project admin"
                hint="Receives 99% of Phase-2 shelf revenue. Defaults to the connected wallet. The CREATE2 salt input is the same address — it receives no funds."
                value={projectAdmin}
                onValueChange={v => {
                  setProjectAdmin(v)
                  if (salt) { setSalt(''); setPredictedHook('') }
                }}
                placeholder="0x…"
                error={projectAdmin && !isAddress(projectAdmin) ? 'NOT A VALID ADDRESS' : null}
              />
              {isAddress(projectAdmin) && address && projectAdmin.toLowerCase() !== address.toLowerCase() && (
                <p className="text-note text-warning">
                  Custom admin — this address, not yours, receives the 99% shelf cut.
                </p>
              )}

              <details className="group">
                <summary className="cursor-pointer list-none font-mono text-label text-text-tertiary hover:text-text-secondary">
                  Optional manifesto, links, artwork
                  <span className="ml-2 text-text-quiet group-open:hidden">+</span>
                  <span className="ml-2 hidden text-text-quiet group-open:inline">−</span>
                </summary>
                <div className="mt-gap flex flex-col gap-gap">
                  <Field
                    label="Manifesto"
                    multiline
                    rows={4}
                    value={description}
                    onValueChange={setDescription}
                    placeholder="Utility, economic model, roadmap."
                  />
                  <Field label="Image URL" value={logoUrl} onValueChange={setLogoUrl} placeholder="https://…/logo.png" />
                  <Field label="Website" value={website} onValueChange={setWebsite} placeholder="https://…" />
                  <Field label="Twitter / X" value={twitter} onValueChange={setTwitter} placeholder="@handle" />
                  <Field label="Telegram / Discord" value={telegram} onValueChange={setTelegram} placeholder="t.me/…" />
                </div>
              </details>
            </Card>

            <Card
              id="02"
              title="Genesis window"
              subtitle="Immutable. The window runs to completion even if the soft cap fills in minutes."
            >
              <div role="radiogroup" aria-label="Genesis window" className="grid grid-cols-1 gap-gap sm:grid-cols-3">
                {GENESIS_WINDOWS.map(w => {
                  const selected = w.seconds === activeWindow.seconds
                  return (
                    <button
                      key={w.label}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => pickWindow(w.seconds)}
                      className={
                        'flex flex-col gap-gap-tight rounded-card border px-card py-card text-left transition-colors ' +
                        (selected
                          ? 'border-border-accent bg-brand/10 shadow-armed'
                          : 'border-border-subtle bg-surface-elevated hover:border-border-strong hover:bg-surface-hover')
                      }
                    >
                      <span className={`font-mono text-label ${selected ? 'text-brand' : 'text-text-quiet'}`}>
                        {w.tag}
                      </span>
                      <span className="text-title text-text-primary">{w.label}</span>
                      <span className="text-note text-text-tertiary leading-relaxed">{w.blurb}</span>
                    </button>
                  )
                })}
              </div>
            </Card>

            <Card
              id="03"
              title="Mine and deploy"
              subtitle="The button grinds a 0x20CC CREATE2 salt, then pays the launch fee in the same flow."
              status={salt ? <Badge tone="ok" pip live>salt locked</Badge> : undefined}
            >
              {predictedHook && (
                <CardWell padding="card">
                  <p className="font-mono text-label text-text-quiet">Predicted hook</p>
                  <p className="mt-1 break-all font-mono text-note text-brand">{predictedHook}</p>
                </CardWell>
              )}

              <label className="flex cursor-pointer items-start gap-gap select-none">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={() => setAck(a => !a)}
                  className="mt-1 h-4 w-4 accent-brand"
                />
                <span className="text-note text-text-secondary leading-relaxed">
                  I accept the immutable pact: {feeDisplay} ETH launch fee, {softCapDisplay} ETH
                  soft cap, a genesis window that cannot close early, and a full{' '}
                  <span className="text-warning">refund()</span> if the raise misses or the{' '}
                  {Number(LAUNCH_WINDOW_SECONDS / 86400n)}-day launch window expires unopened.
                </span>
              </label>

              {mineError && (
                <p className="text-note text-danger">{mineError}</p>
              )}

              <ActionButton gate={gate} size="lg" />

              {isConfirmed && hash && (
                <p className="font-mono text-note text-success">
                  Confirmed.{' '}
                  <a
                    href={testnetExplorerTx(hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand underline decoration-dotted underline-offset-2"
                  >
                    {hash.slice(0, 10)}…{hash.slice(-6)}
                  </a>
                  {syncState === 'syncing' && ' · syncing directory'}
                  {syncState === 'done' && ' · directory synced'}
                  {syncState === 'error' && ' · directory sync deferred'}
                </p>
              )}

              <Link
                href="/"
                className="self-start font-mono text-label text-text-tertiary hover:text-text-secondary"
              >
                Cancel
              </Link>
            </Card>
          </section>

          <aside className="lg:col-span-1">
            <div className="sticky top-24">
              <Card
                id="PACT"
                title="Immutable rules"
                subtitle="Unalterable the moment createLaunch confirms."
                interactive={false}
              >
                <ul className="flex flex-col gap-gap">
                  <PactRule
                    kicker={shareOf(GENESIS_SUPPLY, TOTAL_SUPPLY)}
                    title={`${millions(GENESIS_SUPPLY)} genesis`}
                    body={`${millions(GENESIS_CLAIM_SUPPLY)} claimable to depositors · ${millions(GENESIS_LP_SUPPLY)} locked as genesis LP.`}
                  />
                  <PactRule
                    kicker={shareOf(BONDING_MAX, TOTAL_SUPPLY)}
                    title={`${millions(BONDING_MAX)} ladder`}
                    body={`${TIER_COUNT} equal shelves across a ${LADDER_SPAN}× span. Unsold supply can never be reminted.`}
                  />
                  <PactRule
                    kicker="10%"
                    title="Genesis premium"
                    body="The 55/45 claim/LP split opens P₀ at 1.10× what depositors paid."
                  />
                  <PactRule
                    kicker={`${Number(LAUNCH_WINDOW_SECONDS / 86400n)} days`}
                    title="Unopened raise refunds in full"
                    body="If launch() is not called after a successful genesis, every depositor reclaims 100% of their ETH. No penalty, no haircut."
                  />
                </ul>

                <CardWell padding="card">
                  <p className="font-mono text-label text-text-quiet">Live factory dials</p>
                  <dl className="mt-gap-tight flex flex-col gap-1 font-mono text-note">
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">Launch fee</dt>
                      <dd className="text-text-primary">{feeDisplay} ETH</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">Soft cap</dt>
                      <dd className="text-text-primary">{softCapDisplay} ETH</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">Per-wallet cap</dt>
                      <dd className="text-text-primary">{trimEth(formatUnits(perWalletCapWei, 18))} ETH</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">Network</dt>
                      <dd className="text-text-primary">{TESTNET_CHAIN_LABEL}</dd>
                    </div>
                  </dl>
                </CardWell>

                <p className="text-note text-text-quiet leading-relaxed">
                  No proxy, no admin key, no upgrade. MINTER_ROLE is granted once to this
                  project&apos;s Hook. DEFAULT_ADMIN_ROLE is left vacant.
                </p>
                <p className="break-all font-mono text-micro text-text-quiet">
                  Factory {FACTORY_ADDRESS}
                </p>
              </Card>
            </div>
          </aside>
        </div>
      </div>
    </main>
  )
}
