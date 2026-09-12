'use client'

/**
 * /launch — three numbered form groups, then one signature.
 *
 *   1. Identity              picture, name, ticker, blurb, who takes the 99 % shelf cut
 *   2. Links                 optional, and off-chain: website, X, Telegram
 *   3. Genesis window        3 h / 24 h / 72 h, baked into the hook initcode
 *   -  Ground salt           unnumbered, and absent until there is one to show
 *   -  Submit                unnumbered: the pact tick, then createLaunch
 *
 * The skeleton is the v0 redesign's, down to the markup: a numbered `<legend>`
 * over each `<fieldset>`, an unnumbered submit panel under them, and a 340px
 * preview column beside the lot. Where this page departs from
 * the mock it is because the mock is a mock — fake data and stubbed writes —
 * and this page spends real ETH through a real factory.
 *
 * NO "MINE HOOK SALT" BUTTON, AND THE SALT IS NOT A NUMBERED SECTION. The mock
 * mines on its own button and lets a later Deploy submit whatever that button
 * last produced. The grind stays inside Deploy here, so there is no step left
 * for the creator to perform and nothing to number: the salt panel is a
 * readout that appears once Deploy has ground one. The reasoning is written out
 * at the panel itself, because that is where the next person will look for it.
 *
 * NO "GENESIS TARGET" FIELD. See `LaunchPreview` — the minimum raise is one
 * factory dial shared by every launch, not a per-launch input, so an editable
 * target would be a number the creator sets and the contract ignores. The
 * window is genuinely theirs to choose and stays a control; the raise it is
 * measured against is reported beside it.
 *
 * THE THREE PANELS THE MOCK HAS NO ROOM FOR — the immutable pact, the
 * two-transaction cost breakdown and the live factory dials — are all kept, and
 * they are deliberately not kept together. The pact and the cost sit in the
 * main column directly above the submit panel, because they are consent and
 * cost disclosure on a page that moves money and a reader has to pass them to
 * reach the button. The dials are reference rather than consent, so they sit in
 * the aside under the preview.
 */

import { useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
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
  ACTIVE_CHAIN_LABEL, MAINNET_CHAIN_LABEL,
  CHAIN_STATUS_BADGE, CHAIN_STAGING_NOTE, BADGE_NAMES_SETTLEMENT_CHAIN,
  testnetExplorerTx,
  // No `GENESIS_LP_SUPPLY`: the footnote states the claim share and calls the
  // remainder "the rest", because the two are halves of one split and naming
  // both invites them to disagree.
  GENESIS_SUPPLY, GENESIS_CLAIM_SUPPLY,
  BONDING_MAX, TIER_COUNT, LADDER_SPAN,
  LAUNCH_WINDOW_SECONDS,
} from '@/lib/contracts'
import type { ProjectPayload } from '../api/projects/route'
import { buildProjectAttestationMessage } from '@/lib/projectAttestation'
import { rememberProject } from '@/lib/projectCache'
import { LogoField } from '@/components/LogoField'
import { LaunchPreview } from '@/components/LaunchPreview'
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

/**
 * The three windows the hook accepts, and nothing else about them.
 *
 * `tag` and `blurb` are gone rather than left unused. Each entry carried a
 * name ("Standard") and a sentence ("One full rotation of timezones. The
 * default."), and the selected one rendered under the pills — a tag repeating
 * the hour count on the button above it, plus prose. The label IS the choice
 * here: three durations, one of them already selected, and a note on the group
 * saying the window cannot close early. There is nothing left to explain.
 */
