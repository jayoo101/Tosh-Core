'use client'
import { useCallback } from 'react'
import type { Address } from 'viem'

import { HOOK_ABI } from '@/lib/contracts'
import {
  Card, Readout, ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { fmt } from './format'


export function RefundPanel({
  hookAddress, ethDeposited, refetch,
}: {
  hookAddress:   Address
  ethDeposited:  bigint
  refetch:       () => void
}) {
  const { send, isPending, isConfirming } = useTxAction({
    action: 'claim your refund',
    labels: { confirmed: 'Refund received — 100% returned' },
    onConfirmed: refetch,
  })

  const handleRefund = useCallback(() => {
    send({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'refund', args: [],
    })
  }, [hookAddress, send])

  const gate = useActionGate({
    action: 'Claim 100% Refund',
    onAct: handleRefund,
    tx: { isPending, isConfirming },
    blockersInRevertOrder: revertOrder({
      id: 'no-deposit',
      active: ethDeposited === 0n,
      label: 'Nothing to refund',
      reason: 'This wallet has nothing deposited in this project, so there is nothing to refund.',
      tone: 'neutral',
    }),
  })

  return (
    <Card
      id="P-3"
      title="Claim refund"
      subtitle="The raise missed its floor, or the 7-day window to open trading lapsed. Take back the full amount, no penalty."
      tone="warn"
    >
      <Readout label="Your deposit" value={`${fmt(ethDeposited)} ETH`} tone="warn" />
      <ActionButton gate={gate} size="lg" intent="danger" />
    </Card>
  )
}
