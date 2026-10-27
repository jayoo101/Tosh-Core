'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { isAddress, type Address } from 'viem'
import { useAccount, useReadContract } from 'wagmi'

import {
  AddressLink, Card, Field, Readout, ReadoutGrid,
  revertOrder, useActionGate, useQuoteApproval, useTxAction,
} from '@/components/ui'
import { WRAP_VARS } from '@/components/ProjectTerminal/useWrapNative'
import {
  GENESIS_TOKENS, LP_TOKENS_MAX, SALE_TOKENS, SHELF_TOKENS, TOTAL_TOKENS,
  fmtClock, fmtCompact, fmtPrice, pct, toNum,
} from '@/components/x/curve'
import { GenesisCurveChart, PriceLadderMini } from '@/components/x/GenesisCurveChart'
import { PhaseBadge, v2Phase, type V2Phase } from '@/components/x/Lifecycle'
import { Bar, Panel, Stat, StatGrid } from '@/components/x/Panel'
import { ProjectTabs } from '@/components/x/ProjectTabs'
import { fill, useT } from '@/i18n'
import { TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_HOOK_ABI, V2_LENS_ABI } from '@/lib/v2/abis'
import { V2, V2_LENS, v2Quote, type V2Quote } from '@/lib/v2/config'
import { useGenesisState } from '@/lib/v2/useV2'
import { BidMarket } from './BidMarket'
import { fmtSig, fmtTime, parseAmount } from './fmt'
import { GenesisBuyPanel } from './GenesisBuyPanel'
import { useNow, useWrapShortfall } from './hooks'
import { WalletAction } from './WalletAction'
import { AgentModeSheet, useAgentAddress } from './AgentModeSheet'
import { prepSteps } from './agentSteps'
import { TransferPanel } from './TransferPanel'

import { agentShares } from './shares'
type State = NonNullable<ReturnType<typeof useGenesisState>['data']>

/**
 * `header` is the page's identity row; it takes the price block for its right
 * side because that block reads the same genesis state as everything here.
 */
export function V2Terminal({ hook, symbol, header }: {
  hook: Address
  symbol: string
  header?: (aside: ReactNode) => ReactNode
}) {
  const tx = useT().x
  const { data: s, refetch } = useGenesisState(hook)
  const now = useNow()
  if (!s) {
    return (
      <div className="flex flex-col gap-6">
        {header?.(null)}
        <Card><p className="text-note text-text-tertiary">…</p></Card>
      </div>
    )
  }

  const quote = v2Quote(s.quoteAsset, s.acceptsNative)
  const genesisOpen = !s.launched && s.soldOutAt === 0n && BigInt(now) < s.genesisDeadline
  const phase = v2Phase(s, now)
  const p = toNum(s.basePrice)

  // After launch the book only takes cancellations, and those live on /market.
  const tabs = [
    ...(s.launched ? [] : [{ id: 'market', label: tx.tabMarket, content: <BidMarket hook={hook} symbol={symbol} embedded /> }]),
    { id: 'tokenomics', label: tx.tabTokenomics, content: <Tokenomics s={s} quote={quote} /> },
    { id: 'rules', label: tx.tabRules, content: <Rules s={s} quote={quote} /> },
    { id: 'fund', label: tx.tabFund, content: <FundPanel hook={hook} s={s} quote={quote} onDone={() => void refetch()} /> },
  ]

  return (
    <div className="flex flex-col gap-6">
      {header?.(<PriceAside s={s} quote={quote} phase={phase} />)}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-6">
          <GenesisStatGrid s={s} quote={quote} now={now} phase={phase} />
          {s.launched ? (
            <ShelfLadder hook={hook} quote={quote} />
          ) : (
            <Panel title={tx.curveTitle}>
              <GenesisCurveChart p={p} sold={toNum(s.sold)} quote={quote.symbol} />
              <PriceLadderMini p={p} current={toNum(s.currentPrice)} quote={quote.symbol} />
            </Panel>
          )}
          <ProjectTabs tabs={tabs} />
        </div>
        <aside className="flex flex-col gap-6 lg:sticky lg:top-20 lg:self-start">
          {s.launched
            ? <ShelfPanel hook={hook} quote={quote} symbol={symbol} />
            : <GenesisBuyPanel hook={hook} quote={quote} open={genesisOpen} symbol={symbol} />}
          <LaunchPanel hook={hook} s={s} quote={quote} now={now} onDone={() => void refetch()} />
          {!s.launched && <TransferPanel token={s.token} symbol={symbol} />}
        </aside>
      </div>
    </div>
  )
}

