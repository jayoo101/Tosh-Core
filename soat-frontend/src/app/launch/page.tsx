'use client'

/**
 * /launch — the factory owner's form for `createLaunch`.
 *
 *   1. Identity              picture, name, ticker, blurb
 *   2. Developer             who the Circuit NFT (and its revenue) is minted to
 *   3. Caps                  hard cap and per-wallet cap, baked into the hook
 *   4. Links                 optional, and off-chain: website, X, Telegram
 *   5. Genesis window        3 h / 24 h / 72 h, baked into the hook initcode
 *   -  Submit                unnumbered: the terms tick, then createLaunch
 *
 * `createLaunch` is `onlyOwner` and unpaid. When the owner is a
 * `ToshLaunchGateway`, every signer of its Safe may list from here with their
 * own wallet, and the call goes to the gateway. Otherwise this page serves a
 * single-key owner only; a Safe owner with no gateway is pointed at
 * `scripts/safeLaunchTx.mjs`, which builds the same call as a Transaction
 * Builder batch.
 *
 * The salt is picked on the Deploy click rather than on its own button: a
 * prediction is only valid for the owner, developer, caps and window it was
 * derived against, and deriving on the click that sends leaves no gap for any
 * of them to move in.
 */

import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  useAccount, useBalance, useSwitchChain,
  useReadContracts, usePublicClient, useEstimateFeesPerGas,
  useSignMessage,
} from 'wagmi'
import {
  formatUnits, parseUnits, parseEventLogs, isAddress,
  BaseError, ContractFunctionRevertedError,
  type Address,
} from 'viem'

import { useTosh } from '../lib/useTosh'
import {
  pickHookSalt,
  GENESIS_DURATION_FAST,
  GENESIS_DURATION_STANDARD,
  GENESIS_DURATION_SLOW,
} from '../lib/hookAddress'
import {
  CREATE_LAUNCH_GAS_TOTAL, LAUNCH_GAS_TOTAL,
  gasCostWei, formatEstimateEth,
} from '../lib/launchGas'
import {
  FACTORY_ADDRESS,
  FACTORY_ABI, TARGET_CHAIN_ID,
  QUOTE_DECIMALS, QUOTE_SYMBOL,
  ACTIVE_CHAIN_LABEL, MAINNET_CHAIN_LABEL,
  CHAIN_STATUS_BADGE, CHAIN_STAGING_NOTE, BADGE_NAMES_SETTLEMENT_CHAIN,
  testnetExplorerTx,
  GENESIS_SUPPLY, GENESIS_CLAIM_SUPPLY,
  BONDING_MAX, TIER_COUNT, LADDER_SPAN,
  LAUNCH_WINDOW_SECONDS,
} from '@/lib/contracts'
import { NATIVE_SYMBOL } from '@/lib/chain'
import { useWalletChainId } from '@/lib/useWalletChainId'
import type { ProjectPayload } from '../api/projects/route'
import { buildProjectAttestationMessage } from '@/lib/projectAttestation'
import { rememberProject } from '@/lib/projectCache'
import { LogoField } from '@/components/LogoField'
import { LaunchPreview } from '@/components/LaunchPreview'
import { LaunchesPaused } from '@/components/LaunchesPaused'
import { LAUNCHES_PAUSED } from '@/lib/launchGate'
import { LAUNCH_GATEWAY_ABI, useLaunchAuthority } from '@/lib/launchAuthority'
import { Emph, fill, useT, type Dictionary } from '@/i18n'
import {
  AddressLink, Badge, Card, Field,
  ActionButton, useActionGate, revertOrder, useTxLifecycleToast,
  shortErrorMessage, EM_DASH, toshToast, truncateHex,
} from '@/components/ui'

const trimEth = (s: string) =>
  s.includes('.') ? s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '0' : s

const TOTAL_SUPPLY = GENESIS_SUPPLY + BONDING_MAX
const millions = (wei: bigint) => `${trimEth(formatUnits(wei / 1_000_000n, 18))}M`
const shareOf = (wei: bigint, of: bigint) =>
  of > 0n ? `${Number((wei * 1000n) / of) / 10}%` : '—'
const quoteLabel = (units: bigint) => trimEth(formatUnits(units, QUOTE_DECIMALS))

const DEFAULT_HARD_CAP = '1000'

/** A positive quote amount with at most `QUOTE_DECIMALS` places, or `null`. */
function parseQuote(input: string): bigint | null {
  const v = input.trim()
  if (!new RegExp(`^\\d+(\\.\\d{0,${QUOTE_DECIMALS}})?$`).test(v)) return null
  try { return parseUnits(v, QUOTE_DECIMALS) } catch { return null }
}

