'use client'
import { useState, useCallback, useMemo } from 'react'
import { useReadContract } from 'wagmi'
import { parseUnits, parseEventLogs, erc20Abi, type Address } from 'viem'

import {
  PERMIT2, CL_POSITION_MANAGER, QUOTE_ASSET, QUOTE_DECIMALS, QUOTE_SYMBOL,
} from '@/lib/contracts'
import { POSM_ABI, PERMIT2_ABI } from '@/lib/lpAbis'
import { pairedAmount1, liquidityForAmounts, amountsForLiquidity } from '@/lib/clMath'
import { encodeMintPayload, encodeBurnPayload } from '@/lib/lpActions'
import {
  useLpPoolState,
  useLpPositions,
  rememberLpPosition,
  lpScanCoverageLabel,
} from '@/lib/useLpPosition'
import {
  Card, Readout, Field, ActionButton, useActionGate, revertOrder, useTxAction, toshToast,
  CLOCK_UNSYNCED,
} from '@/components/ui'
import type { TxReceipt } from '@/components/ui/useTxAction'
import { fmt, fmtQuote } from './format'

const LP_SLIPPAGE_PRESETS = [
  { bps: 50n,  label: '0.5%' },
  { bps: 100n, label: '1%' },
  { bps: 200n, label: '2%' },
  { bps: 500n, label: '5%' },
] as const


// ─────────────────────────────────────────────────────────────────────────────
// LIQUIDITY PANEL  ·  retail market making
//
// The hook deliberately leaves BEFORE_REMOVE_LIQUIDITY off its address mask, so
// third-party LPs add and remove freely — Infinity never even calls into Tosh
// code on those paths.  What was missing was a front door: posm positions are ERC-721s
// behind a Permit2 approval dance, which is not something a retail user is
// going to hand-assemble.
//
// Scope is deliberately ONE range: the same full range the genesis position
// uses.  A range picker would mean teaching ticks, and concentrated LPs are
// already served by dedicated tooling.
// ─────────────────────────────────────────────────────────────────────────────

/** Permit2 allowances are uint160 and carry their own expiry. */
export const MAX_UINT160 = (1n << 160n) - 1n
export const PERMIT2_TTL_SECONDS = 60n * 60n * 24n * 30n
export const TX_DEADLINE_SECONDS = 60n * 20n

