'use client'
import { useCallback } from 'react'
import type { Address } from 'viem'

import { HOOK_ABI, LAUNCH_WINDOW_SECONDS } from '@/lib/contracts'
import {
  Card, Readout, ActionButton, useActionGate, useTxAction, formatCountdown,
} from '@/components/ui'
import { fmt } from './format'


// ─────────────────────────────────────────────────────────────────────────────
// AWAITING LAUNCH PANEL  ·  soft cap met, creator has not opened the pool yet
// ─────────────────────────────────────────────────────────────────────────────

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
  const { send, isPending, isConfirming } = useTxAction({
    action: 'open the pool',
    labels: { confirmed: 'Pool open — the ladder is live' },
    onConfirmed: refetch,
  })

  const handleLaunch = useCallback(() => {
    send({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'launch', args: [],
    })
  }, [hookAddress, send])

  const expiresAt = genesisDeadline + LAUNCH_WINDOW_SECONDS
  const secsLeft = Math.max(0, Number(expiresAt) - nowSec)
  const countdown = formatCountdown(secsLeft)

  const gate = useActionGate({
    action: 'Trigger Launch',
    onAct: handleLaunch,
    tx: { isPending, isConfirming },
  })

  return (
    <Card
      id="P-1.5"
      title="Launch the pool"
      subtitle="hook.launch() seeds the V4 pool, mints genesis LP, and opens the shelf ladder. Irreversible."
      tone={isCreator ? 'ok' : 'default'}
    >
      <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-3">
        <Readout label="Raised" value={`${fmt(totalEthDeposited)} ETH`} />
        <Readout label="Soft cap" value="Met" tone="ok" />
        <Readout label="Window remaining" value={countdown} tone="warn" />
      </div>

      {isCreator ? (
        <>
          <p className="text-note text-text-secondary leading-relaxed">
            You created {symbol}. Triggering launch pairs the raised ETH with the
            genesis LP allocation and starts the ladder. Depositors can claim their
            pro-rata share the moment it confirms.
          </p>
          <p className="text-note text-warning leading-relaxed">
            {countdown} left. After that, launch() dies permanently and every
            depositor reclaims 100% of their ETH.
          </p>
          <ActionButton gate={gate} size="lg" intent="primary" />
        </>
      ) : (
        <div className="rounded-card border border-warning/30 bg-warning/5 px-card py-gap">
          <p className="font-mono text-label text-warning">Waiting on the creator</p>
          <p className="mt-1 text-note text-text-secondary leading-relaxed">
            The raise cleared its soft cap. If the pool is not opened within{' '}
            {countdown}, the refund terminal unlocks automatically and returns
            100% of your deposit. Your ETH is not at risk.
          </p>
        </div>
      )}
    </Card>
  )
}
