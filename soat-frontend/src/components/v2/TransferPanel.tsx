'use client'

import { useMemo, useState } from 'react'
import { erc20Abi, formatUnits, isAddress, type Address } from 'viem'
import { useAccount, useBytecode, useReadContract } from 'wagmi'

import { Button, Card, Field, FieldAffix, Readout, revertOrder, useActionGate, useTxAction } from '@/components/ui'
import { fill, useT } from '@/i18n'
import { TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_TOKEN_ABI } from '@/lib/v2/abis'
import { WalletAction } from './WalletAction'
import { AgentModeSheet, useAgentAddress } from './AgentModeSheet'
import { fmtSig, isContractCode as hasCode, parseAmount } from './fmt'
import { useTokenBalance } from './hooks'

/**
 * Wallet-to-wallet transfer. Before launch the token only moves between
 * wallets (EIP-7702 accounts included) and only to registered receivers, so
 * both are checked here first rather than left to surface as a revert.
 */
export function TransferPanel({ token, symbol }: { token: Address; symbol: string }) {
  const t = useT().v2
  const tx2 = useT().x
  const { address } = useAccount()
  const agent = useAgentAddress()
  const [rawTo, setRawTo] = useState('')
  const [raw, setRaw] = useState('')
  const [copied, setCopied] = useState(false)
  const to = isAddress(rawTo.trim()) ? (rawTo.trim() as Address) : undefined
  const amount = parseAmount(raw) ?? 0n
  const bal = useTokenBalance(token, address ?? agent)

  const { data: open } = useReadContract({
    address: token, abi: V2_TOKEN_ABI, functionName: 'tradingOpen', chainId: TARGET_CHAIN_ID,
    query: { refetchInterval: 15_000 },
  })
  const { data: registered, refetch: refetchReg } = useReadContract({
    address: token, abi: V2_TOKEN_ABI, functionName: 'isReceiver', args: to ? [to] : undefined, chainId: TARGET_CHAIN_ID,
    query: { enabled: !!to && open === false },
  })
  const { data: toCode } = useBytecode({ address: to, chainId: TARGET_CHAIN_ID, query: { enabled: !!to && open === false } })
  const { data: myCode } = useBytecode({ address, chainId: TARGET_CHAIN_ID, query: { enabled: !!address && open === false } })

  const restricted = open === false
  const link = typeof window !== 'undefined' ? `${window.location.origin}/register?token=${token}` : `/register?token=${token}`

  const tx = useTxAction({ action: t.transferAction, onConfirmed: () => { setRaw(''); void bal.refetch() } })
  const gate = useActionGate({
    action: t.transferBtn,
    tx,
    onAct: () => tx.send({ address: token, abi: erc20Abi, functionName: 'transfer', args: [to!, amount] }),
    blockersInRevertOrder: revertOrder(
      { id: 'to', active: !to, label: t.transferBtn, reason: t.transferBadAddr, tone: 'neutral' },
      restricted && hasCode(myCode) && { id: 'self', active: true, label: t.transferBtn, reason: t.transferSelfCode },
      restricted && hasCode(toCode) && { id: 'code', active: true, label: t.transferBtn, reason: t.transferContract },
      restricted && registered === false && { id: 'reg', active: true, label: t.transferBtn, reason: t.transferUnregistered, tone: 'warn' },
      { id: 'amount', active: amount === 0n || amount > (bal.data ?? 0n), label: t.transferBtn, reason: t.transferAmountReason, tone: 'neutral' },
    ),
  })

  const steps = useMemo(
    () => (to && amount > 0n && !(restricted && (hasCode(toCode) || registered === false))
      ? [{
          note: fill(t.agentNoteTransfer, { amount: fmtSig(amount), symbol, to }),
          to: token, abi: erc20Abi, functionName: 'transfer', args: [to, amount] as const,
        }]
      : null),
    [to, amount, restricted, toCode, registered, token, symbol, t],
  )

  if (!address && !agent) {
    return (
      <Card title={t.holdTitle}>
        <p className="text-note text-text-tertiary">{tx2.holdHint}</p>
      </Card>
    )
  }

  return (
    <Card title={t.holdTitle}>
      <Readout label={t.holdBalance} value={`${fmtSig(bal.data)} ${symbol}`} />
      <Field label={t.transferTo} value={rawTo} onValueChange={v => { setRawTo(v); void refetchReg() }} placeholder="0x…" />
      <Field
        label={`${t.transferAmount} (${symbol})`}
        value={raw}
        onValueChange={setRaw}
        inputMode="decimal"
        placeholder="0"
        affix={<FieldAffix onClick={() => setRaw(formatUnits(bal.data ?? 0n, 18))} disabled={!bal.data} />}
      />
      {restricted && to && registered === false && !hasCode(toCode) && (
        <div className="flex flex-col gap-2 text-note text-text-secondary">
          <p>{t.transferUnregistered}</p>
          <code className="break-all font-mono text-micro text-text-primary">{link}</code>
          <Button size="sm" variant="ghost" label={copied ? t.agentCopied : t.copyLink}
            onClick={() => void navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})} />
        </div>
      )}
      <WalletAction gate={gate} />
      <AgentModeSheet
        title={`${t.transferBtn} ${fmtSig(amount)} ${symbol}`}
        steps={steps}
        notes={restricted ? [t.agentAddressBook] : []}
        onDone={() => void bal.refetch()}
      />
    </Card>
  )
}
