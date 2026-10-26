'use client'

import Link from 'next/link'
import { useState } from 'react'
import { isAddress, type Address } from 'viem'
import { useAccount, useReadContract } from 'wagmi'

import {
  ActionButton, AddressLink, Badge, Card, Field, Progress, Readout, ReadoutGrid,
  revertOrder, useActionGate, useQuoteApproval, useTxAction,
} from '@/components/ui'
import { WRAP_VARS } from '@/components/ProjectTerminal/useWrapNative'
import { fill, useT } from '@/i18n'
import { TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_HOOK_ABI } from '@/lib/v2/abis'
import { V2, v2Quote, type V2Quote } from '@/lib/v2/config'
import { useGenesisState } from '@/lib/v2/useV2'
import { fmtCountdown, fmtSig, fmtTime, parseAmount } from './fmt'
import { GenesisBuyPanel } from './GenesisBuyPanel'
import { useNow, useWrapShortfall } from './hooks'
import { AgentModeSheet } from './AgentModeSheet'
import { prepSteps } from './agentSteps'
import { TransferPanel } from './TransferPanel'

type State = NonNullable<ReturnType<typeof useGenesisState>['data']>

export function V2Terminal({ hook, symbol }: { hook: Address; symbol: string }) {
  const t = useT().v2
  const { data: s, refetch } = useGenesisState(hook)
  const now = useNow()
  if (!s) return <Card><p className="text-note text-text-tertiary">…</p></Card>

  const quote = v2Quote(s.quoteAsset, s.acceptsNative)
  const genesisOpen = !s.launched && s.soldOutAt === 0n && BigInt(now) < s.genesisDeadline

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-6">
        <GenesisStats s={s} quote={quote} now={now} />
        {!s.launched && (
          <Card title={t.rulesTitle}>
            <p className="text-note text-text-secondary">{t.rulesBody}</p>
            <div className="flex flex-wrap gap-4 text-note">
              <Link className="text-brand hover:underline" href={`/projects/${hook}/market`}>{t.marketLink} →</Link>
              <Link className="text-brand hover:underline" href={`/register?token=${s.token}`}>{t.registerLink} →</Link>
            </div>
          </Card>
        )}
        {s.launched && <ShelfPanel hook={hook} quote={quote} symbol={symbol} />}
        <FundPanel hook={hook} s={s} quote={quote} onDone={() => void refetch()} />
      </div>
      <aside className="flex flex-col gap-6 lg:sticky lg:top-20 lg:self-start">
        {!s.launched && <GenesisBuyPanel hook={hook} quote={quote} open={genesisOpen} />}
        <LaunchPanel hook={hook} s={s} quote={quote} now={now} onDone={() => void refetch()} />
        <TransferPanel token={s.token} symbol={symbol} />
      </aside>
    </div>
  )
}

function GenesisStats({ s, quote, now }: { s: State; quote: V2Quote; now: number }) {
  const t = useT().v2
  const pct = Number((s.sold * 10_000n) / V2.SALE_SUPPLY) / 100
  const status = s.launched
    ? <Badge tone="ok" pip live>LIVE</Badge>
    : s.soldOutAt !== 0n
      ? <Badge tone="info">{t.soldOut}</Badge>
      : BigInt(now) >= s.genesisDeadline
        ? <Badge tone="neutral">{t.closed}</Badge>
        : <Badge tone="warn" pip live>{t.genesisTitle}</Badge>

  return (
    <Card title={t.genesisTitle} status={status}>
      <p className="text-note text-text-secondary">
        {fill(t.genesisBlurb, {
          p: fmtSig(s.basePrice), p15: fmtSig((s.basePrice * 3n) / 2n), quote: quote.symbol,
        })}
      </p>
      <Progress pct={pct} label={t.sold} caption={`${fmtSig(s.sold)} / 5.6M`} />
      <ReadoutGrid columns={3}>
        <Readout label={t.price} value={`${fmtSig(s.currentPrice)} ${quote.symbol}`} />
        <Readout label={t.raised} value={`${fmtSig(s.raised)} / ${fmtSig(s.hardCap)} ${quote.symbol}`} />
        <Readout label={t.perAgentCap} value={`${fmtSig(s.perAgentCap)} ${quote.symbol}`} />
        {!s.launched && s.soldOutAt === 0n && (
          <Readout label={t.endsIn} value={fmtCountdown(Number(s.genesisDeadline) - now)} />
        )}
      </ReadoutGrid>
    </Card>
  )
}

function LaunchPanel({ hook, s, quote, now, onDone }: {
  hook: Address; s: State; quote: V2Quote; now: number; onDone: () => void
}) {
  const t = useT().v2
  const { address } = useAccount()
  const tx = useTxAction({ action: t.launchAction, onConfirmed: onDone })
  const started = BigInt(now) >= s.launchStart && s.raised > 0n
  const publicOpen = BigInt(now) >= s.publicLaunchAt
  const isController = !!address && address.toLowerCase() === s.projectController.toLowerCase()

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

  return (
    <Card title={t.launchTitle}>
      <p className="text-note text-text-secondary">
        {s.launched ? t.launchExplain : started ? (publicOpen ? t.launchPublic : fill(t.launchAdminWindow, { time: fmtTime(s.publicLaunchAt) })) : t.launchExplain}
      </p>
      {!s.launched && <ActionButton gate={gate} />}
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
          <ActionButton gate={wGate} />
          <Field label={t.fundAddrLabel} value={raw} onValueChange={setRaw} placeholder="0x…" />
          <ActionButton gate={cGate} />
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
      <ActionButton gate={gate} />
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
