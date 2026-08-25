'use client'
import { useState, useEffect, useCallback } from 'react'
import {
  useReadContract, useReadContracts, useBlockNumber,
  useWriteContract, useWaitForTransactionReceipt,
} from 'wagmi'
import { parseUnits, type Address, type ContractFunctionParameters } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI, TARGET_CHAIN_ID,
  TIER_COUNT, TIER_SIZE,
} from '@/lib/contracts'
import {
  Card, Readout, Field, ActionButton, useActionGate, revertOrder,
} from '@/components/ui'
import { fmt } from './format'
import { AlarmLine, TxLine } from './primitives'
import { ShelfLadder } from './ShelfLadder'

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
  const status = statusRaw as
    | readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean]
    | undefined
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
  const ethCost = (quoteData as bigint | undefined) ?? 0n
  const isDust = quotable && !quoteFailed && ethCost === 0n
  const maxEthCost = ethCost === 0n ? 0n : ethCost + (ethCost * SLIPPAGE_BPS) / 10_000n
  const insufficientBal = maxEthCost > 0n && maxEthCost > p.ethBalance
  const gateLocked = tokenAmountWei > 0n && !unlocked

  // Before anyone has minted, a shut gate is the DESIGNED opening state, not a
  // fault: shelf 0 sits 5% over the pool, so the ladder lifts only once the
  // market holds at or above the genesis price.  Say that instead of alarming.
  const awaitingFirstUnlock = gateLocked && p.phase2Minted === 0n

  const {
    writeContract: writeMint,
    isPending:     isMinting,
    data:          mintHash,
    error:         mintError,
  } = useWriteContract()
  const { isLoading: isMintConfirming, isSuccess: mintedNow } =
    useWaitForTransactionReceipt({ hash: mintHash })
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (mintedNow) { p.refetch(); setTokenAmount('') } }, [mintedNow, p])

  const txBusy = isMinting || isMintConfirming

  // Nothing is re-checked here — the gate owns that, and keeping a second copy
  // of the conditions is how this list and the button's cascade came to disagree
  // about which one wins.
  const submitMint = useCallback(() => {
    writeMint({
      address: p.hookAddress, abi: HOOK_ABI,
      functionName: 'mintBondingCurve',
      args: [tokenAmountWei],
      value: maxEthCost,
      chainId: TARGET_CHAIN_ID,
    })
  }, [p.hookAddress, tokenAmountWei, maxEthCost, writeMint])

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
        label: '[invalid_amount]',
        reason: 'That is not a number this field can send as a token amount.',
        tone: 'warn',
      },
      {
        id: 'amount-zero',
        active: !tokenAmountInvalid && tokenAmountWei === 0n,
        label: '[enter_amount]',
        reason: `Enter how many ${p.symbol} to mint.`,
        tone: 'neutral',
      },
      {
        id: 'ladder-halted',
        active: halted,
        label: `[ladder_halted · resumes ${haltTxt}]`,
        reason: `Shelf minting is suspended by the protocol circuit breaker${haltIsGlobal ? ' platform-wide' : ' for this project'} — it lifts on its own in ${haltTxt}, and the pool keeps trading meanwhile.`,
      },
      {
        id: 'same-block',
        active: sameBlockLock,
        label: '[minting_shut_this_block]',
        reason: 'A swap landed in this block and the hook refuses to mint alongside it — the ladder reopens on the next block.',
        tone: 'warn',
      },
      {
        id: 'exceeds-max',
        active: exceedsMax,
        label: '[exceeds_max_per_call]',
        reason: `One call can serve at most ${fmt(maxMintable)} right now — send the rest in a second transaction.`,
      },
      {
        id: 'awaiting-first-unlock',
        active: awaitingFirstUnlock,
        label: '[awaiting_market_above_p0]',
        reason: 'Shelf 0 sits 5% over the pool by design, so the ladder opens only once the market holds at or above P₀.',
        tone: 'neutral',
      },
      {
        id: 'gate-locked',
        active: gateLocked,
        label: '[gate_locked]',
        reason: 'The 105% price gate is shut — the next shelf is above the ceiling until spot or TWAP catches up.',
      },
      {
        id: 'no-capacity',
        active: noCapacity,
        label: '[no_size_available]',
        reason: 'The hook will serve no size at all in one call right now — the ladder is either fully sold or priced out at the margin.',
      },
      {
        id: 'dust',
        active: isDust,
        label: '[invalid_amount]',
        reason: 'That amount quotes to zero ETH — raise it until the order is worth a wei.',
        tone: 'warn',
      },
      {
        id: 'balance',
        active: insufficientBal,
        label: '[insufficient_eth]',
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
    : exceedsMax         ? 'ABOVE THE PER-CALL MAX'
    : isDust             ? 'QUOTES TO ZERO'
    : insufficientBal    ? 'ABOVE YOUR BALANCE'
    : null

  // Not faults.  A shut gate before the first mint is the designed opening
  // state, and a same-block lock clears by itself on the next block — colouring
  // either of them as an error was the thing the old cascade got wrong.
  const amountHint =
      sameBlockLock       ? 'MINTING IS SHUT FOR THIS BLOCK — THE LADDER REOPENS NEXT BLOCK'
    : awaitingFirstUnlock ? 'LADDER OPENS ONCE THE MARKET HOLDS AT OR ABOVE P₀'
    : maxMintable > 0n    ? `UP TO ${fmt(maxMintable)} IN ONE CALL · SWEEPS SHELVES`
    : undefined

  return (
    <Card
      id="P-2"
      title={`SHELF LADDER · ${p.symbol}`}
      subtitle="hook.mintBondingCurve{value}(tokenAmount) · 4000 rungs to 2000× · sweeps shelves · 105% min(spot, TWAP) gate"
    >
      <ShelfLadder hookAddress={p.hookAddress} p0={p.p0} halted={halted} />

      {halted && (
        <div className="border border-danger/40 px-4 py-3 flex flex-col gap-1">
          <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-danger">
            → LADDER SUSPENDED · {haltIsGlobal ? 'PLATFORM-WIDE' : 'THIS PROJECT'} · LIFTS IN {haltTxt}
          </p>
          <p className="font-mono text-[11px] text-[#888] leading-relaxed">
            The protocol owner has tripped the circuit breaker, so the hook
            rejects every <span className="text-white">mintBondingCurve</span> call
            until it expires. The pool itself is untouched — the token still
            trades on Uniswap, existing balances are unaffected, and the halt
            lapses on its own without any further action.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6">
        <Readout label="P₀ · POOL OPEN"
                 value={`${fmt(p.p0)} ETH`}
                 hint="genesis LP price" />
        <Readout label="SHELF 0 · +5%"
                 value={`${fmt(p.shelfP0)} ETH`}
                 hint="mint premium over market" />
        <Readout label="ACTIVE SHELF"
                 value={`${fmt(p.currentPrice)} ETH`}
                 hint={`${premiumRaw.toFixed(2)}× ladder base`} />
        <Readout label="PHASE-2 MINTED"
                 value={`${fmt(p.phase2Minted)} / ${fmt(p.bondingMax)}`}
                 hint={`${TIER_COUNT} shelves × ${fmt(TIER_SIZE)}`} />
      </div>

      <Field
        label="TOKEN AMOUNT TO MINT"
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
        <div className="border border-[#1F1F2E]">
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-x divide-[#1F1F2E]">
            <div className="px-4 py-3 flex flex-col gap-1">
              <span className="font-mono text-label text-text-tertiary">QUOTED COST</span>
              <span className="font-mono text-base text-white tabular-nums">
                {isQuoting ? '…' : `${fmt(ethCost)} ETH`}
              </span>
            </div>
            <div className="px-4 py-3 flex flex-col gap-1">
              <span className="font-mono text-label text-text-tertiary">MAX W/ 0.5% SLIPPAGE</span>
              <span className="font-mono text-base text-white tabular-nums">
                {fmt(maxEthCost)} ETH
              </span>
            </div>
            <div className="px-4 py-3 flex flex-col gap-1">
              <span className="font-mono text-label text-text-tertiary">L-01 GUARD</span>
              {isDust
                ? <span className="font-mono text-base text-brand">→ L-01_LOCKED</span>
                : <span className="font-mono text-base text-brand">L-01_invariant: verified.</span>}
            </div>
          </div>
          <p className="px-4 py-2 border-t border-[#1F1F2E] text-[10px] font-mono text-[#555] tracking-wider break-all">
            msg.value = {maxEthCost.toString()} wei · excess refunded
          </p>
        </div>
      )}

      <ActionButton gate={gate} />

      <AlarmLine msg={mintError?.message?.slice(0, 200) ?? null} />
      <TxLine hash={mintHash} label="mintBondingCurve" />
    </Card>
  )
}
