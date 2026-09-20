'use client'

/**
 * BONDING STATE  ·  Phase 2, shared across two grid columns
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The v0 skeleton puts the shelf ladder in the main column and the buy form in
 * the 360px sidebar. Those are siblings in two different grid tracks, so they
 * cannot be one component any more — but nearly everything they display is one
 * derivation: `tierStatus` feeds both the ladder table and the 105% gate badge,
 * the circuit-breaker reads feed both the halt banner and the buy button's
 * first blocker, and the quote is computed from the amount the form owns.
 *
 * So every read, the input state, the quote and the ONE write gate live here,
 * and the two halves are markup over this context. Copying any of it into a
 * second component would mean two `quoteMint` polls disagreeing about the cost
 * of the same order, and two places able to issue `mintBondingCurve`.
 *
 * NOTHING IN HERE IS NEW except the settlement. It is `BondingPanel`'s former
 * body, moved verbatim — same reads, same cadences, same revert-ordered blocker
 * cascade. The buy path used to send `value: maxQuoteCost`; it now approves that
 * amount and passes it as `maxCost`. The split is still a layout change.
 *
 * WHY THIS IS NOT BEHIND `next/dynamic` the way the two halves are: a dynamic
 * component's fallback renders INSTEAD of its children, and this provider wraps
 * the whole two-column grid — so a loading state here would blank the header
 * stats and the About section while a chunk arrived. It is rendered only for
 * `'bonding'`, and it imports no module `index.tsx` does not already pull in,
 * so keeping it static costs this file's own bytes and nothing more.
 */

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import {
  useReadContract, useReadContracts, useBlockNumber,
} from 'wagmi'
import { parseUnits, type Address, type ContractFunctionParameters } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI, QUOTE_SYMBOL,
} from '@/lib/contracts'
import {
  useActionGate, revertOrder, useTxAction, useQuoteApproval, type ActionGate,
} from '@/components/ui'
import { fmt, fmtQuote } from './format'
import type { TierStatus } from './ShelfLadder'

/** Buy-side slippage tolerance in basis points (0.5 %).
 *
 *  Padded into `maxCost`, the CEILING argument — not into a payment. Since the
 *  quote asset became an ERC-20 the hook pulls the true cost with
 *  `transferFrom`, so the excess is never transferred and there is nothing to
 *  refund; what the padding actually spends is allowance. The previous wording
 *  described the native-value era and promised the buyer change that no longer
 *  exists as a concept on this path. */
const SLIPPAGE_BPS = 50n

export interface BondingProps {
  hookAddress:  Address
  symbol:       string
  userAddress:  Address | undefined
  isConnected:  boolean
  p0:           bigint
  shelfP0:     bigint
  currentPrice: bigint
  phase2Minted: bigint
  bondingMax:   bigint
  quoteBalance:   bigint
  nowSec:       number
  refetch:      () => void
}

export interface BondingState {
  /** The props as handed in, so neither half needs its own copy of them. */
  p: BondingProps

  // ── Ladder column ─────────────────────────────────────────────────────────
  status:       TierStatus | undefined
  unlocked:     boolean
  halted:       boolean
  haltIsGlobal: boolean
  haltTxt:      string
  premiumRaw:   number

  // ── Buy column ────────────────────────────────────────────────────────────
  tokenAmount:    string
  setTokenAmount: (v: string) => void
  quotable:         boolean
  quoteCost:          bigint
  maxQuoteCost:       bigint
  quoteUnknown:     boolean
  quoteUnavailable: boolean
  isDust:           boolean
  txBusy:           boolean
  amountError:      string | null
  amountHint:       string | undefined

  // ── Shared by both ────────────────────────────────────────────────────────
  sameBlockLock:       boolean
  awaitingFirstUnlock: boolean

  /** The single write gate. Only the buy form renders a button for it. */
  gate:  ActionGate
  armed: boolean
}

const BondingCtx = createContext<BondingState | null>(null)

/**
 * Throws rather than returning null, and deliberately so: a half rendered
 * outside the provider would otherwise paint an empty buy form with a dead
 * button instead of failing where the mistake is.
 */
export function useBondingState(): BondingState {
  const state = useContext(BondingCtx)
  if (!state) {
    throw new Error(
      '[bonding] useBondingState() outside <BondingStateProvider>. ' +
      'The ladder section and the buy form are two grid columns over one ' +
      'derivation — both must sit inside the provider ProjectTerminal renders.',
    )
  }
  return state
}

