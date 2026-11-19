'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useReadContract, useReadContracts } from 'wagmi'
import { formatUnits, type Address } from 'viem'

import { Panel } from '@/components/x/Panel'
import { Button, useQuoteApproval, useTxAction } from '@/components/ui'
import { useWalletPicker } from '@/components/WalletPicker'
import { TARGET_CHAIN_ID } from '@/lib/contracts'
import { OURO_BIDBOOK_ABI } from '@/lib/ouroboros/abis'
import { OURO_BIDBOOK, OURO_TOKEN, OURO_USDT } from '@/lib/ouroboros/config'

import { useOuroCopy } from './copy'
import { fmt, fmtCompact, fmtPrice, parseAmount, shortAddr } from './fmt'
import type { OuroUser } from './useOuro'

const ONE = 10n ** 18n
const FEE_BPS = 200n
/** What a buyer receives of `tokens`: the book keeps 2 % of each side. */
const afterFee = (tokens: bigint) => tokens - (tokens * FEE_BPS) / 10_000n
/** Bids scanned straight from the contract, newest first, on top of what the index lists. */
const CHAIN_SCAN = 200

interface Bid {
  id: bigint
  buyer: Address
  price: bigint
  usdtLeft: bigint
}

function useOpenBids() {
  const { data: indexed } = useQuery({
    queryKey: ['ouro-bids'],
    queryFn: async () => {
      const r = await fetch('/api/ouroboros/bids')
      if (!r.ok) return [] as string[]
      const body = (await r.json()) as { bids: { bid_id: string }[] }
      return body.bids.map(b => b.bid_id)
    },
    refetchInterval: 15_000,
  })
  const { data: next } = useReadContract({
    address: OURO_BIDBOOK,
    abi: OURO_BIDBOOK_ABI,
    functionName: 'nextBidId',
    chainId: TARGET_CHAIN_ID,
    query: { refetchInterval: 8_000 },
  })

  const ids = useMemo(() => {
    const set = new Set<bigint>((indexed ?? []).map(s => BigInt(s)))
    if (next !== undefined) {
      for (let i = next - 1n; i >= 1n && i >= next - BigInt(CHAIN_SCAN); i--) set.add(i)
    }
    return [...set]
  }, [indexed, next])

  const { data, refetch } = useReadContracts({
    contracts: ids.map(id => ({
      address: OURO_BIDBOOK!,
      abi: OURO_BIDBOOK_ABI,
      functionName: 'bids',
      args: [id],
      chainId: TARGET_CHAIN_ID,
    }) as const),
    query: { enabled: ids.length > 0, refetchInterval: 8_000 },
  })

  const bids: Bid[] = []
  data?.forEach((r, i) => {
    if (r.status !== 'success') return
    const [buyer, price, usdtLeft] = r.result as readonly [Address, bigint, bigint]
    if (usdtLeft > 0n) bids.push({ id: ids[i], buyer, price, usdtLeft })
  })
  bids.sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : Number(a.id - b.id)))
  return { bids, refetch }
}

