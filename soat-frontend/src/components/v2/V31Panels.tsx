'use client'

import { useState } from 'react'
import { zeroHash, type Address } from 'viem'
import { useAccount, useReadContract } from 'wagmi'

import {
  Card, Field, Readout, ReadoutGrid, revertOrder, useActionGate, useQuoteApproval, useTxAction,
} from '@/components/ui'
import { fmtClock, fmtCompact, fmtPrice, pct, toNum } from '@/components/x/curve'
import { Bar, Panel, Stat, StatGrid } from '@/components/x/Panel'
import { fill, useT } from '@/i18n'
import { TARGET_CHAIN_ID } from '@/lib/chain'
import { V31_HOOK_ABI, V31_VESTING_ABI } from '@/lib/v2/abisV31'
import { V2, V31, type V2Quote } from '@/lib/v2/config'
import { untilNext, v31Split } from '@/lib/v2/l2Math'
import { useAccountState, useGenesisState, useL2Account, useL2Quote, useL2State } from '@/lib/v2/useV2'
import { AgentModeSheet, useAgentAddress } from './AgentModeSheet'
import { prepSteps } from './agentSteps'
import { fmtSig, fmtTime, parseAmount } from './fmt'
import { WalletAction } from './WalletAction'

type State = NonNullable<ReturnType<typeof useGenesisState>['data']>

const SLIPPAGE_BPS = 100n

