'use client'

import Link from 'next/link'
import { useMemo, useState, type ReactNode } from 'react'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { useAccount, useReadContract } from 'wagmi'

import {
  Button, Card, Field, FieldAffix, PageHeader, Readout,
  revertOrder, useActionGate, useQuoteApproval, useTxAction,
} from '@/components/ui'
import { fill, useT } from '@/i18n'
import { TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_BIDBOOK_ABI } from '@/lib/v2/abis'
import { depth, escrowFor, fillFloor, planSell, withSlippage, grossAt, type LiveBid } from '@/lib/v2/bidMath'
import { V2, V2_BIDBOOK, v2Quote, type V2Quote } from '@/lib/v2/config'
import { useBids, useGenesisState } from '@/lib/v2/useV2'
import { WRAP_VARS } from '@/components/ProjectTerminal/useWrapNative'
import { fmtSig, parseAmount } from './fmt'
import { useTokenBalance, useWrapShortfall } from './hooks'
import { RiskAck, useRiskAck } from './RiskAck'
import { RecentTrades } from './RecentTrades'
import { WalletAction } from './WalletAction'
import { AgentAddressField, AgentModeSheet, useAgentAddress } from './AgentModeSheet'
import { approveStep, prepSteps } from './agentSteps'

/** 1 % below the previewed proceeds, for `minTotalOut`. */
const SELL_SLIPPAGE_BPS = 100n

/**
 * `embedded` is the project page's market tab and the `/market` listing: no
 * page header, a stats strip, one order panel at a time, and a layout that
 * follows the container's width, not the viewport's.
 */
