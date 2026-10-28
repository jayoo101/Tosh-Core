'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { erc20Abi, isAddress, type Address } from 'viem'
import { useAccount, useReadContracts } from 'wagmi'

import { ActionButton, Badge, Card, Field, PageHeader, revertOrder, useActionGate, useTxAction } from '@/components/ui'
import { fill, useT } from '@/i18n'
import { TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_TOKEN_ABI } from '@/lib/v2/abis'
import { AgentModeSheet, useAgentAddress } from './AgentModeSheet'

export function RegisterPanel() {
  const t = useT().v2
  const params = useSearchParams()
  const { address: connected } = useAccount()
  const agent = useAgentAddress()
  const address = connected ?? agent
  const [raw, setRaw] = useState(params.get('token') ?? '')
  const token = isAddress(raw.trim()) ? (raw.trim() as Address) : undefined

  const { data, refetch } = useReadContracts({
    contracts: token
      ? [
          { address: token, abi: erc20Abi, functionName: 'symbol', chainId: TARGET_CHAIN_ID },
          { address: token, abi: V2_TOKEN_ABI, functionName: 'tradingOpen', chainId: TARGET_CHAIN_ID },
          { address: token, abi: V2_TOKEN_ABI, functionName: 'isReceiver', args: [address ?? '0x0000000000000000000000000000000000000000'], chainId: TARGET_CHAIN_ID },
        ]
      : [],
    query: { enabled: !!token },
  })
  const symbol = data?.[0]?.status === 'success' ? (data[0].result as string) : undefined
  const open = data?.[1]?.status === 'success' ? (data[1].result as boolean) : undefined
  const registered = data?.[2]?.status === 'success' ? (data[2].result as boolean) : undefined

  const tx = useTxAction({ action: t.registerAction, onConfirmed: () => void refetch() })
  const gate = useActionGate({
    action: t.registerBtn,
    tx,
    onAct: () => tx.send({ address: token!, abi: V2_TOKEN_ABI, functionName: 'registerReceiver', args: [] }),
    blockersInRevertOrder: revertOrder(
      { id: 'token', active: symbol === undefined, label: t.registerBtn, reason: t.registerToken, tone: 'neutral' },
      { id: 'open', active: open === true, label: t.registerBtn, reason: fill(t.tradingOpen, { symbol: symbol ?? '' }), tone: 'neutral' },
      { id: 'done', active: registered === true, label: t.registerBtn, reason: fill(t.registered, { symbol: symbol ?? '' }), tone: 'neutral' },
    ),
  })

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <PageHeader title={t.registerTitle} subtitle={t.registerBlurb} />
      <Card>
        <Field label={t.registerToken} value={raw} onValueChange={setRaw} placeholder="0x…" />
        {symbol && address && open !== undefined && registered !== undefined && (
          <Badge tone={open || registered ? 'ok' : 'warn'} pip>
            {open
              ? fill(t.tradingOpen, { symbol })
              : registered
                ? fill(t.registered, { symbol })
                : fill(t.notRegistered, { symbol })}
          </Badge>
        )}
        <ActionButton gate={gate} />
        {symbol && open === false && (
          <AgentModeSheet
            title={fill(t.agentNoteRegister, { symbol })}
            steps={[{ note: fill(t.agentNoteRegister, { symbol }), to: token!, abi: V2_TOKEN_ABI, functionName: 'registerReceiver' }]}
            onDone={() => void refetch()}
          />
        )}
      </Card>
    </div>
  )
}