/** The L2 curve: price after decay, supply split three ways, and the two idle clocks. */
export function L2CurvePanel({ hook, quote, now }: { hook: Address; quote: V2Quote; now: number }) {
  const t = useT().v31
  const { data: l2 } = useL2State(hook)
  if (!l2) return <Panel title={t.curveTitle}><p className="text-note text-text-tertiary">…</p></Panel>

  const minted = pct(l2.minted, l2.supply)
  const burned = pct(l2.burned, l2.supply)
  const left = pct(l2.remaining, l2.supply)
  const multiple = l2.p0 > 0n ? toNum(l2.price) / toNum(l2.p0) : 0
  const perBurn = l2.supply / V31.BURN_PERIODS
  const done = l2.remaining === 0n

  return (
    <Panel>
      <div className="flex flex-col gap-2">
        <h2 className="text-label uppercase text-text-tertiary">{t.curveTitle}</h2>
        <p className="text-pretty text-title text-text-primary">{t.curveBody}</p>
      </div>
      <StatGrid>
        <Stat
          label={t.price}
          value={`${fmtPrice(toNum(l2.price))} ${quote.symbol}`}
          sub={multiple > 0 ? fill(t.vsOpen, { x: multiple.toFixed(3) }) : undefined}
          highlight
        />
        <Stat label={t.lastPrice} value={`${fmtPrice(toNum(l2.lastPrice))} ${quote.symbol}`} sub={fmtTime(l2.lastMintAt)} />
        <Stat
          label={t.nextDecay}
          value={l2.halted || done ? '—' : fmtClock(untilNext(now, l2.lastMintAt, V31.DECAY_INTERVAL_S))}
          sub={t.nextDecaySub}
        />
        <Stat
          label={t.nextBurn}
          value={l2.halted || done ? '—' : fmtClock(untilNext(now, l2.lastMintAt, V31.BURN_INTERVAL_S))}
          sub={fill(t.burnSize, { amount: fmtCompact(toNum(perBurn)) })}
        />
      </StatGrid>
      {l2.halted && <p className="text-note text-warning">{t.halted}</p>}
      {done && <p className="text-note text-text-secondary">{t.soldOut}</p>}
      <div className="flex flex-col gap-3">
        <div className="flex h-3 overflow-hidden rounded-pill" aria-hidden="true">
          <span className="bg-brand" style={{ width: `${minted}%` }} />
          <span className="bg-danger/60" style={{ width: `${burned}%` }} />
          <span className="bg-text-tertiary/30" style={{ width: `${left}%` }} />
        </div>
        <dl className="grid grid-cols-3 gap-4">
          {[
            [t.minted, l2.minted, minted, 'bg-brand'],
            [t.burned, l2.burned, burned, 'bg-danger/60'],
            [t.remaining, l2.remaining, left, 'bg-text-tertiary/30'],
          ].map(([k, v, p, cls]) => (
            <div key={k as string} className="flex flex-col gap-1">
              <dt className="flex items-center gap-2 text-body text-text-tertiary">
                <span className={`size-2.5 rounded-pill ${cls as string}`} aria-hidden="true" />
                {k as string}
              </dt>
              <dd className="font-mono text-title text-text-primary">
                {fmtCompact(toNum(v as bigint))}
                <span className="ml-2 text-note text-text-tertiary">{`${(p as number).toFixed(1)}%`}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Panel>
  )
}

/** One mint per Agent ID and wallet: pay in, tokens to the 8-hour vesting lock. */
export function L2MintPanel({ hook, s, quote, symbol, onDone }: {
  hook: Address; s: State; quote: V2Quote; symbol: string; onDone: () => void
}) {
  const t = useT().v31
  const tv = useT().v2
  const { address } = useAccount()
  const agent = useAgentAddress()
  const buyer = address ?? agent
  const [raw, setRaw] = useState('')
  const pay = parseAmount(raw) ?? 0n
  const { data: l2, refetch: refetchL2 } = useL2State(hook)
  const { data: acct } = useAccountState(hook, buyer)
  const { data: mine, refetch: refetchMine } = useL2Account(hook, buyer)
  const { data: q } = useL2Quote(hook, pay)
  const tokens = q?.[0] ?? 0n
  const cost = q?.[1] ?? 0n
  const minTokens = (tokens * (V2.BPS - SLIPPAGE_BPS)) / V2.BPS
  const approval = useQuoteApproval(hook, pay, quote.asset)
  const refresh = () => { void refetchL2(); void refetchMine(); approval.refetch(); onDone() }
  const tx = useTxAction({ action: t.mintAction, onConfirmed: () => { setRaw(''); refresh() } })

  const noAgentId = acct !== undefined && acct.registryOk && acct.agentKey === zeroHash
  // With an Agent ID, the factory only reports zero once this ID or wallet has minted.
  const already = acct?.registryOk === true && !noAgentId && mine?.mintable === 0n
  const max = mine?.mintable ?? l2?.quota
  const args = [pay, minTokens] as const

  const gate = useActionGate({
    action: t.mintBtn,
    tx,
    onAct: () => tx.send({ address: hook, abi: V31_HOOK_ABI, functionName: 'mintL2', args }),
    blockersInRevertOrder: revertOrder(
      pay > 0n && pay < s.minBuy && {
        id: 'min', active: true, label: t.mintBtn,
        reason: fill(t.belowMin, { min: fmtSig(s.minBuy), quote: quote.symbol }), tone: 'neutral',
      },
      !already && max !== undefined && pay > max && max > 0n && {
        id: 'max', active: true, label: t.mintBtn,
        reason: fill(t.aboveCap, { max: fmtSig(max), quote: quote.symbol }), tone: 'neutral',
      },
      l2 !== undefined && l2.remaining === 0n && { id: 'out', active: true, label: t.mintBtn, reason: t.soldOut, tone: 'neutral' },
      l2?.halted && { id: 'halted', active: true, label: t.mintBtn, reason: t.halted, tone: 'neutral' },
      noAgentId && { id: 'agent', active: true, label: t.mintBtn, reason: t.noAgent, tone: 'neutral' },
      already && { id: 'once', active: true, label: t.mintBtn, reason: t.already, tone: 'neutral' },
      { id: 'amount', active: pay === 0n || tokens === 0n, label: t.mintBtn, reason: t.payLabel, tone: 'neutral' },
      approval.needsApproval && {
        id: 'approve', active: true, label: fill(tv.approve, { quote: quote.symbol }),
        reason: fill(tv.approve, { quote: quote.symbol }), tone: 'info', resolve: approval.approve,
      },
    ),
  })

  return (
    <Card title={t.mintTitle} subtitle={t.mintBlurb}>
      <ReadoutGrid columns={2}>
        <Readout label={t.price} value={l2 ? `${fmtPrice(toNum(l2.price))} ${quote.symbol}` : '—'} />
        <Readout
          label={t.mintable}
          value={noAgentId ? t.noAgentShort : already ? t.alreadyShort : max !== undefined ? `${fmtSig(max)} ${quote.symbol}` : '—'}
        />
      </ReadoutGrid>
      <Field label={`${t.payLabel} (${quote.symbol})`} value={raw} onValueChange={setRaw} inputMode="decimal" placeholder={fmtSig(s.minBuy)} />
      {tokens > 0n && (
        <ReadoutGrid columns={2}>
          <Readout label={t.youGet} value={`${fmtSig(tokens)} ${symbol}`} />
          <Readout label={t.minOut} value={`${fmtSig(minTokens)} ${symbol}`} />
          <Readout label={t.cost} value={`${fmtSig(cost)} ${quote.symbol}`} />
          <Readout label={t.priceAfter} value={`${fmtPrice(toNum(q?.[2]))} ${quote.symbol}`} />
        </ReadoutGrid>
      )}
      <WalletAction gate={gate} open />
      <AgentModeSheet
        title={fill(t.agentNoteMint, { pay: fmtSig(pay), quote: quote.symbol, min: fmtSig(minTokens), symbol })}
        summary={cost > 0n ? `${t.cost}: ${fmtSig(cost)} ${quote.symbol}` : undefined}
        steps={pay > 0n && tokens > 0n ? [
          ...prepSteps(quote, hook, pay, tv),
          {
            note: fill(t.agentNoteMint, { pay: fmtSig(pay), quote: quote.symbol, min: fmtSig(minTokens), symbol }),
            to: hook, abi: V31_HOOK_ABI, functionName: 'mintL2', args,
          },
        ] : null}
        onDone={refresh}
      />
    </Card>
  )
}

/** The caller's L2 lock: 1/480 releases each minute over 8 hours. */
export function VestingPanel({ hook, symbol, now }: { hook: Address; symbol: string; now: number }) {
  const t = useT().v31
  const { address } = useAccount()
  const agent = useAgentAddress()
  const holder = address ?? agent
  const { data: mine, refetch } = useL2Account(hook, holder)
  const { data: vesting } = useReadContract({
    address: hook, abi: V31_HOOK_ABI, functionName: 'mintVesting', chainId: TARGET_CHAIN_ID,
    query: { staleTime: Infinity },
  })
  const tx = useTxAction({ action: t.claimAction, onConfirmed: () => void refetch() })
  const claimable = mine?.claimable ?? 0n
  const gate = useActionGate({
    action: t.claimBtn,
    tx,
    onAct: () => tx.send({ address: vesting!, abi: V31_VESTING_ABI, functionName: 'claim', args: [hook] }),
    blockersInRevertOrder: revertOrder(
      { id: 'zero', active: claimable === 0n || !vesting, label: t.claimBtn, reason: t.nothingToClaim, tone: 'neutral' },
    ),
  })
  if (!mine || mine.lockedTotal === 0n) return null

  const end = Number(mine.lockStart) + V31.VEST_DURATION_S
  const elapsed = Math.min(Math.max(now - Number(mine.lockStart), 0), V31.VEST_DURATION_S)
  const unlocked = (elapsed / V31.VEST_DURATION_S) * 100

  return (
    <Card title={t.vestTitle} subtitle={t.vestBlurb}>
      <Bar pct={unlocked} label={t.vestTitle} thick />
      <ReadoutGrid columns={2}>
        <Readout label={t.vestLocked} value={`${fmtSig(mine.lockedTotal)} ${symbol}`} />
        <Readout label={t.vestClaimed} value={`${fmtSig(mine.claimed)} ${symbol}`} />
        <Readout label={t.vestClaimable} value={`${fmtSig(claimable)} ${symbol}`} />
        <Readout label={t.vestFullAt} value={now >= end ? t.vestDone : fmtClock(end - now)} />
      </ReadoutGrid>
      {address && <WalletAction gate={gate} />}
      {vesting && claimable > 0n && (
        <AgentModeSheet
          title={fill(t.agentNoteClaim, { amount: fmtSig(claimable), symbol })}
          steps={[{
            note: fill(t.agentNoteClaim, { amount: fmtSig(claimable), symbol }),
            to: vesting, abi: V31_VESTING_ABI, functionName: 'claim', args: [hook],
          }]}
          onDone={() => void refetch()}
        />
      )}
    </Card>
  )
}

/** Supply split for a v3.1 project. Pool and L2 scale by raised / hard cap until launch fixes them. */
export function V31Tokenomics({ s }: { s: State }) {
  const t = useT().v31
  const { ratio, sold, pool, l2, unminted } = v31Split(s.sold, s.raised, s.hardCap)
  const parts = [
    { label: t.tokL1, value: sold, cls: 'bg-brand' },
    { label: t.tokPool, value: pool, cls: 'bg-brand/50' },
    { label: t.tokL2, value: l2, cls: 'bg-text-tertiary/50' },
    { label: t.tokNever, value: unminted, cls: 'bg-danger/30' },
  ]
  const lp = Number(V31.LP_SHARE_BPS) / 100
  const platform = Number(V31.PLATFORM_TAX_BPS) / 100

  return (
    <div className="flex flex-col gap-6">
      <div className="flex h-3 overflow-hidden rounded-pill" aria-hidden="true">
        {parts.map(pt => <span key={pt.label} className={pt.cls} style={{ width: `${pct(pt.value, V31.MAX_SUPPLY)}%` }} />)}
      </div>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {parts.map(pt => (
          <div key={pt.label} className="flex flex-col gap-1">
            <dt className="flex items-center gap-2 text-body text-text-tertiary">
              <span className={`size-2.5 rounded-pill ${pt.cls}`} aria-hidden="true" />
              {pt.label}
            </dt>
            <dd className="font-mono text-title text-text-primary">
              {fmtCompact(toNum(pt.value))}
              <span className="ml-2 text-note text-text-tertiary">{`${pct(pt.value, V31.MAX_SUPPLY).toFixed(1)}%`}</span>
            </dd>
          </div>
        ))}
      </dl>
      <ul className="flex flex-col gap-2 border-t border-border-subtle pt-5 text-body text-text-tertiary">
        <li>{fill(t.tokNote1, { total: fmtCompact(toNum(V31.MAX_SUPPLY)), ratio: (toNum(ratio) * 100).toFixed(1) })}</li>
        <li>{fill(t.tokNote2, { lp: String(lp), project: String(100 - lp - platform), platform: String(platform) })}</li>
      </ul>
    </div>
  )
}

export function V31Rules({ s, quote }: { s: State; quote: V2Quote }) {
  const t = useT().v31
  const rules = [
    [t.ruleGenesis, fill(t.ruleGenesisBody, { cap: fmtSig(s.perAgentCap), min: fmtSig(s.minBuy), quote: quote.symbol })],
    [t.ruleCurve, t.ruleCurveBody],
    [t.ruleDecay, t.ruleDecayBody],
    [t.ruleBurn, t.ruleBurnBody],
    [t.ruleOnce, fill(t.ruleOnceBody, { quota: String(Number(V31.L2_QUOTA_BPS) / 100), min: fmtSig(s.minBuy), quote: quote.symbol })],
    [t.ruleVest, t.ruleVestBody],
    [t.ruleTax, t.ruleTaxBody],
    [t.ruleBuyback, t.ruleBuybackBody],
  ]
  return (
    <dl className="flex flex-col divide-y divide-border-subtle">
      {rules.map(([k, v]) => (
        <div key={k} className="grid grid-cols-1 gap-1 py-3 first:pt-0 sm:grid-cols-[140px_1fr] sm:gap-4">
          <dt className="font-bold text-text-primary">{k}</dt>
          <dd className="text-pretty text-body text-text-tertiary">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
