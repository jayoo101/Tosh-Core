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
 * and this page spends the real settlement coin through a real factory.
 *
 * NO "MINE HOOK SALT" BUTTON, AND THE SALT IS NOT A NUMBERED SECTION. The mock
 * mines on its own button and lets a later Deploy submit whatever that button
 * last produced. Salt selection stays inside Deploy here, so there is no step left
 * for the creator to perform and nothing to number: the salt panel is a
 * readout that appears once Deploy has picked one. The reasoning is written out
 * at the panel itself, because that is where the next person will look for it.
 *
 * NOTHING IS MINED ANY MORE, on this page or in Solidity. Uniswap V4 encoded a
 * hook's permissions in its address, so a launch had to search for a salt whose
 * CREATE2 address carried the right bits; PancakeSwap Infinity asks the hook for
 * its own bitmap. A salt is now picked at random and checked for occupancy, and
 * the guard that a failed search used to provide by accident — refusing a launch
 * whose factory dials moved mid-flight — is an explicit `CapsChanged` check.
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
  useAccount, useBalance, useSwitchChain,
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
  // No `GENESIS_LP_SUPPLY`: the footnote states the claim share and calls the
  // remainder "the rest", because the two are halves of one split and naming
  // both invites them to disagree.
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
    // The dial guard, and it replaced `InvalidHookSalt` rather than joining it.
    // Under Uniswap V4 a rotated cap re-rolled the CREATE2 address, which then
    // failed the permission mask about 31 times in 32 — the salt error was the
    // symptom and the cap change was the cause. PancakeSwap Infinity reads
    // permissions from the hook itself, so the address no longer objects and the
    // factory has to; `expectedSoftCap` / `expectedWalletCap` are what it checks.
    case 'CapsChanged':
      return 'The factory dials moved while you were reading. Deploy again to quote the new ones.'
    case 'InsufficientLaunchFee':
      return 'The value sent does not cover the launch fee.'
    case 'InvalidAdmin':
      return 'The Phase-2 admin cannot be the zero address.'
    case 'DeployFailed':
      return 'The hook clone failed to deploy. Deploy again for a fresh salt.'
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
  const chainId = useWalletChainId()
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
  const [isDerivingSalt, setIsDerivingSalt] = useState(false)
  const [saltError, setSaltError] = useState('')
  const [saltCaps, setSaltCaps] = useState<{ soft: bigint; wallet: bigint } | null>(null)

  /**
   * Drop a held salt and everything derived from it.
   *
   * THREE SITES CLEARED THIS AND TWO OF THEM FORGOT `saltCaps`. A salt is only
   * valid for the account, the window and the factory dials it was derived
   * against, so changing any of those invalidates it — but `pickWindow` and the
   * Project admin field cleared `salt` and `predictedHook` and left `saltCaps`
   * pointing at dials nothing was measured against any more. The watcher below
   * then fired on the next dial change and reported "the next deploy will use
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
  const clearSalt = () => {
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
    // A salt is only valid for the account it was derived against.
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

  // ⚠ THE BEM BALANCE READ WAS DELETED HERE. It existed because the fee was
  //   pulled in BEM and the creator had to be shown whether they held enough
  //   of a second asset. The fee is native BNB, so `useBalance` above already
  //   answers the only funding question this page has, and a creator with no
  //   BEM at all can deploy — they need it to DEPOSIT into their own round,
  //   which is a different page and a later decision.

  // A zero launch fee is legal, so an unread dial must never collapse into 0n:
  // that reading is both a lie in the pact the depositor ticks and the wrong
  // bound to quote the factory. Treat the three dials as one all-or-nothing quote.
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
  // 18 decimals, not `QUOTE_DECIMALS`: the fee is native BNB and every cap
  // around it is still 8-decimal BEM. Reading this dial with the quote scale
  // renders 0.005 BNB as 50000000000, which is a plausible enough figure to
  // ship.
  const feeDisplay = useMemo(
    () => (dialsReady ? formatEstimateEth(launchFeeWei) : EM_DASH),
    [dialsReady, launchFeeWei],
  )
  // No `softCapDisplay`. `softCapWei` is still read and still passed to
  // `createLaunch` — it is an immutable arg of the hook clone and therefore an
  // input to the CREATE2 address — but nothing on this page renders it.

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
  // `PROJECT_GAS_TOTAL` (create + launch) no longer has a row. The panel used
  // to end on "Gas, both together", which summed two transactions the creator
  // signs days apart; with `Due now` restored as the headline that row was the
  // second total on a four-row list, and the less actionable one.
  /*
   * ONE CURRENCY AGAIN, SO THESE ADD UP AGAIN.
   *
   * The history is worth keeping, because the bug it records would return the
   * moment anyone re-denominates the fee. This read `launchFeeWei +
   * createGasWei` while the fee was native, which was right. The BEM migration
   * made the fee 8-decimal base units against 18-decimal gas wei, and the sum
   * silently became arithmetic on unlike units: ten orders of magnitude too
   * large, shown as the headline cost, and — worse — fed to the sufficiency
   * gate, where a BEM-plus-BNB figure compared against a BNB balance declared
   * every wallet underfunded. It was split into two lines to fix that.
   *
   * The fee is native BNB once more, so the split has nothing left to separate
   * and the sum is honest. ⚠ IF THE FEE EVER LEAVES THE NATIVE COIN AGAIN THIS
   * LINE IS THE FIRST THING THAT BREAKS, and it will break quietly, in the
   * direction of blocking every creator rather than of letting one through.
   */
  const gasNowWei = createGasWei
  const dueNowWei = dialsReady && gasNowWei !== null ? launchFeeWei + gasNowWei : null

  /** Native coin, 18 decimals — gas only. */
  const nativeDisplay = (wei: bigint | null) =>
    wei === null ? EM_DASH : `${formatEstimateEth(wei)} ${NATIVE_SYMBOL}`

  // `quoteDisplay` was deleted with the last BEM figure this page showed. It
  // formatted 8-decimal quote amounts, and the launch fee — its only remaining
  // caller once the caps came off the panel — is native BNB now.

  const adminAddr = isAddress(projectAdmin) ? projectAdmin as Address : undefined

  // Returns the caps alongside the salt because `createLaunch` now has to quote
  // them back, and `setSaltCaps` cannot be read on the same tick it is written.
  // Handing them to the caller keeps the pair that produced the prediction and the
  // pair sent to the factory literally the same values, rather than two reads that
  // are usually equal.
  const deriveSalt = useCallback(async (): Promise<
    { rawSalt: `0x${string}`; hookAddress: `0x${string}`; soft: bigint; wallet: bigint } | null
  > => {
    if (!address || !publicClient || !adminAddr) return null
    setSaltError('')
    setIsDerivingSalt(true)
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
      // initialisation, so it no longer moves the predicted address.
      const initcodeHash = await publicClient.readContract({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'hookInitcodeHash',
        args: [address, address, liveSoftCap, liveWalletCap, genesisDuration],
      }) as `0x${string}`
      // Picked, not ground. `pickHookSalt` returns 32 random bytes and the
      // address they land on; the occupancy check that used to be implicit in the
      // mask search is now explicit, because a salt's only remaining job is to be
      // unused. See the note at the top of `lib/hookAddress`.
      //
      // The loop is a formality — a random 32-byte salt colliding needs a
      // deliberate effort — but a bounded retry is cheaper than shipping a path
      // where CREATE2 silently returns address(0) and the factory reports
      // `DeployFailed` with nothing to act on.
      let rawSalt: `0x${string}` | null = null
      let hookAddress: `0x${string}` | null = null
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = pickHookSalt(
          FACTORY_ADDRESS as `0x${string}`, address as `0x${string}`, initcodeHash,
        )
        const occupant = await publicClient.getBytecode({ address: candidate.hookAddress })
        if (!occupant || occupant === '0x') {
          rawSalt = candidate.rawSalt
          hookAddress = candidate.hookAddress
          break
        }
      }
      if (rawSalt === null || hookAddress === null) {
        throw new Error('Could not find an unused hook address in 8 attempts — please retry.')
      }
      setSalt(rawSalt)
      setPredictedHook(hookAddress)
      setSaltCaps({ soft: liveSoftCap, wallet: liveWalletCap })
      return { rawSalt, hookAddress, soft: liveSoftCap, wallet: liveWalletCap }
    } catch (e: unknown) {
      setSaltError(shortErrorMessage(e))
      return null
    } finally {
      setIsDerivingSalt(false)
    }
  }, [address, publicClient, adminAddr, genesisDuration])

  useEffect(() => {
    if (!saltCaps) return
    if (!dialsReady) return
    if (saltCaps.soft === softCapWei && saltCaps.wallet === perWalletCapWei) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSalt(''); setPredictedHook(''); setSaltCaps(null)
    setSaltError('Factory soft cap / wallet cap changed — the next deploy will use a fresh salt.')
  }, [saltCaps, dialsReady, softCapWei, perWalletCapWei])

  const nameTrimmed = name.trim()
  const symbolTrimmed = symbol.trim().toUpperCase()
  const identityComplete = Boolean(nameTrimmed) && Boolean(symbolTrimmed) && Boolean(address) && Boolean(adminAddr)
  const ethBalance = ethBal?.value ?? 0n

  /*
   * TWO GATES BECAME ONE AGAIN, and the merged one is stricter than either.
   *
   * While the fee was BEM these had to be separate comparisons against separate
   * balances, and a creator could be short of one asset while holding plenty of
   * the other. Both are BNB now, so the honest question is whether the wallet
   * covers the fee AND the gas to spend it — the original argument for putting
   * gas in the gate at all, which the split could only approximate by asking it
   * twice.
   *
   * ⚠ THIS NO LONGER LETS THROUGH A WALLET HOLDING EXACTLY THE FEE. That wallet
   *   passed both old gates and then failed in the mempool.
   *
   * Still falls open when its input is unavailable: a lapsed gate beats one
   * that blocks a funded wallet on a quiet fee oracle.
   */
  const insufficientFunds =
    walletEnabled && dueNowWei !== null && ethBalance < dueNowWei

  /*
   * ⚠ THE ALLOWANCE GATE IS GONE, AND SO IS THE APPROVE TRANSACTION.
   *
   * `createLaunch` took the fee with `transferFrom` and reverted from inside
   * the factory without an allowance, so the button had to be gated on one and
   * a creator signed twice to deploy. The fee is `msg.value` again: nothing is
   * pulled, nothing needs approving, and deploying is one signature.
   *
   * `useQuoteApproval` is still imported and used elsewhere on this page for
   * nothing — check before re-adding a step here.
   */

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
    setSaltError('')

    pendingRef.current = {
      name: nameTrimmed, symbol: symbolTrimmed,
      logoUrl, website, twitter, telegram, description,
      predictedHook: predictedHook || undefined,
    }

    // The caps the salt was derived against, and the ones `createLaunch` will be
    // asked to confirm. They travel together from here on: a salt and a cap pair
    // that disagree is exactly what `CapsChanged` exists to refuse.
    let saltToUse = salt as `0x${string}` | ''
    let capsToSend = saltCaps
    if (!saltToUse) {
      const picked = await deriveSalt()
      if (!picked) return
      saltToUse = picked.rawSalt
      capsToSend = { soft: picked.soft, wallet: picked.wallet }
      if (pendingRef.current) pendingRef.current.predictedHook = picked.hookAddress
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
          const picked = await deriveSalt()
          if (!picked) return
          saltToUse = picked.rawSalt
          capsToSend = { soft: picked.soft, wallet: picked.wallet }
          if (pendingRef.current) pendingRef.current.predictedHook = picked.hookAddress
        }
      } catch { /* the factory's own CapsChanged is the backstop */ }
    }
    // Held salt, and the caps it was derived against were never recorded — a
    // session that predates this code, or state that survived a reload. Deriving a
    // fresh salt is cheaper than guessing: the factory would refuse a mismatched
    // pair anyway, and re-reading the dials here would only make the mismatch
    // harder to see.
    if (!capsToSend) {
      const picked = await deriveSalt()
      if (!picked) return
      saltToUse = picked.rawSalt
      capsToSend = { soft: picked.soft, wallet: picked.wallet }
      if (pendingRef.current) pendingRef.current.predictedHook = picked.hookAddress
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
    // the one moment it decides whether the wallet is spent from.
    let feeToSend = launchFeeWei
    if (publicClient) {
      try {
        const liveFee = await publicClient.readContract({
          address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launchFee',
        }) as bigint
        if (liveFee !== launchFeeWei) {
          setAckedTerms(null)
          setSaltError(
            // The fee is native BNB at 18 decimals, not the quote asset at 8.
            // Read in BEM this sentence was out by ten orders of magnitude and
            // named the wrong coin, so a creator comparing it against the cost
            // card beside it saw two different fees for the same launch.
            `Launch fee is now ${nativeDisplay(liveFee)}, not `
            + `${nativeDisplay(launchFeeWei)}. Review the terms and tick the pact again.`,
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
            saltToUse as `0x${string}`, feeToSend,
              capsToSend.soft, capsToSend.wallet, genesisDuration,
            ],
            // ⚠ THE `value` IS NOT OPTIONAL HERE, and leaving it off does not
            //   make this a read-only check — it makes it a check of a
            //   DIFFERENT transaction than the one the wallet will send.
            //
            //   `createLaunch` is payable and funds itself from `msg.value`.
            //   This simulation ran without one for as long as the fee was a
            //   BEM `transferFrom`, where there was genuinely nothing to send;
            //   when the fee became native BNB the write in
            //   `useTosh.createLaunch` grew a `value` and this call did not.
            //   The factory then saw `msg.value == 0`, reverted with
            //   `InsufficientLaunchFee`, and `launchRevertMessage` turned that
            //   into "The value sent does not cover the launch fee." — shown to
            //   a creator whose wallet had never been asked for anything. No
            //   launch could be deployed through this page at all.
            //
            //   It must stay the same figure `createLaunch` is handed below.
            value: feeToSend,
            account: address,
        })
      } catch (e: unknown) {
        const reason = launchRevertMessage(e)
        if (reason !== null) {
          setSaltError(reason)
          return
        }
      }
    }

    reset(); setSyncState('idle')
    try {
      await createLaunch(
        nameTrimmed, symbolTrimmed, address, adminAddr,
        saltToUse as `0x${string}`, feeToSend,
        capsToSend.soft, capsToSend.wallet, genesisDuration,
      )
    } catch { /* wagmi + toast */ }
  }, [
    address, adminAddr, chainId, switchChainAsync, nameTrimmed, symbolTrimmed,
    logoUrl, website, twitter, telegram, description, salt, deriveSalt,
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

      // Logs plus the CREATE2 prediction are enough to name the destination;
      // `launches(count-1)` below only backfills the token address when the
      // receipt's logs could not be parsed.
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
      // The `launches(count-1)` backfill runs BEFORE the redirect now, for the
      // same reason the publish below does: after `router.push` this component
      // is unmounted and whatever it had left to do does not happen.
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

      // AWAITED, AND THE REDIRECT WAITS ON IT. This used to be
      // `void publish().catch(...)` fired immediately after `router.push`, on
      // the reasoning that declining costs the listing and not the launch. That
      // reasoning holds; the ordering did not. `router.push` unmounts this
      // component, which took the wallet prompt and the POST down with it — so
      // the common case was not "the creator declined" but "the creator was
      // never asked", and every launch published from this page lost its logo,
      // its links and its description to a chain-only fallback row. The failure
      // was silent twice over: `setSyncState('error')` writes to a page nobody
      // is looking at any more.
      //
      // So the signature prompt now happens while the creator is still on the
      // page that explains why it is being asked for, and the redirect is the
      // last thing that happens.
      try {
        await publish()
      } catch {
        setSyncState('error')
        toshToast.error(
          'Launch confirmed, but the listing was not published. Open your ' +
          'project and use Publish listing to finish it.',
          { duration: 10_000 },
        )
      }

      toshToast.success('Launch confirmed — opening your project')
      router.push(`/projects/${destination}`)
    }
    void sync()
  }, [isConfirmed, hash, receipt, publicClient, router, signMessageAsync])

  const pickWindow = (next: bigint) => {
    if (next === genesisDuration) return
    setGenesisDuration(next)
    // The duration is baked into the hook initcode, so it is one of the three
    // things a salt is ground against.
    clearSalt()
  }

  const gate = useActionGate({
    // `NATIVE_SYMBOL`, because this figure is the launch fee and the launch fee
    // is BNB. The pact checkbox and the cost card two cells away already say so;
    // this button was the one place still labelling the same number in BEM.
    action: `Deploy — ${feeDisplay} ${NATIVE_SYMBOL}`,
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
        reason: 'Fetching the launch fee, the raise target and the per-wallet cap before quoting what you owe.',
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
      /*
       * ⚠ BACK TO ONE BLOCKER FROM THREE. There were three because the creator
       *   needed two assets and an allowance: `insufficient-gas`,
       *   `insufficient-fee` and `approve-fee`, ordered bottom-up so that a
       *   wallet short of everything was told about the missing BEM before
       *   being invited to approve a balance it did not have.
       *
       *   Both costs are BNB now and nothing is approved, so there is one
       *   question left and it is asked once.
       */
      {
        id: 'insufficient-funds',
        active: insufficientFunds,
        label: `Need ${nativeDisplay(dueNowWei)}`,
        reason: `Deploying costs ${nativeDisplay(launchFeeWei)} in launch fee plus about ${nativeDisplay(gasNowWei)} in gas, both in ${NATIVE_SYMBOL}. This wallet does not hold the ${nativeDisplay(dueNowWei)} that comes to.`,
        tone: 'warn',
      },
      {
        id: 'salt',
        active: isDerivingSalt,
        // No longer a search, and the copy should not promise one. This used to
        // say "Searching for an address Uniswap will accept" and take seconds;
        // it is now two contract reads and an occupancy check.
        label: 'Reserving your pool address…',
        reason: `Reserving an address for a ${genesisDuration / 3600n}h window and checking it is free. Takes a moment.`,
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
            One signature deploys your token with its own PancakeSwap Infinity pool and opens a
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
              the Enter key can spend the settlement coin — and the deploy path is gated through
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
                    clearSalt()
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
                  Immutable. The window runs to completion; time-up opens launch regardless of how much was raised.
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

                  {/* THE MINIMUM RAISE READOUT IS GONE FROM HERE, and it has
                      since gone from the other three places too. It was a
                      `Minimum raise / <softCapDisplay> / Set on the factory,
                      not per launch` block on the right of this row — the
                      fourth place on one screen showing one number.

                      Deduplicating it was the right first move and the wrong
                      diagnosis. The problem was not that `defaultSoftCap`
                      appeared four times; it was that no wording for it was
                      true, so each pass renamed it rather than removing it.
                      The preview's row, the aside's dial and the consent line
                      have all now gone the same way as this one, for the
                      reasons written where each used to be.

                      Two of those four earn their place: the preview because it
                      is a mock-up of the listing, and the consent because it is
                      the copy being agreed to. This one was neither, and it was
                      the worst of the four — sitting beside the duration pills
                      it read as a property of the window the creator was
                      choosing, when it is a factory dial that the choice above
                      it does not affect at all.

                      The mock has an editable "Genesis target" here. It stays
                      out because `defaultSoftCap` is not the creator's to type,
                      and an input the contract ignores is worse than no input. */}
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

                A salt's PREDICTION is only valid for the account, the genesis
                window and the factory dials it was derived against. A button that
                derives and then waits for a second click puts a gap between those
                two moments, and anything moving inside that gap — the owner
                retuning `defaultSoftCap` or `maxPogAllocationLimit`, the creator
                switching wallets or picking a different window — leaves a salt
                that reads as locked and is not.

                THE FACTORY USED TO CATCH THAT BY ACCIDENT and now catches it on
                purpose. Under Uniswap V4 a moved dial re-rolled the address, the
                new address failed the permission mask about 31 times in 32, and
                the launch reverted `InvalidHookSalt`; the one time in 32 it
                passed, the launch went through at an address nobody predicted.
                Infinity takes permissions from the hook's own bitmap, so that
                accident is gone entirely — `createLaunch` is handed
                `expectedSoftCap` and `expectedWalletCap` and reverts
                `CapsChanged` on any difference, which closes the 1-in-32 hole
                the mask left open.

                What that revert costs is worth stating exactly: the whole
                transaction unwinds, so the launch fee comes back with it and
                only the gas is gone. It is a wasted transaction and a wasted
                wallet prompt, not a lost fee. Deriving on the same click that
                sends the transaction is the one ordering with no gap in it, so
                that is where `deriveSalt` is called from — see `handleLaunch`.

                So this readout is usually empty before the first Deploy, which
                is exactly the mock's `no salt mined` state. It fills in when a
                deploy picked a salt and then stopped short of a confirmed
                transaction — the pre-flight decoded a revert, the fee moved,
                the wallet prompt was declined — and that held salt is what the
                next Deploy reuses after re-reading the caps. `predictedHook` is
                the address `deriveSalt` already derived from that same salt; it
                is read here, never recomputed. */}
            {/* NO LONGER A NUMBERED SECTION, and this is the page's biggest
                cut. It was `4 · hook salt`: a fieldset the same
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
                when a Deploy picked one and then stopped short of a confirmed
                transaction — pre-flight decoded a revert, the fee moved, the
                wallet prompt was declined — and that salt is what the next
                Deploy reuses after re-reading the caps. When it exists it is
                worth showing, because it is also the first time the creator
                can see their pool address. When it does not, there is nothing
                to say.

                The one thing a reader did need from the old note — that Deploy
                settles the salt before the wallet opens — moved next to the
                button, in the submit block, where it explains the pause as it
                happens rather than three sections earlier. The pause is now an
                RPC round-trip rather than a search, and much shorter for it. */}
            {salt && (
              <div className="flex min-w-0 flex-col gap-gap-tight rounded-panel border border-border-subtle bg-surface-card p-card-lg shadow-panel">
                <div className="flex flex-wrap items-center justify-between gap-gap-tight">
                  <p className="font-mono text-label text-text-tertiary">Hook salt</p>
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
                  {/* ⚠ THIS ROW WAS LABELLED "Refund window", WHICH NAMED THE
                      WRONG WINDOW AND POINTED IT AT THE WRONG PERSON.

                      `LAUNCH_WINDOW_SECONDS` is the creator's deadline to call
                      `launch()` after genesis closes. Refunds open when it
                      EXPIRES, and `canRefund()` tests nothing but
                      `block.timestamp > genesisDeadline + LAUNCH_WINDOW`, so
                      once open they never close.

                      So the old label was wrong twice over: these 7 days are
                      the window before refunds rather than the window for them,
                      and the refund itself has no deadline at all. The reader
                      of this panel is the creator, and "Refund window: 7 days"
                      invites them to conclude their depositors have a week to
                      pull out — when in fact THEY have a week to ship, and
                      missing it is what hands the money back. */}
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Your deadline to launch</dt>
                    <dd className="text-text-primary">
                      {Number(LAUNCH_WINDOW_SECONDS / 86400n)} days
                    </dd>
                  </div>
                </dl>
                <p className="text-micro leading-relaxed text-text-quiet">
                  Fixed at deploy, and unsold supply is never re-mintable. Genesis
                  splits {shareOf(GENESIS_CLAIM_SUPPLY, GENESIS_SUPPLY)} to depositor
                  claims and the rest to pool liquidity, which is what opens the market
                  above what they paid. The clock starts when genesis closes: open the
                  pool inside it, or every depositor can take back 100% of their{' '}
                  {QUOTE_SYMBOL} — with no deadline of their own to beat.
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
                {/* THE TOTAL IS BACK, because it is a quantity again.

                    It was removed when the fee moved to BEM: "Due now" had been
                    the launch fee plus the create gas, and once those were
                    8-decimal quote units and 18-decimal wei the sum was a figure
                    in no currency at all. Four rows in two assets was the honest
                    shape of that, and it made the creator notice they needed
                    both.

                    The fee is native BNB again, so the same addition is sound
                    and the four rows are now four ways of saying BNB. `Due now`
                    leads because it is the number a creator budgets against, and
                    it is the only one that can stop this transaction.

                    The second transaction stays broken out for the original
                    reason, which never depended on the denomination: only the
                    creator can send it, and a wallet drained by the first
                    strands a raise that already succeeded. */}
                <dl className="flex flex-col gap-gap-tight font-mono text-note">
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Due now</dt>
                    <dd className="text-text-primary">{nativeDisplay(dueNowWei)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">└ launch fee</dt>
                    <dd className="text-text-secondary">{nativeDisplay(dialsReady ? launchFeeWei : null)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">└ gas, deploy now</dt>
                    <dd className="text-text-secondary">{nativeDisplay(gasNowWei)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Gas, open pool later</dt>
                    <dd className="text-text-secondary">
                      {nativeDisplay(gasCostWei(LAUNCH_GAS_TOTAL, feePerGas))}
                    </dd>
                  </div>
                </dl>
                <p className="text-micro leading-relaxed text-text-quiet">
                  {NATIVE_SYMBOL} only, and one signature — the fee is sent with the
                  transaction, not approved first. Send more than the fee and the
                  difference comes straight back. Gas is estimated at the current
                  rate, which moves before you sign. Opening the pool is a later
                  transaction only you can send.
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
            {/* ⚠ THIS LINE USED TO CLAIM TWO THINGS THAT WERE NOT TRUE, on the
                one page whose entire argument is that a creator can go and
                check. It read: "No proxy, no admin key, no upgrade. Only this
                project's own contract can ever mint the token, and nobody holds
                an admin role over it."

                "No proxy" was false on inspection. The hook and the token are
                both CREATE2 clones — 131 bytes that `delegatecall` a fixed
                implementation — so a reader who opens the bytecode finds a
                proxy in the first instruction. The true and stronger claim is
                that the implementation address is part of the clone's own code
                and cannot be pointed anywhere else.

                "Nobody holds an admin role over it" contradicted the factory's
                own natspec, which calls `haltLadderMinting` a "break-glass
                brake" and "the new trust assumption". The owner can freeze this
                project's shelf minting for up to `MAX_HALT_DURATION`, renewably.
                Governance §9 of the README has always listed it; only this
                sentence denied it.

                What survives is what holds: minting is the hook's alone, the
                deployed parameters are immutable, and the brake is bounded and
                cannot touch anyone's balance. Saying that is more persuasive
                than the overclaim was, and it does not fall over when someone
                reads the contract. */}
            <p className="flex flex-wrap items-center gap-x-gap-tight text-note leading-relaxed text-text-quiet">
              No upgrade path and no admin key over your token: the terms above are
              fixed in the contract&apos;s own bytecode at deploy, and only this
              project&apos;s contract can ever mint. The platform keeps one bounded
              brake — it can pause shelf minting for up to 7 days at a time, on the
              record, and it can never reach a deposit, a refund or a claim.
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
                      I accept the immutable pact: {feeDisplay} {NATIVE_SYMBOL} launch fee, a genesis
                      window that cannot close early, and a{' '}
                      <span className="text-warning">full refund</span> if the{' '}
                      {Number(LAUNCH_WINDOW_SECONDS / 86400n)}-day window to open trading expires unused.
                    </>
                  ) : dialsFailed ? (
                    <span className="text-danger">
                      The factory did not answer on chain {TARGET_CHAIN_ID}, so the launch fee and
                      raise target are unknown. There are no terms to accept yet.
                    </span>
                  ) : (
                    <span className="text-text-tertiary">
                      Reading the launch fee and the raise target off the factory — the pact
                      appears here with its real numbers in it.
                    </span>
                  )}
                </span>
              </label>

              {saltError && (
                <p className="text-note text-danger">{saltError}</p>
              )}

              <ActionButton gate={gate} size="lg" />

              {/* The one sentence worth keeping from the deleted salt section,
                  moved to the only place it does any work. Deploy settles the
                  CREATE2 address before it opens the wallet, so the button sits
                  busy with nothing else to show for it; said here, it explains a
                  pause the reader is watching, rather than pre-explaining one
                  three sections above it.

                  It says "a moment" rather than the old "a few seconds" because
                  the wait is now three RPC calls instead of a salt search. */}
              <p className="text-micro leading-relaxed text-text-quiet">
                Deploy reserves your pool address before the wallet opens, so
                expect a moment before the prompt.
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
                  {syncState === 'error' && ' · not listed — finish from the project page'}
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
                      {dialsReady ? `${feeDisplay} ${NATIVE_SYMBOL}` : EM_DASH}
                    </dd>
                  </div>
                  {/* ⚠ THE `Raise target` ROW IS GONE, and the label it carried
                      was the second attempt at describing something that is not
                      there. It began as `Soft cap`, the contract's own name for
                      `defaultSoftCap`; that was renamed to `Minimum raise` so
                      one dial would not wear two labels in two panels, then to
                      `Raise target`.

                      All three were wrong in the same way. It is not a cap —
                      deposits run past it. It is not a minimum — a raise below
                      it launches, and the real floor is the one that makes a
                      ladder solvable, which `RaiseTooSmallForLadder` puts near
                      21 BEM and which this figure sits far above. It is not a
                      target either, because nothing reads it: `launch()` does
                      not consult it, and reaching it does nothing at all.

                      `softCapWei` stays in the code. It is an argument to
                      `createLaunch` and part of the hook's initcode, so it
                      still decides the CREATE2 address — it simply has nothing
                      to say to a creator. */}
                  <div className="flex justify-between gap-4">
                    <dt className="text-text-tertiary">Per-wallet cap</dt>
                    <dd className="text-text-primary">
                      {dialsReady ? `${trimEth(formatUnits(perWalletCapWei, QUOTE_DECIMALS))} ${QUOTE_SYMBOL}` : EM_DASH}
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