function PriceAside({ s, quote, phase }: { s: State; quote: V2Quote; phase: V2Phase }) {
  const tx = useT().x
  return (
    <div className="flex flex-col gap-1 sm:items-end">
      <PhaseBadge phase={phase} />
      <span className="mt-2 text-label uppercase text-text-tertiary">{tx.currentPrice}</span>
      <span className="font-mono text-section font-bold tabular-nums text-brand sm:text-hero">
        {fmtPrice(toNum(s.currentPrice))}
        <span className="ml-1.5 text-readout font-normal text-text-secondary">{quote.symbol}</span>
      </span>
      {!s.launched && (
        <span className="font-mono text-note text-text-tertiary">
          {fill(tx.launchAt2P, { p: fmtPrice(2 * toNum(s.basePrice)) })}
        </span>
      )}
    </div>
  )
}

function GenesisStatGrid({ s, quote, now, phase }: { s: State; quote: V2Quote; now: number; phase: V2Phase }) {
  const tx = useT().x
  const sold = pct(s.sold, V2.SALE_SUPPLY)
  const phaseLabel = { GENESIS: tx.phaseGenesis, PENDING: tx.phasePending, TRADING: tx.phaseTrading }[phase]
  return (
    <StatGrid>
      <Stat label={tx.statSold} value={`${sold.toFixed(2)}%`} sub={`${fmtCompact(toNum(s.sold))} / ${fmtCompact(SALE_TOKENS)}`}>
        <Bar pct={sold} label={tx.statSold} />
      </Stat>
      <Stat
        label={tx.statRaised}
        value={fmtSig(s.raised)}
        sub={fill(tx.statRaisedSub, { cap: fmtSig(s.hardCap), quote: quote.symbol })}
      />
      <Stat label={tx.statPerAgent} value={fmtSig(s.perAgentCap)} sub={quote.symbol} />
      {phase === 'GENESIS'
        ? <Stat label={tx.statEndsIn} value={fmtClock(Number(s.genesisDeadline) - now)} highlight />
        : <Stat label={tx.statStage} value={phaseLabel} highlight />}
    </StatGrid>
  )
}

function Tokenomics({ s, quote }: { s: State; quote: V2Quote }) {
  const tx = useT().x
  const parts = [
    { label: tx.tokGenesis, value: SALE_TOKENS, cls: 'bg-brand' },
    { label: tx.tokPool, value: LP_TOKENS_MAX, cls: 'bg-brand/50' },
    { label: tx.tokShelf, value: SHELF_TOKENS, cls: 'bg-text-tertiary/40' },
  ]
  const fundPct = Number(V2.FUND_BPS) / 100
  return (
    <div className="flex flex-col gap-6">
      <div className="flex h-3 overflow-hidden rounded-pill" aria-hidden="true">
        {parts.map(pt => <span key={pt.label} className={pt.cls} style={{ width: `${(pt.value / TOTAL_TOKENS) * 100}%` }} />)}
      </div>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {parts.map(pt => (
          <div key={pt.label} className="flex flex-col gap-1">
            <dt className="flex items-center gap-2 text-body text-text-tertiary">
              <span className={`size-2.5 rounded-pill ${pt.cls}`} aria-hidden="true" />
              {pt.label}
            </dt>
            <dd className="font-mono text-title text-text-primary">
              {fmtCompact(pt.value)}
              <span className="ml-2 text-note text-text-tertiary">{((pt.value / TOTAL_TOKENS) * 100).toFixed(0)}%</span>
            </dd>
          </div>
        ))}
      </dl>
      <ul className="flex flex-col gap-2 border-t border-border-subtle pt-5 text-body text-text-tertiary">
        <li>{fill(tx.tokNote1, { total: fmtCompact(TOTAL_TOKENS), genesis: fmtCompact(GENESIS_TOKENS) })}</li>
        <li>{fill(tx.tokNote2, { fund: String(fundPct), lp: String(100 - fundPct) })}</li>
        <li>{fill(tx.tokNote3, { amount: fmtSig((s.hardCap * (10_000n - V2.FUND_BPS)) / 10_000n), quote: quote.symbol, lp: fmtCompact(LP_TOKENS_MAX) })}</li>
      </ul>
    </div>
  )
}

