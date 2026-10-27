'use client'

import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { formatUnits, type Address } from 'viem'
import { useAccount, useBytecode, useReadContract } from 'wagmi'

import { ActionButton, Card, Field, FieldAffix, revertOrder, useActionGate, useQuoteApproval, useTxAction } from '@/components/ui'
import { fmtPrice, priceAfterWei, toNum } from '@/components/x/curve'
import { Row } from '@/components/x/Panel'
import { fill, useT } from '@/i18n'
import { ACTIVE_CHAIN_LABEL, TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_HOOK_ABI, V2_LENS_ABI } from '@/lib/v2/abis'
import { V2_LENS, type V2Quote } from '@/lib/v2/config'
import { useAccountState, useGenesisState } from '@/lib/v2/useV2'
import { fmtSig, isContractCode, parseAmount } from './fmt'
import { RiskAck, useRiskAck } from './RiskAck'
import { AgentModeSheet } from './AgentModeSheet'
import { WalletAction } from './WalletAction'
import { approveStep } from './agentSteps'

/** 0.5 % below the quoted token amount, for `minTokens`. */
const SLIPPAGE_BPS = 50n

const BINANCE_WALLET_INVITE = 'https://web3.binance.com/referral?ref=TOSHX'

export function GenesisBuyPanel({ hook, quote, open, symbol }: { hook: Address; quote: V2Quote; open: boolean; symbol: string }) {
  const t = useT().v2
  const tx2 = useT().x
  const { address } = useAccount()
  const [raw, setRaw] = useState('')
  const pay = parseAmount(raw, quote.decimals) ?? 0n

  const state = useGenesisState(hook)
  const acct = useAccountState(hook, address)
  const { data: code } = useBytecode({ address, chainId: TARGET_CHAIN_ID, query: { enabled: !!address } })
  const hasCode = isContractCode(code)
  const noAgentId = acct.data !== undefined && acct.data.registryOk && acct.data.agentKey === `0x${'0'.repeat(64)}`
  // The Agent ID lives on the Agentic Wallet, which cannot connect to a site.
  const agentFirst = !address || hasCode || noAgentId

  const remaining = acct.data?.remaining ?? 0n
  // With no wallet connected (an Agent signs elsewhere) the quote is for the full amount.
  const budget = acct.data !== undefined && pay > remaining ? remaining : pay
  const { data: q } = useReadContract({
    address: V2_LENS,
    abi: V2_LENS_ABI,
    functionName: 'quoteGenesis',
    args: [hook, budget],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: budget > 0n },
  })
  const tokens = q?.[0] ?? 0n
  const cost = q?.[1] ?? 0n
  const minTokens = (tokens * (10_000n - SLIPPAGE_BPS)) / 10_000n
  const base = state.data?.basePrice ?? 0n
  const after = tokens > 0n && base > 0n ? priceAfterWei(base, state.data?.sold ?? 0n, tokens) : 0n

  const approval = useQuoteApproval(quote.native ? undefined : hook, pay, quote.asset)
  const tx = useTxAction({
    action: t.buyAction,
    onConfirmed: () => { setRaw(''); void state.refetch(); void acct.refetch(); approval.refetch() },
  })

  const minBuy = state.data?.minBuy ?? 0n
  const risk = useRiskAck(hook)
  const gate = useActionGate({
    action: t.buy,
    tx,
    onAct: () =>
      tx.send({
        address: hook,
        abi: V2_HOOK_ABI,
        functionName: 'buyGenesis',
        args: [pay, minTokens],
        ...(quote.native ? { value: pay } : {}),
      }),
    blockersInRevertOrder: revertOrder(
      !open && { id: 'closed', active: true, label: t.closed, reason: t.launchWaiting, tone: 'neutral' },
      hasCode && { id: 'code', active: true, label: t.agentTitle, reason: t.agentCodeWallet },
      acct.data !== undefined && !acct.data.registryOk && { id: 'registry', active: true, label: t.agentTitle, reason: t.agentRegistryDown, tone: 'warn' },
      noAgentId && { id: 'agent', active: true, label: t.agentTitle, reason: t.agentNone },
      acct.data !== undefined && acct.data.agentKey !== `0x${'0'.repeat(64)}` && remaining === 0n &&
        { id: 'used', active: true, label: t.agentTitle, reason: t.agentUsedUp, tone: 'neutral' },
      { id: 'amount', active: pay === 0n || tokens === 0n, label: t.buy, reason: fill(t.minBuy, { min: fmtSig(minBuy), quote: quote.symbol }), tone: 'neutral' },
      { id: 'risk', active: !risk.acked, label: t.buy, reason: t.riskRequired, tone: 'neutral' },
      !quote.native && approval.needsApproval && {
        id: 'approve', active: true, label: fill(t.approve, { quote: quote.symbol }),
        reason: fill(t.approve, { quote: quote.symbol }), tone: 'info', resolve: approval.approve,
      },
    ),
  })

  const agentLine =
    acct.data === undefined
      ? null
      : !acct.data.registryOk
        ? t.agentRegistryDown
        : acct.data.agentKey === `0x${'0'.repeat(64)}`
          ? t.agentNone
          : fill(t.agentOk, {
              remaining: fmtSig(remaining),
              cap: fmtSig(state.data?.perAgentCap),
              quote: quote.symbol,
            })

  return (
    <Card title={t.genesisTitle} subtitle={t.agentTitle}>
      <p className="text-pretty text-note text-text-tertiary">
        {fill(tx2.genesisNeed, { cap: fmtSig(state.data?.perAgentCap), quote: quote.symbol })}{' '}
        <a href={BINANCE_WALLET_INVITE} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-bold text-brand hover:underline">
          {tx2.genesisGetId}
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      </p>
      {agentLine && <p className="text-note text-text-secondary">{agentLine}</p>}
      <Field
        label={`${t.payLabel} (${quote.symbol})`}
        value={raw}
        onValueChange={setRaw}
        inputMode="decimal"
        placeholder="0.0"
        affix={<FieldAffix onClick={() => setRaw(formatUnits(remaining, quote.decimals))} disabled={remaining === 0n} />}
        hint={fill(t.minBuy, { min: fmtSig(minBuy), quote: quote.symbol })}
      />
      <dl className="flex flex-col gap-2 rounded-card border border-border-subtle bg-bg-base/60 p-4 text-body">
        <Row k={t.receiveLabel} v={tokens > 0n ? `${fmtSig(tokens, 18, 6)} ${symbol}` : '—'} strong />
      </dl>
      <details className="text-note text-text-tertiary">
        <summary className="cursor-pointer hover:text-text-primary">{tx2.quoteDetails}</summary>
        <dl className="mt-2 flex flex-col gap-2 px-1 text-body">
          <Row k={tx2.quoteAvg} v={tokens > 0n ? `${fmtPrice(toNum(cost, quote.decimals) / toNum(tokens))} ${quote.symbol}` : '—'} />
          <Row k={tx2.quoteAfter} v={after > 0n ? `${fmtPrice(toNum(after, quote.decimals))} ${quote.symbol}` : '—'} />
          <Row
            k={tx2.quoteVs2P}
            v={after > 0n ? `${((toNum(after, quote.decimals) / (2 * toNum(base, quote.decimals))) * 100).toFixed(1)}%` : '—'}
          />
          <Row k={tx2.quoteSlippage} v={`${Number(SLIPPAGE_BPS) / 100}%`} />
          <Row k={tx2.quoteMin} v={tokens > 0n ? `${fmtSig(minTokens, 18, 6)} ${symbol}` : '—'} />
        </dl>
      </details>
      <RiskAck {...risk} />
      {gate.verdict.kind !== 'connect' && <ActionButton gate={gate} />}
      {open && (
        <AgentModeSheet
          title={pay > 0n ? `${t.agentNoteBuy} ${fmtSig(pay)} ${quote.symbol}` : `${t.agentNoteBuy} ${symbol}`}
          template={risk.acked ? [
            fill(quote.native ? t.agentTplGenesisNative : t.agentTplGenesis, {
              chain: ACTIVE_CHAIN_LABEL, id: String(TARGET_CHAIN_ID), quote: quote.symbol, symbol,
              asset: quote.asset, hook, dec: String(quote.decimals),
            }),
            t.agentWalletSettings,
          ].join('\n\n') : undefined}
          pending={t.agentAckFirst}
          steps={risk.acked && pay > 0n && tokens > 0n ? [
            ...(quote.native ? [] : [approveStep(quote.asset, quote.symbol, hook, pay, t)]),
            {
              note: t.agentNoteBuy, to: hook, abi: V2_HOOK_ABI, functionName: 'buyGenesis',
              args: [pay, minTokens], ...(quote.native ? { value: pay } : {}),
            },
          ] : null}
          defaultOpen={agentFirst}
          notes={[t.agentNoteCapClamp, t.agentWalletSettings]}
          onDone={() => { void state.refetch(); void acct.refetch(); approval.refetch() }}
        />
      )}
      {gate.verdict.kind === 'connect' && <WalletAction gate={gate} />}
      <a href="#market" className="text-note text-brand hover:underline">{tx2.buyMarketLink}</a>
    </Card>
  )
}
