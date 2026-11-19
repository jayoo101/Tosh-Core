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
const afterFee = (tokens: bigint) => tokens - (tokens * FEE_BPS) / 10_000n
const CHAIN_SCAN = 200

interface Bid {
  id: bigint
  buyer: Address
  price: bigint
  usdtLeft: bigint
}

interface Level {
  price: bigint
  usdtLeft: bigint
  tokens: bigint
  count: number
}

function depthLevels(bids: Bid[]): Level[] {
  const map = new Map<string, Level>()
  for (const b of bids) {
    const k = b.price.toString()
    const cur = map.get(k)
    if (cur) {
      cur.usdtLeft += b.usdtLeft
      cur.count += 1
    } else {
      map.set(k, { price: b.price, usdtLeft: b.usdtLeft, tokens: 0n, count: 1 })
    }
  }
  const levels = [...map.values()]
  for (const l of levels) l.tokens = l.price === 0n ? 0n : (l.usdtLeft * ONE) / l.price
  // Skip levels that would show as 0 USDT or 0 OURO on the depth table.
  const minUsdt = 10n ** 16n // 0.01 USDT
  return levels
    .filter(l => l.tokens > 0n && l.usdtLeft >= minUsdt)
    .sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : 0))
}

/** Oldest non-mine bid at the best price that still has room for `amount`. */
function bestFillTarget(bids: Bid[], amount: bigint, mine: string | undefined): Bid | undefined {
  if (amount === 0n) return undefined
  const open = bids
    .filter(b => !mine || b.buyer.toLowerCase() !== mine)
    .sort((a, b) => (a.price === b.price ? Number(a.id - b.id) : a.price > b.price ? -1 : 1))
  return open.find(b => (b.usdtLeft * ONE) / b.price > 0n)
}

function useOpenBids() {
  const { data: indexed } = useQuery({
    queryKey: ['ouro-bids'],
    queryFn: async () => {
      const r = await fetch('/api/ouroboros/bids')
      if (!r.ok) return { ids: [] as string[], highFill: null as string | null }
      const body = (await r.json()) as { bids: { bid_id: string }[]; highFill?: string | null }
      return { ids: body.bids.map(b => b.bid_id), highFill: body.highFill ?? null }
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
    const set = new Set<bigint>((indexed?.ids ?? []).map(s => BigInt(s)))
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
    // Keep dust for "My bids" (so it can still be cancelled); depth hides it.
    if (usdtLeft > 0n) bids.push({ id: ids[i], buyer, price, usdtLeft })
  })
  bids.sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : Number(a.id - b.id)))
  const highFill = indexed?.highFill ? BigInt(indexed.highFill) : undefined
  return { bids, highFill, refetch }
}

export function BidBookPanel({ open, user, address, onDone }: {
  open: boolean
  user: OuroUser
  address: Address | undefined
  onDone: () => void
}) {
  const c = useOuroCopy()
  const { bids, highFill, refetch } = useOpenBids()
  const done = () => { void refetch(); onDone() }
  const mine = address?.toLowerCase()
  const myBids = bids.filter(b => mine && b.buyer.toLowerCase() === mine)
  const levels = useMemo(() => depthLevels(bids), [bids])

  const { data: terms } = useReadContract({
    address: OURO_MINT,
    abi: OURO_MINT_ABI,
    functionName: 'seedTerms',
    chainId: TARGET_CHAIN_ID,
    query: { enabled: open, refetchInterval: 30_000 },
  })
  const { data: volume } = useReadContracts({
    contracts: [
      { address: OURO_BIDBOOK!, abi: OURO_BIDBOOK_ABI, functionName: 'filledUsdt', chainId: TARGET_CHAIN_ID },
      { address: OURO_BIDBOOK!, abi: OURO_BIDBOOK_ABI, functionName: 'filledTokens', chainId: TARGET_CHAIN_ID },
    ],
    query: { enabled: open && !!OURO_BIDBOOK, refetchInterval: 15_000 },
  })
  const l1Floor = terms?.[0]
  const filledUsdt = volume?.[0]?.status === 'success' ? (volume[0].result as bigint) : 0n
  const depthUsdt = levels.reduce((s, l) => s + l.usdtLeft, 0n)
  const best = levels[0]?.price

  if (!open && myBids.length === 0) return null

  if (!open) {
    return (
      <Panel title={c.bookTitle}>
        <p className="text-note text-text-secondary">{c.bookClosed}</p>
        <MyBids bids={myBids} onDone={done} />
      </Panel>
    )
  }

  const stats: [string, string][] = [
    [c.bookBest, best !== undefined ? fmtPrice(best) : '—'],
    [c.bookHighFill, highFill !== undefined ? fmtPrice(highFill) : '—'],
    [c.bookDepth, `${fmt(depthUsdt, 2)} USDT`],
    [c.bookVolume, `${fmtCompact(filledUsdt)} USDT`],
    [c.bookCount, levels.length.toLocaleString()],
  ]

  return (
    <Panel title={c.bookTitle}>
      <p className="text-note text-text-secondary">{c.bookNote}</p>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-card bg-border-subtle sm:grid-cols-3">
        {stats.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-1 bg-bg-subtle p-4">
            <dt className="text-label uppercase text-text-tertiary">{k}</dt>
            <dd className="font-mono text-readout font-bold text-text-primary">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]">
        <DepthTable levels={levels} />
        <aside className="flex min-w-0 flex-col gap-4">
          <TradeAside
            bids={bids}
            levels={levels}
            user={user}
            address={address}
            l1Floor={l1Floor}
            onDone={done}
          />
          <MyBids bids={myBids} onDone={done} empty={address ? c.myBidsNone : c.myBidsConnect} />
        </aside>
      </div>
    </Panel>
  )
}

