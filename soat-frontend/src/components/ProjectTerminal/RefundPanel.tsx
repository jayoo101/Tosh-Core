'use client'
import { useCallback } from 'react'
import type { Address } from 'viem'

import { HOOK_ABI } from '@/lib/contracts'
import {
  Card, Readout, ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { useT, type Dictionary } from '@/i18n'
import { fmtQuote } from './format'


/**
 * ⚠ TWO FAILURES ARRIVE AT THIS PANEL, and a depositor reading it is owed the
 *   one that actually happened.
 *
 *   The subtitle used to state the zombie case as fact — "the 7-day window
 *   lapsed without a launch" — because that was the only way in. A raise too
 *   small to carry a ladder now refunds the moment genesis closes, so that
 *   sentence would be shown up to a week before it became true, about a
 *   creator who had not run out of time and in most cases never will: their
 *   round could not have opened a pool at any point.
 *
 * The two sentences themselves live in `i18n/dict/en.ts`, which is also where
 * the argument above is restated for whoever translates them — a translator who
 * reads only the strings cannot tell that picking the wrong one accuses a
 * creator of running out of time they have not run out of.
 */
function refundReason(t: Dictionary, ladderViable: boolean | undefined): string {
  return ladderViable === false ? t.refund.reasonTooSmall : t.refund.reasonLapsed
}

export function RefundPanel({
  hookAddress, nativeDeposited, refetch, ladderViable,
}: {
  hookAddress:   Address
  /// `undefined` while the read is in flight. NOT the same as `0n`, which is a
  /// definite "this wallet has nothing here" and is what gates the button below.
  nativeDeposited:  bigint | undefined
  refetch:       () => void
  /** The hook's `ladderViable()`; `undefined` while the read is in flight. */
  ladderViable?: boolean
}) {
  const t = useT()

  const { send, isPending, isConfirming } = useTxAction({
    action: t.refund.txAction,
    labels: { confirmed: t.refund.txConfirmed },
    onConfirmed: refetch,
  })

  const handleRefund = useCallback(() => {
    send({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'refund', args: [],
    })
  }, [hookAddress, send])

  const gate = useActionGate({
    action: t.refund.cta,
    onAct: handleRefund,
    tx: { isPending, isConfirming },
    blockersInRevertOrder: revertOrder(
      {
        // ⚠ SEPARATE FROM "nothing to refund", because the two used to share a
        //   `?? 0n` and this is the screen where a depositor comes to get their
        //   money back. Told "this wallet has nothing deposited in this project"
        //   while their own balance was still loading, the reasonable reaction is
        //   to leave — and the phase is already `refund`, so the round has failed
        //   and the window to act is finite.
        //
        //   ⚠ THESE TWO PAIRS ARE THE MOST SWAPPABLE STRINGS IN THE APP. Give
        //     each blocker the other's `reason` and the panel states the wrong
        //     cause for not paying a depositor back, which typechecks, lints and
        //     screenshots clean. `moneyBackCopy.golden.test.tsx` is what catches
        //     it; see the demonstration in the commit that added that file.
        id: 'deposit-pending',
        active: nativeDeposited === undefined,
        label: t.refund.pendingLabel,
        reason: t.refund.pendingReason,
        tone: 'neutral',
      },
      {
        id: 'no-deposit',
        active: nativeDeposited === 0n,
        label: t.refund.noneLabel,
        reason: t.refund.noneReason,
        tone: 'neutral',
      },
    ),
  })

  return (
    <Card
      id="P-3"
      title={t.refund.title}
      subtitle={refundReason(t, ladderViable)}
      tone="warn"
    >
      <Readout
        label={t.refund.yourDeposit}
        value={nativeDeposited === undefined ? '…' : `${fmtQuote(nativeDeposited)} ${QUOTE_SYMBOL}`}
        tone="warn"
      />
      <ActionButton gate={gate} size="lg" intent="danger" />
    </Card>
  )
}