export function BidMarket({ hook, symbol, embedded = false }: {
  hook: Address
  symbol: string
  embedded?: boolean
}) {
  const t = useT().v2
  const tx = useT().x
  const { address: connected } = useAccount()
  const agent = useAgentAddress()
  const address = connected ?? agent
  const { data: s } = useGenesisState(hook)
  const book = useBids(hook)
  const [side, setSide] = useState<'sell' | 'bid'>('sell')

  if (!s) return <p className="text-note text-text-tertiary">…</p>
  const quote = v2Quote(s.quoteAsset, s.acceptsNative)
  const mine = book.bids.filter(b => address && b.bidder.toLowerCase() === address.toLowerCase() && b.escrow > 0n)

  if (embedded) {
    const best = book.open.reduce((m, b) => (b.price > m ? b.price : m), 0n)
    const escrowed = book.open.reduce((sum, b) => sum + b.escrow, 0n)
    const stats = [
      [tx.mktBest, best > 0n ? `${fmtSig(best, 18, 6)} ${quote.symbol}` : '—'],
      [tx.mktCurve, `${fmtSig(s.currentPrice, 18, 6)} ${quote.symbol}`],
      [tx.mktFloor, `${fmtSig(fillFloor(s.currentPrice), 18, 6)} ${quote.symbol}`],
      [tx.mktEscrow, `${fmtSig(escrowed)} ${quote.symbol}`],
    ] as const
    return (
      <div className="@container flex flex-col gap-6">
        <p className="text-body text-text-tertiary">{fill(t.marketBlurb, { quote: quote.symbol })}</p>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-card bg-border-subtle @3xl:grid-cols-4">
          {stats.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-1 bg-bg-subtle p-4">
              <dt className="text-label uppercase text-text-tertiary">{k}</dt>
              <dd className="font-mono text-readout font-bold text-text-primary">{v}</dd>
            </div>
          ))}
        </dl>
        {s.launched && <Card tone="warn"><p className="text-note">{t.marketClosed}</p></Card>}
        <div className="grid gap-6 @3xl:grid-cols-[minmax(0,1fr)_340px]">
          <DepthTable bids={book.open} quote={quote} floor={fillFloor(s.currentPrice)} />
          {!s.launched && (
            <div className="flex flex-col gap-4">
              <div role="tablist" aria-label={tx.mktSideLabel} className="grid grid-cols-2 gap-1 rounded-input bg-surface-hover/70 p-1">
                {([['sell', tx.mktSell], ['bid', tx.mktBid]] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={side === id}
                    onClick={() => setSide(id)}
                    className={`rounded-input px-2 py-1.5 text-note font-bold transition-colors ${
                      side === id ? 'bg-brand text-bg-base' : 'text-text-tertiary hover:text-text-primary'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {side === 'sell'
                ? <SellPanel hook={hook} token={s.token} symbol={symbol} quote={quote} bids={book.open} price={s.currentPrice} onDone={book.refetch} />
                : (
                  <>
                    <p className="rounded-input bg-brand/10 px-3 py-2 text-note text-brand">{tx.mktBuyOnlyWarn}</p>
                    <PlacePanel hook={hook} quote={quote} price={s.currentPrice} minBid={s.minBuy} onDone={book.refetch} />
                  </>
                )}
            </div>
          )}
        </div>
        <MyBids
          bids={mine}
          quote={quote}
          onDone={book.refetch}
          empty={address ? t.myBidsNone : t.myBidsLookup}
          footer={!connected && <AgentAddressField label={t.myBidsAddr} />}
        />
        <RecentTrades hook={hook} quote={quote} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={<Link href={`/projects/${hook}`} className="hover:underline">← ${symbol}</Link>}
        title={t.marketTitle}
        subtitle={fill(t.marketBlurb, { quote: quote.symbol })}
      />
      {s.launched && <Card tone="warn"><p className="text-note">{t.marketClosed}</p></Card>}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <DepthTable bids={book.open} quote={quote} floor={fillFloor(s.currentPrice)} />
        {!s.launched && (
          <aside className="flex flex-col gap-6">
            <SellPanel hook={hook} token={s.token} symbol={symbol} quote={quote} bids={book.open} price={s.currentPrice} onDone={book.refetch} />
            <PlacePanel hook={hook} quote={quote} price={s.currentPrice} minBid={s.minBuy} onDone={book.refetch} />
          </aside>
        )}
      </div>
      <MyBids bids={mine} quote={quote} onDone={book.refetch} />
      <RecentTrades hook={hook} quote={quote} />
    </div>
  )
}

function DepthTable({ bids, quote, floor }: { bids: readonly LiveBid[]; quote: V2Quote; floor: bigint }) {
  const t = useT().v2
  const levels = useMemo(() => depth(bids), [bids])
  return (
    <Card title={t.depth}>
      {levels.length === 0 ? (
        <p className="text-note text-text-tertiary">{t.noBids}</p>
      ) : (
        <table className="w-full font-mono text-note tabular-nums">
          <thead className="text-label text-text-tertiary">
            <tr>
              <th className="py-1 text-left">{fill(t.colPrice, { quote: quote.symbol })}</th>
              <th className="py-1 text-right">{t.colQty}</th>
              <th className="py-1 text-right">{fill(t.colTotal, { quote: quote.symbol })}</th>
              <th className="py-1 text-right">{t.colOrders}</th>
            </tr>
          </thead>
          <tbody>
            {levels.map(l => (
              <tr key={l.price.toString()} className={l.price < floor ? 'text-text-quiet line-through' : 'text-success'}>
                <td className="py-1">{fmtSig(l.price, 18, 6)}</td>
                <td className="py-1 text-right text-text-primary">{fmtSig(l.tokens)}</td>
                <td className="py-1 text-right text-text-primary">{fmtSig(l.quote)}</td>
                <td className="py-1 text-right text-text-secondary">{l.bids}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-label text-text-tertiary">{fill(t.sellFloor, { floor: fmtSig(floor, 18, 6), quote: quote.symbol })}</p>
    </Card>
  )
}

function SellPanel({ hook, token, symbol, quote, bids, price, onDone }: {
  hook: Address; token: Address; symbol: string; quote: V2Quote; bids: readonly LiveBid[]; price: bigint; onDone: () => void
}) {
  const t = useT().v2
  const { address } = useAccount()
  const [raw, setRaw] = useState('')
  const amount = parseAmount(raw) ?? 0n
  const bal = useTokenBalance(token)
  // Routed only into bids 1 % clear of the floor: GENESIS buys keep raising it,
  // and a bid that drops under it by inclusion time is skipped, not filled.
  const routeFloor = (fillFloor(price) * 101n) / 100n
  const plan = useMemo(() => planSell(bids, amount, routeFloor), [bids, amount, routeFloor])
  const risk = useRiskAck(hook)
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: token, abi: erc20Abi, functionName: 'allowance',
    args: address && V2_BIDBOOK ? [address, V2_BIDBOOK] : undefined, chainId: TARGET_CHAIN_ID,
    query: { enabled: !!address },
  })
  const approve = useTxAction({ action: fill(t.approveToken, { symbol }), onConfirmed: () => void refetchAllowance() })
  const tx = useTxAction({ action: t.sellAction, onConfirmed: () => { setRaw(''); void bal.refetch(); onDone() } })

  const gate = useActionGate({
    action: t.sellBtn,
    tx,
    onAct: () => tx.send({
      address: V2_BIDBOOK!, abi: V2_BIDBOOK_ABI, functionName: 'fill',
      args: [hook, plan.ids, plan.qtys, withSlippage(plan.out, SELL_SLIPPAGE_BPS)],
    }),
    blockersInRevertOrder: revertOrder(
      { id: 'amount', active: amount === 0n, label: t.sellBtn, reason: t.sellAmount, tone: 'neutral' },
      { id: 'balance', active: amount > (bal.data ?? 0n), label: t.sellBtn, reason: fill(t.sellBalance, { amount: fmtSig(bal.data) }), tone: 'neutral' },
      { id: 'nothing', active: plan.tokens === 0n, label: t.sellBtn, reason: t.sellNothing, tone: 'neutral' },
      { id: 'risk', active: !risk.acked, label: t.sellBtn, reason: t.riskRequired, tone: 'neutral' },
      (allowance ?? 0n) < plan.tokens && {
        id: 'approve', active: true, label: fill(t.approveToken, { symbol }), reason: fill(t.approveToken, { symbol }), tone: 'info',
        resolve: () => approve.send({ address: token, abi: erc20Abi, functionName: 'approve', args: [V2_BIDBOOK!, plan.tokens] }),
      },
    ),
  })

  return (
    <Card title={t.sellTitle}>
      <Field
        label={`${t.sellAmount} (${symbol})`}
        value={raw}
        onValueChange={setRaw}
        inputMode="decimal"
        placeholder="0"
        hint={fill(t.sellBalance, { amount: fmtSig(bal.data) })}
        affix={<FieldAffix onClick={() => setRaw(formatUnits(bal.data ?? 0n, 18))} disabled={!bal.data} />}
      />
      {plan.tokens > 0n && (
        <p className="text-note text-text-secondary">
          {fill(t.sellReceive, { amount: fmtSig(plan.out), quote: quote.symbol })}
          {plan.tokens < amount && ` (${fmtSig(plan.tokens)} ${symbol})`}
        </p>
      )}
      <RiskAck {...risk} />
      <WalletAction gate={gate} open />
      <AgentModeSheet
        title={`${t.agentNoteSell} ${fmtSig(plan.tokens)} ${symbol}`}
        summary={plan.tokens > 0n ? fill(t.sellReceive, { amount: fmtSig(plan.out), quote: quote.symbol }) : undefined}
        steps={risk.acked && plan.tokens > 0n ? [
          approveStep(token, symbol, V2_BIDBOOK!, plan.tokens, t),
          {
            note: t.agentNoteSell, to: V2_BIDBOOK!, abi: V2_BIDBOOK_ABI, functionName: 'fill',
            args: [hook, plan.ids, plan.qtys, withSlippage(plan.out, SELL_SLIPPAGE_BPS)],
          },
        ] : null}
        onDone={() => { void bal.refetch(); void refetchAllowance(); onDone() }}
      />
    </Card>
  )
}

function PlacePanel({ hook, quote, price, minBid, onDone }: {
  hook: Address; quote: V2Quote; price: bigint; minBid: bigint; onDone: () => void
}) {
  const t = useT().v2
  const tw = useT().wrap
  const [rawPrice, setRawPrice] = useState('')
  const [rawQty, setRawQty] = useState('')
  const bidPrice = parseAmount(rawPrice) ?? 0n
  const qty = parseAmount(rawQty) ?? 0n
  const escrow = bidPrice > 0n && qty > 0n ? escrowFor(bidPrice, qty) : 0n
  const approval = useQuoteApproval(V2_BIDBOOK, escrow, quote.asset)
  const wrap = useWrapShortfall(quote, escrow, approval.refetch)
  const tx = useTxAction({ action: t.placeAction, onConfirmed: () => { setRawQty(''); approval.refetch(); wrap.refetch(); onDone() } })

  const gate = useActionGate({
    action: t.placeBtn,
    tx,
    onAct: () => tx.send({ address: V2_BIDBOOK!, abi: V2_BIDBOOK_ABI, functionName: 'placeBid', args: [hook, bidPrice, qty] }),
    blockersInRevertOrder: revertOrder(
      { id: 'price', active: bidPrice < price, label: t.placeBtn, reason: fill(t.placeMin, { p: fmtSig(price, 18, 6), quote: quote.symbol }), tone: 'neutral' },
      { id: 'qty', active: qty < V2.MIN_FILL_QTY, label: t.placeBtn, reason: t.placeQtyMin, tone: 'neutral' },
      { id: 'min', active: grossAt(bidPrice, qty) < minBid, label: t.placeBtn, reason: fill(t.placeMinTotal, { min: fmtSig(minBid), quote: quote.symbol }), tone: 'neutral' },
      wrap.gap > 0n && {
        id: 'wrap', active: true,
        label: fill(tw.wrapLabel, { ...WRAP_VARS, amount: fmtSig(wrap.gap) }),
        reason: fill(tw.wrapReason, { ...WRAP_VARS, amount: fmtSig(wrap.gap) }),
        tone: 'info', resolve: wrap.canWrap ? wrap.wrap : undefined,
      },
      approval.needsApproval && {
        id: 'approve', active: true, label: fill(t.approve, { quote: quote.symbol }),
        reason: fill(t.approve, { quote: quote.symbol }), tone: 'info', resolve: approval.approve,
      },
    ),
  })

  return (
    <Card title={t.placeTitle}>
      <Field
        label={fill(t.placePrice, { quote: quote.symbol })}
        value={rawPrice}
        onValueChange={setRawPrice}
        inputMode="decimal"
        placeholder={formatUnits(price, 18)}
        hint={fill(t.placeMin, { p: fmtSig(price, 18, 6), quote: quote.symbol })}
        affix={<FieldAffix label="min" onClick={() => setRawPrice(formatUnits(price, 18))} />}
      />
      <Field label={t.placeQty} value={rawQty} onValueChange={setRawQty} inputMode="decimal" placeholder="0" />
      {escrow > 0n && <Readout label={t.payLabel} value={fill(t.placeEscrow, { amount: fmtSig(escrow), quote: quote.symbol })} />}
      <WalletAction gate={gate} open />
      <AgentModeSheet
        title={`${t.agentNoteBid} ${fmtSig(qty)} @ ${fmtSig(bidPrice, 18, 6)} ${quote.symbol}`}
        steps={bidPrice >= price && qty >= V2.MIN_FILL_QTY && grossAt(bidPrice, qty) >= minBid ? [
          ...prepSteps(quote, V2_BIDBOOK!, escrow, t),
          { note: t.agentNoteBid, to: V2_BIDBOOK!, abi: V2_BIDBOOK_ABI, functionName: 'placeBid', args: [hook, bidPrice, qty] },
        ] : null}
        onDone={() => { approval.refetch(); wrap.refetch(); onDone() }}
      />
    </Card>
  )
}

/** Hidden when there are no bids, unless `empty` gives the card something to say. */
export function MyBids({ bids, quote, onDone, showHook = false, empty, footer }: {
  bids: readonly (LiveBid & { hook?: Address })[]; quote?: V2Quote; onDone: () => void; showHook?: boolean
  empty?: string; footer?: ReactNode
}) {
  const t = useT().v2
  if (bids.length === 0 && !empty) return null
  return (
    <Card title={t.myBids}>
      {bids.length === 0
        ? <p className="text-note text-text-tertiary">{empty}</p>
        : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {bids.map(b => <MyBidRow key={b.id.toString()} bid={b} quote={quote} onDone={onDone} showHook={showHook} />)}
          </ul>
        )}
      {footer}
    </Card>
  )
}

function MyBidRow({ bid, quote, onDone, showHook }: {
  bid: LiveBid & { hook?: Address }; quote?: V2Quote; onDone: () => void; showHook: boolean
}) {
  const t = useT().v2
  const { address } = useAccount()
  const tx = useTxAction({ action: t.cancelAction, onConfirmed: onDone })
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 font-mono text-note tabular-nums">
      <span className="text-text-secondary">#{bid.id.toString()}</span>
      {showHook && bid.hook && (
        <Link className="text-brand hover:underline" href={`/projects/${bid.hook}/market`}>{bid.hook.slice(0, 10)}…</Link>
      )}
      <span>{fmtSig(bid.price, 18, 6)} {quote?.symbol ?? ''}</span>
      <span className="text-text-secondary">{fill(t.filledOf, { filled: fmtSig(bid.filled), qty: fmtSig(bid.qty) })}</span>
      {address && (
        <Button
          size="sm"
          variant="ghost"
          label={t.cancel}
          {...(tx.isBusy ? { busy: true as const } : {})}
          onClick={() => tx.send({ address: V2_BIDBOOK!, abi: V2_BIDBOOK_ABI, functionName: 'cancelBid', args: [bid.id] })}
        />
      )}
      <div className="basis-full font-sans">
        <AgentModeSheet
          title={fill(t.agentNoteCancel, { id: bid.id.toString() })}
          steps={[{
            note: fill(t.agentNoteCancel, { id: bid.id.toString() }),
            to: V2_BIDBOOK!, abi: V2_BIDBOOK_ABI, functionName: 'cancelBid', args: [bid.id],
          }]}
          onDone={onDone}
        />
      </div>
    </li>
  )
}