function Rules({ s, quote }: { s: State; quote: V2Quote }) {
  const t = useT().v2
  const tx = useT().x
  const shares = agentShares(quote, s.minBuy, s.perAgentCap)
  const rules = [
    [tx.ruleCurve, tx.ruleCurveBody],
    [tx.ruleCap, shares
      ? fill(tx.ruleCapBodyShares, { size: fmtSig(shares.size), quote: quote.symbol, count: String(shares.count) })
      : fill(tx.ruleCapBody, { cap: fmtSig(s.perAgentCap), quote: quote.symbol })],
    [tx.ruleFinal, tx.ruleFinalBody],
    [tx.rulePrelaunch, tx.rulePrelaunchBody],
    [tx.ruleLaunch, tx.ruleLaunchBody],
    [tx.ruleBook, tx.ruleBookBody],
    [tx.ruleShelf, tx.ruleShelfBody],
  ]
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col divide-y divide-border-subtle">
        {rules.map(([k, v]) => (
          <div key={k} className="grid grid-cols-1 gap-1 py-3 first:pt-0 sm:grid-cols-[140px_1fr] sm:gap-4">
            <dt className="font-bold text-text-primary">{k}</dt>
            <dd className="text-pretty text-body text-text-tertiary">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-note text-text-tertiary">{tx.ruleAgentNote}</p>
      <div className="flex flex-wrap gap-4 text-note">
        <Link className="text-brand hover:underline" href={`/register?token=${s.token}`}>{t.registerLink} →</Link>
      </div>
    </div>
  )
}

const LADDER_WINDOW = 6

function ShelfLadder({ hook, quote }: { hook: Address; quote: V2Quote }) {
  const tx = useT().x
  const { data: st } = useReadContract({
    address: hook, abi: V2_HOOK_ABI, functionName: 'tierStatus', chainId: TARGET_CHAIN_ID,
    query: { refetchInterval: 8_000 },
  })
  const idx = st?.[0] ?? 0n
  const start = idx > 1n ? idx - 1n : 0n
  const { data: tiers } = useReadContract({
    address: V2_LENS, abi: V2_LENS_ABI, functionName: 'getTiers', args: [hook, start, BigInt(LADDER_WINDOW)],
    chainId: TARGET_CHAIN_ID, query: { enabled: !!st && !!V2_LENS, refetchInterval: 8_000 },
  })
  const current = tiers?.[Number(idx - start)]
  const filled = current ? pct(current.soldAmount, current.totalAmount) : 0
  const step = (n: bigint) => (n + 1n).toLocaleString()

  return (
    <Panel>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-label uppercase text-text-tertiary">{tx.ladderTitle}</h2>
          <p className="text-pretty text-title text-text-primary">{tx.ladderBody}</p>
        </div>
        <span className="shrink-0 rounded-input border border-border-subtle px-2 py-1 font-mono text-note text-text-tertiary">
          {tx.ladderCap}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between font-mono">
          <span className="font-bold text-text-primary">{fill(tx.ladderStep, { n: step(idx) })}</span>
          <span className="text-brand">{`${filled.toFixed(1)}%`}</span>
        </div>
        <Bar pct={filled} label={fill(tx.ladderStep, { n: step(idx) })} thick />
      </div>
      <dl className="grid grid-cols-3 gap-4">
        {[
          [tx.ladderPrice, st ? `${fmtPrice(toNum(st[1]))} ${quote.symbol}` : '—'],
          [tx.ladderLeft, st ? fmtCompact(toNum(st[2])) : '—'],
          [tx.ladderSpot, st ? `${fmtPrice(toNum(st[3]))} ${quote.symbol}` : '—'],
        ].map(([k, v]) => (
          <div key={k} className="flex flex-col gap-1">
            <dt className="text-body text-text-tertiary">{k}</dt>
            <dd className="font-mono text-title text-text-primary">{v}</dd>
          </div>
        ))}
      </dl>
      {tiers && tiers.length > 0 && (
        <div className="overflow-hidden rounded-card border border-border-subtle">
          <table className="w-full font-mono text-body">
            <caption className="sr-only">{tx.ladderCaption}</caption>
            <tbody>
              {tiers.map((tier, i) => {
                const n = start + BigInt(i)
                const isCurrent = n === idx
                const status = tier.soldAmount >= tier.totalAmount ? tx.ladderFilled : isCurrent ? tx.ladderActive : tx.ladderQueued
                return (
                  <tr
                    key={n.toString()}
                    className={`border-b border-border-subtle last:border-b-0 ${isCurrent ? 'bg-brand/10 text-text-primary' : 'text-text-tertiary'}`}
                  >
                    <th scope="row" className="px-5 py-3 text-left font-normal">#{step(n)}</th>
                    <td className="px-5 py-3">{`${fmtPrice(toNum(tier.price))} ${quote.symbol}`}</td>
                    <td className="px-5 py-3 text-right">{`${pct(tier.soldAmount, tier.totalAmount).toFixed(1)}%`}</td>
                    <td className={`px-5 py-3 text-right font-sans ${isCurrent ? 'text-brand' : ''}`}>{status}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

function LaunchPanel({ hook, s, quote, now, onDone }: {
  hook: Address; s: State; quote: V2Quote; now: number; onDone: () => void
}) {
  const t = useT().v2
  const { address } = useAccount()
  const agent = useAgentAddress()
  const tx = useTxAction({ action: t.launchAction, onConfirmed: onDone })
  const started = BigInt(now) >= s.launchStart && s.raised > 0n
  const publicOpen = BigInt(now) >= s.publicLaunchAt
  const controller = s.projectController.toLowerCase()
  const isController = !!address && address.toLowerCase() === controller
  // The Circuit NFT holder is often an Agentic Wallet, which cannot connect,
  // so the address typed into Agent mode counts as being the project too.
  const isProject = isController || (!!agent && agent.toLowerCase() === controller)

  const gate = useActionGate({
    action: t.launchBtn,
    tx,
    onAct: () => tx.send({ address: hook, abi: V2_HOOK_ABI, functionName: 'launch' }),
    blockersInRevertOrder: revertOrder(
      s.launched && { id: 'launched', active: true, label: t.launchBtn, reason: t.marketClosed, tone: 'neutral' },
      !started && { id: 'wait', active: true, label: t.launchBtn, reason: t.launchWaiting, tone: 'neutral' },
      started && !publicOpen && !isController && {
        id: 'window', active: true, label: t.launchBtn,
        reason: fill(t.launchAdminWindow, { time: fmtTime(s.publicLaunchAt) }), tone: 'info',
      },
    ),
  })

  if (!isProject) return null

  return (
    <Card title={t.launchTitle}>
      <p className="text-note text-text-secondary">
        {s.launched ? t.launchExplain : started ? (publicOpen ? t.launchPublic : fill(t.launchAdminWindow, { time: fmtTime(s.publicLaunchAt) })) : t.launchExplain}
      </p>
      {!s.launched && <WalletAction gate={gate} />}
      {!s.launched && started && (
        <AgentModeSheet
          title={t.launchBtn}
          steps={[{ note: t.agentNoteLaunch, to: hook, abi: V2_HOOK_ABI, functionName: 'launch' }]}
          onDone={onDone}
        />
      )}
      {s.launched && <LaunchedLine hook={hook} quote={quote} />}
    </Card>
  )
}

function LaunchedLine({ hook, quote }: { hook: Address; quote: V2Quote }) {
  const t = useT().v2
  const { data: p0 } = useReadContract({ address: hook, abi: V2_HOOK_ABI, functionName: 'p0', chainId: TARGET_CHAIN_ID })
  return <p className="text-note text-success">{fill(t.launched, { p0: fmtSig(p0), quote: quote.symbol })}</p>
}

function FundPanel({ hook, s, quote, onDone }: { hook: Address; s: State; quote: V2Quote; onDone: () => void }) {
  const t = useT().v2
  const { address } = useAccount()
  const [raw, setRaw] = useState('')
  const isController = !!address && address.toLowerCase() === s.projectController.toLowerCase()
  const withdraw = useTxAction({ action: t.withdrawAction, onConfirmed: onDone })
  const change = useTxAction({ action: t.setFundAction, onConfirmed: () => { setRaw(''); onDone() } })

  const wGate = useActionGate({
    action: t.withdraw,
    tx: withdraw,
    onAct: () => withdraw.send({ address: hook, abi: V2_HOOK_ABI, functionName: 'withdrawFund' }),
    blockersInRevertOrder: revertOrder(
      !isController && { id: 'ctl', active: true, label: t.withdraw, reason: t.controllerOnly, tone: 'neutral' },
      { id: 'zero', active: s.fundAvailable === 0n, label: t.withdraw, reason: t.fundBlurb, tone: 'neutral' },
    ),
  })
  const cGate = useActionGate({
    action: t.setFund,
    tx: change,
    onAct: () => change.send({ address: hook, abi: V2_HOOK_ABI, functionName: 'setProjectFund', args: [raw as Address] }),
    blockersInRevertOrder: revertOrder(
      !isController && { id: 'ctl', active: true, label: t.setFund, reason: t.controllerOnly, tone: 'neutral' },
      { id: 'addr', active: !isAddress(raw), label: t.setFund, reason: t.fundAddrLabel, tone: 'neutral' },
    ),
  })

  return (
    <Card title={t.fundTitle} subtitle={t.fundBlurb}>
      <ReadoutGrid columns={2}>
        <Readout label={t.fundAvailable} value={`${fmtSig(s.fundAvailable)} ${quote.symbol}`} />
        <Readout label={t.fundTo} value={<AddressLink value={s.projectFund} />} />
      </ReadoutGrid>
      {s.fundAvailable > 0n && (
        <AgentModeSheet
          title={`${t.withdraw} ${fmtSig(s.fundAvailable)} ${quote.symbol}`}
          steps={[{ note: t.agentNoteWithdraw, to: hook, abi: V2_HOOK_ABI, functionName: 'withdrawFund' }]}
          onDone={onDone}
        />
      )}
      {isController && (
        <div className="flex flex-col gap-4">
          <WalletAction gate={wGate} />
          <Field label={t.fundAddrLabel} value={raw} onValueChange={setRaw} placeholder="0x…" />
          <WalletAction gate={cGate} />
        </div>
      )}
    </Card>
  )
}

function ShelfPanel({ hook, quote, symbol }: { hook: Address; quote: V2Quote; symbol: string }) {
  const t = useT().v2
  const tw = useT().wrap
  const [raw, setRaw] = useState('')
  const amount = parseAmount(raw) ?? 0n
  const { data: st, refetch } = useReadContract({
    address: hook, abi: V2_HOOK_ABI, functionName: 'tierStatus', chainId: TARGET_CHAIN_ID,
    query: { refetchInterval: 8_000 },
  })
  const { data: cost } = useReadContract({
    address: hook, abi: V2_HOOK_ABI, functionName: 'quoteMint', args: [amount], chainId: TARGET_CHAIN_ID,
    query: { enabled: amount > 0n },
  })
  const maxCost = cost ?? 0n
  const approval = useQuoteApproval(hook, maxCost, quote.asset)
  const wrap = useWrapShortfall(quote, maxCost, () => {})
  const tx = useTxAction({ action: t.mintAction, onConfirmed: () => { setRaw(''); void refetch(); approval.refetch(); wrap.refetch() } })
  const unlocked = st?.[6] ?? false

  const gate = useActionGate({
    action: t.mintBtn,
    tx,
    onAct: () => tx.send({ address: hook, abi: V2_HOOK_ABI, functionName: 'mintBondingCurve', args: [amount, maxCost] }),
    blockersInRevertOrder: revertOrder(
      !unlocked && { id: 'locked', active: true, label: t.mintBtn, reason: t.shelfLocked, tone: 'neutral' },
      { id: 'amount', active: amount === 0n || maxCost === 0n, label: t.mintBtn, reason: t.mintAmount, tone: 'neutral' },
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
    <Card title={t.shelfTitle} subtitle={t.shelfBlurb}>
      <ReadoutGrid columns={2}>
        <Readout label={t.shelfPrice} value={st ? `${fmtSig(st[1])} ${quote.symbol}` : '—'} />
        <Readout label={t.shelfLeft} value={st ? `${fmtSig(st[2])} ${symbol}` : '—'} />
      </ReadoutGrid>
      <Field label={`${t.mintAmount} (${symbol})`} value={raw} onValueChange={setRaw} inputMode="decimal" placeholder="0" />
      {maxCost > 0n && <Readout label={t.payLabel} value={`${fmtSig(maxCost)} ${quote.symbol}`} />}
      <WalletAction gate={gate} open />
      <AgentModeSheet
        title={fill(t.agentNoteMint, { amount: fmtSig(amount), symbol })}
        summary={maxCost > 0n ? `${t.payLabel}: ${fmtSig(maxCost)} ${quote.symbol}` : undefined}
        steps={unlocked && amount > 0n && maxCost > 0n ? [
          ...prepSteps(quote, hook, maxCost, t),
          { note: fill(t.agentNoteMint, { amount: fmtSig(amount), symbol }), to: hook, abi: V2_HOOK_ABI, functionName: 'mintBondingCurve', args: [amount, maxCost] },
        ] : null}
        onDone={() => { void refetch(); approval.refetch(); wrap.refetch() }}
      />
    </Card>
  )
}
