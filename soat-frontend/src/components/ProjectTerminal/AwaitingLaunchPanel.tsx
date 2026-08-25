'use client'
import { useEffect, useCallback } from 'react'
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import type { Address } from 'viem'

import { HOOK_ABI, TARGET_CHAIN_ID, LAUNCH_WINDOW_SECONDS } from '@/lib/contracts'
import { Card, Readout, ActionButton, useActionGate } from '@/components/ui'
import { fmt } from './format'
import { AlarmLine, TxLine } from './primitives'


// ─────────────────────────────────────────────────────────────────────────────
// AWAITING LAUNCH PANEL  ·  soft cap met, creator has not opened the pool yet
// ─────────────────────────────────────────────────────────────────────────────

/// The genesis succeeded but nothing is tradeable until the creator calls
/// `launch()`, which seeds the V4 pool and opens the shelf ladder.  There was
/// previously no way to do that from the UI at all, so every raise stalled here
/// and eventually decayed into a zombie refund once the 7-day window lapsed.
export function AwaitingLaunchPanel({
  hookAddress, symbol, isCreator, totalEthDeposited, genesisDeadline, nowSec, refetch,
}: {
  hookAddress:       Address
  symbol:            string
  isCreator:         boolean
  totalEthDeposited: bigint
  genesisDeadline:   bigint
  nowSec:            number
  refetch:           () => void
}) {
  const {
    writeContract, isPending, data: txHash, error: writeError,
  } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } =
    useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) refetch() }, [isSuccess, refetch])

  const handleLaunch = useCallback(() => {
    writeContract({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'launch', args: [],
      chainId: TARGET_CHAIN_ID,
    })
  }, [hookAddress, writeContract])

  // `launch()` reverts with LaunchWindowExpired past this point, after which
  // every depositor can pull their ETH back out instead.  `resolvePhase` routes
  // to `refund` on the same clock and the same deadline, so this panel is never
  // mounted past the expiry and carries no expired branch of its own.
  const expiresAt = genesisDeadline + LAUNCH_WINDOW_SECONDS
  const hoursLeft = Math.max(0, Math.floor((Number(expiresAt) - nowSec) / 3600))

  // Rendered only on the creator branch below, and the panel is never mounted
  // past the launch window, so `launch()` has no reachable blocker of its own.
  const gate = useActionGate({
    action: 'open the pool',
    onAct: handleLaunch,
    tx: { isPending, isConfirming },
  })

  return (
    <Card
      id="P-1.5"
      title="LAUNCH TERMINAL"
      subtitle="hook.launch() — seeds the V4 pool, mints genesis LP, opens the shelf ladder"
    >
      <Readout label="RAISED" value={`${fmt(totalEthDeposited)} ETH`} />
      <Readout label="SOFT CAP" value="MET" />
      <Readout label="LAUNCH WINDOW" value={`${hoursLeft}h REMAINING`} />

      {isCreator ? (
        <>
          <p className="font-mono text-[11px] text-[#888] leading-relaxed">
            You are the creator of {symbol}. Calling <span className="text-tosh-fluo">launch()</span> is
            irreversible: it pairs the raised ETH with the genesis LP allocation, hands
            the position to the hook, and starts the ladder. Depositors can claim their
            pro-rata share immediately afterwards.
          </p>
          <p className="font-mono text-[11px] text-tosh-amber leading-relaxed">
            You have {hoursLeft}h left. If you do not open the pool within 7 days of the
            genesis deadline, the raise is written off: <span className="text-white">launch()</span> stops
            working permanently and every depositor reclaims their ETH in full.
          </p>
          <ActionButton gate={gate} />
        </>
      ) : (
        <p className="font-mono text-[11px] text-[#888] leading-relaxed">
          The raise cleared its soft cap and is waiting on the creator to open the
          pool. Your deposit is safe: if the pool is not opened within the launch
          window, the refund terminal unlocks automatically and returns 100% of it.
        </p>
      )}

      <AlarmLine msg={writeError?.message?.slice(0, 200) ?? null} />
      <TxLine hash={txHash} label="launch" />
    </Card>
  )
}
