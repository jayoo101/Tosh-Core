'use client'
import { useEffect, useCallback } from 'react'
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import type { Address } from 'viem'

import { HOOK_ABI, TARGET_CHAIN_ID } from '@/lib/contracts'
import {
  Card, Readout, ActionButton, useActionGate, revertOrder,
} from '@/components/ui'
import { fmt } from './format'
import { AlarmLine, TxLine } from './primitives'


// ─────────────────────────────────────────────────────────────────────────────
// REFUND PANEL  ·  Phase 3
// ─────────────────────────────────────────────────────────────────────────────

// `isConnected` is gone from the props: the gate resolves wallet state itself,
// so passing it down only gave the panel a second, staler copy of it.
export function RefundPanel({
  hookAddress, ethDeposited, refetch,
}: {
  hookAddress:   Address
  ethDeposited:  bigint
  refetch:       () => void
}) {
  const {
    writeContract, isPending, data: txHash, error: writeError,
  } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } =
    useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) refetch() }, [isSuccess, refetch])

  const handleRefund = useCallback(() => {
    writeContract({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'refund', args: [],
      chainId: TARGET_CHAIN_ID,
    })
  }, [hookAddress, writeContract])

  const gate = useActionGate({
    action: 'claim refund',
    onAct: handleRefund,
    tx: { isPending, isConfirming },
    blockersInRevertOrder: revertOrder({
      id: 'no-deposit',
      active: ethDeposited === 0n,
      label: '[no_deposit]',
      reason: 'This wallet has nothing deposited in this project, so there is nothing to refund.',
      tone: 'neutral',
    }),
  })

  return (
    <Card
      id="P-3"
      title="REFUND TERMINAL"
      subtitle="hook.refund() — soft-cap not met OR zombie window elapsed · full claim, no penalty"
    >
      <Readout label="YOUR DEPOSIT" value={`${fmt(ethDeposited)} ETH`} />
      <p className="font-mono text-[10px] tracking-[0.4em] uppercase text-brand">
        → REFUND_GATE: OPEN
      </p>
      <ActionButton gate={gate} />
      <AlarmLine msg={writeError?.message?.slice(0, 200) ?? null} />
      <TxLine hash={txHash} label="refund" />
    </Card>
  )
}
