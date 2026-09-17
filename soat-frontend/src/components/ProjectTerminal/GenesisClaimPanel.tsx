'use client'
import { useCallback } from 'react'
import { useReadContract } from 'wagmi'
import type { Address } from 'viem'

import { HOOK_ABI } from '@/lib/contracts'
import {
  Card, Readout, ActionButton, useActionGate, useTxAction, revertOrder,
} from '@/components/ui'
import { fmt } from './format'


export function GenesisClaimPanel({
  hookAddress, symbol, userAddress, nativeDeposited, refetch,
}: {
  hookAddress:  Address
  symbol:       string
  userAddress:  Address | undefined
  nativeDeposited: bigint
  refetch:      () => void
}) {
  const { data: hasClaimedRaw, refetch: refetchClaimed } = useReadContract({
    address:      hookAddress,
    abi:          HOOK_ABI,
    functionName: 'hasClaimed',
    args:         userAddress ? [userAddress] : undefined,
    query:        { enabled: !!userAddress, refetchInterval: 15_000 },
  })
  // `?? false` is the right default for *hiding* the panel — an unread flag
  // should not make the allocation disappear. It is the wrong default for
  // arming the button, because "not known to have claimed" and "has not
  // claimed" are the same value here, and only one of them can be spent twice.
  const claimedUnknown = userAddress !== undefined && hasClaimedRaw === undefined
  const hasClaimed = (hasClaimedRaw as boolean | undefined) ?? false

  const { send, isPending, isConfirming } = useTxAction({
    action: `claim ${symbol}`,
    onConfirmed: () => { refetch(); void refetchClaimed() },
  })

  const handleClaim = useCallback(() => {
    send({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'claimGenesis', args: [],
    })
  }, [hookAddress, send])

  const gate = useActionGate({
    action: `Claim ${symbol}`,
    onAct: handleClaim,
    tx: { isPending, isConfirming },
    blockersInRevertOrder: revertOrder({
      id: 'claimed-unknown',
      active: claimedUnknown,
      label: 'Checking your claim…',
      reason: 'Reading whether this wallet has already claimed. There is one claim per wallet, so the button waits for the answer rather than offering a transaction that would fail.',
      tone: 'neutral',
    }),
  })

  if (nativeDeposited === 0n || hasClaimed) return null

  return (
    <Card
      id="P-1.9"
      title={`Genesis allocation · ${symbol}`}
      subtitle="Your share of the genesis supply, in proportion to what you deposited. One claim per wallet."
    >
      <Readout label="Your genesis deposit" value={`${fmt(nativeDeposited)} ETH`} />
      <ActionButton gate={gate} />
    </Card>
  )
}