const GENESIS_WINDOWS = [
  { seconds: GENESIS_DURATION_FAST     },
  { seconds: GENESIS_DURATION_STANDARD },
  { seconds: GENESIS_DURATION_SLOW     },
] as const

/**
 * The sentence for a decoded `createLaunch` revert, or `null` when the failure
 * was not a revert the factory owns.
 *
 * `null` is load-bearing: a transport failure or a node that refuses
 * `eth_call` must never stand between the owner and a launch the factory would
 * have accepted, so only a decoded revert is grounds to stop.
 */
function launchRevertMessage(err: unknown, t: Dictionary['launch']): string | null {
  const reverted = err instanceof BaseError
    ? err.walk((e) => e instanceof ContractFunctionRevertedError)
    : null
  if (!(reverted instanceof ContractFunctionRevertedError)) return null

  const name = reverted.data?.errorName ?? reverted.reason ?? ''
  switch (name) {
    case 'NameTaken':
      return t.revertNameTaken
    case 'InvalidDeveloper':
      return t.revertInvalidDeveloper
    case 'HardCapTooLow':
      return t.revertHardCapTooLow
    case 'HardCapTooHigh':
      return t.revertHardCapTooHigh
    case 'InvalidWalletCap':
      return t.revertInvalidWalletCap
    case 'OwnableUnauthorizedAccount':
    case 'NotLauncher':
      return t.revertNotOwner
    case 'DeployFailed':
      return t.revertDeployFailed
    case 'EnforcedPause':
      return t.revertPaused
    default:
      return name ? fill(t.revertOther, { name }) : null
  }
}

/**
 * The shell one numbered form group sits in, and the body wrapper inside it.
 *
 * `min-w-0` is not cosmetic: a UA stylesheet gives every `fieldset` a
 * `min-inline-size: min-content`, so one long unbroken readout could widen the
 * `minmax(0,1fr)` column and shove the 340px preview off the viewport. The body
 * is a separate wrapper because a flex fieldset drops its legend out of the
 * border notch.
 */
const SECTION =
  'min-w-0 rounded-panel border border-border-subtle bg-surface-card p-card-lg shadow-panel'

const SECTION_BODY = 'flex min-w-0 flex-col gap-gap'

function StepLegend({ n, children, optional = false }: {
  n: number
  children: ReactNode
  optional?: boolean
}) {
  const t = useT().launch
  return (
    <legend className="mb-gap flex flex-wrap items-center gap-gap-tight px-1 text-readout font-semibold text-text-primary">
      <span
        aria-hidden
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-input bg-brand/15 font-mono text-note tabular-nums text-brand"
      >
        {n}
      </span>
      {children}
      {optional && (
        <span className="ml-1 rounded-pill bg-surface-hover px-2 py-0.5 text-micro font-normal text-text-secondary">
          {t.optional}
        </span>
      )}
    </legend>
  )
}

function SectionNote({ children }: { children: ReactNode }) {
  return <p className="text-note leading-relaxed text-text-tertiary">{children}</p>
}

export default function LaunchRoute() {
  return LAUNCHES_PAUSED ? <LaunchesPaused /> : <GenesisConsole />
}

/** The immutable terms a tick consents to. */
interface Terms {
  developer: string
  hardCap:   bigint
  walletCap: bigint
  duration:  bigint
}

