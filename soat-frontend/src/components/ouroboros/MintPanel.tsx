'use client'

import { useState } from 'react'
import { useReadContract } from 'wagmi'

import { Panel, Row } from '@/components/x/Panel'
import { Button, cn, useQuoteApproval, useTxAction } from '@/components/ui'
import { useWalletPicker } from '@/components/WalletPicker'
import { NATIVE_SYMBOL } from '@/lib/chain'
import { TARGET_CHAIN_ID } from '@/lib/contracts'
import { OURO_MINT_ABI } from '@/lib/ouroboros/abis'
import { L1_PRICE, L2_TOTAL_SHARES, MAX_SHARES, OURO_MINT, OURO_USDT } from '@/lib/ouroboros/config'
import { ladderCost } from '@/lib/ouroboros/ladder'

import { useOuroCopy } from './copy'
import { fmt, fmtCompact } from './fmt'
import { l2PoolCap, type OuroState, type OuroUser } from './useOuro'
import { useOuroRef } from './useOuroRef'

/** BNB sent above the quote so a feed tick between read and inclusion does not revert; the excess is refunded. */
const BNB_BUFFER_BPS = 50n
/** Pool movement tolerated between quote and inclusion for L2 tokens. */
const L2_SLIPPAGE_BPS = 100n
/** Ladder movement tolerated on the L2 price when another mint lands first; only the true cost is pulled. */
export const L2_MAX_PAY_BPS = 200n

export function MintPanel({ state, user, address, onDone }: {
  state: OuroState
  user: OuroUser
  address: string | undefined
  onDone: () => void
}) {
  const c = useOuroCopy()
  const picker = useWalletPicker()
  const isL2 = state.phase === 'L2'
  const [shares, setShares] = useState(1)
  const [payBnb, setPayBnb] = useState(false)

  const soldLeft = isL2 ? Number(L2_TOTAL_SHARES - state.l2Minted) : MAX_SHARES
  const poolCap = isL2 ? l2PoolCap(state) : MAX_SHARES
  const max = Math.max(0, Math.min(MAX_SHARES, user.remaining, soldLeft, poolCap))
  const n = Math.min(Math.max(shares, 1), Math.max(max, 1))

  const { data: l2Quote } = useReadContract({
    address: OURO_MINT,
    abi: OURO_MINT_ABI,
    functionName: 'quoteL2',
    args: [BigInt(n)],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: isL2, refetchInterval: 6_000 },
  })

  const cost = isL2 ? (l2Quote?.[0] ?? ladderCost(Number(state.l2Minted), n)) : L1_PRICE * BigInt(n)
  const tokens = isL2 ? (l2Quote?.[1] ?? 0n) : 0n
  const minTokens = (tokens * (10_000n - L2_SLIPPAGE_BPS)) / 10_000n
  const maxPay = isL2 ? cost + (cost * L2_MAX_PAY_BPS) / 10_000n : cost

  const { data: bnbQuote } = useReadContract({
    address: OURO_MINT,
    abi: OURO_MINT_ABI,
    functionName: 'quoteBnb',
    // Quoted on the most the mint may cost; the contract refunds the BNB it does not spend.
    args: [maxPay],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: payBnb && cost > 0n, refetchInterval: 6_000 },
  })
  const bnbValue = bnbQuote === undefined ? undefined : bnbQuote + (bnbQuote * BNB_BUFFER_BPS) / 10_000n

  const approval = useQuoteApproval(OURO_MINT, maxPay, OURO_USDT!)
  // An allowance that covers today's cost is enough; it then also bounds the pull.
  const allowance = approval.state.kind === 'unknown' ? undefined : approval.state.allowance
  const payLimit = allowance !== undefined && allowance >= cost && allowance < maxPay ? allowance : maxPay
  // The exact approval is spent by the mint; re-read it so the next one asks again.
  const tx = useTxAction({ action: 'mint', onConfirmed: () => { approval.refetch(); onDone() } })
  const ref = useOuroRef()

  const send = () => {
    if (!OURO_MINT) return
    if (isL2) {
      tx.send({
        address: OURO_MINT,
        abi: OURO_MINT_ABI,
        functionName: 'mintL2',
        args: [BigInt(n), payLimit, minTokens, ref.ref],
        value: payBnb ? bnbValue : undefined,
      })
    } else {
      tx.send({
        address: OURO_MINT,
        abi: OURO_MINT_ABI,
        functionName: 'mintL1',
        args: [BigInt(n), cost, ref.ref],
        value: payBnb ? bnbValue : undefined,
      })
    }
  }

  const blocked = state.paused ? c.paused
    : isL2 && !state.poolSeeded ? c.awaitSeed
    : poolCap === 0 ? c.poolTooThin
    : max === 0 ? c.noAgent
    : null
  const needsApprove = !payBnb && allowance !== undefined && allowance < cost
  const approvalUnknown = !payBnb && approval.state.kind === 'unknown'

  return (
    <Panel title={`${c.mintTitle} · ${state.phase ? c.phase[state.phase] : ''}`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-note text-text-tertiary">
            {c.shares}
            <input
              type="number"
              min={1}
              max={Math.max(max, 1)}
              value={n}
              onChange={e => setShares(Math.floor(Number(e.target.value)) || 1)}
              className="w-28 rounded-input border border-border-subtle bg-bg-subtle px-3 py-2 font-mono text-text-primary"
            />
          </label>
          <Button label="MAX" variant="ghost" size="sm" onClick={() => setShares(max)} disabled={max === 0} />
          <div className="flex flex-col gap-1 text-note text-text-tertiary">
            {c.payWith}
            <div className="flex overflow-hidden rounded-input border border-border-subtle">
              {(['USDT', NATIVE_SYMBOL] as const).map((label, i) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setPayBnb(i === 1)}
                  className={cn(
                    'px-3 py-2 font-mono text-note',
                    payBnb === (i === 1) ? 'bg-brand text-bg-base' : 'text-text-secondary hover:bg-surface-hover',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <dl className="flex flex-col gap-2 text-note">
          <Row k={c.remaining} v={address ? `${user.remaining} / ${MAX_SHARES}` : '—'} />
          <Row k={c.cost} v={`${fmt(cost)} USDT`} strong={!payBnb} />
          {payBnb && <Row k={c.costBnb} v={bnbQuote === undefined ? '…' : `${fmt(bnbQuote, 6)} ${NATIVE_SYMBOL}`} strong />}
          {isL2
            ? <Row k={c.estTokens} v={tokens > 0n ? fmtCompact(tokens) : '…'} />
            : <Row k={c.estTokens} v={c.l1Tokens} />}
          {ref.code && <Row k={c.refCode} v={ref.code} />}
        </dl>

        <p className="text-note text-text-tertiary">{c.perId}{isL2 ? ` · ${c.poolCapNote} · ${c.vestNote}` : ''}</p>

        {!address ? (
          <Button label={c.connect} full onClick={() => picker?.open()} />
        ) : blocked ? (
          <Button label={blocked} full disabled reason={blocked} />
        ) : needsApprove ? (
          <Button
            label={c.approve}
            full
            onClick={approval.approve}
            disabled={approval.tx.isBusy}
          />
        ) : (
          <Button
            label={`${c.mint} ${n}`}
            full
            onClick={send}
            disabled={tx.isBusy || approvalUnknown || (payBnb && bnbValue === undefined) || (isL2 && tokens === 0n)}
          />
        )}
      </div>
    </Panel>
  )
}
