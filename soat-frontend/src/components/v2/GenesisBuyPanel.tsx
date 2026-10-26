'use client'

import { useState } from 'react'
import { formatUnits, type Address } from 'viem'
import { useAccount, useBytecode, useReadContract } from 'wagmi'

import { ActionButton, Card, Field, FieldAffix, Readout, revertOrder, useActionGate, useQuoteApproval, useTxAction } from '@/components/ui'
import { fill, useT } from '@/i18n'
import { TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_HOOK_ABI, V2_LENS_ABI } from '@/lib/v2/abis'
import { V2_LENS, type V2Quote } from '@/lib/v2/config'
import { useAccountState, useGenesisState } from '@/lib/v2/useV2'
import { fmtSig, isContractCode, parseAmount } from './fmt'
import { RiskAck, useRiskAck } from './RiskAck'
import { AgentModeSheet } from './AgentModeSheet'
import { approveStep } from './agentSteps'

/** 0.5 % below the quoted token amount, for `minTokens`. */
const SLIPPAGE_BPS = 50n

export function GenesisBuyPanel({ hook, quote, open }: { hook: Address; quote: V2Quote; open: boolean }) {
  const t = useT().v2
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
  const minTokens = (tokens * (10_000n - SLIPPAGE_BPS)) / 10_000n

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
      <Readout label={t.receiveLabel} value={tokens > 0n ? fmtSig(tokens, 18, 6) : '—'} />
      <RiskAck {...risk} />
      <ActionButton gate={gate} />
      {open && (
        <AgentModeSheet
          title={`${t.agentNoteBuy} ${fmtSig(pay)} ${quote.symbol}`}
          summary={tokens > 0n ? `${t.receiveLabel}: ${fmtSig(tokens, 18, 6)}` : undefined}
          steps={risk.acked && pay > 0n && tokens > 0n ? [
            ...(quote.native ? [] : [approveStep(quote.asset, quote.symbol, hook, pay, t)]),
            {
              note: t.agentNoteBuy, to: hook, abi: V2_HOOK_ABI, functionName: 'buyGenesis',
              args: [pay, minTokens], ...(quote.native ? { value: pay } : {}),
            },
          ] : null}
          lead={agentFirst ? t.agentGenesisLead : undefined}
          defaultOpen={agentFirst}
          notes={[t.agentNoteCapClamp, t.agentWalletSettings]}
          onDone={() => { void state.refetch(); void acct.refetch(); approval.refetch() }}
        />
      )}
    </Card>
  )
}