function DepthTable({ levels }: { levels: Level[] }) {
  const c = useOuroCopy()
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border-subtle p-4 md:p-5">
      <h3 className="text-label uppercase text-text-tertiary">{c.bookDepthTitle}</h3>
      {levels.length === 0 ? (
        <p className="py-8 text-center text-note text-text-tertiary">{c.noBids}</p>
      ) : (
        <table className="w-full border-collapse font-mono text-note tabular-nums">
          <thead>
            <tr className="border-b border-border-subtle text-left text-text-tertiary">
              <th className="py-2 pr-2 font-normal">{c.price}</th>
              <th className="py-2 pr-2 text-right font-normal">{c.tokensLeft}</th>
              <th className="py-2 text-right font-normal">{c.left}</th>
            </tr>
          </thead>
          <tbody>
            {levels.slice(0, 20).map(l => (
              <tr key={l.price.toString()} className="border-b border-border-subtle last:border-b-0">
                <td className="py-2 pr-2 text-brand">{fmtPrice(l.price)}</td>
                <td className="py-2 pr-2 text-right text-text-primary">{fmtCompact(l.tokens)}</td>
                <td className="py-2 text-right text-text-primary">{fmt(l.usdtLeft, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function TradeAside({ bids, levels, user, address, l1Floor, onDone }: {
  bids: Bid[]
  levels: Level[]
  user: OuroUser
  address: Address | undefined
  l1Floor: bigint | undefined
  onDone: () => void
}) {
  const c = useOuroCopy()
  const [side, setSide] = useState<'sell' | 'bid'>('sell')
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label={c.bookSideLabel} className="grid grid-cols-2 gap-1 rounded-input bg-surface-hover/70 p-1">
        {([['sell', c.bookSellTab], ['bid', c.bookBuyTab]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={side === id}
            onClick={() => setSide(id)}
            className={cn(
              'rounded-input px-2 py-1.5 text-note font-bold transition-colors',
              side === id ? 'bg-brand text-bg-base' : 'text-text-tertiary hover:text-text-primary',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {side === 'sell' ? (
        <SellPanel bids={bids} user={user} address={address} onDone={onDone} />
      ) : (
        <PlacePanel l1Floor={l1Floor} best={levels[0]?.price} address={address} onDone={onDone} />
      )}
    </div>
  )
}

function SellPanel({ bids, user, address, onDone }: {
  bids: Bid[]
  user: OuroUser
  address: Address | undefined
  onDone: () => void
}) {
  const c = useOuroCopy()
  const picker = useWalletPicker()
  const [raw, setRaw] = useState('')
  const amount = parseAmount(raw) ?? 0n
  const mine = address?.toLowerCase()
  const othersFillable = bids
    .filter(b => !mine || b.buyer.toLowerCase() !== mine)
    .reduce((s, b) => s + (b.price === 0n ? 0n : (b.usdtLeft * ONE) / b.price), 0n)
  const maxSell = user.tokenBalance < othersFillable ? user.tokenBalance : othersFillable
  const target = bestFillTarget(bids, amount > 0n ? amount : 1n, mine)
  const targetFillable = target ? (target.usdtLeft * ONE) / target.price : 0n
  const take = target && amount > 0n ? (amount < targetFillable ? amount : targetFillable) : 0n
  const gross = target && take > 0n ? (take * target.price) / ONE : 0n
  const net = gross - (gross * FEE_BPS) / 10_000n
  const approval = useQuoteApproval(OURO_BIDBOOK, take, OURO_TOKEN!)
  const fill = useTxAction({ action: 'fill', onConfirmed: () => { setRaw(''); approval.refetch(); onDone() } })

  return (
    <div className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-subtle/40 p-4">
      <h3 className="text-label uppercase text-text-tertiary">{c.bookSellTitle}</h3>
      <Field label={c.sellAmount} value={raw} onChange={setRaw} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-note">
        <span className="text-text-tertiary">{c.bookBalance}: {fmtCompact(user.tokenBalance)} OURO</span>
        <button
          type="button"
          disabled={maxSell === 0n}
          onClick={() => setRaw(formatUnits(maxSell, 18))}
          className="font-mono text-label font-bold uppercase text-brand hover:text-brand/80 disabled:text-text-quiet"
        >
          MAX
        </button>
      </div>
      {take > 0n && target && (
        <dl className="flex flex-col gap-1">
          <Row k={c.price} v={fmtPrice(target.price)} />
          <Row k={c.youGet} v={`${fmt(net, 2)} USDT`} strong />
        </dl>
      )}
      {!address ? (
        <Button label={c.connect} onClick={() => picker?.open()} />
      ) : approval.needsApproval ? (
        <Button label={c.approveToken} onClick={approval.approve} disabled={approval.tx.isBusy} />
      ) : (
        <Button
          label={c.sell}
          disabled={fill.isBusy || take === 0n || !target}
          onClick={() => target && OURO_BIDBOOK && fill.send({
            address: OURO_BIDBOOK, abi: OURO_BIDBOOK_ABI, functionName: 'fill',
            args: [target.id, take, net],
          })}
        />
      )}
      {maxSell > 0n && take > 0n && take < amount && amount <= maxSell && (
        <p className="text-note text-text-tertiary">{c.bookSellPartial}</p>
      )}
    </div>
  )
}

function PlacePanel({ l1Floor, best, address, onDone }: {
  l1Floor: bigint | undefined
  best: bigint | undefined
  address: Address | undefined
  onDone: () => void
}) {
  const c = useOuroCopy()
  const picker = useWalletPicker()
  const [usdtIn, setUsdtIn] = useState('')
  const [priceIn, setPriceIn] = useState('')
  const bidUsdt = parseAmount(usdtIn) ?? 0n
  const bidPrice = parseAmount(priceIn) ?? 0n
  const bidApproval = useQuoteApproval(OURO_BIDBOOK, bidUsdt, OURO_USDT!)
  const place = useTxAction({ action: 'bid', onConfirmed: () => { setUsdtIn(''); bidApproval.refetch(); onDone() } })
  const suggest = best !== undefined && l1Floor !== undefined
    ? (best > l1Floor ? best : l1Floor)
    : (best ?? l1Floor)

  return (
    <div className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-subtle/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-label uppercase text-text-tertiary">{c.bookBuy}</h3>
        {suggest !== undefined && (
          <button
            type="button"
            onClick={() => setPriceIn(formatUnits(suggest, 18))}
            className="font-mono text-note text-brand transition-colors hover:text-brand/80"
          >
            {best !== undefined && best >= (l1Floor ?? 0n) ? c.bookUseBest : c.bookUseFloor}
          </button>
        )}
      </div>
      <p className="rounded-input bg-brand/10 px-3 py-2 text-note text-brand">{c.bookBuyOnly}</p>
      <Field label={c.bidPrice} value={priceIn} onChange={setPriceIn} />
      <Field label={c.bidUsdt} value={usdtIn} onChange={setUsdtIn} />
      <dl>
        <Row
          k={c.bidTokens}
          v={bidPrice > 0n ? fmtCompact(afterFee((bidUsdt * ONE) / bidPrice)) : '—'}
          strong={bidPrice > 0n && bidUsdt > 0n}
        />
      </dl>
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
  )
}

function MyBids({ bids, onDone, empty }: { bids: Bid[]; onDone: () => void; empty?: string }) {
  const c = useOuroCopy()
  if (bids.length === 0 && !empty) return null
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border-subtle p-4">
      <h3 className="text-label uppercase text-text-tertiary">{c.myBids}</h3>
      {bids.length === 0 ? (
        <p className="text-note text-text-tertiary">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {bids.map(b => <MyBidRow key={b.id.toString()} bid={b} onDone={onDone} />)}
        </ul>
      )}
    </div>
  )
}

function MyBidRow({ bid, onDone }: { bid: Bid; onDone: () => void }) {
  const c = useOuroCopy()
  const cancel = useTxAction({ action: 'cancel', onConfirmed: onDone })
  const tokens = bid.price === 0n ? 0n : (bid.usdtLeft * ONE) / bid.price
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 font-mono text-note tabular-nums">
      <span className="text-brand">{fmtPrice(bid.price)}</span>
      <span className="text-text-secondary">{fmt(bid.usdtLeft, 2)} USDT</span>
      <span className="text-text-secondary">{fmtCompact(tokens)} OURO</span>
      <Button
        label={c.cancel}
        size="sm"
        variant="danger"
        disabled={cancel.isBusy}
        onClick={() => OURO_BIDBOOK && cancel.send({
          address: OURO_BIDBOOK, abi: OURO_BIDBOOK_ABI, functionName: 'cancel', args: [bid.id],
        })}
      />
    </li>
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