function GenesisConsole() {
  const { address, isConnected } = useAccount()
  const chainId = useWalletChainId()
  const { switchChainAsync } = useSwitchChain()
  const publicClient = usePublicClient()
  const { signMessageAsync } = useSignMessage()
  const router = useRouter()
  const t = useT().launch

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
   * without the picture that was just chosen.
   */
  const [logoUploading, setLogoUploading] = useState(false)
  const [website, setWebsite] = useState('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  const [developer, setDeveloper] = useState('')
  const [hardCapInput, setHardCapInput] = useState(DEFAULT_HARD_CAP)
  const [uncapped, setUncapped] = useState(false)
  /** `null` until edited, so it follows the factory's PoG ceiling until then. */
  const [walletCapInput, setWalletCapInput] = useState<string | null>(null)
  /**
   * The terms that were ticked, or `null` for not ticked. Stored as values
   * rather than a boolean so a tick cannot survive an edit to any of them.
   */
  const [ackedTerms, setAckedTerms] = useState<Terms | null>(null)

  const [salt, setSalt] = useState('')
  const [predictedHook, setPredictedHook] = useState('')
  const [saltTerms, setSaltTerms] = useState<Terms | null>(null)
  const [isDerivingSalt, setIsDerivingSalt] = useState(false)
  const [saltError, setSaltError] = useState('')
  const [ownerIsContract, setOwnerIsContract] = useState<boolean | null>(null)

  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle')

  useTxLifecycleToast({
    labels: { action: t.txAction },
    hash,
    isPending,
    isConfirming,
    isConfirmed,
    error,
  })

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

  const dialRead = useReadContracts({
    contracts: [
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'owner' },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'MIN_HARD_CAP' },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'MAX_HARD_CAP' },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'maxPogAllocationLimit' },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'paused' },
    ],
  })
  const { data: ethBal } = useBalance({ address, query: { enabled: walletEnabled } })

  const dials = dialRead.data
  const dialsReady = dials !== undefined && dials.every(d => d.status === 'success')
  /**
   * `isError` as well as the per-call statuses: a failed batch (RPC down,
   * multicall reverting) leaves `data` undefined and reports only on `isError`,
   * which would otherwise read as "still loading" forever.
   */
  const dialsFailed =
    dialRead.isError || (dials !== undefined && dials.some(d => d.status === 'failure'))

  const ownerAddr = dialsReady ? (dials[0].result as Address) : undefined
  const minHardCap = dialsReady ? (dials[1].result as bigint) : 0n
  const maxHardCap = dialsReady ? (dials[2].result as bigint) : 0n
  const pogLimit = dialsReady ? (dials[3].result as bigint) : 0n
  const factoryPaused = dialsReady && (dials[4].result as boolean)

  const authority = useLaunchAuthority(ownerAddr, address)
  const isOwner = authority.canLaunch
  /** Who the platform is, for the dials and the developer warning: the Safe, through a gateway or not. */
  const platformAddr = authority.safe ?? ownerAddr

  useEffect(() => {
    if (!ownerAddr || !publicClient || isOwner || authority.gateway) return
    let live = true
    publicClient.getBytecode({ address: ownerAddr })
      .then(code => { if (live) setOwnerIsContract(Boolean(code && code !== '0x')) })
      .catch(() => {})
    return () => { live = false }
  }, [ownerAddr, publicClient, isOwner, authority.gateway])

  const walletCapText = walletCapInput ?? (dialsReady ? quoteLabel(pogLimit) : '')
  // 0 is the factory's "no hard cap": the round runs to its deadline, and the
  // wallet cap is held to MAX_HARD_CAP in the hard cap's place.
  const hardCap = uncapped ? 0n : parseQuote(hardCapInput)
  const walletCap = parseQuote(walletCapText)
  const hardCapError =
    uncapped || !hardCapInput.trim() ? null
    : hardCap === null ? t.invalidAmount
    : dialsReady && (hardCap < minHardCap || hardCap > maxHardCap)
      ? fill(t.hardCapRange, { min: quoteLabel(minHardCap), max: quoteLabel(maxHardCap), quote: QUOTE_SYMBOL })
      : null
  const walletCapError =
    !walletCapText.trim() ? null
    : walletCap === null ? t.invalidAmount
    : uncapped
      ? walletCap === 0n || (dialsReady && walletCap > maxHardCap)
        ? fill(t.walletCapRangeUncapped, { max: quoteLabel(maxHardCap), quote: QUOTE_SYMBOL })
        : null
    : walletCap === 0n || (hardCap !== null && walletCap > hardCap) ? t.walletCapRange
      : null
  const hardCapLabel = (cap: bigint) =>
    cap === 0n ? t.noHardCapValue : `${quoteLabel(cap)} ${QUOTE_SYMBOL}`
  const capsValid =
    dialsReady && hardCap !== null && walletCap !== null && !hardCapError && !walletCapError

  const developerAddr = isAddress(developer) ? developer as Address : undefined

  const terms: Terms | null =
    developerAddr && capsValid
      ? { developer: developerAddr.toLowerCase(), hardCap: hardCap!, walletCap: walletCap!, duration: genesisDuration }
      : null
  const sameTerms = (a: Terms | null, b: Terms | null) =>
    a !== null && b !== null
    && a.developer === b.developer && a.hardCap === b.hardCap
    && a.walletCap === b.walletCap && a.duration === b.duration
  const ack = sameTerms(ackedTerms, terms)

  // A held salt is only good for the terms it was derived against; the
  // readout disappears the moment any of them changes.
  const saltLive = Boolean(salt) && sameTerms(saltTerms, terms)

  const { data: fees } = useEstimateFeesPerGas()
  const feePerGas = fees?.maxFeePerGas ?? fees?.gasPrice
  const gasNowWei = gasCostWei(CREATE_LAUNCH_GAS_TOTAL, feePerGas)

  const nativeDisplay = (wei: bigint | null) =>
    wei === null ? EM_DASH : `${formatEstimateEth(wei)} ${NATIVE_SYMBOL}`

  const deriveSalt = useCallback(async (): Promise<
    { rawSalt: `0x${string}`; hookAddress: `0x${string}` } | null
  > => {
    const creator = authority.creator
    if (!address || !creator || !publicClient || !terms) return null
    setSaltError('')
    setIsDerivingSalt(true)
    try {
      // (projectTreasury, creator, hardCap, perWalletCap, genesisDuration), and
      // the creator is the factory's `msg.sender` — the gateway when there is
      // one, otherwise the owner signing this.
      const initcodeHash = await publicClient.readContract({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'hookInitcodeHash',
        args: [terms.developer as Address, creator, terms.hardCap, terms.walletCap, terms.duration],
      }) as `0x${string}`
      let rawSalt: `0x${string}` | null = null
      let hookAddress: `0x${string}` | null = null
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = pickHookSalt(
          FACTORY_ADDRESS as `0x${string}`, creator as `0x${string}`, initcodeHash,
        )
        const occupant = await publicClient.getBytecode({ address: candidate.hookAddress })
        if (!occupant || occupant === '0x') {
          rawSalt = candidate.rawSalt
          hookAddress = candidate.hookAddress
          break
        }
      }
      if (rawSalt === null || hookAddress === null) {
        throw new Error(t.noFreeSalt)
      }
      setSalt(rawSalt)
      setPredictedHook(hookAddress)
      setSaltTerms(terms)
      return { rawSalt, hookAddress }
    } catch (e: unknown) {
      setSaltError(shortErrorMessage(e))
      return null
    } finally {
      setIsDerivingSalt(false)
    }
  // `terms` is rebuilt every render; its fields are the real dependencies.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, authority.creator, publicClient, terms?.developer, terms?.hardCap, terms?.walletCap, terms?.duration, t])

  const nameTrimmed = name.trim()
  const symbolTrimmed = symbol.trim().toUpperCase()
  const identityComplete = Boolean(nameTrimmed) && Boolean(symbolTrimmed)
  const ethBalance = ethBal?.value ?? 0n

  /** Falls open without a gas quote: a lapsed gate beats one that blocks a funded wallet. */
  const insufficientFunds =
    walletEnabled && gasNowWei !== null && ethBalance < gasNowWei

  const handleLaunch = useCallback(async () => {
    if (!address || !terms || !isOwner) return
    if (chainId !== TARGET_CHAIN_ID) {
      try {
        await switchChainAsync({ chainId: TARGET_CHAIN_ID })
        await new Promise<void>(r => setTimeout(r, 300))
      } catch { return }
    }

    setSaltError('')

    pendingRef.current = {
      name: nameTrimmed, symbol: symbolTrimmed,
      logoUrl, website, twitter, telegram, description,
      predictedHook: saltLive ? predictedHook : undefined,
    }

    let saltToUse = saltLive ? salt as `0x${string}` : ''
    if (!saltToUse) {
      const picked = await deriveSalt()
      if (!picked) return
      saltToUse = picked.rawSalt
      if (pendingRef.current) pendingRef.current.predictedHook = picked.hookAddress
    }

    const args = [
      nameTrimmed, symbolTrimmed, terms.developer as Address, saltToUse as `0x${string}`,
      terms.hardCap, terms.walletCap, terms.duration,
    ] as const

    // Pre-flight. The write pins a gas cap and so never estimates, which
    // leaves this `eth_call` as the only place a revert can be read before
    // gas is spent on it.
    if (publicClient) {
      try {
        await publicClient.simulateContract({
          address: authority.target,
          abi: [...FACTORY_ABI, ...LAUNCH_GATEWAY_ABI],
          functionName: 'createLaunch',
          args,
          account: address,
        })
      } catch (e: unknown) {
        const reason = launchRevertMessage(e, t)
        if (reason !== null) {
          setSaltError(reason)
          return
        }
      }
    }

    reset(); setSyncState('idle')
    try {
      await createLaunch(...args, authority.target)
    } catch { /* wagmi + toast */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    address, isOwner, authority.target, chainId, switchChainAsync, nameTrimmed, symbolTrimmed,
    logoUrl, website, twitter, telegram, description, salt, saltLive, deriveSalt,
    createLaunch, reset, publicClient, predictedHook, t,
    terms?.developer, terms?.hardCap, terms?.walletCap, terms?.duration,
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

      hookAddress = hookAddress ?? snap.predictedHook
      const destination = tokenAddress ?? hookAddress
      if (!destination) {
        toshToast.error(t.noTokenAddress)
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
      // Runs before the redirect: after `router.push` this component is
      // unmounted and whatever it had left to do does not happen.
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
        } catch { /* the predicted hook is enough to open the page on */ }
      }

      // The listing is signed because whoever writes the registry row chooses
      // the name, logo and links the audience sees, and the txHash alone is
      // public the moment the launch confirms. The server compares the signer
      // against the event's `creator` — the owner that sent it, or, for a
      // gateway, the owners of the Safe behind it, which this signer is one of.
      const publish = async () => {
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

      // Awaited, and the redirect waits on it: `router.push` unmounts this
      // component and would take the wallet prompt and the POST down with it.
      try {
        await publish()
      } catch {
        setSyncState('error')
        toshToast.error(t.notListed, { duration: 10_000 })
      }

      toshToast.success(t.opening)
      router.push(`/projects/${destination}`)
    }
    void sync()
  }, [isConfirmed, hash, receipt, publicClient, router, signMessageAsync, t])

  const ownerShort = platformAddr ? truncateHex(platformAddr) : EM_DASH
  const capRange = { min: quoteLabel(minHardCap), max: quoteLabel(maxHardCap), quote: QUOTE_SYMBOL }

  const gate = useActionGate({
    action: t.deploy,
    onAct: () => { void handleLaunch() },
    tx: { isPending, isConfirming },
    blockersInRevertOrder: revertOrder(
      {
        id: 'dials-unread',
        active: !dialsReady && !dialsFailed,
        label: t.dialsLabel,
        reason: t.dialsReason,
        tone: 'neutral',
      },
      {
        id: 'dials-unreachable',
        active: dialsFailed,
        label: t.unreachableLabel,
        reason: fill(t.unreachableReason, { factory: FACTORY_ADDRESS, chain: String(TARGET_CHAIN_ID) }),
        tone: 'danger',
      },
      {
        id: 'not-signer',
        active: dialsReady && !!authority.gateway && authority.resolved && !isOwner,
        label: t.signerLabel,
        reason: fill(t.signerReason, { owner: ownerShort }),
        tone: 'warn',
      },
      {
        id: 'owner-is-safe',
        active: dialsReady && authority.resolved && !authority.gateway && !isOwner && ownerIsContract === true,
        label: t.safeLabel,
        reason: fill(t.safeReason, { owner: ownerShort }),
        tone: 'warn',
      },
      {
        id: 'not-owner',
        active: dialsReady && authority.resolved && !authority.gateway && !isOwner && ownerIsContract !== true,
        label: t.ownerLabel,
        reason: fill(t.ownerReason, { owner: ownerShort }),
        tone: 'warn',
      },
      {
        id: 'factory-paused',
        active: factoryPaused,
        label: t.pausedLabel,
        reason: t.revertPaused,
        tone: 'danger',
      },
      {
        id: 'developer',
        active: !developerAddr,
        label: t.developerLabel,
        reason: t.developerReason,
        tone: 'neutral',
      },
      {
        id: 'caps',
        active: dialsReady && !capsValid,
        label: t.capsLabel,
        reason: fill(uncapped ? t.capsReasonUncapped : t.capsReason, capRange),
        tone: 'neutral',
      },
      {
        id: 'identity',
        active: !identityComplete,
        label: t.identityLabel,
        reason: t.identityReason,
        tone: 'neutral',
      },
      {
        id: 'logo-uploading',
        active: logoUploading,
        label: t.logoLabel,
        reason: t.logoReason,
        tone: 'info',
      },
      {
        id: 'ack',
        active: !ack,
        label: t.ackLabel,
        reason: t.ackReason,
        tone: 'warn',
      },
      {
        id: 'insufficient-funds',
        active: insufficientFunds,
        label: fill(t.fundsLabel, { due: nativeDisplay(gasNowWei) }),
        reason: fill(t.fundsReason, { due: nativeDisplay(gasNowWei) }),
        tone: 'warn',
      },
      {
        id: 'salt',
        active: isDerivingSalt,
        label: t.saltLabel,
        reason: fill(t.saltReason, { hours: String(genesisDuration / 3600n) }),
        tone: 'info',
      },
      {
        id: 'confirmed',
        active: isConfirmed,
        label: t.confirmedLabel,
        reason: t.confirmedReason,
        tone: 'info',
      },
    ),
  })

  const activeWindow = GENESIS_WINDOWS.find(w => w.seconds === genesisDuration) ?? GENESIS_WINDOWS[1]
  const hours = String(activeWindow.seconds / 3600n)

  return (
    <main>
      <div className="mx-auto max-w-7xl px-4 py-page sm:px-6">
        <div className="flex flex-col gap-gap-tight border-b border-border-subtle pb-section">
          <div className="flex flex-wrap items-center gap-gap-tight">
            {!BADGE_NAMES_SETTLEMENT_CHAIN && (
              <span className="font-mono text-label text-text-tertiary">
                {fill(t.settlesOn, { chain: MAINNET_CHAIN_LABEL })}
              </span>
            )}
            <Badge tone="ok" pip>{CHAIN_STATUS_BADGE}</Badge>
          </div>

          <h1 className="font-mono text-section text-text-primary sm:text-hero">
            {t.title}
          </h1>

          <p className="max-w-xl text-readout leading-relaxed text-text-secondary">
            {CHAIN_STAGING_NOTE ? `${CHAIN_STAGING_NOTE} ` : ''}
            {t.lede}
          </p>
        </div>

        <div className="mt-section grid gap-section lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* `onSubmit` swallows the event so the Enter key cannot deploy; the
              deploy path is the gated button. */}
          <form
            className="flex min-w-0 flex-col gap-gap"
            onSubmit={e => { e.preventDefault() }}
          >
            <fieldset className={SECTION}>
              <StepLegend n={1}>{t.identity}</StepLegend>
              <div className={SECTION_BODY}>
                <LogoField
                  value={logoUrl}
                  onValueChange={setLogoUrl}
                  onBusyChange={setLogoUploading}
                  name={name || symbol}
                />

                <div className="grid grid-cols-1 gap-gap sm:grid-cols-2">
                  <Field
                    label={t.name}
                    value={name}
                    onValueChange={setName}
                    placeholder="QuantMind"
                  />
                  <Field
                    label={t.ticker}
                    value={symbol}
                    onValueChange={setSymbol}
                    placeholder="QMT"
                    uppercase
                  />
                </div>

                <Field
                  label={t.description}
                  multiline
                  rows={3}
                  value={description}
                  onValueChange={setDescription}
                  placeholder={t.descriptionPlaceholder}
                />
              </div>
            </fieldset>

            <fieldset className={SECTION}>
              <StepLegend n={2}>{t.developer}</StepLegend>
              <div className={SECTION_BODY}>
                <Field
                  label={t.developerAddress}
                  hint={t.developerHint}
                  value={developer}
                  onValueChange={setDeveloper}
                  placeholder="0x…"
                  error={developer && !isAddress(developer) ? t.invalidAddress : null}
                />
                {developerAddr && platformAddr && developerAddr.toLowerCase() === platformAddr.toLowerCase() && (
                  <p className="text-note text-warning">
                    {t.developerIsOwner}
                  </p>
                )}
              </div>
            </fieldset>

            <fieldset className={SECTION}>
              <StepLegend n={3}>{t.caps}</StepLegend>
              <div className={SECTION_BODY}>
                <SectionNote>
                  {uncapped ? t.capsNoteUncapped : t.capsNote}
                </SectionNote>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={uncapped}
                    onChange={() => setUncapped(v => !v)}
                    className="mt-1 h-4 w-4 accent-brand"
                  />
                  <span className="text-note leading-relaxed text-text-secondary">
                    {t.noHardCap}
                  </span>
                </label>
                <div className="grid grid-cols-1 gap-gap sm:grid-cols-2">
                  <Field
                    label={fill(t.hardCap, { quote: QUOTE_SYMBOL })}
                    hint={uncapped ? t.noHardCapHint : dialsReady ? fill(t.hardCapHint, capRange) : undefined}
                    value={uncapped ? '' : hardCapInput}
                    onValueChange={setHardCapInput}
                    inputMode="decimal"
                    placeholder={uncapped ? t.noHardCapValue : DEFAULT_HARD_CAP}
                    error={hardCapError}
                    disabled={uncapped}
                  />
                  <Field
                    label={fill(t.walletCap, { quote: QUOTE_SYMBOL })}
                    hint={uncapped ? fill(t.walletCapHintUncapped, { max: capRange.max, quote: QUOTE_SYMBOL }) : t.walletCapHint}
                    value={walletCapText}
                    onValueChange={setWalletCapInput}
                    inputMode="decimal"
                    placeholder={dialsReady ? quoteLabel(pogLimit) : ''}
                    error={walletCapError}
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className={SECTION}>
              <StepLegend n={4} optional>{t.links}</StepLegend>
              <div className={SECTION_BODY}>
                <Field
                  label={t.website}
                  value={website}
                  onValueChange={setWebsite}
                  placeholder="https://your-agent.xyz"
                />
                <div className="grid grid-cols-1 gap-gap sm:grid-cols-2">
                  <Field
                    label={t.twitter}
                    value={twitter}
                    onValueChange={setTwitter}
                    placeholder="@handle"
                  />
                  <Field
                    label={t.telegram}
                    value={telegram}
                    onValueChange={setTelegram}
                    placeholder="t.me/group"
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className={SECTION}>
              <StepLegend n={5}>{t.window}</StepLegend>
              <div className={SECTION_BODY}>
                <SectionNote>
                  {t.windowNote}
                </SectionNote>

                <div className="flex flex-col gap-gap-tight">
                  <span className="font-mono text-label text-text-tertiary">{t.duration}</span>
                  <div
                    role="radiogroup"
                    aria-label={t.window}
                    className="flex flex-wrap gap-gap-tight"
                  >
                    {GENESIS_WINDOWS.map(w => {
                      const selected = w.seconds === activeWindow.seconds
                      return (
                        <button
                          key={String(w.seconds)}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setGenesisDuration(w.seconds)}
                          className={
                            'min-h-11 rounded-input border px-card font-mono text-readout transition-colors ' +
                            (selected
                              ? 'border-border-accent bg-brand/10 text-brand shadow-armed'
                              : 'border-border-subtle bg-surface-elevated text-text-tertiary hover:border-border-strong hover:bg-surface-hover hover:text-text-secondary')
                          }
                        >
                          {fill(t.windowHours, { hours: String(w.seconds / 3600n) })}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </fieldset>

            {/* Only shown once a Deploy picked a salt and stopped short of a
                confirmed transaction; the next Deploy reuses it while the
                terms it was derived against still hold. */}
            {saltLive && (
              <div className="flex min-w-0 flex-col gap-gap-tight rounded-panel border border-border-subtle bg-surface-card p-card-lg shadow-panel">
                <div className="flex flex-wrap items-center justify-between gap-gap-tight">
                  <p className="font-mono text-label text-text-tertiary">{t.saltTitle}</p>
                  <Badge tone="ok" size="sm" pip>{t.saltHeld}</Badge>
                </div>
                <p className="break-all font-mono text-note text-text-primary">{salt}</p>

                {predictedHook && (
                  <>
                    <p className="mt-gap-tight font-mono text-label text-text-quiet">
                      {t.poolAddress}
                    </p>
                    <p className="break-all font-mono text-note text-brand">{predictedHook}</p>
                  </>
                )}
              </div>
            )}

            <div className="grid min-w-0 gap-card lg:grid-cols-2">
              <Card id="PACT" title={t.pactTitle} interactive={false}>
                <dl className="flex flex-col gap-gap-tight font-mono text-note">
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">{t.genesisSupply}</dt>
                    <dd className="text-text-primary">
                      {millions(GENESIS_SUPPLY)} · {shareOf(GENESIS_SUPPLY, TOTAL_SUPPLY)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">{t.ladderSupply}</dt>
                    <dd className="text-text-primary">
                      {millions(BONDING_MAX)} · {shareOf(BONDING_MAX, TOTAL_SUPPLY)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">{t.ladderShelves}</dt>
                    <dd className="text-text-primary">
                      {fill(t.ladderShelvesValue, { count: TIER_COUNT.toLocaleString(), span: String(LADDER_SPAN) })}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">{t.openingPrice}</dt>
                    <dd className="text-text-primary">{t.openingPriceValue}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">{t.deadline}</dt>
                    <dd className="text-text-primary">
                      {fill(t.deadlineValue, { days: Number(LAUNCH_WINDOW_SECONDS / 86400n) })}
                    </dd>
                  </div>
                </dl>
                <p className="text-micro leading-relaxed text-text-quiet">
                  {fill(t.pactFootnote, {
                    share: shareOf(GENESIS_CLAIM_SUPPLY, GENESIS_SUPPLY), quote: QUOTE_SYMBOL,
                  })}
                </p>
              </Card>

              <Card
                id="COST"
                title={t.costTitle}
                subtitle={t.costSubtitle}
                interactive={false}
              >
                <dl className="flex flex-col gap-gap-tight font-mono text-note">
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">{t.costGasNow}</dt>
                    <dd className="text-text-primary">{nativeDisplay(gasNowWei)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">{t.costGasLater}</dt>
                    <dd className="text-text-secondary">
                      {nativeDisplay(gasCostWei(LAUNCH_GAS_TOTAL, feePerGas))}
                    </dd>
                  </div>
                </dl>
                <p className="text-micro leading-relaxed text-text-quiet">
                  {fill(t.costFootnote, { native: NATIVE_SYMBOL })}
                </p>
              </Card>
            </div>

            <p className="flex flex-wrap items-center gap-x-gap-tight text-note leading-relaxed text-text-quiet">
              {t.noUpgrade}
              <AddressLink value={FACTORY_ADDRESS} label={fill(t.factoryLabel, { address: truncateHex(FACTORY_ADDRESS) })} className="text-micro" />
            </p>

            <div className="flex min-w-0 flex-col gap-gap rounded-panel border border-border-subtle bg-surface-card p-card-lg shadow-panel">
              {/* Nothing to accept until every term is known: a consent line
                  with blanks in it is its own defect. */}
              <label
                className={`flex items-start gap-gap select-none ${
                  terms ? 'cursor-pointer' : 'cursor-not-allowed'
                }`}
              >
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={!terms}
                  onChange={() => setAckedTerms(ack ? null : terms)}
                  className="mt-1 h-4 w-4 accent-brand disabled:opacity-40"
                />
                <span className="text-note leading-relaxed text-text-secondary">
                  {terms ? (
                    <Emph
                      text={t.pactAccept}
                      vars={{
                        developer: truncateHex(terms.developer),
                        hardCap: hardCapLabel(terms.hardCap),
                        walletCap: quoteLabel(terms.walletCap),
                        quote: QUOTE_SYMBOL,
                        hours,
                        days: Number(LAUNCH_WINDOW_SECONDS / 86400n),
                      }}
                      className="text-warning"
                    />
                  ) : dialsFailed ? (
                    <span className="text-danger">
                      {fill(t.pactFailed, { chain: String(TARGET_CHAIN_ID) })}
                    </span>
                  ) : dialsReady ? (
                    <span className="text-text-tertiary">
                      {t.pactIncomplete}
                    </span>
                  ) : (
                    <span className="text-text-tertiary">
                      {t.pactLoading}
                    </span>
                  )}
                </span>
              </label>

              {saltError && (
                <p className="text-note text-danger">{saltError}</p>
              )}

              <ActionButton gate={gate} size="lg" />

              <p className="text-micro leading-relaxed text-text-quiet">
                {t.deployNote}
              </p>

              {isConfirmed && hash && (
                <p className="font-mono text-note text-success">
                  {t.confirmed}{' '}
                  <a
                    href={testnetExplorerTx(hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand underline decoration-dotted underline-offset-2"
                  >
                    {hash.slice(0, 10)}…{hash.slice(-6)}
                  </a>
                  {syncState === 'syncing' && ` · ${t.syncSigning}`}
                  {syncState === 'done' && ` · ${t.syncDone}`}
                  {syncState === 'error' && ` · ${t.syncError}`}
                </p>
              )}

              {/* `min-h-11` is the 44px touch floor for a standalone control. */}
              <Link
                href="/"
                className="inline-flex min-h-11 items-center self-start font-mono text-label text-text-tertiary hover:text-text-secondary"
              >
                {t.cancel}
              </Link>
            </div>
          </form>

          <aside className="lg:sticky lg:top-20 lg:self-start">
            <div className="flex flex-col gap-card">
              <LaunchPreview
                name={nameTrimmed}
                symbol={symbolTrimmed}
                description={description}
                logoUrl={logoUrl}
                windowLabel={fill(t.windowShort, { hours })}
                poolAddress={saltLive ? predictedHook : ''}
              />

              <Card
                id="DIALS"
                title={t.dialsTitle}
                subtitle={t.dialsSubtitle}
                interactive={false}
              >
                <dl className="flex flex-col gap-gap-tight font-mono text-note">
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">{t.dialOwner}</dt>
                    <dd className="text-text-primary">
                      {platformAddr ? <AddressLink value={platformAddr} /> : EM_DASH}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">{t.dialHardCapRange}</dt>
                    <dd className="text-text-primary">
                      {dialsReady ? `${capRange.min}–${capRange.max} ${QUOTE_SYMBOL}` : EM_DASH}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">{t.dialPogLimit}</dt>
                    <dd className="text-text-primary">
                      {dialsReady ? `${quoteLabel(pogLimit)} ${QUOTE_SYMBOL}` : EM_DASH}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">{t.dialNetwork}</dt>
                    <dd className="text-text-primary">{ACTIVE_CHAIN_LABEL}</dd>
                  </div>
                </dl>
              </Card>
            </div>
          </aside>
        </div>
      </div>
    </main>
  )
}
