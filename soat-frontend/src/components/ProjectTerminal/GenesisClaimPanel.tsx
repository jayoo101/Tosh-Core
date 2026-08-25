'use client'
import { useEffect, useCallback } from 'react'
import {
  useReadContract, useWriteContract, useWaitForTransactionReceipt,
} from 'wagmi'
import type { Address } from 'viem'

import { HOOK_ABI, TARGET_CHAIN_ID } from '@/lib/contracts'
import { Card, Readout, ActionButton, useActionGate } from '@/components/ui'
import { fmt } from './format'
import { AlarmLine, TxLine } from './primitives'


// ─────────────────────────────────────────────────────────────────────────────
// GENESIS CLAIM PANEL  ·  pro-rata token allocation, post-launch
// ─────────────────────────────────────────────────────────────────────────────

/// Genesis depositors are owed a pro-rata slice of GENESIS_CLAIM_SUPPLY the
/// moment `launch()` lands.  The only entry point used to live in the user
/// drawer, which meant a depositor sitting on the project page had no way to
/// see — let alone take — the tokens their ETH had already bought.
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

  const {
    writeContract, isPending, data: txHash, error: writeError,
  } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } =
    useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => {
    if (!isSuccess) return
    refetch(); void refetchClaimed()
  }, [isSuccess, refetch, refetchClaimed])

  const handleClaim = useCallback(() => {
    writeContract({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'claimGenesis', args: [],
      chainId: TARGET_CHAIN_ID,
    })
  }, [hookAddress, writeContract])

  // No blockers: the panel unmounts entirely in the two states that would have
  // produced one, so the only thing left to model is wallet, network and busy.
  const gate = useActionGate({
    action: `claim ${symbol}`,
    onAct: handleClaim,
    tx: { isPending, isConfirming },
  })

  if (ethDeposited === 0n || hasClaimed) return null

  return (
    <Card
      id="P-1.9"
      title={`GENESIS ALLOCATION · ${symbol}`}
      subtitle="hook.claimGenesis() — your pro-rata share of the genesis block, one claim per wallet"
    >
      <Readout label="YOUR GENESIS DEPOSIT" value={`${fmt(ethDeposited)} ETH`} />
      <ActionButton gate={gate} />
      <AlarmLine msg={writeError?.message?.slice(0, 200) ?? null} />
      <TxLine hash={txHash} label="claimGenesis" />
    </Card>
  )
}
