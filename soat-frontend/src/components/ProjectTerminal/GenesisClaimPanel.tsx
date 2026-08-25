'use client'
import { useCallback } from 'react'
import { useReadContract } from 'wagmi'
import type { Address } from 'viem'

import { HOOK_ABI } from '@/lib/contracts'
import { Card, Readout, ActionButton, useActionGate, useTxAction } from '@/components/ui'
import { fmt } from './format'


export function GenesisClaimPanel({
  hookAddress, symbol, userAddress, ethDeposited, refetch,
}: {
  hookAddress:  Address
  symbol:       string
  userAddress:  Address | undefined
  ethDeposited: bigint
  refetch:      () => void
}) {
  const { data: hasClaimedRaw, refetch: refetchClaimed } = useReadContract({
    address:      hookAddress,
    abi:          HOOK_ABI,
    functionName: 'hasClaimed',
    args:         userAddress ? [userAddress] : undefined,
    query:        { enabled: !!userAddress, refetchInterval: 15_000 },
  })
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
  })

  if (ethDeposited === 0n || hasClaimed) return null

  return (
    <Card
      id="P-1.9"
      title={`Genesis allocation · ${symbol}`}
      subtitle="hook.claimGenesis() — your pro-rata share of the genesis block, one claim per wallet"
    >
      <Readout label="Your genesis deposit" value={`${fmt(ethDeposited)} ETH`} />
      <ActionButton gate={gate} />
    </Card>
  )
}
