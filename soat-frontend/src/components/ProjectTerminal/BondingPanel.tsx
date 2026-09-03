'use client'
import { useState, useCallback } from 'react'
import {
  useReadContract, useReadContracts, useBlockNumber,
} from 'wagmi'
import { parseUnits, type Address, type ContractFunctionParameters } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI,
} from '@/lib/contracts'
import {
  Badge, Card, Readout, Field, ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { fmt } from './format'
import { ShelfLadder, type TierStatus } from './ShelfLadder'

/** Buy-side slippage tolerance in basis points (0.5 %).  Padded into the
 *  on-chain quote and sent as `msg.value`; excess ETH is refunded by the hook. */
const SLIPPAGE_BPS = 50n


// ─────────────────────────────────────────────────────────────────────────────
// BONDING PANEL  ·  Phase 2
// ─────────────────────────────────────────────────────────────────────────────

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
  ethBalance:   bigint
  nowSec:       number
  refetch:      () => void
}

export function BondingPanel(p: BondingProps) {
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
  const ethCost = (quoteData as bigint | undefined) ?? 0n
  const quotePending = quotable && !quoteFailed && !hasQuote
  const quoteUnavailable = quotable && quoteFailed
  const isDust = quotable && !quoteFailed && hasQuote && ethCost === 0n
  // `isQuoting` also covers a refetch over a stale figure, which is exactly when
  // showing the old number would be worst: the amount on screen no longer
  // matches the amount typed.
  const quoteUnknown = quotePending || isQuoting
  const maxEthCost = ethCost === 0n ? 0n : ethCost + (ethCost * SLIPPAGE_BPS) / 10_000n
  const insufficientBal = maxEthCost > 0n && maxEthCost > p.ethBalance
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
    // below. `mintBondingCurve` is payable and a zero-value call cannot do
    // anything but revert, so the one thing worth hard-coding here is that we
    // never ask a wallet to sign one — a future reordering of the blocker list
    // should cost a dead button, not the user's gas.
    if (maxEthCost === 0n) return
    sendMint({
      address: p.hookAddress, abi: HOOK_ABI,
      functionName: 'mintBondingCurve',
      args: [tokenAmountWei],
      value: maxEthCost,
    })
  }, [p.hookAddress, tokenAmountWei, maxEthCost, sendMint])

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
        reason: 'That amount costs less than the smallest unit of ETH. Raise it until it is worth at least a wei.',
        tone: 'warn',
      },
      {
        id: 'balance',
        active: insufficientBal,
        label: 'Not enough ETH',
        reason: 'This wallet does not hold the quoted cost plus its slippage headroom.',
        tone: 'warn',
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
    : isDust             ? 'COSTS LESS THAN A WEI'
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

  return (
    <Card
      id="P-2"
      title={`SHELF LADDER · ${p.symbol}`}
      subtitle="Buy straight from the ladder. One order sweeps as many shelves as it needs, and a 105% ceiling stops it clearing far above the market price."
    >
      <ShelfLadder hookAddress={p.hookAddress} p0={p.p0} halted={halted} status={status} />

      {halted && (
        <div className="border border-danger/40 px-4 py-3 flex flex-col gap-1">
          <p className="font-mono text-label tracking-[0.32em] uppercase text-danger">
            → LADDER SUSPENDED · {haltIsGlobal ? 'PLATFORM-WIDE' : 'THIS PROJECT'} · LIFTS IN {haltTxt}
          </p>
          <p className="font-mono text-note text-text-tertiary leading-relaxed">
            The protocol owner has tripped the circuit breaker, so the contract
            turns away every shelf purchase until it expires. The pool itself is
            untouched — the token still
            trades on Uniswap, existing balances are unaffected, and the halt
            lapses on its own without any further action.
          </p>
        </div>
      )}

      {/* Stacked so the three prices match the hand-rolled gate cell beside
          them, and so a price never has to share ~90px with its own label. */}
      <div className="grid grid-cols-2 gap-6 @lg:grid-cols-4">
        <Readout layout="stack"
                 label="OPENING PRICE"
                 value={`${fmt(p.p0)} ETH`}
                 hint="what the pool started at" />
        <Readout layout="stack"
                 label="FIRST SHELF · +5%"
                 value={`${fmt(p.shelfP0)} ETH`}
                 hint="premium over the market" />
        <Readout layout="stack"
                 label="ACTIVE SHELF"
                 value={`${fmt(p.currentPrice)} ETH`}
                 hint={`${premiumRaw.toFixed(2)}× ladder base`} />
        <div className="flex flex-col gap-gap-tight border-b border-border-subtle pb-gap">
          <span className="font-mono text-label text-text-quiet">105% gate</span>
          {halted ? (
            <Badge tone="danger">halted</Badge>
          ) : sameBlockLock ? (
            <Badge tone="warn">same-block lock</Badge>
          ) : awaitingFirstUnlock ? (
            <Badge tone="neutral">awaiting market</Badge>
          ) : unlocked ? (
            <Badge tone="ok" pip live>open</Badge>
          ) : (
            <Badge tone="warn">locked</Badge>
          )}
          <span className="text-note text-text-tertiary">
            {fmt(p.phase2Minted)} / {fmt(p.bondingMax)} sold
          </span>
        </div>
      </div>

      <Field
        label="AMOUNT TO BUY"
        value={tokenAmount}
        onValueChange={setTokenAmount}
        placeholder="e.g. 1000"
        inputMode="decimal"
        disabled={txBusy || !p.isConnected || halted}
        error={amountError}
        armed={armed}
        hint={amountHint}
      />

      {quotable && (
        <div className="border border-border-subtle">
          <div className="grid grid-cols-1 @md:grid-cols-3 divide-y divide-border-subtle @md:divide-x @md:divide-y-0">
            <Readout
              layout="stack"
              className="px-4 py-3"
              label="QUOTED COST"
              value={quoteUnknown ? '…' : quoteUnavailable ? 'Unavailable' : `${fmt(ethCost)} ETH`}
              tone={quoteUnavailable ? 'warn' : 'ink'}
            />
            <Readout
              layout="stack"
              className="px-4 py-3"
              label="MOST YOU CAN PAY"
              // Only one of these three cells used to admit it was waiting. The
              // other two read straight off `maxEthCost`, which is 0n until the
              // quote lands — so the panel spent every in-flight moment stating
              // that the order costs nothing and sends nothing. A ceiling of
              // "0 ETH" is not a pending state, it is a wrong answer.
              value={quoteUnknown || quoteUnavailable ? '…' : `${fmt(maxEthCost)} ETH`}
              hint="0.5% over the quote; the difference comes back"
            />
            <Readout
              layout="stack"
              className="px-4 py-3"
              label="ORDER SIZE"
              value={quoteUnknown ? '…' : isDust ? 'Below minimum' : 'Accepted'}
              tone={isDust ? 'warn' : 'ok'}
              hint={isDust ? 'Raise the amount until it costs at least a wei' : undefined}
            />
          </div>
        </div>
      )}

      <ActionButton gate={gate} />
    </Card>
  )
}
