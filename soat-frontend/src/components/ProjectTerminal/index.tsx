'use client'

/**
 * Tosh Protocol · CRYPTOGRAPHIC TRADING TERMINAL  (v5.0 — native-coin)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   PHASE 1 · GENESIS
 *     ▸ Native-coin deposits via factory.deposit{value}(hook, referrer)
 *     ▸ H-01 PoG quota ledger
 *
 *   PHASE 2 · DISCRETE TIER SHELVES
 *     ▸ 4000 fixed-price rungs, 105 % min(spot, TWAP) unlock gate
 *     ▸ hook.mintBondingCurve{value}(tokenAmount)
 *
 *   PHASE 3 · REFUND
 *     ▸ hook.refund() returns 100 % of the native-coin deposit
 *
 * ── LAYOUT: PORTED FROM THE v0 REDESIGN ──────────────────────────────────────
 *
 * This used to be one 768px column with every panel stacked in it. The mock is
 * 1280px wide and splits into a wide reading column and a 360px sidebar that
 * sticks: everything that INFORMS goes left, everything that ASKS FOR A
 * TRANSACTION goes right, where it stays in view while the left column scrolls.
 *
 * The chain reads did not move. This file still owns the whole bulk call and
 * every panel's props are unchanged; only the JSX around them is new.
 */
import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { useAccount, useReadContract, useReadContracts } from 'wagmi'
import type { Address, ContractFunctionParameters } from 'viem'

import type { ProjectRow } from '@/app/lib/supabase'
import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI, BONDING_MAX, TIER_COUNT, TIER_SIZE,
  ERC20_ABI, QUOTE_ASSET, QUOTE_SYMBOL, TARGET_CHAIN_ID,
} from '@/lib/contracts'
import { isUnlisted } from '@/lib/projectRow'
import { useBoundReferrer } from '@/lib/useReferral'
import {
  Card, Skeleton, useIsHydrated, useNowSec, CLOCK_UNSYNCED,
} from '@/components/ui'
import { genesisWindow, resolvePhase, type Phase } from './phase'
import { HeroStats } from './HeroStats'
import { GenesisPanel } from './GenesisPanel'
import { AwaitingLaunchPanel } from './AwaitingLaunchPanel'
import { RefundPanel } from './RefundPanel'
import { ReferralPanel } from './ReferralPanel'
import { LifecycleTracker } from './LifecycleTracker'
import { BondingStateProvider } from './bondingState'

// Phase-2 only, and by far the heaviest code on this route: the 4000-rung
// ladder table, the quoting maths, and the Permit2 / V4 position manager
// stack. A project in genesis — which is every project for its first hours —
// used to download all of it to render a deposit box.
//
// `BondingPanel` is now two exports rather than one, because the mock puts the
// ladder in the main column and the buy form in the sidebar and those are
// siblings in two different grid tracks. They still come from one module, so
// this is one chunk fetched once, not two. What they share — the reads, the
// amount, the quote and the single write gate — lives in `bondingState`, which
// is imported statically above; see the header comment there for why a provider
// cannot be lazy when it wraps the grid it provides for.
//
// `LifecycleTracker` is a static import despite also being phase-scoped:
// markup plus arithmetic over values this file already holds, with no
// dependency the bundle does not carry anyway, so it does not earn a chunk
// boundary or the loading flash it costs. `MarketMakingSection` and
// `LadderCurveSection` were the other two until both sections came out.
const panelFallback = () => <Skeleton className="h-64" radius="card" />
const GenesisClaimPanel = dynamic(
  () => import('./GenesisClaimPanel').then(m => m.GenesisClaimPanel),
  { loading: panelFallback },
)
const BondingLadderSection = dynamic(
  () => import('./BondingPanel').then(m => m.BondingLadderSection),
  { loading: panelFallback },
)
const BondingBuyPanel = dynamic(
  () => import('./BondingPanel').then(m => m.BondingBuyPanel),
  { loading: panelFallback },
)
const LiquidityPanel = dynamic(
  () => import('./LiquidityPanel').then(m => m.LiquidityPanel),
  { loading: panelFallback },
)
// Rendered for one wallet on a launch whose registry write did not land, which
// is the rarest surface in the app — and it pulls in the launch form's logo
// uploader and the attestation builder. Everyone else should not pay for it.
const PublishListingPanel = dynamic(
  () => import('./PublishListingPanel').then(m => m.PublishListingPanel),
  { loading: panelFallback },
)

