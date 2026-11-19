'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useReadContract, useReadContracts } from 'wagmi'
import { formatUnits, type Address } from 'viem'

import { Panel, Row } from '@/components/x/Panel'
import { Button, cn, useQuoteApproval, useTxAction } from '@/components/ui'
import { useWalletPicker } from '@/components/WalletPicker'
import { TARGET_CHAIN_ID } from '@/lib/contracts'
import { OURO_BIDBOOK_ABI, OURO_MINT_ABI } from '@/lib/ouroboros/abis'
import { OURO_BIDBOOK, OURO_MINT, OURO_TOKEN, OURO_USDT } from '@/lib/ouroboros/config'

import { useOuroCopy } from './copy'
import { fmt, fmtCompact, fmtPrice, parseAmount } from './fmt'
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

/** One price level: every open bid at that price, stacked for display. */
interface Level {
  price: bigint
  usdtLeft: bigint
  fillable: bigint
  /** Non-mine bids, oldest first — a sell fills the head. */
  others: Bid[]
  /** The caller's bids at this price, oldest first — cancel takes the head. */
  mine: Bid[]
}

function stackByPrice(bids: Bid[], mineAddr: string | undefined): Level[] {
  const map = new Map<string, Bid[]>()
  for (const b of bids) {
    const k = b.price.toString()
    const list = map.get(k)
    if (list) list.push(b)
    else map.set(k, [b])
  }
  const levels: Level[] = []
  for (const group of map.values()) {
    group.sort((a, b) => Number(a.id - b.id))
    const usdtLeft = group.reduce((s, b) => s + b.usdtLeft, 0n)
    const price = group[0].price
    const mine: Bid[] = []
    const others: Bid[] = []
    for (const b of group) {
      if (mineAddr && b.buyer.toLowerCase() === mineAddr) mine.push(b)
      else others.push(b)
    }
    levels.push({
      price,
      usdtLeft,
      fillable: price === 0n ? 0n : (usdtLeft * ONE) / price,
      others,
      mine,
    })
  }
  levels.sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : 0))
  return levels
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

  const { data: terms } = useReadContract({
    address: OURO_MINT,
    abi: OURO_MINT_ABI,
    functionName: 'seedTerms',
    chainId: TARGET_CHAIN_ID,
    query: { enabled: open, refetchInterval: 30_000 },
  })
  const l1Floor = terms?.[0]

  const [usdtIn, setUsdtIn] = useState('')
  const [priceIn, setPriceIn] = useState('')
  const bidUsdt = parseAmount(usdtIn) ?? 0n
  const bidPrice = parseAmount(priceIn) ?? 0n
  const bidApproval = useQuoteApproval(OURO_BIDBOOK, bidUsdt, OURO_USDT!)
  const place = useTxAction({ action: 'bid', onConfirmed: () => { bidApproval.refetch(); done() } })

  const mine = address?.toLowerCase()
  const visible = open ? bids : bids.filter(b => b.buyer.toLowerCase() === mine)
  const levels = useMemo(() => stackByPrice(visible, mine), [visible, mine])
  if (!open && visible.length === 0) return null

  const depth = bids.reduce((s, b) => s + b.usdtLeft, 0n)
  const best = levels[0]?.price

  return (
    <Panel title={c.bookTitle}>
      <p className="text-note text-text-secondary">{open ? c.bookNote : c.bookClosed}</p>

      {open && (
        <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border-subtle pb-4 font-mono text-note">
          <span className="text-text-tertiary">{c.bookCount} <span className="text-text-primary">{levels.length}</span></span>
          <span className="text-text-tertiary">{c.bookBest} <span className="text-brand">{best !== undefined ? fmtPrice(best) : '—'}</span></span>
          <span className="text-text-tertiary">{c.bookDepth} <span className="text-text-primary">{fmt(depth, 2)} USDT</span></span>
          {l1Floor !== undefined && (
            <span className="text-text-tertiary">{c.bookFloor} <span className="text-text-primary">{fmtPrice(l1Floor)}</span></span>
          )}
        </div>
      )}

      {open && (
        <div className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-subtle/40 p-4 md:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-label uppercase text-text-tertiary">{c.bookBuy}</h3>
            {l1Floor !== undefined && (
              <button
                type="button"
                onClick={() => setPriceIn(formatUnits(l1Floor, 18))}
                className="font-mono text-note text-brand transition-colors hover:text-brand/80"
              >
                {c.bookUseFloor}
              </button>
            )}
          </div>
          <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <Field label={c.bidUsdt} value={usdtIn} onChange={setUsdtIn} />
            <Field label={c.bidPrice} value={priceIn} onChange={setPriceIn} />
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
          <dl>
            <Row
              k={c.bidTokens}
              v={bidPrice > 0n ? fmtCompact(afterFee((bidUsdt * ONE) / bidPrice)) : '—'}
              strong={bidPrice > 0n && bidUsdt > 0n}
            />
          </dl>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <h3 className="text-label uppercase text-text-tertiary">{c.bookList}</h3>
        {levels.length === 0 ? (
          <p className="rounded-card border border-dashed border-border-subtle px-4 py-8 text-center text-note text-text-tertiary">
            {c.noBids}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-note">
              <thead>
                <tr className="border-b border-border-subtle text-left text-text-tertiary">
                  <th className="px-3 py-2 font-normal">{c.price}</th>
                  <th className="px-3 py-2 text-right font-normal">{c.left}</th>
                  <th className="px-3 py-2 text-right font-normal">{c.tokensLeft}</th>
                  <th className="px-3 py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {levels.map(level => (
                  <LevelRow key={level.price.toString()} level={level} open={open} user={user} onDone={done} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  )
}

function LevelRow({ level, open, user, onDone }: {
  level: Level
  open: boolean
  user: OuroUser
  onDone: () => void
}) {
  const c = useOuroCopy()
  const [amount, setAmount] = useState('')
  const othersUsdt = level.others.reduce((s, b) => s + b.usdtLeft, 0n)
  const othersFillable = level.price === 0n || othersUsdt === 0n ? 0n : (othersUsdt * ONE) / level.price
  const target = level.others[0]
  const targetFillable = target ? (target.usdtLeft * ONE) / target.price : 0n
  const qty = parseAmount(amount) ?? 0n
  // One transaction fills the oldest non-mine bid at this price.
  const take = target && qty > 0n ? (qty < targetFillable ? qty : targetFillable) : 0n
  const gross = target ? (take * target.price) / ONE : 0n
  const net = gross - (gross * FEE_BPS) / 10_000n
  const approval = useQuoteApproval(OURO_BIDBOOK, take, OURO_TOKEN!)
  const fill = useTxAction({ action: 'fill', onConfirmed: () => { approval.refetch(); onDone() } })
  const cancel = useTxAction({ action: 'cancel', onConfirmed: onDone })
  const maxSell = user.tokenBalance < othersFillable ? user.tokenBalance : othersFillable
  const canSell = open && level.others.length > 0 && user.tokenBalance > 0n
  const mineHead = level.mine[0]

  return (
    <tr className={cn('border-b border-border-subtle align-top last:border-b-0', level.mine.length > 0 && 'bg-brand/5')}>
      <td className="px-3 py-3 font-mono text-brand">{fmtPrice(level.price)}</td>
      <td className="px-3 py-3 text-right font-mono">{fmt(level.usdtLeft, 2)}</td>
      <td className="px-3 py-3 text-right font-mono text-text-secondary">{fmtCompact(level.fillable)}</td>
      <td className="px-3 py-3">
        <div className="flex flex-col items-end gap-2">
          {canSell && (
            <>
              <div className="flex h-9 items-stretch overflow-hidden rounded-input border border-border-subtle bg-bg-subtle focus-within:border-brand">
                <input
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder={c.sellAmount}
                  inputMode="decimal"
                  className="w-28 min-w-0 bg-transparent px-2 font-mono text-text-primary outline-none"
                />
                <button
                  type="button"
                  onClick={() => setAmount(formatUnits(maxSell, 18))}
                  disabled={maxSell === 0n}
                  className="border-l border-border-subtle px-2 font-mono text-label font-bold uppercase text-brand transition-colors hover:bg-brand/10 disabled:cursor-not-allowed disabled:text-text-quiet"
                >
                  MAX
                </button>
              </div>
              {take > 0n && (
                <span className="font-mono text-text-tertiary">{c.youGet}: {fmt(net, 2)}</span>
              )}
              {approval.needsApproval ? (
                <Button label={c.approveToken} size="sm" onClick={approval.approve} disabled={approval.tx.isBusy} />
              ) : (
                <Button
                  label={c.sell}
                  size="sm"
                  disabled={fill.isBusy || take === 0n || !target}
                  onClick={() => target && OURO_BIDBOOK && fill.send({
                    address: OURO_BIDBOOK, abi: OURO_BIDBOOK_ABI, functionName: 'fill',
                    args: [target.id, take, net],
                  })}
                />
              )}
            </>
          )}
          {mineHead && (
            <Button
              label={level.mine.length > 1 ? `${c.cancel} · ${level.mine.length}` : c.cancel}
              size="sm"
              variant="danger"
              disabled={cancel.isBusy}
              onClick={() => OURO_BIDBOOK && cancel.send({
                address: OURO_BIDBOOK, abi: OURO_BIDBOOK_ABI, functionName: 'cancel', args: [mineHead.id],
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
    <label className="flex flex-col gap-1.5 text-note text-text-tertiary">
      {label}
      <input
        inputMode="decimal"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-11 w-full rounded-input border border-border-subtle bg-bg-subtle px-3 font-mono text-text-primary outline-none focus:border-brand"
      />
    </label>
  )
}