export function LiquidityPanel({
  hookAddress, tokenAddress, symbol, userAddress, isConnected, quoteBalance, nowSec,
}: {
  hookAddress:  Address
  tokenAddress: Address | undefined
  symbol:       string
  userAddress:  Address | undefined
  isConnected:  boolean
  quoteBalance:   bigint
  /** Ticking clock lifted to the parent, so render stays pure. */
  nowSec:       number
}) {
  const [quoteAmount, setEthAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(100n)

  const { sqrtPriceX96, totalLiquidity, hooksRegistrationBitmap } =
    useLpPoolState(tokenAddress, hookAddress)
  const { positions, totals, degraded, refresh } =
    useLpPositions(userAddress, hookAddress, sqrtPriceX96)

  // Derived from the chain definition, so it is constant for a build; read once
  // rather than per render.
  const scanCoverage = useMemo(() => lpScanCoverageLabel(), [])

  const poolAmounts = amountsForLiquidity(sqrtPriceX96, totalLiquidity)

  const quoteUnits = (() => {
    const t = quoteAmount.trim()
    if (!t) return 0n
    try { return parseUnits(t, QUOTE_DECIMALS) } catch { return -1n }
  })()
  const quoteInvalid = quoteUnits === -1n

  // What the pool will pull for the token leg, plus the same 0.5% headroom the
  // shelf mint uses.  posm reverts on `amountNMax`, so under-quoting is fatal
  // while over-quoting is refunded by SWEEP / left unspent.
  const tokenNeeded = quoteUnits > 0n ? pairedAmount1(sqrtPriceX96, quoteUnits) : 0n
  const quoteMax   = quoteUnits   + (quoteUnits   * slippageBps) / 10_000n
  const tokenMax = tokenNeeded + (tokenNeeded * slippageBps) / 10_000n

  const { data: tokenBalance } = useReadContract({
    address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf',
    args: userAddress ? [userAddress] : undefined,
    query: { enabled: !!tokenAddress && !!userAddress, refetchInterval: 12_000 },
  })
  const { data: permit2Allowance, refetch: refetchErc20 } = useReadContract({
    address: tokenAddress, abi: erc20Abi, functionName: 'allowance',
    args: userAddress ? [userAddress, PERMIT2] : undefined,
    query: { enabled: !!tokenAddress && !!userAddress, refetchInterval: 12_000 },
  })
  const { data: posmAllowance, refetch: refetchPermit2 } = useReadContract({
    address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance',
    args: userAddress && tokenAddress ? [userAddress, tokenAddress, CL_POSITION_MANAGER] : undefined,
    query: { enabled: !!tokenAddress && !!userAddress, refetchInterval: 12_000 },
  })

  /*
   * ─────────────────────────────────────────────────────────────────────────────
   * THE QUOTE LEG NOW NEEDS THE SAME DANCE, AND IT USED TO NEED NOTHING
   * ─────────────────────────────────────────────────────────────────────────────
   *
   * This panel's three-step flow — approve the token for Permit2, let Permit2 fund
   * the position manager, mint — existed only for the TOKEN leg. The other leg was
   * native ETH and arrived as `msg.value`, so there was nothing to authorise: one
   * side of the position was pushed and the other pulled.
   *
   * Both sides are pulled now, and both pull through Permit2, so the flow is five
   * steps rather than three. That is not a doubling of the old dance dressed up as
   * two more buttons; it is the same two-stage authorisation applied to a second
   * token, because Permit2's allowances are per-token and knowing about BEM says
   * nothing about the project token.
   *
   * WHICH PERMIT2. PancakeSwap's, at `0x31c2…c768`, not Uniswap's canonical
   * `0x0000…8BA3`. Both are live on BSC and both are working Permit2 deployments,
   * which is what made getting it wrong survive testing: approving the canonical
   * one succeeds, and the mint then reverts `AllowanceExpired` naming a contract
   * the user never approved. `PERMIT2` in `contracts.ts` carries the full note;
   * `ToshV5Fork.t.sol` asserts the position manager agrees with it.
   */
  const { data: quotePermit2Allowance, refetch: refetchQuoteErc20 } = useReadContract({
    address: QUOTE_ASSET, abi: erc20Abi, functionName: 'allowance',
    args: userAddress ? [userAddress, PERMIT2] : undefined,
    query: { enabled: !!userAddress, refetchInterval: 12_000 },
  })
  const { data: quotePosmAllowance, refetch: refetchQuotePermit2 } = useReadContract({
    address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance',
    args: userAddress ? [userAddress, QUOTE_ASSET, CL_POSITION_MANAGER] : undefined,
    query: { enabled: !!userAddress, refetchInterval: 12_000 },
  })

  const nowSeconds = BigInt(nowSec)

  // `undefined` means the read has not landed; `0n` means the chain answered
  // zero. Coalescing them with `?? 0n` made every gate below state the pending
  // case as fact — a fully funded LP was told "the wallet holds 0" for the
  // first few hundred milliseconds after typing, and someone already holding a
  // MAX_UINT160 approval was offered "Step 1 of 3 — approve" with a live
  // handler, so clicking paid gas for a no-op. The panel already blocks on
  // other unresolved reads (`token-unresolved`, `pool-price`, `clock-unsynced`);
  // these two were the ones that slipped through.
  const balanceUnresolved   = !!userAddress && tokenBalance === undefined
  // Four allowances now, and the same argument covers all of them: an unresolved
  // read must not be presented as a zero allowance, or a user who has already
  // approved is offered a live approve button that pays gas for a no-op.
  const allowanceUnresolved = !!userAddress && (
    permit2Allowance === undefined || posmAllowance === undefined
    || quotePermit2Allowance === undefined || quotePosmAllowance === undefined
  )
  const readsUnresolved     = tokenMax > 0n && (balanceUnresolved || allowanceUnresolved)

  // Compared against the deadline the transaction will actually carry, not
  // against now. Permit2 checks `expiration` when the block executes, so an
  // allowance with ten seconds left passes a check against `now` and then
  // reverts `AllowanceExpired` on arrival.
  const mintDeadline = nowSeconds + TX_DEADLINE_SECONDS

  const needsErc20Approval =
    tokenMax > 0n && permit2Allowance !== undefined && permit2Allowance < tokenMax
  const needsPermit2Approval =
    tokenMax > 0n &&
    posmAllowance !== undefined &&
    (posmAllowance[0] < tokenMax || BigInt(posmAllowance[1]) <= mintDeadline)

  // The same two conditions for the quote leg. Gated on `quoteMax` rather than
  // `tokenMax` so a position that needs only one leg topped up does not demand
  // approvals for the other — they are separate amounts and can be separately
  // covered.
  const needsQuoteErc20Approval =
    quoteMax > 0n && quotePermit2Allowance !== undefined && quotePermit2Allowance < quoteMax
  const needsQuotePermit2Approval =
    quoteMax > 0n &&
    quotePosmAllowance !== undefined &&
    (quotePosmAllowance[0] < quoteMax || BigInt(quotePosmAllowance[1]) <= mintDeadline)

  const insufficientQuote   = quoteMax > 0n && quoteMax > quoteBalance
  const insufficientToken =
    tokenMax > 0n && tokenBalance !== undefined && tokenMax > tokenBalance

  // This panel sends three different transactions through one `send`, so the
  // confirmation handler has to work out which one came back. It used to not
  // bother, and ran its full mint-completed routine after an APPROVAL too: a
  // user typed 0.5, clicked "Step 1 of 3 — approve", and the amount was cleared
  // out from under them before they reached step 3.
  //
  // The discriminator is the receipt itself rather than a "what did I last
  // send" flag. A mint hands the user a posm ERC-721, so a `Transfer` to their
  // address in these logs IS the mint, observed rather than remembered — no
  // cross-render mutable state, and no way for the marker to be stale if a
  // second transaction is sent before the first confirms.
  const onConfirmed = useCallback((receipt: TxReceipt) => {
    /*
     * Allowances can move on any of the five, so always re-read all four.
     *
     * All FOUR, which the first version of this got wrong by re-reading only the
     * token's pair. The failure is silent and total: `useReadContract` has no reason
     * to refetch on someone else's receipt, so approving the quote asset would
     * confirm, the toast would say so, and the step indicator would stay lit on
     * step 3 with the button still disabled — a dead end the user can only escape
     * by reloading the page.
     */
    void refetchErc20(); void refetchPermit2()
    void refetchQuoteErc20(); void refetchQuotePermit2()
    if (!userAddress) return

    let minted = false
    try {
      const events = parseEventLogs({
        abi: POSM_ABI, eventName: 'Transfer', logs: receipt.logs,
      })
      for (const ev of events) {
        if (ev.args.to.toLowerCase() === userAddress.toLowerCase()) {
          // Cache the tokenId so the position shows up even when the RPC's log
          // index lags or `eth_getLogs` is unavailable on this endpoint.
          rememberLpPosition(userAddress, hookAddress, ev.args.id)
          minted = true
        }
      }
    } catch { /* nothing to cache — the scan will still find it */ }

    void refresh()
    if (minted) setEthAmount('')
  }, [
    userAddress, hookAddress, refresh,
    refetchErc20, refetchPermit2, refetchQuoteErc20, refetchQuotePermit2,
  ])

  // One receipt watcher, inside `useTxAction`. This panel used to open a second
  // one on the same hash and gate on its `isSuccess`, which resolves for a
  // transaction that mined AND REVERTED — so a failed `modifyLiquidities`
  // (expired Permit2, slippage miss, `amountNMax` breach) wiped the user's
  // input and refetched state that had not changed, while the toast correctly
  // reported the failure. `useTxAction` already separates `receipt.status`
  // from "the receipt arrived"; taking the receipt from it rather than
  // re-fetching one keeps that distinction in a single place.
  const { send, isBusy: busy } = useTxAction({
    action: 'liquidity',
    onConfirmed,
  })

  const approveErc20 = useCallback(() => {
    if (!tokenAddress) return
    send({
      address: tokenAddress, abi: erc20Abi, functionName: 'approve',
      args: [PERMIT2, MAX_UINT160],
    })
  }, [tokenAddress, send])

  const approvePermit2 = useCallback(() => {
    if (!tokenAddress) return
    send({
      address: PERMIT2, abi: PERMIT2_ABI, functionName: 'approve',
      args: [
        tokenAddress, CL_POSITION_MANAGER, MAX_UINT160,
        Number(nowSeconds + PERMIT2_TTL_SECONDS),
      ],
    })
  }, [tokenAddress, nowSeconds, send])

  // The quote leg's two, identical in shape and pointed at the other token. No
  // `tokenAddress` guard: `QUOTE_ASSET` is a module constant that exists before
  // any project does, which is why these are the two steps that can be taken
  // while the token read is still in flight.
  const approveQuoteErc20 = useCallback(() => {
    send({
      address: QUOTE_ASSET, abi: erc20Abi, functionName: 'approve',
      args: [PERMIT2, MAX_UINT160],
    })
  }, [send])

  const approveQuotePermit2 = useCallback(() => {
    send({
      address: PERMIT2, abi: PERMIT2_ABI, functionName: 'approve',
      args: [
        QUOTE_ASSET, CL_POSITION_MANAGER, MAX_UINT160,
        Number(nowSeconds + PERMIT2_TTL_SECONDS),
      ],
    })
  }, [nowSeconds, send])

  // Hoisted out of the click handler so the gate can refuse a deposit that would
  // mint nothing, instead of the handler discovering it after the user commits.
  const liquidity = useMemo(
    () => (quoteUnits > 0n && sqrtPriceX96 > 0n
      ? liquidityForAmounts(sqrtPriceX96, quoteUnits, tokenNeeded)
      : 0n),
    [quoteUnits, sqrtPriceX96, tokenNeeded],
  )

  const addLiquidity = useCallback(() => {
    if (!userAddress || !tokenAddress) return

    if (hooksRegistrationBitmap === undefined || hooksRegistrationBitmap === 0) return

    const unlockData = encodeMintPayload({
      token: tokenAddress,
      hook: hookAddress,
      hooksRegistrationBitmap,
      owner: userAddress,
      liquidity,
      amount0Max: quoteMax,
      amount1Max: tokenMax,
    })

    send({
      address: CL_POSITION_MANAGER, abi: POSM_ABI, functionName: 'modifyLiquidities',
      args: [unlockData, nowSeconds + TX_DEADLINE_SECONDS],
      // NO `value`, and sending one would now be a donation. This carried
      // `value: quoteMax` while `currency0` was native ETH — the leg funded itself
      // and SWEEP bounced the remainder. `currency0` is an ERC-20 now, so
      // SETTLE_PAIR pulls it through Permit2 and any native value attached here
      // would be settled against nothing and swept to whoever the payload names.
    })
  }, [
    userAddress, tokenAddress, hookAddress, hooksRegistrationBitmap, liquidity,
    quoteMax, tokenMax, nowSeconds, send,
  ])

  const withdraw = useCallback((tokenId: bigint, amount0: bigint, amount1: bigint) => {
    if (!userAddress || !tokenAddress) {
      toshToast.error('Connect a wallet first')
      return
    }

    const unlockData = encodeBurnPayload({
      token: tokenAddress,
      recipient: userAddress,
      tokenId,
      amount0Min: amount0 - (amount0 * slippageBps) / 10_000n,
      amount1Min: amount1 - (amount1 * slippageBps) / 10_000n,
    })

    send({
      address: CL_POSITION_MANAGER, abi: POSM_ABI, functionName: 'modifyLiquidities',
      args: [unlockData, nowSeconds + TX_DEADLINE_SECONDS],
    })
  }, [userAddress, tokenAddress, nowSeconds, send, slippageBps])

  // Terse: the red border plus a short tag.  The gate states each of these in
  // full under the button, including the numbers, so repeating them here would
  // show one fault as two.
  const ethError =
      quoteInvalid        ? 'NOT A NUMBER'
    : insufficientQuote   ? `ABOVE YOUR ${QUOTE_SYMBOL} BALANCE`
    : insufficientToken ? `NEEDS MORE ${symbol}`
    : null

  // One live step at a time, so the CTA always says exactly what the next
  // signature does rather than dumping three buttons on the user at once.  The
  // two approvals are blockers that carry a `resolve`, which is what keeps the
  // button enabled and turns "you are blocked" into "here is the next signature".
  //
  // `quoteInvalid` now precedes the zero check.  It could not before: an
  // unparseable box sets `quoteUnits` to `-1n`, so `quoteUnits <= 0n` matched first and
  // typing a stray letter reported "Enter an ETH amount" at a field that was
  // visibly not empty.
  const gate = useActionGate({
    action: 'Step 3 of 3 — deposit into the pool',
    onAct: addLiquidity,
    tx: { isBusy: busy },
    blockersInRevertOrder: revertOrder(
      {
        id: 'clock-unsynced',
        active: nowSec === CLOCK_UNSYNCED,
        label: 'Syncing the clock…',
        reason: 'Every signature below carries a deadline derived from the wall clock. Until it syncs, that deadline would land in 1970 and Permit2 would reject the position.',
        tone: 'neutral',
      },
      {
        id: 'token-unresolved',
        active: !tokenAddress,
        label: 'Loading the token…',
        reason: 'Still reading this project’s token address.',
        tone: 'neutral',
      },
      {
        id: 'amount-invalid',
        active: quoteInvalid,
        label: 'Check the amount',
        reason: `That is not a number this field can send as ${QUOTE_SYMBOL}.`,
        tone: 'warn',
      },
      {
        id: 'amount-zero',
        active: !quoteInvalid && quoteUnits === 0n,
        label: 'Enter an amount',
        reason: `Enter the amount of ${QUOTE_SYMBOL} to put into the pool.`,
        tone: 'neutral',
      },
      {
        id: 'pool-price',
        active: sqrtPriceX96 === 0n,
        label: 'Pool price unavailable',
        reason: 'The pool price has not come back yet, and a full-range position cannot be sized without it.',
        tone: 'neutral',
      },
      {
        id: 'bitmap-unresolved',
        active: hooksRegistrationBitmap === undefined || hooksRegistrationBitmap === 0,
        label: 'Reading the pool key…',
        reason: 'The hook’s permission bitmap has not come back yet, and a PoolKey cannot be encoded without it.',
        tone: 'neutral',
      },
      {
        id: 'reads-unresolved',
        active: readsUnresolved,
        label: 'Reading your wallet…',
        reason: `Still reading this wallet’s ${symbol} balance and Permit2 allowances. The next step depends on both, so it is named once they land rather than guessed now.`,
        tone: 'neutral',
      },
      {
        id: 'balance-eth',
        active: insufficientQuote,
        label: `Not enough ${QUOTE_SYMBOL}`,
        reason: `This wallet does not hold the deposit plus its ${Number(slippageBps) / 100}% headroom.`,
        tone: 'warn',
      },
      {
        id: 'balance-token',
        active: insufficientToken,
        label: `Not enough ${symbol}`,
        reason: `A full-range position funds both legs — this one needs ${fmt(tokenNeeded)} ${symbol} and the wallet holds ${fmt(tokenBalance ?? 0n)}.`,
        // `?? 0n` is safe to print here only because `reads-unresolved` above
        // holds the gate until `tokenBalance` is defined, so this blocker
        // cannot be the active one while the number is still a placeholder.
        tone: 'warn',
      },
      {
        id: 'dust',
        active: liquidity === 0n && quoteUnits > 0n && sqrtPriceX96 > 0n,
        label: 'Amount too small',
        reason: 'That deposit is too small to add any liquidity at the current price. Raise it.',
        tone: 'warn',
      },
      /*
       * FIVE STEPS, and the old copy for two of them was wrong even before the
       * count changed: "approve the token before it can move EITHER leg" was true
       * of a pool whose other leg was native ETH and needed no allowance at all.
       * Permit2's allowances are per-token, so the token approval never had
       * anything to do with the other leg, and now that the other leg is an ERC-20
       * it needs its own pair of steps rather than being covered by these.
       *
       * Ordered quote-leg-first because `revertOrder` surfaces the LAST active
       * blocker, so the token's steps are named first and the quote's steps are
       * reached once the token is done. The numbering below is written to match
       * that traversal, which is why the quote steps carry the higher numbers.
       */
      {
        id: 'approve-erc20',
        active: needsErc20Approval,
        label: `Step 1 of 5 — approve ${symbol} for Permit2`,
        reason: `Permit2 needs a one-time allowance on ${symbol} before it can move the token leg of the position.`,
        tone: 'info',
        resolve: approveErc20,
      },
      {
        id: 'approve-permit2',
        active: needsPermit2Approval,
        label: `Step 2 of 5 — let Permit2 spend your ${symbol}`,
        reason: `Permit2 holds the ${symbol} allowance but has not been told the position manager may draw on it.`,
        tone: 'info',
        resolve: approvePermit2,
      },
      {
        id: 'approve-quote-erc20',
        active: needsQuoteErc20Approval,
        label: `Step 3 of 5 — approve ${QUOTE_SYMBOL} for Permit2`,
        reason: `The other leg is ${QUOTE_SYMBOL} now rather than the chain's own coin, so it is pulled like the token instead of being sent with the transaction. Permit2 needs its own one-time allowance on it.`,
        tone: 'info',
        resolve: approveQuoteErc20,
      },
      {
        id: 'approve-quote-permit2',
        active: needsQuotePermit2Approval,
        label: `Step 4 of 5 — let Permit2 spend your ${QUOTE_SYMBOL}`,
        reason: `Same as step 2, for the ${QUOTE_SYMBOL} leg: Permit2 grants the position manager a spending window per token, and this one has either expired or was never opened.`,
        tone: 'info',
        resolve: approveQuotePermit2,
      },
    ),
  })

  return (
    <Card
      id="P-3"
      // Was `MARKET MAKING · SYM/ETH`. The heading changed when a separate
      // explainer card sat directly above this one and both said the same
      // words. That card is gone; the title stays, because this panel is
      // still about the reader's own position, not about market making in
      // general. Copy only: nothing below moved.
      title={`YOUR LIQUIDITY · ${symbol}/${QUOTE_SYMBOL}`}
      subtitle="Infinity PositionManager · full range · 0.30% pool fee accrues to LPs"
    >
      <div className="grid grid-cols-2 gap-6 @lg:grid-cols-4">
        <Readout layout="stack"
                 label={`POOL DEPTH · ${QUOTE_SYMBOL}`}
                 value={fmtQuote(poolAmounts.amount0)}
                 hint="all LPs incl. genesis" />
        <Readout layout="stack"
                 label={`POOL DEPTH · ${symbol}`}
                 value={fmt(poolAmounts.amount1)}
                 hint="all LPs incl. genesis" />
        <Readout layout="stack"
                 label={`MY POSITION · ${QUOTE_SYMBOL}`}
                 value={fmtQuote(totals.amount0)}
                 hint={`${positions.length} position${positions.length === 1 ? '' : 's'}`} />
        <Readout layout="stack"
                 label={`MY POSITION · ${symbol}`}
                 value={fmt(totals.amount1)}
                 hint="withdrawable any time" />
      </div>

      <Field
        label={`${QUOTE_SYMBOL} TO DEPOSIT`}
        value={quoteAmount}
        onValueChange={setEthAmount}
        placeholder="e.g. 5"
        inputMode="decimal"
        disabled={busy || !isConnected}
        error={ethError}
        armed={gate.verdict.kind === 'ready'}
        hint={quoteUnits > 0n && sqrtPriceX96 > 0n
          ? `PAIRS WITH ${fmt(tokenNeeded)} ${symbol} AT THE CURRENT PRICE`
          : 'FULL RANGE · BOTH LEGS REQUIRED · WITHDRAW ANY TIME'}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-label font-semibold text-text-tertiary uppercase tracking-widest">
          Slippage
        </span>
        <div role="radiogroup" aria-label="LP slippage tolerance" className="flex gap-1">
          {LP_SLIPPAGE_PRESETS.map(p => {
            const selected = p.bps === slippageBps
            return (
              <button
                key={p.label}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setSlippageBps(p.bps)}
                disabled={busy}
                className={
                  'text-label font-mono px-2 py-1 rounded-md border transition-colors ' +
                  (selected
                    ? 'border-brand text-text-primary bg-brand/10'
                    : 'border-border-strong text-text-tertiary hover:text-text-secondary')
                }
              >
                {p.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* FIVE CELLS, not three, and the labels had to get shorter to fit.

          Three wide cells reading "Approve / Permit2 / Deposit" became five, so
          each names its asset by ticker instead of by role — the old "Approve"
          and "Permit2" were only unambiguous while there was one token to
          approve. The grid is still one row: a wrapped progress indicator reads
          as two separate processes, which is the opposite of what it is for. */}
      <ol className="grid grid-cols-5 gap-gap-tight">
        {([
          `${symbol} →P2`, `P2 →${symbol}`,
          `${QUOTE_SYMBOL} →P2`, `P2 →${QUOTE_SYMBOL}`,
          'Deposit',
        ] as const).map((label, i) => {
          // The same traversal order the blockers are listed in, so the lit cell
          // always matches the button underneath.
          const current =
            needsErc20Approval ? 0
            : needsPermit2Approval ? 1
            : needsQuoteErc20Approval ? 2
            : needsQuotePermit2Approval ? 3
            : 4
          const done = i < current
          const active = i === current
          return (
            <li
              key={label}
              className={
                'rounded-input border px-3 py-2 text-center font-mono text-label ' +
                (done
                  ? 'border-success/40 bg-success/10 text-success'
                  : active
                    ? 'border-border-accent bg-brand/10 text-brand'
                    : 'border-border-subtle text-text-quiet')
              }
            >
              {i + 1} · {label}
            </li>
          )
        })}
      </ol>

      <ActionButton gate={gate} />

      {positions.length > 0 && (
        <div className="border border-border-subtle">
          <div className="px-4 py-2 border-b border-border-subtle">
            <span className="font-mono text-label text-text-tertiary">{'// OPEN POSITIONS'}</span>
          </div>
          {positions.map(pos => (
            <div
              key={pos.tokenId.toString()}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border-subtle last:border-b-0"
            >
              <div className="font-mono text-note text-text-tertiary tabular-nums">
                <span className="text-text-primary">#{pos.tokenId.toString()}</span>
                {' · '}{fmtQuote(pos.amount0)} {QUOTE_SYMBOL}{' + '}{fmt(pos.amount1)} {symbol}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => withdraw(pos.tokenId, pos.amount0, pos.amount1)}
                className="text-label font-bold uppercase tracking-wider px-3 py-1 rounded-md
                           border border-border-strong text-text-secondary hover:bg-surface-elevated/60
                           disabled:opacity-40 transition-colors"
              >
                Withdraw
              </button>
            </div>
          ))}
        </div>
      )}

      {degraded && (
        <p className="text-label font-mono text-text-tertiary tracking-wider leading-relaxed">
          {'// '}This RPC would not serve position logs, so only positions minted from this
          browser are listed. Your other positions are safe on-chain and remain withdrawable
          through any PancakeSwap Infinity interface.
        </p>
      )}

      {/*
        Stated even when the scan succeeds, because succeeding is not the same
        as being complete. Discovery walks a bounded span of `Transfer` logs —
        hours, not weeks, on a 100 ms chain — so a position minted before that
        window and not held in this browser's cache is simply absent from the
        list above, with nothing to distinguish it from having no position at
        all. Only the failure case used to say anything, which is the case that
        needed it least: it at least announced itself.
      */}
      {!degraded && scanCoverage && (
        <p className="text-label font-mono text-text-tertiary tracking-wider leading-relaxed">
          {'// '}Position discovery scans the last {scanCoverage} of transfers. Anything older,
          minted from another browser, is not listed here — it remains yours on-chain and
          withdrawable through any PancakeSwap Infinity interface.
        </p>
      )}
    </Card>
  )
}