/**
 * What the page header is allowed to know about the chain.
 *
 * The mock's header carries a phase badge and a live price, and both are
 * resolved here — this file owns every read on the route, and the brief for the
 * port is explicit that no read may move. But the header itself belongs to
 * `ProjectDetail`, which owns the page shell.
 *
 * So the header comes in as a function of this state rather than the state
 * going out to a second reader. `null` means "nothing chain-derived is safe to
 * print yet", which is not the same as zero: before the clock syncs,
 * `resolvePhase` reads an expired genesis as still open (see the PRECONDITION
 * on `resolvePhase`), so a badge rendered then would assert the wrong phase for
 * a frame.
 */
export interface TerminalHeaderState {
  phase: Phase
  /** `currentBondingPrice` — the live shelf, in wei per whole token. */
  currentPrice: bigint
  /**
   * Which shelf `currentPrice` came off, zero-based, derived from
   * `phase2Minted` rather than read a second time.
   *
   * Added so the header has something true under the price. The mock prints a
   * 24h delta there and this app has no price history to difference against,
   * so the slot held a permanent "no price feed · 24h" — a caption explaining
   * an absence, directly under the largest number on the page. The shelf index
   * is the honest answer to the question that line was gesturing at: not how
   * the price moved, but where it currently is on a ladder whose every rung is
   * known in advance.
   */
  shelfIndex: number
  /**
   * `hook.creator()`. Surfaced rather than newly read: the launch panel already
   * needs it to decide whether to offer the launch button, and the mock's
   * header prints `by 0x…`. `ProjectRow` has no creator column, so the chain is
   * the only place it exists.
   */
  creator: Address | undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT  ·  ProjectTerminal
// ─────────────────────────────────────────────────────────────────────────────

export default function ProjectTerminal({ project, about, header }: {
  project: ProjectRow
  /**
   * The mock's `About` section, rendered at the top of the main column.
   *
   * Passed in rather than built here because the description is registry data,
   * not chain data, and `ProjectDetail` already holds the row. It is a slot and
   * not a second copy: the header used to print the description too, and it no
   * longer does.
   */
  about?: ReactNode
  header?: (live: TerminalHeaderState | null) => ReactNode
}) {
  const { address, isConnected } = useAccount()
  const hydrated    = useIsHydrated()
  const userAddress = hydrated ? (address as Address | undefined) : undefined
  const wConnected  = hydrated ? isConnected : false

  const hookAddress = project.hook_address as Address | undefined
  const symbol      = project.symbol || 'TOK'

  /*
   * ONE BALANCE, AND IT IS NO LONGER THE NATIVE ONE.
   *
   * This was `useBalance` — the wallet's BNB — threaded into three panels as
   * `ethBalance` and compared against deposit and mint amounts. Every one of those
   * amounts is denominated in the quote asset now, so the native balance answers a
   * question nothing asks: no panel below asks the user to part with BNB, only to
   * have enough of it for gas, which the wallet enforces on its own.
   *
   * A RENAME WOULD HAVE COMPILED, which is why the read was replaced rather than
   * relabelled. `nativeBalance >= amountWei` type-checks perfectly while comparing
   * an 18-decimal balance against an 8-decimal amount, and it errs PERMISSIVELY —
   * a wallet holding 0.01 BNB reads as 10^16 against a 9.28-unit requirement of
   * 9.28e8, so every balance gate in the terminal would have opened for everyone.
   * The deposits would then revert inside `transferFrom`, having spent gas.
   */
  const { data: quoteBal } = useReadContract({
    address: QUOTE_ASSET, abi: ERC20_ABI, functionName: 'balanceOf',
    args: userAddress ? [userAddress] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!userAddress },
  })
  const quoteBalance = quoteBal ?? 0n

  /**
   * The shared clock store, not a locally-seeded one.
   *
   * The local version this replaces seeded its state with `Date.now()`, which
   * makes the server snapshot and the hydration snapshot disagree by
   * construction; it only went unnoticed because a dev machine renders both
   * with the same clock.
   *
   * The store's contract is that it reads `CLOCK_UNSYNCED` (0) until the first
   * client tick, and 0 is NOT a usable stand-in for the wall clock here. Every
   * panel below compares it against on-chain timestamps, and LiquidityPanel
   * derives Permit2 and swap deadlines from it — at 0 those become deadlines in
   * 1970, which the router is guaranteed to reject, and `resolvePhase` would
   * read an expired genesis as still open. So rather than teach all five
   * consumers to recognise 0, nothing clock-derived renders until it lands.
   */
  const nowSec = useNowSec()
  const clockReady = nowSec !== CLOCK_UNSYNCED