const GENESIS_WINDOWS = [
  { seconds: GENESIS_DURATION_FAST,     label: '3 hours'  },
  { seconds: GENESIS_DURATION_STANDARD, label: '24 hours' },
  { seconds: GENESIS_DURATION_SLOW,     label: '72 hours' },
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

/*
 * `PactRule` USED TO BE HERE — a brand percentage over a mono heading over a
 * sentence, one per clause. The pact is now label-and-figure rows in the same
 * `dl` as the cost card beside it, so there is no component left to share: a
 * row is four lines of markup and inventing a name for it would only hide that
 * the two cards are deliberately identical in shape.
 *
 * The font question it answered is settled and worth keeping. v0 puts every
 * figure and identifier in mono and keeps the sans face for labels, legends
 * and prose — so the values in both cards are mono, and the only sans left in
 * them is the `Card` title and the footnote.
 */

/**
 * The shell one numbered form group sits in, and the body wrapper inside it.
 *
 * A `<fieldset>` rather than a `Card`, which is the redesign's markup and is
 * also the honest one: these four blocks are groups of controls, and a
 * `<legend>` is the only heading assistive tech announces as the group's name
 * when it reaches the fields inside. `Card` is untouched and still carries the
 * read-only panels in the aside — and the admin console, whose `/// G3`
 * eyebrows index governance groups rather than steps in a sequence.
 *
 * `min-w-0` is not cosmetic. A UA stylesheet gives every `fieldset` a
 * `min-inline-size: min-content`, so one long unbroken readout inside a
 * fieldset can widen the `minmax(0,1fr)` column past its share and shove the
 * 340px preview column off the viewport. The readouts also break rather than
 * truncate, for the same reason: `truncate` sets `white-space: nowrap`, whose
 * min-content is the whole string.
 *
 * The body is a separate wrapper because the fieldset itself has to stay a
 * block. A flex fieldset makes its legend an ordinary flex item, which drops it
 * out of the notch in the top border — the one piece of chrome that says at a
 * glance that these fields are grouped.
 */
const SECTION =
  'min-w-0 rounded-panel border border-border-subtle bg-surface-card p-card-lg shadow-panel'

const SECTION_BODY = 'flex min-w-0 flex-col gap-gap'

/**
 * The redesign's numbered disc, in the legend it belongs to.
 *
 * A 20px `rounded-input` square in `bg-brand/15`, which is the mock's `h-5 w-5`
 * accent chip at its middle radius step. It replaced a 24px bordered pill: at
 * this size a border spends most of the disc on its own outline, and a pill
 * beside square-cornered inputs read as a stray chip rather than as an index.
 *
 * The number is `aria-hidden`. It is positional decoration, and a screen
 * reader announcing "one Identity" is worse than "Identity".
 */
function StepLegend({ n, children, optional = false }: {
  n: number
  children: ReactNode
  optional?: boolean
}) {
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
          optional
        </span>
      )}
    </legend>
  )
}

/**
 * The one line of prose a section is allowed under its legend.
 *
 * DOWN TO A SINGLE CALLER, and that is the test it now has to pass. Three
 * sections used to carry one: `Identity`'s restated the four labels beneath it
 * and went; the hook-salt section's went with the section itself. What is left
 * is `Genesis window`, where the note says the one thing none of its controls
 * can — that the window is immutable once set — which is exactly the bar for
 * adding another.
 *
 * Quieter than body prose (`text-text-tertiary`, as `Card` subtitles are) so it
 * reads as a caption on the group rather than as the first field in it.
 */
