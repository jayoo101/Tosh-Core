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
import { useRouter } from 'next/navigation'
import {
  useAccount, useBalance, useChainId, useSwitchChain,
  useReadContracts, usePublicClient, useEstimateFeesPerGas,
  useSignMessage,
} from 'wagmi'
import {
  formatUnits, parseEventLogs, isAddress,
  BaseError, ContractFunctionRevertedError,
  type Address,
} from 'viem'

import { useTosh } from '../lib/useTosh'
import {
  mineHookSalt,
  GENESIS_DURATION_FAST,
  GENESIS_DURATION_STANDARD,
  GENESIS_DURATION_SLOW,
} from '../lib/hookMiner'
import {
  CREATE_LAUNCH_GAS_TOTAL, LAUNCH_GAS_TOTAL, PROJECT_GAS_TOTAL,
  gasCostWei, formatEstimateEth,
} from '../lib/launchGas'
import {
  FACTORY_ADDRESS,
  FACTORY_ABI, TARGET_CHAIN_ID,
  ACTIVE_CHAIN_LABEL, CHAIN_BYLINE,
  CHAIN_STATUS_BADGE, CHAIN_POSITIONING,
  testnetExplorerTx,
  GENESIS_SUPPLY, GENESIS_CLAIM_SUPPLY, GENESIS_LP_SUPPLY,
  BONDING_MAX, TIER_COUNT, LADDER_SPAN,
  LAUNCH_WINDOW_SECONDS,
} from '@/lib/contracts'
import type { ProjectPayload } from '../api/projects/route'
import { buildProjectAttestationMessage } from '@/lib/projectAttestation'
import { rememberProject } from '@/lib/projectCache'
import { LogoField } from '@/components/LogoField'
import {
  Badge, Card, CardWell, Field, PageHeader,
  ActionButton, useActionGate, revertOrder, useTxLifecycleToast,
  shortErrorMessage, EM_DASH, toshToast,
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

/**
 * The creator-facing sentence for a `createLaunch` revert, or `null` when the
 * failure was not a revert the factory owns.
 *
 * `useTosh` pins an explicit gas cap so an RPC cannot dress a revert up as
 * "exceeds block gas limit", and the price of that is no `eth_estimateGas` and
 * therefore no pre-flight of any kind. Without the simulation in
 * `handleLaunch` the factory's reason reaches nobody: by the time the receipt
 * says `reverted` the fee and the gas are spent, and all `useTosh` can offer
 * is the generic "rejected by the factory" string.
 *
 * Read structurally off `ContractFunctionRevertedError` rather than matched
 * against message text, because `shortErrorMessage` keeps only the first line
 * of a viem error and the custom-error name sits several lines below it.
 *
 * `null` is the load-bearing return. A transport failure, a rate limit, or a
 * node that refuses `eth_call` with value must never stand between a creator
 * and a launch the factory would have accepted, so only a decoded revert is
 * grounds to stop.
 */
function launchRevertMessage(err: unknown): string | null {
  const reverted = err instanceof BaseError
    ? err.walk((e) => e instanceof ContractFunctionRevertedError)
    : null
  if (!(reverted instanceof ContractFunctionRevertedError)) return null

  const name = reverted.data?.errorName ?? reverted.reason ?? ''
  switch (name) {
    case 'FeeChanged':
      return 'The launch fee was raised above your quote. Reload to see the new terms.'
    case 'NameTaken':
      return 'That name and ticker pair is already claimed. Pick another.'
    case 'InvalidHookSalt':
      return 'The factory dials moved since the salt was ground. Deploy again for a fresh one.'
    case 'InsufficientLaunchFee':
      return 'The value sent does not cover the launch fee.'
    case 'InvalidAdmin':
      return 'The Phase-2 admin cannot be the zero address.'
    case 'DeployFailed':
      return 'The hook clone failed to deploy. Deploy again to grind a fresh salt.'
    case 'EnforcedPause':
      return 'The factory is paused and is not taking new projects.'
    default:
      return name ? `The factory rejected this launch: ${name}.` : null
  }
}

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
  const { signMessageAsync } = useSignMessage()
  const router = useRouter()

  const {
    createLaunch,
    hash, receipt, isPending, isConfirming, isConfirmed, error, reset,
  } = useTosh()

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [genesisDuration, setGenesisDuration] = useState<bigint>(GENESIS_DURATION_STANDARD)
  const [logoUrl, setLogoUrl] = useState('')
  /**
   * True while `POST /api/projects/logo` is in flight. `logoUrl` is inside the
   * attestation, so a deploy that snapshots mid-upload would list the token
   * without the picture the creator just chose.
   */
  const [logoUploading, setLogoUploading] = useState(false)
  const [website, setWebsite] = useState('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  /**
   * The terms that were ticked, or `null` for not ticked.
   *
   * A `boolean` here made consent portable between different pacts, which is
   * the one thing it must not be. The creator agrees to a specific launch fee
   * and a specific minimum raise; both are owner-tunable dials read live off
   * the factory. Storing only "yes" let a tick survive the numbers it was
   * given for — the same failure the salt effect below already guards against
   * for the soft cap and the wallet cap, which is where the shape came from.
   */
  const [ackedTerms, setAckedTerms] = useState<{ fee: bigint; softCap: bigint } | null>(null)
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

  // Which address this effect last auto-filled. Switching accounts has to
  // re-point the admin field, because the previous account's address is a
  // legal-looking value that silently hands the 99 % shelf cut to the wallet
  // the user just switched away from. A hand-typed address is left alone: an
  // account switch must not overwrite a deliberate choice.
  const autofilledAdminRef = useRef<string | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect -- the account is the
     external system this effect synchronises against, and resetting the form
     state it invalidates is the entire job. */
  useEffect(() => {
    if (!address) return
    if (!projectAdmin || projectAdmin === autofilledAdminRef.current) {
      autofilledAdminRef.current = address
      setProjectAdmin(address)
    }
    // A salt is only valid for the account it was mined against.
    setSalt('')
    setPredictedHook('')
    setSaltCaps(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])
  /* eslint-enable react-hooks/set-state-in-effect */

  /**
   * What the form held when the launch was submitted.
   *
   * No longer derived from `ProjectPayload`. That type is now strictly the
   * wire format — presentation fields plus a signature, with name, symbol and
   * the addresses removed because the server reads those from the receipt
   * rather than believing the caller. This snapshot still needs the name and
   * symbol, but for a different job: seeding the optimistic local cache so the
   * post-launch redirect lands on a populated page. Tying the two together
   * again would mean either sending fields the server ignores or dropping ones
   * the UI needs.
   */
  interface PendingLaunch {
    name:         string
    symbol:       string
    logoUrl:      string
    website:      string
    twitter:      string
    telegram:     string
    description?: string
    predictedHook?: string
  }

  const pendingRef = useRef<PendingLaunch | null>(null)
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
  // Aliased because `feeRead` is a fresh object every render: depending on it
  // from `handleLaunch` would rebuild that callback on each one, while the
  // refetch function itself is stable.
  const refetchDials = feeRead.refetch
  const { data: ethBal } = useBalance({ address, query: { enabled: walletEnabled } })

  // A zero launch fee is legal, so an unread dial must never collapse into 0n:
  // that reading is both a lie in the pact the depositor ticks and the wrong
  // msg.value to sign. Treat the three dials as one all-or-nothing quote.
  const dials = feeRead.data
  const dialsReady = dials !== undefined && dials.every(d => d.status === 'success')
  /**
   * `isError` as well as the per-call statuses, because they describe two
   * different failures and only one of them was covered.
   *
   * A per-call `status: 'failure'` is a reverting contract: the batch came
   * back and one entry in it did not. But if the BATCH fails — RPC down,
   * multicall reverting, transport error — wagmi leaves `data` undefined and
   * reports it on `isError`, which nothing here read. Both flags derive from
   * `dials !== undefined`, so both were false, and false/false is the same
   * state as "still loading".
   *
   * The page therefore sat on "Reading the terms…" indefinitely with an
   * unreachable factory, and the `dials-unreachable` blocker written for
   * exactly that case could never fire.
   */
  const dialsFailed =
    feeRead.isError || (dials !== undefined && dials.some(d => d.status === 'failure'))

  const launchFeeWei = dialsReady ? (dials[0].result as bigint) : 0n
  const softCapWei = dialsReady ? (dials[1].result as bigint) : 0n
  const perWalletCapWei = dialsReady ? (dials[2].result as bigint) : 0n
  const feeDisplay = useMemo(
    () => (dialsReady ? trimEth(formatUnits(launchFeeWei, 18)) : EM_DASH),
    [dialsReady, launchFeeWei],
  )
  const softCapDisplay = useMemo(
    () => (dialsReady ? trimEth(formatUnits(softCapWei, 18)) : EM_DASH),
    [dialsReady, softCapWei],
  )

  /**
   * Whether the pact currently on screen is the one that was agreed to.
   *
   * Derived rather than stored, so it cannot drift: it goes false on its own
   * if the dials stop resolving or if the owner retunes either number between
   * the tick and the signature. Both of those used to leave the box ticked
   * against terms that were no longer the terms.
   */
  const ack =
    dialsReady
    && ackedTerms !== null
    && ackedTerms.fee === launchFeeWei
    && ackedTerms.softCap === softCapWei
  // PM-F8. `maxFeePerGas` rather than the base fee: it is what the wallet will
  // authorise, so quoting the base fee would under-promise and leave a creator
  // short exactly when the network is busy.
  const { data: fees } = useEstimateFeesPerGas()
  const feePerGas = fees?.maxFeePerGas ?? fees?.gasPrice
  const createGasWei = gasCostWei(CREATE_LAUNCH_GAS_TOTAL, feePerGas)
  const projectGasWei = gasCostWei(PROJECT_GAS_TOTAL, feePerGas)
  const gasKnown = createGasWei !== null && projectGasWei !== null

  // Two numbers, and they are not the same one. `createLaunch` is due now;
  // `launch()` is due after genesis succeeds but is still the creator's to pay,
  // and only they can call it — a wallet funded for the first alone strands a
  // successful raise that nobody else is able to open.
  const dueNowWei = dialsReady && createGasWei !== null ? launchFeeWei + createGasWei : null
  const dueTotalWei = dialsReady && projectGasWei !== null ? launchFeeWei + projectGasWei : null

  const ethDisplay = (wei: bigint | null) => (wei === null ? EM_DASH : `${formatEstimateEth(wei)} ETH`)

  const adminAddr = isAddress(projectAdmin) ? projectAdmin as Address : undefined

  const mineSalt = useCallback(async (): Promise<{ rawSalt: `0x${string}`; hookAddress: `0x${string}` } | null> => {
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
      // (projectTreasury, creator, softCap, perWalletCap, genesisDuration).
      // projectAdmin is deliberately absent: the hook is an EIP-1167 clone whose
      // immutable args are creator, projectTreasury, softCap, perWalletCap and
      // genesisDuration. The admin is mutable by design and is applied at
      // initialisation, so it no longer moves the mined address.
      const initcodeHash = await publicClient.readContract({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'hookInitcodeHash',
        args: [address, address, liveSoftCap, liveWalletCap, genesisDuration],
      }) as `0x${string}`
      const { rawSalt, hookAddress } = mineHookSalt(
        FACTORY_ADDRESS as `0x${string}`, address as `0x${string}`, initcodeHash,
      )
      setSalt(rawSalt)
      setPredictedHook(hookAddress)
      setSaltCaps({ soft: liveSoftCap, wallet: liveWalletCap })
      return { rawSalt, hookAddress }
    } catch (e: unknown) {
      setMineError(shortErrorMessage(e))
      return null
    } finally {
      setIsMining(false)
    }
  }, [address, publicClient, adminAddr, genesisDuration])

  useEffect(() => {
    if (!saltCaps) return
    if (!dialsReady) return
    if (saltCaps.soft === softCapWei && saltCaps.wallet === perWalletCapWei) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSalt(''); setPredictedHook(''); setSaltCaps(null)
    setMineError('Factory soft cap / wallet cap changed — the next deploy will grind a fresh salt.')
  }, [saltCaps, dialsReady, softCapWei, perWalletCapWei])

  const nameTrimmed = name.trim()
  const symbolTrimmed = symbol.trim().toUpperCase()
  const identityComplete = Boolean(nameTrimmed) && Boolean(symbolTrimmed) && Boolean(address) && Boolean(adminAddr)
  const ethBalance = ethBal?.value ?? 0n
  // Gas belongs in this gate. Checking the fee alone admits a wallet holding
  // exactly the fee, which then cannot pay for the transaction that spends it —
  // a wallet-level failure after the page showed every check as passing. Falls
  // back to the fee alone when the fee oracle is quiet, since a lapsed gate
  // would be worse than a slightly lenient one.
  const requiredNowWei = dueNowWei ?? launchFeeWei
  const insufficientFee = walletEnabled && dialsReady && ethBalance < requiredNowWei

  const handleLaunch = useCallback(async () => {
    if (!address || !adminAddr) return
    if (!dialsReady) return
    if (chainId !== TARGET_CHAIN_ID) {
      try {
        await switchChainAsync({ chainId: TARGET_CHAIN_ID })
        await new Promise<void>(r => setTimeout(r, 300))
      } catch { return }
    }

    // A message from the previous attempt outlives it: `mineSalt` clears this
    // on entry, but it is skipped entirely when a valid salt is already held.
    setMineError('')

    pendingRef.current = {
      name: nameTrimmed, symbol: symbolTrimmed,
      logoUrl, website, twitter, telegram, description,
      predictedHook: predictedHook || undefined,
    }

    let saltToUse = salt as `0x${string}` | ''
    if (!saltToUse) {
      const mined = await mineSalt()
      if (!mined) return
      saltToUse = mined.rawSalt
      if (pendingRef.current) pendingRef.current.predictedHook = mined.hookAddress
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
          saltToUse = mined.rawSalt
          if (pendingRef.current) pendingRef.current.predictedHook = mined.hookAddress
        }
      } catch { /* contract still rejects a stale salt */ }
    }

    // `useTosh.createLaunch` documents that its caller MUST read the live fee
    // immediately before invoking it. `launchFeeWei` comes from a
    // `useReadContracts` with no refetch interval, so in a long-lived session
    // it can be arbitrarily old — and it was the one dial in that batch not
    // re-read above, where the two caps are re-read precisely because a stale
    // value invalidates the transaction.
    //
    // A moved fee un-ticks the pact rather than being spent anyway. That box
    // is an agreement to two specific numbers, and `ack` already goes false
    // when the cached read notices a change; this is the same rule applied at
    // the one moment it decides whether ETH leaves the wallet.
    let feeToSend = launchFeeWei
    if (publicClient) {
      try {
        const liveFee = await publicClient.readContract({
          address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launchFee',
        }) as bigint
        if (liveFee !== launchFeeWei) {
          setAckedTerms(null)
          setMineError(
            `Launch fee is now ${trimEth(formatUnits(liveFee, 18))} ETH, not `
            + `${trimEth(formatUnits(launchFeeWei, 18))} ETH. Review the terms and tick the pact again.`,
          )
          void refetchDials()
          return
        }
        feeToSend = liveFee
      } catch { /* the factory's own FeeChanged is the backstop */ }
    }

    // Pre-flight. The write pins an explicit gas cap and so never estimates,
    // which leaves this `eth_call` as the only thing between a rejected launch
    // and a creator who has already paid for it — see `launchRevertMessage`,
    // and note that only a decoded revert stops the send.
    if (publicClient) {
      try {
        await publicClient.simulateContract({
          address: FACTORY_ADDRESS,
          abi: FACTORY_ABI,
          functionName: 'createLaunch',
          args: [
            nameTrimmed, symbolTrimmed, address, adminAddr,
            saltToUse as `0x${string}`, feeToSend, genesisDuration,
          ],
          value: feeToSend,
          account: address,
        })
      } catch (e: unknown) {
        const reason = launchRevertMessage(e)
        if (reason !== null) {
          setMineError(reason)
          return
        }
      }
    }

    reset(); setSyncState('idle')
    try {
      await createLaunch(
        nameTrimmed, symbolTrimmed, address, adminAddr,
        saltToUse as `0x${string}`, feeToSend, genesisDuration,
      )
    } catch { /* wagmi + toast */ }
  }, [
    address, adminAddr, chainId, switchChainAsync, nameTrimmed, symbolTrimmed,
    logoUrl, website, twitter, telegram, description, salt, mineSalt,
    createLaunch, launchFeeWei, genesisDuration, reset, publicClient, saltCaps,
    dialsReady, predictedHook, refetchDials,
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

      // Do not wait on another RPC before leaving this page. Logs plus the
      // CREATE2 prediction are enough; `launches(count-1)` only backfills.
      hookAddress = hookAddress ?? snap.predictedHook
      const destination = tokenAddress ?? hookAddress
      if (!destination) {
        toshToast.error('Launch confirmed, but the token address was not in the receipt.')
        return
      }

      rememberProject({
        id:            tokenAddress ?? destination,
        chain_id:      TARGET_CHAIN_ID,
        tx_hash:       hash,
        token_address: tokenAddress ?? null,
        hook_address:  hookAddress ?? null,
        name:          snap.name,
        symbol:        snap.symbol,
        logo_url:      snap.logoUrl || null,
        website:       snap.website || null,
        twitter:       snap.twitter || null,
        telegram:      snap.telegram || null,
        description:   snap.description?.trim() || null,
        created_at:    new Date().toISOString(),
      })
      toshToast.success('Launch confirmed — opening your project')
      router.push(`/projects/${destination}`)

      // A second wallet prompt, right after the launch, and it is worth being
      // clear about why the cheaper option was rejected. The registry row is
      // what the directory and the project page render, so whoever writes it
      // chooses the name, the logo and the outbound links the audience sees.
      // Without a signature the only key is the txHash, which is public the
      // moment the launch confirms — so an attacker watching for
      // `LaunchCreated` could POST first with their own site and the real
      // creator's request would come back `{ duplicate: true }`. The server
      // now recovers this signature and compares it against the `creator` in
      // the event. Nothing is sent and nothing is approved; it only proves who
      // is speaking.
      //
      // Identity fields are gone from the body because the server reads them
      // from the receipt. Only the presentation fields are signed, and only
      // those are the caller's to choose.
      const publish = async () => {
        // `syncing` had no setter, so the copy below the tx hash could only
        // ever read `done` or `error`. It matters more now than it did: this
        // step opens a wallet signature prompt, so there is a real window in
        // which the launch is confirmed and the listing is still waiting on
        // the user.
        setSyncState('syncing')
        const signature = await signMessageAsync({
          message: buildProjectAttestationMessage({
            chainId:     TARGET_CHAIN_ID,
            txHash:      hash,
            logoUrl:     snap.logoUrl,
            website:     snap.website,
            twitter:     snap.twitter,
            telegram:    snap.telegram,
            description: snap.description ?? '',
          }),
        })

        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            txHash: hash,
            logoUrl: snap.logoUrl,
            website: snap.website,
            twitter: snap.twitter,
            telegram: snap.telegram,
            description: snap.description,
            signature,
          } satisfies ProjectPayload),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setSyncState('done')
      }

      // Declining costs the listing, not the launch: the token exists on chain
      // either way, and `rememberProject` above has already put it in this
      // browser's cache, so the redirect lands on a populated page regardless.
      void publish().catch(() => { setSyncState('error') })

      if (!tokenAddress && publicClient) {
        try {
          const count = await publicClient.readContract({
            address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launchCount',
          }) as bigint
          if (count > 0n) {
            const l = await publicClient.readContract({
              address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launches', args: [count - 1n],
            }) as readonly [string, string, string, bigint]
            rememberProject({
              id:            l[0],
              chain_id:      TARGET_CHAIN_ID,
              tx_hash:       hash,
              token_address: l[0],
              hook_address:  l[1],
              name:          snap.name,
              symbol:        snap.symbol,
              logo_url:      snap.logoUrl || null,
              website:       snap.website || null,
              twitter:       snap.twitter || null,
              telegram:      snap.telegram || null,
              description:   snap.description?.trim() || null,
              created_at:    new Date().toISOString(),
            })
          }
        } catch { /* page already opened on the predicted hook */ }
      }
    }
    void sync()
  }, [isConfirmed, hash, receipt, publicClient, router, signMessageAsync])

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
        reason: 'The name, ticker and a valid admin address are fixed into the token the moment it deploys, so they have to be settled before you sign.',
        tone: 'neutral',
      },
      {
        id: 'logo-uploading',
        active: logoUploading,
        label: 'Uploading logo…',
        reason: 'The picture has to finish landing before you sign: its URL is inside the directory attestation, and a snapshot taken now would list the token without it.',
        tone: 'info',
      },
      {
        id: 'dials-unread',
        active: !dialsReady && !dialsFailed,
        label: 'Reading the terms…',
        reason: 'Fetching the launch fee, the minimum raise and the per-wallet cap before quoting what you owe.',
        tone: 'neutral',
      },
      {
        id: 'dials-unreachable',
        active: dialsFailed,
        label: 'Factory unreachable',
        reason: `The factory at ${FACTORY_ADDRESS} did not answer on chain ${TARGET_CHAIN_ID}. Signing against an unknown fee would either fail or overpay, so this stays locked until it responds.`,
        tone: 'danger',
      },
      {
        id: 'ack',
        active: !ack,
        label: 'Acknowledge the pact',
        reason: 'The rules on the right are immutable once this transaction lands. Tick the box to proceed.',
        tone: 'warn',
      },
      {
        id: 'insufficient-fee',
        active: insufficientFee,
        label: `Need ${ethDisplay(requiredNowWei)}`,
        reason: gasKnown
          ? `${feeDisplay} ETH launch fee plus about ${ethDisplay(createGasWei)} of gas at the current rate. This wallet does not hold that much.`
          : `The factory takes ${feeDisplay} ETH as the launch fee. This wallet does not hold that much.`,
        tone: 'warn',
      },
      {
        id: 'mining',
        active: isMining,
        label: 'Finding your pool address…',
        reason: `Searching for an address Uniswap will accept for a ${genesisDuration / 3600n}h window. This runs in your browser and takes a moment.`,
        tone: 'info',
      },
      {
        id: 'confirmed',
        active: isConfirmed,
        label: 'Launch confirmed',
        reason: 'Your token is on chain. Listing it in the directory runs in the background.',
        tone: 'info',
      },
    ),
  })

  const activeWindow = GENESIS_WINDOWS.find(w => w.seconds === genesisDuration) ?? GENESIS_WINDOWS[1]

  return (
    <main>
      <div className="mx-auto max-w-6xl px-4 py-page md:px-6">
        <PageHeader
          eyebrow={CHAIN_BYLINE}
          status={<Badge tone="ok" pip>{CHAIN_STATUS_BADGE}</Badge>}
          title="Create a"
          accent="Tosh Launch"
          subtitle={`${CHAIN_POSITIONING} One signature deploys your token together with its own Uniswap V4 pool and opens a gas-gated funding round.`}
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
                hint="Receives 99% of everything the shelf ladder earns. Defaults to the connected wallet."
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

              <LogoField
                value={logoUrl}
                onValueChange={setLogoUrl}
                onBusyChange={setLogoUploading}
                name={name || symbol}
              />

              <details className="group">
                <summary className="cursor-pointer list-none font-mono text-label text-text-tertiary hover:text-text-secondary">
                  Optional manifesto and links
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
              title="Deploy"
              subtitle="One click works out the address your pool needs, then pays the launch fee in the same flow."
              status={salt ? <Badge tone="ok" pip live>salt locked</Badge> : undefined}
            >
              {predictedHook && (
                <CardWell padding="card">
                  <p className="font-mono text-label text-text-quiet">Your pool address</p>
                  <p className="mt-1 break-all font-mono text-note text-brand">{predictedHook}</p>
                </CardWell>
              )}

              {/* There is nothing to accept until the numbers are known.
                  `feeDisplay` and `softCapDisplay` fall back to an em dash,
                  which is the right answer for the "Live factory dials"
                  readout further down — a readout with no value should say so
                  — and the wrong one inside a pact, where it rendered as
                  "I accept the immutable pact: — ETH launch fee, — ETH
                  minimum raise" beside a box that could still be ticked. The
                  deploy button was already gated on `dialsReady`, so this was
                  never signable; it was a consent statement presenting blanks
                  as terms, which is its own defect. */}
              <label
                className={`flex items-start gap-gap select-none ${
                  dialsReady ? 'cursor-pointer' : 'cursor-not-allowed'
                }`}
              >
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={!dialsReady}
                  onChange={() =>
                    setAckedTerms(ack ? null : { fee: launchFeeWei, softCap: softCapWei })
                  }
                  className="mt-1 h-4 w-4 accent-brand disabled:opacity-40"
                />
                <span className="text-note leading-relaxed text-text-secondary">
                  {dialsReady ? (
                    <>
                      I accept the immutable pact: {feeDisplay} ETH launch fee, {softCapDisplay} ETH
                      minimum raise, a genesis window that cannot close early, and a{' '}
                      <span className="text-warning">full refund</span> if the raise misses or the{' '}
                      {Number(LAUNCH_WINDOW_SECONDS / 86400n)}-day window to open trading expires unused.
                    </>
                  ) : dialsFailed ? (
                    <span className="text-danger">
                      The factory did not answer on chain {TARGET_CHAIN_ID}, so the launch fee and
                      minimum raise are unknown. There are no terms to accept yet.
                    </span>
                  ) : (
                    <span className="text-text-tertiary">
                      Reading the launch fee and the minimum raise off the factory — the pact
                      appears here with its real numbers in it.
                    </span>
                  )}
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
                  {syncState === 'syncing' && ' · sign to list in the directory'}
                  {syncState === 'done' && ' · directory synced'}
                  {syncState === 'error' && ' · directory sync deferred'}
                </p>
              )}

              {/* `min-h-11` is the 44px touch floor. The base rule in
                  globals.css covers header / nav / footer only, so that an
                  inline link inside a paragraph is not given a 44px box; a
                  standalone control in main opts in. This one measured 15px
                  tall — the shortest tap target on the page, and the one that
                  abandons a part-filled form. */}
              <Link
                href="/"
                className="inline-flex min-h-11 items-center self-start font-mono text-label text-text-tertiary hover:text-text-secondary"
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
                subtitle="Unalterable the moment your launch confirms."
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
                    body="Splitting genesis 55/45 between claims and pool liquidity opens the market at 1.10× what depositors paid."
                  />
                  <PactRule
                    kicker={`${Number(LAUNCH_WINDOW_SECONDS / 86400n)} days`}
                    title="Unopened raise refunds in full"
                    body="If trading is never opened after a successful raise, every depositor reclaims 100% of their ETH. No penalty, no haircut."
                  />
                </ul>

                <CardWell padding="card">
                  <p className="font-mono text-label text-text-quiet">Live factory dials</p>
                  <dl className="mt-gap-tight flex flex-col gap-1 font-mono text-note">
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">Launch fee</dt>
                      <dd className="text-text-primary">
                        {dialsReady ? `${feeDisplay} ETH` : EM_DASH}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">Soft cap</dt>
                      <dd className="text-text-primary">
                        {dialsReady ? `${softCapDisplay} ETH` : EM_DASH}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">Per-wallet cap</dt>
                      <dd className="text-text-primary">
                        {dialsReady ? `${trimEth(formatUnits(perWalletCapWei, 18))} ETH` : EM_DASH}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">Network</dt>
                      <dd className="text-text-primary">{ACTIVE_CHAIN_LABEL}</dd>
                    </div>
                  </dl>
                </CardWell>

                <CardWell padding="card">
                  <p className="font-mono text-label text-text-quiet">What this costs you</p>
                  <dl className="mt-gap-tight flex flex-col gap-1 font-mono text-note">
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">Due now</dt>
                      <dd className="text-text-primary">{ethDisplay(dueNowWei)}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">
                        <span className="text-text-quiet">└</span> gas, create
                      </dt>
                      <dd className="text-text-secondary">{ethDisplay(createGasWei)}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">
                        <span className="text-text-quiet">└</span> gas, open pool later
                      </dt>
                      <dd className="text-text-secondary">
                        {ethDisplay(gasCostWei(LAUNCH_GAS_TOTAL, feePerGas))}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-text-tertiary">Total to open</dt>
                      <dd className="text-text-primary">{ethDisplay(dueTotalWei)}</dd>
                    </div>
                  </dl>
                  <p className="mt-gap-tight text-micro text-text-quiet leading-relaxed">
                    Gas is estimated from measured budgets at the current rate, not a
                    simulation of your transaction — the rate moves before you sign.
                    {' '}<span className="text-text-tertiary">Opening the pool</span> is a second
                    transaction you pay after the raise succeeds, and only you can send it.
                  </p>
                </CardWell>

                <p className="text-note text-text-quiet leading-relaxed">
                  No proxy, no admin key, no upgrade. Only this project&apos;s own contract can
                  ever mint the token, and nobody holds an admin role over it.
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
