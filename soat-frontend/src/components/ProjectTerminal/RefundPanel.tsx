'use client'
import { useEffect, useCallback } from 'react'
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import type { Address } from 'viem'

import { HOOK_ABI, TARGET_CHAIN_ID } from '@/lib/contracts'
import { Card, Readout } from '@/components/ui'
import { fmt } from './format'
import { WriteButton, AlarmLine, TxLine } from './primitives'


// ─────────────────────────────────────────────────────────────────────────────
// REFUND PANEL  ·  Phase 3
// ─────────────────────────────────────────────────────────────────────────────

export function RefundPanel({
  hookAddress, ethDeposited, isConnected, refetch,
}: {
  hookAddress:   Address
  ethDeposited:  bigint
  isConnected:   boolean
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

  const txBusy = isPending || isConfirming
  const locked = !isConnected || ethDeposited === 0n

  return (
    <Card
      id="P-3"
      title="REFUND TERMINAL"
      subtitle="hook.refund() — soft-cap not met OR zombie window elapsed · full claim, no penalty"
    >
      <Readout label="YOUR DEPOSIT" value={`${fmt(ethDeposited)} ETH`} />
      <p className="font-mono text-[10px] tracking-[0.4em] uppercase text-tosh-fluo">
        → REFUND_GATE: OPEN
      </p>
      <WriteButton
        label="claim refund"
        lockedLabel={ethDeposited === 0n ? '[no_deposit]' : '[claim_refund]'}
        locked={locked}
        busy={txBusy}
        onClick={handleRefund}
        full
      />
      <AlarmLine msg={writeError?.message?.slice(0, 200) ?? null} />
      <TxLine hash={txHash} label="refund" />
    </Card>
  )
}