function SectionNote({ children }: { children: ReactNode }) {
  return <p className="text-note leading-relaxed text-text-tertiary">{children}</p>
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

  /**
   * Drop a mined salt and everything derived from it.
   *
   * THREE SITES CLEARED THIS AND TWO OF THEM FORGOT `saltCaps`. A salt is only
   * valid for the account, the window and the factory dials it was ground
   * against, so changing any of those invalidates it — but `pickWindow` and the
   * Project admin field cleared `salt` and `predictedHook` and left `saltCaps`
   * pointing at dials nothing was measured against any more. The watcher below
   * then fired on the next dial change and reported "the next deploy will grind
   * a fresh salt" about a salt that had stopped existing several edits earlier.
   * Harmless, and still an error line about state that was not there.
   *
   * Unconditional rather than guarded on `salt`, so it also clears the orphaned
   * `saltCaps` left behind by the bug it fixes.
   *
   * The two effects below clear all three inline instead of calling this: a
   * reference to it in an effect body pulls the function into the dependency
   * array, and it is re-created every render.
   */
  const clearMinedSalt = () => {
    setSalt('')
    setPredictedHook('')
    setSaltCaps(null)
  }

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
    // The duration is baked into the hook initcode, so it is one of the three
    // things a salt is ground against.
    clearMinedSalt()
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
      <div className="mx-auto max-w-7xl px-4 py-page sm:px-6">
        {/* The redesign's header: one flat mono headline over a lede, on a
            hairline. `PageHeader` is untouched and still carries the other
            routes — it splits a title into "Launch an" + a brand-coloured
            "agent", and the mock's headline here is one colour and one word
            joined to the next. Two ways to draw a page title would have been
            worse than not using the component on the one page that wants the
            other way.

            The chain row above it is NOT the mock's, and it stays: the badge is
            the page's only disclosure that this build is provisional, and the
            eyebrow beside it only appears on the arm where the badge names the
            active chain instead of the settlement one. See
            `BADGE_NAMES_SETTLEMENT_CHAIN` and `CHAIN_STAGING_NOTE` in
            lib/chain.ts, and `scripts/checkChainCopy.mjs` for why the three
            never name the same chain twice. */}
        <div className="flex flex-col gap-gap-tight border-b border-border-subtle pb-section">
          <div className="flex flex-wrap items-center gap-gap-tight">
            {!BADGE_NAMES_SETTLEMENT_CHAIN && (
              <span className="font-mono text-label text-text-tertiary">
                Settles on {MAINNET_CHAIN_LABEL}
              </span>
            )}
            <Badge tone="ok" pip>{CHAIN_STATUS_BADGE}</Badge>
          </div>

          <h1 className="font-mono text-section text-text-primary sm:text-hero">
            Launch an agent
          </h1>

          <p className="max-w-xl text-readout leading-relaxed text-text-secondary">
            {CHAIN_STAGING_NOTE ? `${CHAIN_STAGING_NOTE} ` : ''}
            One signature deploys your token with its own Uniswap V4 pool and opens a
            gas-gated funding round that cannot close early.
          </p>
        </div>

        {/* `minmax(0,1fr)` rather than the mock's bare `1fr`: a grid track
            defaults to `min-width: auto`, so a 66-character salt or a 42-hex
            address in the form column can grow the track past its share and
            push the 340px preview off screen. The mock never renders a value
            long enough to find that out. */}
        <div className="mt-section grid gap-section lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* `onSubmit` swallows the event rather than deploying. The mock's
              submit button IS the form's submit, which on this page would mean
              the Enter key can spend ETH — and the deploy path is gated through
              `useActionGate`, which is a deliberate click on a button that has
              already said what it is about to cost. The fieldsets are still a
              real form: grouping, legends and tab order all come from that. */}
          <form
            className="flex min-w-0 flex-col gap-gap"
            onSubmit={e => { e.preventDefault() }}
          >
            <fieldset className={SECTION}>
              <StepLegend n={1}>Identity</StepLegend>
              <div className={SECTION_BODY}>
                {/* NO SECTION NOTE. It read "What the directory and the ticker
                    tape will call this," which is a sentence spent restating
                    the four labels directly beneath it. The notes on sections 3
                    and 4 survive because they say something the controls cannot
                    — that the window is immutable, and that the salt is ground
                    locally — and this one did not. */}
                {/* The picture leads, as it does in the redesign, because it is
                    the only field here whose result the creator cannot predict
                    from what they typed — and because it is the one that has to
                    finish a round trip before Deploy unlocks. */}
                <LogoField
                  value={logoUrl}
                  onValueChange={setLogoUrl}
                  onBusyChange={setLogoUploading}
                  name={name || symbol}
                />

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

                {/* Promoted out of the collapsed details block it used to share
                    with the links, and relabelled from "Manifesto" to the name
                    the payload, the database column and the preview beside it
                    all already used. It is the one optional field with a live
                    consequence on screen, so hiding it behind a disclosure was
                    the reason the preview looked empty for most creators. */}
                {/* No `hint`. It said "Shown on your directory card and
                    project page", which the preview beside this form
                    demonstrates live and captions in its own words. */}
                <Field
                  label="Description"
                  multiline
                  rows={3}
                  value={description}
                  onValueChange={setDescription}
                  placeholder="What does this agent do on-chain?"
                />

                {/* Not in the mock at all, and it cannot be dropped to match:
                    `projectAdmin` is an argument to `createLaunch` and it is
                    the address that collects 99 % of the shelf ladder. A page
                    that hides it is a page that spends the creator's revenue
                    stream on a default they never saw. */}
                <Field
                  label="Project admin"
                  hint="Receives 99% of shelf ladder earnings. Defaults to your wallet."
                  value={projectAdmin}
                  onValueChange={v => {
                    setProjectAdmin(v)
                    clearMinedSalt()
                  }}
                  placeholder="0x…"
                  error={projectAdmin && !isAddress(projectAdmin) ? 'NOT A VALID ADDRESS' : null}
                />
                {isAddress(projectAdmin) && address && projectAdmin.toLowerCase() !== address.toLowerCase() && (
                  <p className="text-note text-warning">
                    Custom admin — this address, not yours, receives the 99% shelf cut.
                  </p>
                )}
              </div>
            </fieldset>

            {/* A group of its own rather than three fields inside a
                disclosure. They are off-chain presentation and genuinely
                skippable, which the pill says — but a creator who does want
                them should not have to discover a `+` to find out they exist. */}
            <fieldset className={SECTION}>
              <StepLegend n={2} optional>Links</StepLegend>
              <div className={SECTION_BODY}>
                <Field
                  label="Website"
                  value={website}
                  onValueChange={setWebsite}
                  placeholder="https://your-agent.xyz"
                />
                <div className="grid grid-cols-1 gap-gap sm:grid-cols-2">
                  <Field
                    label="Twitter / X"
                    value={twitter}
                    onValueChange={setTwitter}
                    placeholder="@handle"
                  />
                  <Field
                    label="Telegram"
                    value={telegram}
                    onValueChange={setTelegram}
                    placeholder="t.me/group"
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className={SECTION}>
              <StepLegend n={3}>Genesis window</StepLegend>
              <div className={SECTION_BODY}>
                <SectionNote>
                  Immutable. The window runs to completion even if the soft cap fills in minutes.
                </SectionNote>

                {/* Three compact pills on one row, which is the redesign's
                    treatment, instead of three card-sized buttons each carrying
                    a paragraph. The paragraphs were the reason this section was
                    taller than the rest of the form put together.

                    The `sm:flex-row` wrapper that used to hold this column and
                    the minimum-raise readout side by side is gone with the
                    readout — a flex row with one child is a row about nothing. */}
                <div className="flex flex-col gap-gap-tight">
                  <span className="font-mono text-label text-text-tertiary">Duration</span>
                  <div
                    role="radiogroup"
                    aria-label="Genesis window"
                    className="flex flex-wrap gap-gap-tight"
                  >
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
                            'min-h-11 rounded-input border px-card font-mono text-readout transition-colors ' +
                            (selected
                              ? 'border-border-accent bg-brand/10 text-brand shadow-armed'
                              : 'border-border-subtle bg-surface-elevated text-text-tertiary hover:border-border-strong hover:bg-surface-hover hover:text-text-secondary')
                          }
                        >
                          {w.label}
                        </button>
                      )
                    })}
                  </div>

                  {/* THE MINIMUM RAISE READOUT IS GONE FROM HERE. It was a
                      `Minimum raise / 0.01 ETH / Set on the factory, not per
                      launch` block on the right of this row — the fourth place
                      on one screen showing one number. The other three are the
                      preview panel's MINIMUM RAISE, the factory dials in the
                      aside (as `Soft cap`, which is why that label is now the
                      same words as these were), and the consent line the
                      creator actually ticks.

                      Two of those four earn their place: the preview because it
                      is a mock-up of the listing, and the consent because it is
                      the copy being agreed to. This one was neither, and it was
                      the worst of the four — sitting beside the duration pills
                      it read as a property of the window the creator was
                      choosing, when it is a factory dial that the choice above
                      it does not affect at all.

                      TODO(v0-audit §B1) went with it: the mock puts an editable
                      "Genesis target" here, and the note explaining why ours is
                      a readout was itself most of the clutter. It stays out
                      because `defaultSoftCap` is not the creator's to type, and
                      an input the contract ignores is worse than no input. */}
                </div>

                {/* NO PER-WINDOW BLURB. The selected one rendered under this
                    row as `Standard — One full rotation of timezones. The
                    default.`, and on the default selection — which is what
                    almost everyone sees — that is a tag restating the "24
                    hours" on the pill above it followed by a sentence saying
                    nothing a creator can act on. The 3h and 72h blurbs did
                    carry some guidance, but not enough to keep a line on the
                    page for the two-thirds of visitors who never read it, and
                    the section note above already states the one thing that is
                    actually binding: the window cannot close early. */}
              </div>
            </fieldset>

            {/* ── 4 · HOOK SALT ──────────────────────────────────────────────
                THE MOCK HAS A "MINE HOOK SALT" BUTTON HERE. THIS IS THE SAME
                SECTION RENDERED AS A READOUT, AND THE GRIND STAYS IN DEPLOY.

                A salt is only valid for the account, the genesis window and the
                factory dials it was mined against. A button that mines and then
                waits for a second click puts a gap between those two moments,
                and anything moving inside that gap — the owner retuning
                `defaultSoftCap` or `maxPogAllocationLimit`, the creator
                switching wallets or picking a different window — leaves a salt
                that reads as locked and is not. The factory catches it and
                reverts with `InvalidHookSalt`.

                What that revert costs is worth stating exactly: the whole
                transaction unwinds, so the launch fee comes back with it and
                only the gas is gone. It is a wasted transaction and a wasted
                wallet prompt, not a lost fee. Mining on the same click that
                sends the transaction is the one ordering with no gap in it, so
                that is where `mineSalt` is called from — see `handleLaunch`.

                So this readout is usually empty before the first Deploy, which
                is exactly the mock's `no salt mined` state. It fills in when a
                deploy ground a salt and then stopped short of a confirmed
                transaction — the pre-flight decoded a revert, the fee moved,
                the wallet prompt was declined — and that held salt is what the
                next Deploy reuses after re-reading the caps. `predictedHook` is
                the address `mineSalt` already derived from that same salt; it
                is read here, never recomputed. */}
            {/* NO LONGER A NUMBERED SECTION, and this is the page's biggest
                cut. It was `4 · Uniswap V4 hook salt`: a fieldset the same
                size as the three real form groups, carrying a three-line note
                about CREATE2 and a well reading "no salt mined / Nothing to do
                here."

                That is what it said on every first visit — which is every
                visit that matters. A numbered step in a four-step form that
                asks for nothing and reports nothing is worse than no step: it
                implies there is something to do, and the reader has to read it
                to find out there is not. The salt is machinery, and the reason
                it was ever on screen is that it USED to be a "Mine hook salt"
                button the creator had to press.

                What survives is the recovery state. A held salt only exists
                when a Deploy ground one and then stopped short of a confirmed
                transaction — pre-flight decoded a revert, the fee moved, the
                wallet prompt was declined — and that salt is what the next
                Deploy reuses after re-reading the caps. When it exists it is
                worth showing, because it is also the first time the creator
                can see their pool address. When it does not, there is nothing
                to say.

                The one thing a reader did need from the old note — that Deploy
                grinds the salt in-browser, so the button works for a few
                seconds before the wallet opens — moved next to the button, in
                the submit block, where it explains the pause as it happens
                rather than three sections earlier. */}
            {salt && (
              <div className="flex min-w-0 flex-col gap-gap-tight rounded-panel border border-border-subtle bg-surface-card p-card-lg shadow-panel">
                <div className="flex flex-wrap items-center justify-between gap-gap-tight">
                  <p className="font-mono text-label text-text-tertiary">Ground salt</p>
                  <Badge tone="ok" size="sm" pip>salt held</Badge>
                </div>
                <p className="break-all font-mono text-note text-text-primary">{salt}</p>

                {predictedHook && (
                  <>
                    <p className="mt-gap-tight font-mono text-label text-text-quiet">
                      Your pool address
                    </p>
                    <p className="break-all font-mono text-note text-brand">{predictedHook}</p>
                  </>
                )}
              </div>
            )}

            {/* ── TERMS AND COST, TWO ACROSS ─────────────────────────────────
                These two and the factory dials were all stacked in the 340px
                aside, which is what made that column twice a laptop viewport
                and forced a nested scrollbar. Neither of them is 340px-shaped:
                the pact is four short rules and the costs are four rows of
                label-and-number, so in a narrow column each becomes a tall
                stack and side by side they cost one row.

                THEY BELONG HERE, NEXT TO THE TICK. The consent checkbox is in
                the submit block directly below, and the terms it refers to
                used to be in a different column — a reader ticked "I accept"
                beside a button while the thing being accepted was off to the
                right. Rules, then cost, then the tick, then the button, in
                reading order.

                THE DIALS WENT TO THE ASIDE instead, and they are the one of
                the three that should never have been here: they are not terms.
                The pact is what cannot change and the costs are what is owed,
                both of which the tick covers; the dials are what the factory
                happens to be set to today, which is the opposite of immutable.
                They are reference values you check WHILE filling the form, so
                they belong in the column that follows you down it. */}
            <div className="grid min-w-0 gap-card lg:grid-cols-2">
              {/* ── THE PACT, AS ROWS ──────────────────────────────────────
                  This was four stacked blocks, each a brand percentage over a
                  mono heading over a sentence: about 300px of card beside a
                  110px table, which is where the empty half of the cost card
                  came from. The two sit side by side and are the same KIND of
                  thing — a short list of label-and-figure — so they now have
                  the same shape, and the row that used to be a paragraph is a
                  paragraph no more.

                  The prose did not move to the footnote wholesale; most of it
                  was restatement and is gone. What survives there is the two
                  facts a figure cannot carry: where the 1.10× comes from, and
                  that the refund is total. `Opening price` replaced "Genesis
                  premium / 10%" because 1.10× is the number a creator can act
                  on and "10% premium" is the same fact stated as a derivative
                  of it.

                  NO SUBTITLE either. It read "Unalterable the moment your
                  launch confirms", which is the word "Immutable" in the title
                  with a timestamp attached. The cost card keeps its subtitle
                  because "only the first is due now" is a fact its four rows
                  genuinely do not state. */}
              <Card id="PACT" title="Immutable rules" interactive={false}>
                <dl className="flex flex-col gap-gap-tight font-mono text-note">
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Genesis supply</dt>
                    <dd className="text-text-primary">
                      {millions(GENESIS_SUPPLY)} · {shareOf(GENESIS_SUPPLY, TOTAL_SUPPLY)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Ladder supply</dt>
                    <dd className="text-text-primary">
                      {millions(BONDING_MAX)} · {shareOf(BONDING_MAX, TOTAL_SUPPLY)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Ladder shelves</dt>
                    <dd className="text-text-primary">
                      {TIER_COUNT.toLocaleString()} · {LADDER_SPAN}× span
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Opening price</dt>
                    <dd className="text-text-primary">1.10× genesis</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Refund window</dt>
                    <dd className="text-text-primary">
                      {Number(LAUNCH_WINDOW_SECONDS / 86400n)} days
                    </dd>
                  </div>
                </dl>
                <p className="text-micro leading-relaxed text-text-quiet">
                  Fixed at deploy, and unsold supply is never re-mintable. Genesis
                  splits {shareOf(GENESIS_CLAIM_SUPPLY, GENESIS_SUPPLY)} to depositor
                  claims and the rest to pool liquidity, which is what opens the market
                  above what they paid. Miss the refund window and every depositor takes
                  back 100% of their ETH.
                </p>
              </Card>

              <Card
                id="COST"
                title="What this costs you"
                subtitle="Two transactions, and only the first is due now."
                interactive={false}
              >
                {/* SHORTER LABELS, and one of them was also wrong. Both gas
                    rows were prefixed `└`, which claimed they were components
                    of `Due now` — the create gas is, the pool gas is not: it is
                    a separate transaction sent later. Only the real child keeps
                    the branch, and "gas, open pool later" became a sibling row
                    that says so. The old labels were long enough to wrap their
                    own values onto a second line in a third of this column. */}
                <dl className="flex flex-col gap-gap-tight font-mono text-note">
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Due now</dt>
                    <dd className="text-text-primary">{ethDisplay(dueNowWei)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">
                      <span className="text-text-quiet">└</span> gas
                    </dt>
                    <dd className="text-text-secondary">{ethDisplay(createGasWei)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Open pool later</dt>
                    <dd className="text-text-secondary">
                      {ethDisplay(gasCostWei(LAUNCH_GAS_TOTAL, feePerGas))}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Total to open</dt>
                    <dd className="text-text-primary">{ethDisplay(dueTotalWei)}</dd>
                  </div>
                </dl>
                <p className="text-micro leading-relaxed text-text-quiet">
                  Estimated at the current gas rate, which moves before you sign.
                  Opening the pool is a second transaction only you can send.
                </p>
              </Card>
            </div>

            {/* One line under both cards. It qualifies each of them rather
                than either one, and as the tail of the pact card it read as a
                fifth rule.

                THE FACTORY ADDRESS IS TRUNCATED NOW. It was interpolated raw,
                so 42 characters of hex in `text-micro` mono wrapped onto a
                second line and ended this page on a hex fragment. `AddressLink`
                is what every other address on the site uses: short form, the
                full value in `title`, an explorer link and a copy button — so
                the thing a reader actually wants to do with a contract address
                takes one click instead of a careful drag-select. */}
            <p className="flex flex-wrap items-center gap-x-gap-tight text-note leading-relaxed text-text-quiet">
              No proxy, no admin key, no upgrade. Only this project&apos;s own contract
              can ever mint the token, and nobody holds an admin role over it.
              <AddressLink value={FACTORY_ADDRESS} label={`Factory ${truncateHex(FACTORY_ADDRESS)}`} className="text-micro" />
            </p>

            {/* The submit block: the mock's fifth panel, and like the mock's it
                is neither numbered nor a fieldset. Sections 1–4 are things to
                fill in; this is the one place a decision gets signed, and
                numbering it "5" would have put the irreversible step in the
                same visual sequence as picking a ticker. */}
            <div className="flex min-w-0 flex-col gap-gap rounded-panel border border-border-subtle bg-surface-card p-card-lg shadow-panel">
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

              {/* The one sentence worth keeping from the deleted salt section,
                  moved to the only place it does any work. Deploy grinds a
                  CREATE2 salt in the browser before it opens the wallet, so the
                  button sits busy for a few seconds with nothing else to show
                  for it; said here, it explains a pause the reader is watching,
                  rather than pre-explaining one three sections above it. */}
              <p className="text-micro leading-relaxed text-text-quiet">
                Deploy grinds your pool address in-browser before the wallet
                opens, so expect a few seconds before the prompt.
              </p>

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
            </div>
          </form>

          {/* `lg:sticky lg:top-20 lg:self-start` is the mock's aside, on the
              mock's 340px track. `self-start` is what makes sticky mean
              anything here: a grid item stretches to the row height by default,
              and a full-height item has nothing left to stick against.

              THE HEIGHT CAP AND THE NESTED SCROLLBAR ARE GONE, and so is what
              forced them. This column used to carry the immutable pact, the
              live factory dials and the cost breakdown as well, which made it
              about twice a laptop viewport — so pinning it put the refund
              clause and the cost of the two transactions permanently out of
              reach, and `max-h` plus `overflow-y-auto` was the least-bad
              answer to that. Moving those three into the main column removed
              the problem instead of managing it: one short preview panel is
              exactly what an aside can stick with, which is why the mock's
              sticks without either crutch. */}
          <aside className="lg:sticky lg:top-20 lg:self-start">
            <div className="flex flex-col gap-card">
              <LaunchPreview
                name={nameTrimmed}
                symbol={symbolTrimmed}
                description={description}
                logoUrl={logoUrl}
                windowLabel={`${activeWindow.seconds / 3600n}h`}
                minimumRaise={dialsReady ? `${softCapDisplay} ETH` : EM_DASH}
                poolAddress={predictedHook}
              />

              {/* The dials follow the preview here rather than sitting in the
                  main column with the pact and the costs. They are the numbers
                  a creator checks against what they are typing — the fee they
                  will owe, the cap their raise is measured against — so the
                  column that stays on screen while they type is where they do
                  their work. Two short panels is also what an aside can stick
                  with: this pair is well under a viewport, which is what the
                  three-panel version was not. */}
              <Card
                id="DIALS"
                title="Live factory dials"
                subtitle="Read from the factory now — these move between launches."
                interactive={false}
              >
                <dl className="flex flex-col gap-gap-tight font-mono text-note">
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Launch fee</dt>
                    <dd className="text-text-primary">
                      {dialsReady ? `${feeDisplay} ETH` : EM_DASH}
                    </dd>
                  </div>
                  {/* `Minimum raise`, not `Soft cap`. It is the same
                      `defaultSoftCap` the preview and the consent line both
                      publish, and it was the only place on the page calling it
                      by the contract's name — so one number wore two labels in
                      two panels a scroll apart, which reads as two dials. The
                      creator-facing words win; `softCapWei` keeps the
                      contract's name in the code, where the ambiguity costs
                      nothing. */}
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Minimum raise</dt>
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
              </Card>
            </div>
          </aside>
        </div>
      </div>
    </main>
  )
}