export function BondingStateProvider(
  { children, ...p }: BondingProps & { children: ReactNode },
) {
  const [tokenAmount, setTokenAmount] = useState('')

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
  const status = statusRaw as TierStatus | undefined
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
  //
  // The two are comparable only because the hook stamps the chain's OWN height.
  // On an Arbitrum Orbit chain `block.number` is the L1 height, and a contract
  // that used it would report ~25.8M here while `useBlockNumber` returns the
  // ~47.1M L2 head — the panel would conclude the lockout was open at every
  // moment of its duration and invite a transaction that must revert. See
  // `_blockNumber()` in ToshLaunchpadHook.
  //
  // Worth knowing what this is worth: blocks are 100 ms and the lockout is one
  // of them, so at a 4 s poll this condition is almost never observed true. It
  // stays because it costs nothing and the alternative to a stale `false` is a
  // wallet popup for a doomed transaction — but it is not load-bearing, and the
  // contract remains the thing that actually enforces the rule.
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
  // `quoteData === undefined` and `0n` are different answers and the `??` below
  // erases the difference, so the three states are separated here before
  // anything downstream can conflate them:
  //
  //   • no quote yet      — in flight, or refetching after an input change
  //   • the call reverted — an RPC fault, or a hook state the read rejects
  //   • a quote of 0n     — a real answer, and the only one that means dust
  //
  // Both of the first two used to collapse into "the cost is zero". That armed
  // the button with `value: 0n` against a payable mint, which the hook can only
  // reject — a transaction that cannot succeed, submitted by a user who was
  // shown no reason not to, and paid for in gas. It also mislabelled the
  // ordinary in-flight moment as dust, telling anyone who typed and looked
  // quickly to "raise it until the order is worth a wei".
  const hasQuote = quoteData !== undefined
  const quoteCost = (quoteData as bigint | undefined) ?? 0n
  const quotePending = quotable && !quoteFailed && !hasQuote
  const quoteUnavailable = quotable && quoteFailed
  const isDust = quotable && !quoteFailed && hasQuote && quoteCost === 0n
  // `isQuoting` also covers a refetch over a stale figure, which is exactly when
  // showing the old number would be worst: the amount on screen no longer
  // matches the amount typed.
  const quoteUnknown = quotePending || isQuoting
  // ⚠ THE HEADROOM FLOORS TO ZERO ON SMALL ORDERS, and `maxCost == cost` is a
  //   ceiling the hook can miss by one unit. `(cost * 50) / 10_000` is integer
  //   division, so anything under 200 base units of quote gets no headroom at
  //   all — and the quote asset has 8 decimals, not 18, so 200 units is
  //   0.000002 BEM rather than a rounding error nobody can reach. A single
  //   shelf tick priced there quoted exactly, sent exactly, and reverted
  //   `CostAboveMax` on the first tick of drift.
  //
  //   One unit is the smallest headroom that is still headroom. It keeps the
  //   0.5% intent everywhere it is representable and refuses to send a ceiling
  //   that only holds if the price does not move at all.
  const quoteSlippage = (() => {
    if (quoteCost === 0n) return 0n
    const bps = (quoteCost * SLIPPAGE_BPS) / 10_000n
    return bps > 0n ? bps : 1n
  })()
  const maxQuoteCost = quoteCost === 0n ? 0n : quoteCost + quoteSlippage
  const insufficientBal = maxQuoteCost > 0n && maxQuoteCost > p.quoteBalance
  const gateLocked = tokenAmountWei > 0n && !unlocked

  // Before anyone has minted, a shut gate is the DESIGNED opening state, not a
  // fault: shelf 0 sits 5% over the pool, so the ladder lifts only once the
  // market holds at or above the genesis price.  Say that instead of alarming.
  const awaitingFirstUnlock = gateLocked && p.phase2Minted === 0n

  const {
    send: sendMint,
    isPending: isMinting,
    isConfirming: isMintConfirming,
    isBusy: txBusy,
  } = useTxAction({
    action: `buy ${p.symbol}`,
    onConfirmed: () => { p.refetch(); setTokenAmount('') },
  })

  const submitMint = useCallback(() => {
    // Belt and braces behind the `quote-pending` / `quote-unavailable` blockers
    // below. A zero-cost mint cannot do anything but revert, so the one thing
    // worth hard-coding here is that we never ask a wallet to sign one — a future
    // reordering of the blocker list should cost a dead button, not the user's gas.
    if (maxQuoteCost === 0n) return
    sendMint({
      address: p.hookAddress, abi: HOOK_ABI,
      functionName: 'mintBondingCurve',
      // THE SLIPPAGE BOUND MOVED FROM `value` INTO THE ARGUMENTS, and it kept its
      // meaning exactly: the hook charges the true cost and refuses to exceed this
      // ceiling. What changed is that a payable call enforced the bound by simply
      // not having more money available, whereas a pull enforces it explicitly —
      // `maxCost` is now a promise the contract checks rather than a wallet limit.
      //
      // The practical consequence is the residue. The hook pulls the true cost and
      // leaves `maxQuoteCost - cost` approved but unspent, which is why
      // `useQuoteApproval` had to be sure BEM tolerates overwriting a live
      // allowance. It does; see the fork test named in that file.
      args: [tokenAmountWei, maxQuoteCost],
    })
  }, [p.hookAddress, tokenAmountWei, maxQuoteCost, sendMint])

  /*
   * The allowance in front of the mint.
   *
   * Granted to the HOOK, not the factory — the opposite of the genesis deposit,
   * and the asymmetry is real rather than an oversight. `factory.deposit` receives
   * the transfer and forwards it, so the factory is the spender there;
   * `mintBondingCurve` is called on the hook directly and pulls for itself.
   *
   * Approved for `maxQuoteCost` rather than the quoted cost, because that is what
   * the hook is permitted to take. Approving the quote exactly would make every
   * mint fail the moment the shelf moved under it — which is the situation the
   * slippage headroom exists to absorb.
   */
  const approval = useQuoteApproval(p.hookAddress, maxQuoteCost)

  // Rungs climbed since shelf 0, i.e. STEP^index.  Measured against the LADDER
  // base rather than the pool's opening price, so the flat 5% mint premium
  // does not masquerade as ladder progress.
  const premiumRaw =
    p.shelfP0 > 0n && p.currentPrice > 0n
      ? Number(p.currentPrice * 1000n / p.shelfP0) / 1000
      : 1

  // Ordered to match `hook.mintBondingCurve`, which rejects in exactly this
  // sequence: LadderMintingHalted, then SameBlockMintForbidden, and only then
  // reaches the per-leg checks that produce SpanTooManyShelves and
  // TierPriceAboveCeiling.  The cascade this replaces put `exceedsMax` ahead of
  // `sameBlockLock`, so a buyer who typed too much during a same-block lockout
  // was told to send a smaller order — which would have reverted too.  The truth
  // was "wait one block", and lowering the amount could never reveal it.
  const gate = useActionGate({
    action: `buy ${p.symbol}`,
    onAct: submitMint,
    tx: { isPending: isMinting, isConfirming: isMintConfirming },
    blockersInRevertOrder: revertOrder(
      {
        id: 'amount-invalid',
        active: tokenAmountInvalid,
        label: 'Check the amount',
        reason: 'That is not a number this field can send as a token amount.',
        tone: 'warn',
      },
      {
        id: 'amount-zero',
        active: !tokenAmountInvalid && tokenAmountWei === 0n,
        label: 'Enter an amount',
        reason: `Enter how many ${p.symbol} to buy.`,
        tone: 'neutral',
      },
      {
        id: 'ladder-halted',
        active: halted,
        label: `Paused · resumes ${haltTxt}`,
        reason: `Shelf minting is suspended by the protocol circuit breaker${haltIsGlobal ? ' platform-wide' : ' for this project'} — it lifts on its own in ${haltTxt}, and the pool keeps trading meanwhile.`,
      },
      {
        id: 'same-block',
        active: sameBlockLock,
        label: 'Paused for this block',
        reason: 'A swap landed in this block, and the contract will not sell from the shelves alongside one. It reopens on the next block.',
        tone: 'warn',
      },
      {
        id: 'exceeds-max',
        active: exceedsMax,
        label: 'Amount too large',
        reason: `A single purchase can take at most ${fmt(maxMintable)} right now — send the rest as a second transaction.`,
      },
      {
        id: 'awaiting-first-unlock',
        active: awaitingFirstUnlock,
        label: 'Waiting for the market',
        reason: 'The first shelf sits 5% above the pool by design, so it opens only once the market price reaches it.',
        tone: 'neutral',
      },
      {
        id: 'gate-locked',
        active: gateLocked,
        label: 'Above the price ceiling',
        reason: 'The next shelf is more than 5% above the current pool price, so it stays shut until the market catches up.',
      },
      {
        id: 'no-capacity',
        active: noCapacity,
        label: 'No supply available',
        reason: 'No shelf can serve any amount right now — the ladder is either sold out or priced out at the margin.',
      },
      {
        id: 'quote-pending',
        active: quotePending,
        label: 'Checking the price…',
        reason: `Working out what ${p.symbol} costs at the current shelf. The button arms as soon as the price comes back.`,
        tone: 'neutral',
      },
      {
        id: 'quote-unavailable',
        active: quoteUnavailable,
        label: 'Price unavailable',
        reason: 'No price came back for that amount, so there is nothing to attach to the transaction. This is usually a network hiccup — it retries every few seconds.',
        tone: 'warn',
      },
      {
        id: 'dust',
        active: isDust,
        label: 'Amount too small',
        // "At least a wei" was the old wording and it is now doubly wrong: the
        // cost is not in the native coin, and the quote asset's smallest unit is
        // 1e-8 rather than 1e-18. The threshold is also ten orders of magnitude
        // less forgiving than it was, so a token amount that used to round to a
        // nonzero cost can now genuinely round to nothing — this blocker fires far
        // more often than it did, and its copy has to be about the real limit.
        reason: `That amount costs less than the smallest unit of ${QUOTE_SYMBOL} the shelf can charge for. Raise it until the order is worth at least 0.00000001 ${QUOTE_SYMBOL}.`,
        tone: 'warn',
      },
      {
        id: 'balance',
        active: insufficientBal,
        label: `Not enough ${QUOTE_SYMBOL}`,
        reason: `This wallet does not hold the quoted cost plus its slippage headroom — ${fmtQuote(maxQuoteCost)} ${QUOTE_SYMBOL} in total.`,
        tone: 'warn',
      },
      {
        // Last, so it wins once the order is otherwise sendable. Same reasoning as
        // the genesis panel: approving is pointless while the amount is unquotable,
        // dust or unaffordable, so every one of those speaks first.
        id: 'approve',
        active:
          maxQuoteCost > 0n && !insufficientBal && !isDust
          && !quoteUnknown && !quoteUnavailable && approval.needsApproval,
        label: approval.tx.isBusy
          ? 'Approving…'
          : `Approve ${fmtQuote(maxQuoteCost)} ${QUOTE_SYMBOL}`,
        reason: `The shelf pulls ${QUOTE_SYMBOL} from your wallet rather than being sent it, so it needs permission for up to ${fmtQuote(maxQuoteCost)} ${QUOTE_SYMBOL} — the quoted cost plus slippage headroom. It only ever takes the real cost; the difference stays yours.`,
        tone: 'info',
        resolve: approval.approve,
      },
    ),
  })

  const armed = gate.verdict.kind === 'ready'

  // Terse, and only about the number that was typed.  The gate below already
  // states every blocker in full under the button, so anything market-shaped —
  // a shut gate, a halt, no capacity — is deliberately absent: printing the same
  // sentence twice, a hundred pixels apart, reads as two separate problems.
  // What is left here is the red border and a three-word tag; the button carries
  // the explanation and the remedy.
  const amountError =
      tokenAmountInvalid ? 'NOT A NUMBER'
    : exceedsMax         ? 'TOO BIG FOR ONE ORDER'
    : isDust             ? 'COSTS LESS THAN A UNIT'
    : insufficientBal    ? 'ABOVE YOUR BALANCE'
    : null

  // Not faults.  A shut gate before the first mint is the designed opening
  // state, and a same-block lock clears by itself on the next block — colouring
  // either of them as an error was the thing the old cascade got wrong.
  const amountHint =
      sameBlockLock       ? 'THE LADDER IS SHUT FOR THIS BLOCK — IT REOPENS ON THE NEXT ONE'
    : awaitingFirstUnlock ? 'THE LADDER OPENS ONCE THE MARKET REACHES THE FIRST SHELF'
    : maxMintable > 0n    ? `UP TO ${fmt(maxMintable)} IN ONE ORDER · SWEEPS SHELVES`
    : undefined

  // Not memoised, and that is not an oversight: `ProjectTerminal` re-renders
  // this whole subtree once a second off the shared clock regardless, so a
  // stable value object would save nothing while adding a thirty-entry
  // dependency array to keep correct.
  const value: BondingState = {
    p,
    status, unlocked, halted, haltIsGlobal, haltTxt, premiumRaw,
    tokenAmount, setTokenAmount,
    quotable, quoteCost, maxQuoteCost, quoteUnknown, quoteUnavailable, isDust,
    txBusy, amountError, amountHint,
    sameBlockLock, awaitingFirstUnlock,
    gate, armed,
  }

  return <BondingCtx.Provider value={value}>{children}</BondingCtx.Provider>
}
