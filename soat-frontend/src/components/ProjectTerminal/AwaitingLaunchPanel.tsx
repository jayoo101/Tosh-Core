'use client'
import { useCallback } from 'react'
import type { Address } from 'viem'

import { FACTORY_ABI, FACTORY_ADDRESS, LAUNCH_WINDOW_SECONDS } from '@/lib/contracts'
import {
  Card, Readout, ActionButton, useActionGate, useTxAction, formatCountdown,
  revertOrder,
} from '@/components/ui'
import { fill, useT } from '@/i18n'
import { useQuote } from './quoteContext'


// ─────────────────────────────────────────────────────────────────────────────
// AWAITING LAUNCH PANEL  ·  genesis closed, the pool has not been opened yet
//
// The hook admits only the factory, and `factory.launch(hook)` admits only the
// factory's CURRENT owner — not the hook's `creator`, which is frozen at
// creation and goes stale the moment the Safe is rotated. When that owner is a
// `ToshLaunchGateway`, the call goes through it (`launchVia`) from any signer
// of its Safe.
// ─────────────────────────────────────────────────────────────────────────────

export function AwaitingLaunchPanel({
  hookAddress, symbol, canLaunch, launchVia = FACTORY_ADDRESS, totalNativeDeposited, genesisDeadline, nowSec, refetch,
}: {
  hookAddress:       Address
  symbol:            string
  canLaunch:         boolean
  launchVia?:        Address
  totalNativeDeposited: bigint
  genesisDeadline:   bigint
  nowSec:            number
  refetch:           () => void
}) {
  const t = useT()
  const { symbol: QUOTE_SYMBOL, fmt: fmtQuote } = useQuote()

  const { send, isPending, isConfirming } = useTxAction({
    action: t.awaitingLaunch.txAction,
    labels: { confirmed: t.awaitingLaunch.txConfirmed },
    onConfirmed: refetch,
  })

  const handleLaunch = useCallback(() => {
    send({
      address: launchVia, abi: FACTORY_ABI,
      functionName: 'launch', args: [hookAddress],
    })
  }, [hookAddress, launchVia, send])

  const expiresAt = genesisDeadline + LAUNCH_WINDOW_SECONDS
  const secsLeft = Math.max(0, Number(expiresAt) - nowSec)
  const countdown = formatCountdown(secsLeft)

  // The hook refuses `launch()` once the window lapses, and the countdown
  // hitting 00:00:00 was previously cosmetic: the button stayed armed and paid
  // gas for a guaranteed revert.
  const gate = useActionGate({
    action: t.awaitingLaunch.cta,
    onAct: handleLaunch,
    tx: { isPending, isConfirming },
    blockersInRevertOrder: revertOrder(
      {
        id: 'launch-window-expired',
        // STRICTLY LATER THAN `expiresAt`, matching the hook: `launch()` reverts
        // on `block.timestamp > genesisDeadline + LAUNCH_WINDOW`, so the final
        // second is still a legal launch. `secsLeft <= 0` blocked at equality
        // and took the button away one second before the contract did — the same
        // off-by-one `phase.ts` already carries a warning about for refunds,
        // where `resolvePhase` uses `>` and would still say `awaiting_launch`
        // here. Only the button disagreed.
        active: nowSec > 0 && BigInt(nowSec) > expiresAt,
        label: t.awaitingLaunch.expiredLabel,
        reason: t.awaitingLaunch.expiredReason,
        tone: 'warn',
      },
    ),
  })

  return (
    <Card
      id="P-1.5"
      title={t.awaitingLaunch.title}
      subtitle={t.awaitingLaunch.subtitle}
      tone={canLaunch ? 'ok' : 'default'}
    >
      <div className="grid grid-cols-1 gap-x-6 @md:grid-cols-3">
        <Readout label={t.awaitingLaunch.raised} value={`${fmtQuote(totalNativeDeposited)} ${QUOTE_SYMBOL}`} />
        <Readout label={t.awaitingLaunch.status} value={t.awaitingLaunch.statusValue} tone="ok" />
        <Readout label={t.awaitingLaunch.windowRemaining} value={countdown} tone="warn" />
      </div>

      {canLaunch ? (
        <>
          <p className="text-note text-text-secondary leading-relaxed">
            {fill(t.awaitingLaunch.creatorBody, { symbol, quote: QUOTE_SYMBOL })}
          </p>
          <p className="text-note text-warning leading-relaxed">
            {fill(t.awaitingLaunch.creatorDeadline, { countdown, quote: QUOTE_SYMBOL })}
          </p>
          <ActionButton gate={gate} size="lg" intent="primary" />
        </>
      ) : (
        <div className="rounded-card border border-warning/30 bg-warning/5 px-card py-gap">
          <p className="font-mono text-label text-warning">{t.awaitingLaunch.waitingTitle}</p>
          <p className="mt-1 text-note text-text-secondary leading-relaxed">
            {fill(t.awaitingLaunch.waitingBody, { countdown, quote: QUOTE_SYMBOL })}
          </p>
        </div>
      )}
    </Card>
  )
}