  // Bulk chain reads.
  //
  // Typed as a plain `ContractFunctionParameters[]` rather than left to
  // inference: wagmi builds a per-entry mapped type over the whole ABI, and
  // with HOOK_ABI at ~130 entries that tuple blows past TypeScript's
  // instantiation depth limit.  Every result below is cast explicitly anyway,
  // so the precise inference was buying nothing.
  const bulkContracts: ContractFunctionParameters[] = hookAddress ? [
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'totalNativeDeposited' },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'launched'           },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'p0'                 },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'phase2Minted'       },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'canRefund'          },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'genesisDeadline'    },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'softCap'            },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'BONDING_MAX'        },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'currentBondingPrice'},
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'nativeDeposited',
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

  const totalNativeDeposited  = (data?.[0]?.result  as bigint  | undefined) ?? 0n
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

  // The denominator for the genesis countdown, and the reason that countdown
  // can be a bar at all. It is one of the three fixed windows the creator
  // picked at `createLaunch` (3h / 24h / 72h), baked into the clone's initcode
  // and therefore immutable — `staleTime: Infinity` for the same reason
  // `perWalletCap` above uses it.
  const { data: genesisDurationRaw } = useReadContract({
    address: hookAddress, abi: HOOK_ABI, functionName: 'genesisDuration',
    query: { enabled: !!hookAddress, staleTime: Infinity },
  })
  const genesisDuration = (genesisDurationRaw as bigint | undefined) ?? 0n

  // Passing the hook address is what claims this project's referral slot from
  // `?ref=` on landing — the root layout's `<ReferralCapture/>` only parks the
  // lifetime one, because it does not know which project the path names.
  const referrer = useBoundReferrer(userAddress, hookAddress)

  const phase: Phase = resolvePhase({
    totalNativeDeposited, softCap, canRefund, launched, genesisDeadline, nowSec,
  })

  /*
   * ⚠ THE GENESIS CLOCK IS A FRACTION AND THE LAUNCH CLOCK IS NOT, which is
   *   why only the first becomes a bar.
   *
   *   `genesisDuration` is a fixed window chosen up front, so "how much of it
   *   is left" is a real percentage of a real whole. That is exactly what the
   *   soft-cap bar never had — deposits ran past the cap, `launch()` ignored
   *   it, and the bar filled toward a number that gated nothing. A clock is
   *   the honest thing to put in that slot: it has a denominator, and running
   *   out actually ends something.
   *
   *   The launch window that follows (`genesisDeadline + LAUNCH_WINDOW`) is
   *   deliberately NOT drawn here. `AwaitingLaunchPanel` already counts it
   *   down beside the explanation of what happens when it lapses, and a second
   *   copy in the header would be the same number in two places with no way to
   *   keep them honest. The badge keeps a one-word status instead.
   */
  // Not named `window`: that shadows the global one, and this file is a client
  // component where something later will reach for it.
  const genesisClock = genesisWindow({ phase, genesisDeadline, genesisDuration, nowSec })

  const windowLabel = phase === 'awaiting_launch' ? 'window closed' : undefined


  if (!hookAddress) {
    return (
      <>
        {header?.(null)}
        <div className="mt-6 flex flex-col">
          <Card id="ERR" title="HOOK BINDING MISSING">
            <p className="font-mono text-note text-text-tertiary leading-relaxed">
              This project row has no <span className="text-brand">hook_address</span> on file.
              Deploy may still be pending — refresh after the createLaunch tx confirms.
            </p>
          </Card>
        </div>
      </>
    )
  }

  // Vertical rhythm lives on the container rather than as `mt-6` on each panel:
  // a Card carrying its own top margin only spaces correctly when it happens to
  // have a sibling above it.
  if (!clockReady) {
    return (
      <>
        {header?.(null)}
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="@container flex min-w-0 flex-col gap-6">
            <Skeleton className="h-24" radius="card" />
            <Skeleton className="h-64" radius="card" />
          </div>
          <div className="@container flex flex-col gap-4">
            <Skeleton className="h-64" radius="card" />
          </div>
        </div>
      </>
    )
  }

  /**
   * The reading column.
   *
   * `minmax(0,1fr)` on the track and `min-w-0` here, not a bare `1fr`: the
   * ladder table is a fixed `grid-cols-[4rem_1fr_6rem_5rem]`, and an auto
   * minimum would let it push the track wider than the grid, shoving the 360px
   * sidebar off the edge instead of scrolling inside its own card.
   *
   * `@container` moved here from the old single column, and it is still
   * load-bearing: every grid inside these panels queries its column, not the
   * viewport. It has to sit on each column separately now — a single container
   * on the wrapper would tell the sidebar's panels they have 1280px to lay out
   * in when they have 360.
   */
  const grid = (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="@container flex min-w-0 flex-col gap-6">
        {/* Above the hero, and in the reading column rather than the action
            one. It breaks this file's own "signatures go right" rule on
            purpose: the rule sorts panels a visitor chooses between, and this
            is an unfinished step in the creator's own launch that they are
            otherwise given no indication of. It is also a five-field form,
            which the 360px track cannot hold. It disappears for good the
            moment the row exists. */}
        {isCreator && isUnlisted(project) && (
          <PublishListingPanel
            hookAddress={hookAddress}
            name={project.name}
            symbol={symbol}
          />
        )}

        <div className="rounded-panel border border-border-subtle bg-surface-card p-card">
          <HeroStats
            phase={phase}
            symbol={symbol}
            p0={p0}
            currentPrice={currentPrice}
            shelfP0={shelfP0}
            totalNativeDeposited={totalNativeDeposited}
            phase2Minted={phase2Minted}
            bondingMax={bondingMax}
            userEthDeposited={userEthDeposited}
            windowLabel={windowLabel}
            genesisWindow={genesisClock}
          />
        </div>

        {/* `LadderCurveSection` USED TO OPEN THE TRADING COLUMN HERE, holding
            the mock's chart-and-stats slot with a plot of the ladder's own
            price curve and three readouts under it. Both halves are gone.

            The chart was honest and still not worth its height. It plotted
            `Math.pow(TIER_STEP, i - TIER_COUNT)` — a closed-form curve over a
            fixed step and a fixed shelf count, identical in shape for every
            project on the platform and unchanged by anything that happens to
            this one. It labelled itself "ladder geometry · not trade history"
            precisely because a reader would otherwise take it for a market,
            and a panel that has to disclaim what it is not is answering a
            question nobody came here with. The thing it was standing in for —
            a real price history — needs a trade index that does not exist.

            Of its three readouts, two were restatements: `Ladder remaining`
            was the denominator of the progress bar two cards up, and `Shelf
            climb` reads 1.00x for the whole of shelf #0, which is where a new
            project sits. `Total supply` was the one figure on the card that
            appeared nowhere else on this page. It is a constant of the launch
            rather than a fact about the market, so it went with the card
            instead of being rehomed — the launch page states it among the
            immutable terms, which is where a supply number is decided. */}

        {about}

        {phase === 'refund' && (
          <div className="rounded-card border border-warning/40 bg-warning/10 px-card py-gap">
            <p className="font-mono text-label text-warning">Refund window open</p>
            <p className="mt-1 text-note text-text-secondary leading-relaxed">
              This raise did not open a pool. Every depositor can reclaim 100% of
              their {QUOTE_SYMBOL} — no penalty, no haircut, no expiry on the claim itself.
            </p>
          </div>
        )}

        {phase === 'bonding' && (
          <>
            {/* The mock folds the genesis claim into the sidebar's buy card as
                a one-line row. Ours is a Card with its own action gate and its
                own "already claimed" read, and it hides itself entirely for a
                wallet with nothing to claim — so it reads as information here
                rather than as a second button competing with Buy. */}
            <GenesisClaimPanel
              hookAddress={hookAddress}
              symbol={symbol}
              userAddress={userAddress}
              nativeDeposited={userEthDeposited}
              refetch={() => { void refetch() }}
            />
            <BondingLadderSection />
            {/* `MarketMakingSection` USED TO SIT HERE, immediately above the
                LP panel, as a three-paragraph explainer of the pool fee, the
                swap tax and the shelf split. Every figure on it is a platform
                constant — 1.30%, 99%, full-range — identical for every
                project and already restated on the LP panel's own subtitle
                (`full range · 0.30% pool fee accrues to LPs`). A card that
                cannot change between projects is not a project page.

                It is not replaced by a second About. The About slot is
                already rendered above this column, once, from the registry
                description. Two About cards for one paragraph is the copy
                the header used to carry and that this file's `about` prop
                exists to stop. */}
            {launched && (
              <LiquidityPanel
                hookAddress={hookAddress}
                tokenAddress={tokenAddress}
                symbol={symbol}
                userAddress={userAddress}
                isConnected={wConnected}
                quoteBalance={quoteBalance}
                nowSec={nowSec}
              />
            )}
          </>
        )}

        {/* Pre-trading only, as in the mock: once the pool is open all three
            steps are done and the rail says nothing the ladder does not. */}
        {phase !== 'bonding' && <LifecycleTracker phase={phase} />}

        {/* MOVED OUT OF THE ACTION COLUMN, where it sat last under the deposit
            box and was the panel people reported not noticing. Two reasons it
            belongs here instead.
 
            It lost that placement's argument: the sidebar is for panels that
            ask for a signature about THIS project, and it stays in view while
            the reading column scrolls. The referral desk's own claim button is
            dark for almost everyone who sees it — commission accrues only from
            deposits made through your link and unlocks only at launch — so for
            a first-time visitor it is not an action, it is an explanation of a
            programme they have not entered yet.
 
            And it was competing for the one slot that matters. In genesis the
            sidebar's job is the deposit box; a second card below it, taller
            than the box itself, pushed the referral link to where it only
            existed after a scroll past the thing the page is for. Here it
            follows the lifecycle rail, which is the point where a reader has
            finished asking what happens next and can be told how to bring
            somebody with them. */}
        {wConnected && (
          <ReferralPanel
            hookAddress={hookAddress}
            symbol={symbol}
            userAddress={userAddress}
            phase={phase}
            refetch={() => { void refetch() }}
          />
        )}
      </div>

      {/* The action column. Everything that asks for a signature lives here and
          stays in view while the reading column scrolls. */}
      <div className="@container flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
        {phase === 'genesis' && (
          <GenesisPanel
            hookAddress={hookAddress}
            symbol={symbol}
            userAddress={userAddress}
            isConnected={wConnected}
            totalNativeDeposited={totalNativeDeposited}
            quoteBalance={quoteBalance}
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
        )}

        {phase === 'awaiting_launch' && (
          <AwaitingLaunchPanel
            hookAddress={hookAddress}
            symbol={symbol}
            isCreator={isCreator}
            totalNativeDeposited={totalNativeDeposited}
            genesisDeadline={genesisDeadline}
            nowSec={nowSec}
            refetch={() => { void refetch() }}
          />
        )}

        {phase === 'bonding' && <BondingBuyPanel />}

        {phase === 'refund' && (
          <RefundPanel
            hookAddress={hookAddress}
            nativeDeposited={userEthDeposited}
            refetch={() => { void refetch() }}
          />
        )}
      </div>
    </div>
  )

  return (
    <>
      {header?.({
        phase,
        currentPrice,
        // Derived rather than read a second time: every shelf holds exactly
        // `TIER_SIZE`, so the quotient IS the index — the same arithmetic the
        // hook does. `tierStatus[0]` would give it directly, but that read
        // belongs to the bonding provider and this renders from the bulk call.
        // (The removed `LadderCurveSection` computed it the same way, which is
        // why this comment used to cite it.)
        shelfIndex: TIER_SIZE > 0n
          ? Math.min(TIER_COUNT, Number(phase2Minted / TIER_SIZE))
          : 0,
        creator: creatorAddress as Address | undefined,
      })}
      {/*
        The provider wraps BOTH tracks because its two consumers sit in
        different ones, and it is mounted only for the phase that has a ladder —
        so a genesis page never runs a single one of its reads.
      */}
      {phase === 'bonding' ? (
        <BondingStateProvider
          hookAddress={hookAddress}
          symbol={symbol}
          userAddress={userAddress}
          isConnected={wConnected}
          p0={p0}
          shelfP0={shelfP0}
          currentPrice={currentPrice}
          phase2Minted={phase2Minted}
          bondingMax={bondingMax}
          quoteBalance={quoteBalance}
          nowSec={nowSec}
          refetch={() => { void refetch() }}
        >
          {grid}
        </BondingStateProvider>
      ) : grid}
    </>
  )
}
