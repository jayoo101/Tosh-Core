'use client'
import { useCallback } from 'react'
import type { Address } from 'viem'

import { HOOK_ABI } from '@/lib/contracts'
import {
  Card, Readout, ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { QUOTE_SYMBOL } from '@/lib/contracts'
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
 */
function refundReason(ladderViable: boolean | undefined): string {
  if (ladderViable === false) {
    return 'This raise finished too small to open a pool, so it closed instead of launching. '
      + 'Take back the full amount, no penalty.'
  }
  return 'The 7-day window to open trading lapsed without a launch. '
    + 'Take back the full amount, no penalty.'
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
    blockersInRevertOrder: revertOrder(
      {
        // ⚠ SEPARATE FROM "nothing to refund", because the two used to share a
        //   `?? 0n` and this is the screen where a depositor comes to get their
        //   money back. Told "this wallet has nothing deposited in this project"
        //   while their own balance was still loading, the reasonable reaction is
        //   to leave — and the phase is already `refund`, so the round has failed
        //   and the window to act is finite.
        id: 'deposit-pending',
        active: nativeDeposited === undefined,
        label: 'Reading your deposit…',
        reason: 'Fetching this wallet’s balance in the project. The button arms as soon as it lands.',
        tone: 'neutral',
      },
      {
        id: 'no-deposit',
        active: nativeDeposited === 0n,
        label: 'Nothing to refund',
        reason: 'This wallet has nothing deposited in this project, so there is nothing to refund.',
        tone: 'neutral',
      },
    ),
  })

  return (
    <Card
      id="P-3"
      title="Claim refund"
      subtitle={refundReason(ladderViable)}
      tone="warn"
    >
      <Readout
        label="Your deposit"
        value={nativeDeposited === undefined ? '…' : `${fmtQuote(nativeDeposited)} ${QUOTE_SYMBOL}`}
        tone="warn"
      />
      <ActionButton gate={gate} size="lg" intent="danger" />
    </Card>
  )
}
