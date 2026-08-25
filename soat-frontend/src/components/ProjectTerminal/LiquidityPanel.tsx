'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  useReadContract, useWriteContract, useWaitForTransactionReceipt,
} from 'wagmi'
import { parseUnits, parseEventLogs, erc20Abi, type Address } from 'viem'

import { PERMIT2, POSITION_MANAGER, TARGET_CHAIN_ID } from '@/lib/contracts'
import { POSM_ABI, PERMIT2_ABI } from '@/lib/lpAbis'
import { pairedAmount1, liquidityForAmounts, amountsForLiquidity } from '@/lib/v4Math'
import { encodeMintPayload, encodeBurnPayload } from '@/lib/lpActions'
import { useLpPoolState, useLpPositions, rememberLpPosition } from '@/lib/useLpPosition'
import {
  Card, Readout, Field, ActionButton, useActionGate, revertOrder,
} from '@/components/ui'
import { fmt } from './format'
import { AlarmLine, TxLine } from './primitives'

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
// third-party LPs add and remove freely — V4 never even calls into Tosh code on
// those paths.  What was missing was a front door: posm positions are ERC-721s
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
  hookAddress, tokenAddress, symbol, userAddress, isConnected, ethBalance, nowSec,
}: {
  hookAddress:  Address
  tokenAddress: Address | undefined
  symbol:       string
  userAddress:  Address | undefined
  isConnected:  boolean
  ethBalance:   bigint
  /** Ticking clock lifted to the parent, so render stays pure. */
  nowSec:       number
}) {
  const [ethAmount, setEthAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [slippageBps, setSlippageBps] = useState(100n)

  const { sqrtPriceX96, totalLiquidity } = useLpPoolState(tokenAddress, hookAddress)
  const { positions, totals, degraded, refresh } =
    useLpPositions(userAddress, hookAddress, sqrtPriceX96)

  const poolAmounts = amountsForLiquidity(sqrtPriceX96, totalLiquidity)

  const ethWei = (() => {
    const t = ethAmount.trim()
    if (!t) return 0n
    try { return parseUnits(t, 18) } catch { return -1n }
  })()
  const ethInvalid = ethWei === -1n

  // What the pool will pull for the token leg, plus the same 0.5% headroom the
  // shelf mint uses.  posm reverts on `amountNMax`, so under-quoting is fatal
  // while over-quoting is refunded by SWEEP / left unspent.
  const tokenNeeded = ethWei > 0n ? pairedAmount1(sqrtPriceX96, ethWei) : 0n
  const ethMax   = ethWei   + (ethWei   * slippageBps) / 10_000n
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
    args: userAddress && tokenAddress ? [userAddress, tokenAddress, POSITION_MANAGER] : undefined,
    query: { enabled: !!tokenAddress && !!userAddress, refetchInterval: 12_000 },
  })

  const nowSeconds = BigInt(nowSec)
  const needsErc20Approval = tokenMax > 0n && (permit2Allowance ?? 0n) < tokenMax
  const needsPermit2Approval =
    tokenMax > 0n &&
    (!posmAllowance || posmAllowance[0] < tokenMax || BigInt(posmAllowance[1]) <= nowSeconds)

  const insufficientEth   = ethMax > 0n && ethMax > ethBalance
  const insufficientToken = tokenMax > 0n && tokenMax > (tokenBalance ?? 0n)

  const { writeContract, isPending, data: txHash, error: txError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess, data: receipt } =
    useWaitForTransactionReceipt({ hash: txHash })
  const busy = isPending || isConfirming

  // Cache the minted tokenId so the position shows up even when the RPC's log
  // index lags or `eth_getLogs` is unavailable on this endpoint.
  useEffect(() => {
    if (!isSuccess || !receipt || !userAddress) return
    try {
      const events = parseEventLogs({
        abi: POSM_ABI, eventName: 'Transfer', logs: receipt.logs,
      })
      for (const ev of events) {
        if (ev.args.to.toLowerCase() === userAddress.toLowerCase()) {
          rememberLpPosition(userAddress, hookAddress, ev.args.id)
        }
      }
    } catch { /* nothing to cache — the scan will still find it */ }
    void refetchErc20(); void refetchPermit2(); void refresh()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEthAmount('')
  }, [isSuccess, receipt, userAddress, hookAddress, refetchErc20, refetchPermit2, refresh])

  const approveErc20 = useCallback(() => {
    if (!tokenAddress) return
    setError(null)
    writeContract({
      address: tokenAddress, abi: erc20Abi, functionName: 'approve',
      args: [PERMIT2, MAX_UINT160], chainId: TARGET_CHAIN_ID,
    })
  }, [tokenAddress, writeContract])

  const approvePermit2 = useCallback(() => {
    if (!tokenAddress) return
    setError(null)
    writeContract({
      address: PERMIT2, abi: PERMIT2_ABI, functionName: 'approve',
      args: [
        tokenAddress, POSITION_MANAGER, MAX_UINT160,
        Number(nowSeconds + PERMIT2_TTL_SECONDS),
      ],
      chainId: TARGET_CHAIN_ID,
    })
  }, [tokenAddress, nowSeconds, writeContract])

  // Hoisted out of the click handler so the gate can refuse a deposit that would
  // mint nothing, instead of the handler discovering it after the user commits.
  const liquidity = useMemo(
    () => (ethWei > 0n && sqrtPriceX96 > 0n
      ? liquidityForAmounts(sqrtPriceX96, ethWei, tokenNeeded)
      : 0n),
    [ethWei, sqrtPriceX96, tokenNeeded],
  )

  const addLiquidity = useCallback(() => {
    setError(null)
    if (!userAddress || !tokenAddress) return

    const unlockData = encodeMintPayload({
      token: tokenAddress,
      hook: hookAddress,
      owner: userAddress,
      liquidity,
      amount0Max: ethMax,
      amount1Max: tokenMax,
    })

    writeContract({
      address: POSITION_MANAGER, abi: POSM_ABI, functionName: 'modifyLiquidities',
      args: [unlockData, nowSeconds + TX_DEADLINE_SECONDS],
      value: ethMax,
      chainId: TARGET_CHAIN_ID,
    })
  }, [
    userAddress, tokenAddress, hookAddress, liquidity, ethMax, tokenMax,
    nowSeconds, writeContract,
  ])

  const withdraw = useCallback((tokenId: bigint, amount0: bigint, amount1: bigint) => {
    setError(null)
    if (!userAddress || !tokenAddress) { setError('Connect wallet'); return }

    const unlockData = encodeBurnPayload({
      token: tokenAddress,
      recipient: userAddress,
      tokenId,
      amount0Min: amount0 - (amount0 * slippageBps) / 10_000n,
      amount1Min: amount1 - (amount1 * slippageBps) / 10_000n,
    })

    writeContract({
      address: POSITION_MANAGER, abi: POSM_ABI, functionName: 'modifyLiquidities',
      args: [unlockData, nowSeconds + TX_DEADLINE_SECONDS],
      chainId: TARGET_CHAIN_ID,
    })
  }, [userAddress, tokenAddress, nowSeconds, writeContract, slippageBps])

  // Terse: the red border plus a short tag.  The gate states each of these in
  // full under the button, including the numbers, so repeating them here would
  // show one fault as two.
  const ethError =
      ethInvalid        ? 'NOT A NUMBER'
    : insufficientEth   ? 'ABOVE YOUR ETH BALANCE'
    : insufficientToken ? `NEEDS MORE ${symbol}`
    : null

  // One live step at a time, so the CTA always says exactly what the next
  // signature does rather than dumping three buttons on the user at once.  The
  // two approvals are blockers that carry a `resolve`, which is what keeps the
  // button enabled and turns "you are blocked" into "here is the next signature".
  //
  // `ethInvalid` now precedes the zero check.  It could not before: an
  // unparseable box sets `ethWei` to `-1n`, so `ethWei <= 0n` matched first and
  // typing a stray letter reported "Enter an ETH amount" at a field that was
  // visibly not empty.
  const gate = useActionGate({
    action: 'Step 3 of 3 — deposit into the pool',
    onAct: addLiquidity,
    tx: { isBusy: busy },
    blockersInRevertOrder: revertOrder(
      {
        id: 'token-unresolved',
        active: !tokenAddress,
        label: '[token_not_resolved]',
        reason: 'Still reading this project’s token address from the factory.',
        tone: 'neutral',
      },
      {
        id: 'amount-invalid',
        active: ethInvalid,
        label: '[invalid_amount]',
        reason: 'That is not a number this field can send as ETH.',
        tone: 'warn',
      },
      {
        id: 'amount-zero',
        active: !ethInvalid && ethWei === 0n,
        label: '[enter_amount]',
        reason: 'Enter the amount of ETH to put into the pool.',
        tone: 'neutral',
      },
      {
        id: 'pool-price',
        active: sqrtPriceX96 === 0n,
        label: '[pool_price_unavailable]',
        reason: 'The pool price has not been read yet — a full-range mint cannot be sized without it.',
        tone: 'neutral',
      },
      {
        id: 'balance-eth',
        active: insufficientEth,
        label: '[insufficient_eth]',
        reason: `This wallet does not hold the deposit plus its ${Number(slippageBps) / 100}% headroom.`,
        tone: 'warn',
      },
      {
        id: 'balance-token',
        active: insufficientToken,
        label: `[insufficient_${symbol.toLowerCase()}]`,
        reason: `A full-range position funds both legs — this one needs ${fmt(tokenNeeded)} ${symbol} and the wallet holds ${fmt(tokenBalance ?? 0n)}.`,
        tone: 'warn',
      },
      {
        id: 'dust',
        active: liquidity === 0n && ethWei > 0n && sqrtPriceX96 > 0n,
        label: '[too_small_to_mint]',
        reason: 'That deposit is too small to mint any liquidity at the current price — raise it.',
        tone: 'warn',
      },
      {
        id: 'approve-erc20',
        active: needsErc20Approval,
        label: `Step 1 of 3 — approve ${symbol} for Permit2`,
        reason: 'Permit2 needs a one-time allowance on the token before it can move either leg.',
        tone: 'info',
        resolve: approveErc20,
      },
      {
        id: 'approve-permit2',
        active: needsPermit2Approval,
        label: 'Step 2 of 3 — let Permit2 fund the position manager',
        reason: 'Permit2 holds the allowance but has not been told the position manager may spend it.',
        tone: 'info',
        resolve: approvePermit2,
      },
    ),
  })

  return (
    <Card
      id="P-3"
      title={`MARKET MAKING · ${symbol}/ETH`}
      subtitle="Uniswap V4 PositionManager · full range · 0.30% pool fee accrues to LPs"
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6">
        <Readout label="POOL DEPTH · ETH"
                 value={fmt(poolAmounts.amount0)}
                 hint="all LPs incl. genesis" />
        <Readout label={`POOL DEPTH · ${symbol}`}
                 value={fmt(poolAmounts.amount1)}
                 hint="all LPs incl. genesis" />
        <Readout label="MY POSITION · ETH"
                 value={fmt(totals.amount0)}
                 hint={`${positions.length} position${positions.length === 1 ? '' : 's'}`} />
        <Readout label={`MY POSITION · ${symbol}`}
                 value={fmt(totals.amount1)}
                 hint="withdrawable any time" />
      </div>

      <Field
        label="ETH TO DEPOSIT"
        value={ethAmount}
        onValueChange={v => { setEthAmount(v); setError(null) }}
        placeholder="e.g. 0.05"
        inputMode="decimal"
        disabled={busy || !isConnected}
        error={ethError}
        armed={gate.verdict.kind === 'ready'}
        hint={ethWei > 0n && sqrtPriceX96 > 0n
          ? `PAIRS WITH ${fmt(tokenNeeded)} ${symbol} AT THE CURRENT PRICE`
          : 'FULL RANGE · BOTH LEGS REQUIRED · WITHDRAW ANY TIME'}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
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
                  'text-[10px] font-mono px-2 py-1 rounded-md border transition-colors ' +
                  (selected
                    ? 'border-brand text-white bg-brand/10'
                    : 'border-zinc-700 text-zinc-500 hover:text-zinc-300')
                }
              >
                {p.label}
              </button>
            )
          })}
        </div>
      </div>

      <ActionButton gate={gate} />

      {positions.length > 0 && (
        <div className="border border-[#1F1F2E]">
          <div className="px-4 py-2 border-b border-[#1F1F2E]">
            <span className="font-mono text-label text-text-tertiary">{'// OPEN POSITIONS'}</span>
          </div>
          {positions.map(pos => (
            <div
              key={pos.tokenId.toString()}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[#1F1F2E] last:border-b-0"
            >
              <div className="font-mono text-[11px] text-[#888] tabular-nums">
                <span className="text-white">#{pos.tokenId.toString()}</span>
                {' · '}{fmt(pos.amount0)} ETH{' + '}{fmt(pos.amount1)} {symbol}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => withdraw(pos.tokenId, pos.amount0, pos.amount1)}
                className="text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded-md
                           border border-zinc-600 text-zinc-300 hover:bg-zinc-800/60
                           disabled:opacity-40 transition-colors"
              >
                Withdraw
              </button>
            </div>
          ))}
        </div>
      )}

      {degraded && (
        <p className="text-[10px] font-mono text-[#888] tracking-wider leading-relaxed">
          {'// '}This RPC would not serve position logs, so only positions minted from this
          browser are listed. Your other positions are safe on-chain and remain withdrawable
          through any Uniswap V4 interface.
        </p>
      )}

      <AlarmLine msg={error ?? (txError?.message?.slice(0, 200) ?? null)} />
      <TxLine hash={txHash} label="modifyLiquidities" />
    </Card>
  )
}