export function BidBookPanel({ open, user, address, onDone }: {
  open: boolean
  user: OuroUser
  address: Address | undefined
  onDone: () => void
}) {
  const c = useOuroCopy()
  const picker = useWalletPicker()
  const { bids, refetch } = useOpenBids()
  const done = () => { void refetch(); onDone() }

  const [usdtIn, setUsdtIn] = useState('')
  const [priceIn, setPriceIn] = useState('')
  const bidUsdt = parseAmount(usdtIn) ?? 0n
  const bidPrice = parseAmount(priceIn) ?? 0n
  const bidApproval = useQuoteApproval(OURO_BIDBOOK, bidUsdt, OURO_USDT!)
  const place = useTxAction({ action: 'bid', onConfirmed: () => { bidApproval.refetch(); done() } })

  const mine = address?.toLowerCase()
  const visible = open ? bids : bids.filter(b => b.buyer.toLowerCase() === mine)
  if (!open && visible.length === 0) return null

  return (
    <Panel title={c.bookTitle}>
      <p className="text-note text-text-tertiary">{open ? c.bookNote : c.bookClosed}</p>

      {open && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label={c.bidUsdt} value={usdtIn} onChange={setUsdtIn} />
          <Field label={c.bidPrice} value={priceIn} onChange={setPriceIn} />
          <div className="text-note text-text-tertiary">
            {c.bidTokens}: {bidPrice > 0n ? fmtCompact(afterFee((bidUsdt * ONE) / bidPrice)) : '—'}
          </div>
          {!address ? (
            <Button label={c.connect} onClick={() => picker?.open()} />
          ) : bidApproval.needsApproval ? (
            <Button label={c.approve} onClick={bidApproval.approve} disabled={bidApproval.tx.isBusy} />
          ) : (
            <Button
              label={c.placeBid}
              disabled={place.isBusy || bidUsdt < ONE || bidPrice === 0n}
              onClick={() => OURO_BIDBOOK && place.send({
                address: OURO_BIDBOOK, abi: OURO_BIDBOOK_ABI, functionName: 'placeBid', args: [bidUsdt, bidPrice],
              })}
            />
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-card border border-border-subtle">
        <table className="w-full border-collapse text-note">
          <thead>
            <tr className="bg-bg-subtle text-left text-text-tertiary">
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">{c.price}</th>
              <th className="px-3 py-2">{c.left}</th>
              <th className="px-3 py-2">{c.account}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-4 text-center text-text-tertiary">{c.noBids}</td></tr>
            )}
            {visible.map(b => (
              <BidRow key={b.id.toString()} bid={b} open={open} mine={b.buyer.toLowerCase() === mine} user={user} onDone={done} />
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function BidRow({ bid, open, mine, user, onDone }: {
  bid: Bid
  open: boolean
  mine: boolean
  user: OuroUser
  onDone: () => void
}) {
  const c = useOuroCopy()
  const [amount, setAmount] = useState('')
  const fillable = (bid.usdtLeft * ONE) / bid.price
  const qty = parseAmount(amount) ?? 0n
  const gross = (qty * bid.price) / ONE
  const net = gross - (gross * FEE_BPS) / 10_000n
  const approval = useQuoteApproval(OURO_BIDBOOK, qty, OURO_TOKEN!)
  const fill = useTxAction({ action: 'fill', onConfirmed: () => { approval.refetch(); onDone() } })
  const cancel = useTxAction({ action: 'cancel', onConfirmed: onDone })
  const maxSell = user.tokenBalance < fillable ? user.tokenBalance : fillable

  return (
    <tr className="border-t border-border-subtle align-middle">
      <td className="px-3 py-2 font-mono">{bid.id.toString()}</td>
      <td className="px-3 py-2 font-mono">{fmtPrice(bid.price)}</td>
      <td className="px-3 py-2 font-mono">{fmt(bid.usdtLeft, 2)}</td>
      <td className="px-3 py-2 font-mono">{mine ? c.mine : shortAddr(bid.buyer)}</td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {open && !mine && user.tokenBalance > 0n && (
            <>
              <input
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder={c.sellAmount}
                className="w-32 rounded-input border border-border-subtle bg-bg-subtle px-2 py-1 font-mono"
              />
              <Button label="MAX" size="sm" variant="ghost" onClick={() => setAmount(formatUnits(maxSell, 18))} />
              {qty > 0n && <span className="font-mono text-text-tertiary">{c.youGet}: {fmt(net, 2)}</span>}
              {approval.needsApproval ? (
                <Button label={c.approveToken} size="sm" onClick={approval.approve} disabled={approval.tx.isBusy} />
              ) : (
                <Button
                  label={c.sell}
                  size="sm"
                  disabled={fill.isBusy || qty === 0n || qty > maxSell}
                  onClick={() => OURO_BIDBOOK && fill.send({
                    address: OURO_BIDBOOK, abi: OURO_BIDBOOK_ABI, functionName: 'fill', args: [bid.id, qty, net],
                  })}
                />
              )}
            </>
          )}
          {mine && (
            <Button
              label={c.cancel}
              size="sm"
              variant="danger"
              disabled={cancel.isBusy}
              onClick={() => OURO_BIDBOOK && cancel.send({
                address: OURO_BIDBOOK, abi: OURO_BIDBOOK_ABI, functionName: 'cancel', args: [bid.id],
              })}
            />
          )}
        </div>
      </td>
    </tr>
  )
}

export function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-note text-text-tertiary">
      {label}
      <input
        inputMode="decimal"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-40 rounded-input border border-border-subtle bg-bg-subtle px-3 py-2 font-mono text-text-primary"
      />
    </label>
  )
}
