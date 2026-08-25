'use client'
import { useState, useEffect, useCallback } from 'react'
import {
  useReadContract, useWriteContract, useWaitForTransactionReceipt,
} from 'wagmi'
import { parseUnits, parseEventLogs, erc20Abi, type Address } from 'viem'

import { PERMIT2, POSITION_MANAGER, TARGET_CHAIN_ID } from '@/lib/contracts'
import { POSM_ABI, PERMIT2_ABI } from '@/lib/lpAbis'
import { pairedAmount1, liquidityForAmounts, amountsForLiquidity } from '@/lib/v4Math'
import { encodeMintPayload, encodeBurnPayload } from '@/lib/lpActions'
import { useLpPoolState, useLpPositions, rememberLpPosition } from '@/lib/useLpPosition'
import { Card, Readout, Field } from '@/components/ui'
import { fmt } from './format'
import { WriteButton, AlarmLine, TxLine } from './primitives'

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

  const addLiquidity = useCallback(() => {
    setError(null)
    if (!userAddress || !tokenAddress) { setError('Connect wallet'); return }
    if (ethWei <= 0n)      { setError('Enter a positive ETH amount'); return }
    if (sqrtPriceX96 === 0n) { setError('Pool price unavailable — retry in a moment'); return }
    if (insufficientEth)   { setError(`Insufficient ETH for the deposit + ${Number(slippageBps) / 100}% headroom`); return }
    if (insufficientToken) { setError(`Insufficient ${symbol} — full-range LPs must fund both legs`); return }

    const liquidity = liquidityForAmounts(sqrtPriceX96, ethWei, tokenNeeded)
    if (liquidity === 0n) { setError('Deposit too small to mint any liquidity'); return }

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
    userAddress, tokenAddress, hookAddress, ethWei, tokenNeeded, ethMax, tokenMax,
    sqrtPriceX96, insufficientEth, insufficientToken, symbol, nowSeconds, writeContract, slippageBps,
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

  // Both legs have to be funded for a full-range mint, so a short token balance
  // is a fault and not a hint — it was already coloured as one inside the old
  // cascade, which is why it moves to `error` rather than staying below.
  const ethError =
      ethInvalid        ? 'NOT A VALID ETH AMOUNT'
    : insufficientEth   ? `INSUFFICIENT ETH FOR THE DEPOSIT + ${Number(slippageBps) / 100}% HEADROOM`
    : insufficientToken ? `NEEDS ${fmt(tokenNeeded)} ${symbol} — YOU HOLD ${fmt(tokenBalance ?? 0n)}`
    : null

  // One live step at a time, so the CTA always says exactly what the next
  // signature does rather than dumping three buttons on the user at once.
  const step: { label: string; run: (() => void) | null } = (() => {
    if (!isConnected)        return { label: 'Connect wallet to provide liquidity', run: null }
    if (!tokenAddress)       return { label: 'Token not resolved yet', run: null }
    if (ethWei <= 0n)        return { label: 'Enter an ETH amount', run: null }
    if (ethInvalid)          return { label: 'Invalid amount', run: null }
    if (insufficientEth)     return { label: 'Insufficient ETH', run: null }
    if (insufficientToken)   return { label: `Insufficient ${symbol}`, run: null }
    if (needsErc20Approval)  return { label: `Step 1 of 3 — approve ${symbol} for Permit2`, run: approveErc20 }
    if (needsPermit2Approval) return { label: 'Step 2 of 3 — let Permit2 fund the position manager', run: approvePermit2 }
    return { label: 'Step 3 of 3 — deposit into the pool', run: addLiquidity }
  })()

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
        armed={!!step.run && !busy}
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
                    ? 'border-tosh-fluo text-white bg-tosh-fluo/10'
                    : 'border-zinc-700 text-zinc-500 hover:text-zinc-300')
                }
              >
                {p.label}
              </button>
            )
          })}
        </div>
      </div>

      <WriteButton
        label={step.label}
        lockedLabel={`[${step.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}]`}
        locked={!step.run}
        busy={busy}
        onClick={() => step.run?.()}
        full
      />

      {positions.length > 0 && (
        <div className="border border-[#1F1F2E]">
          <div className="px-4 py-2 border-b border-[#1F1F2E]">
            <span className="font-mono text-label text-tosh-mute">{'// OPEN POSITIONS'}</span>
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
