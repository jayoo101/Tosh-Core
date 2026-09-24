'use client'

/**
 * BONDING PANEL  ·  Phase 2, in two halves
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This file used to be one Card holding the ladder table, the shelf readouts,
 * the amount field, the quote box and the buy button. The v0 skeleton splits
 * that in two: the ladder belongs to the wide main column, the buy form to the
 * 360px sidebar.
 *
 *   `BondingLadderSection` — main column. `ShelfLadder` and the halt banner,
 *                            and by now nothing else: the four-across readout
 *                            row it also carried was four figures the rest of
 *                            the page already printed, and it is a tombstone
 *                            comment below. Still main-column only — the table
 *                            is a `grid-cols-[4rem_1fr_6rem_5rem]` and does
 *                            not survive a 360px track.
 *   `BondingBuyPanel`      — sidebar. The reference's `Buy $SYMBOL` card: an
 *                            amount, the quote, the CTA and the 105% ceiling
 *                            note.
 *
 * Neither owns any state. Every read, the amount, the quote and the single
 * write gate live in `bondingState.tsx`, which `ProjectTerminal` wraps around
 * both grid columns — see the header comment there for why that is a provider
 * and not a hook each half calls.
 */

// No `Badge`: the only one in this file was the gate pill, and the gate is
// `ShelfLadder`'s single mono line now.
import {
  Card, Readout, Field, ActionButton,
} from '@/components/ui'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { fill, useT } from '@/i18n'
import { fmtQuote } from './format'
import { ShelfLadder } from './ShelfLadder'
import { useBondingState } from './bondingState'

export type { BondingProps } from './bondingState'

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COLUMN  ·  the ladder itself
// ─────────────────────────────────────────────────────────────────────────────

export function BondingLadderSection() {
  // No `unlocked` or `premiumRaw` here any more: the gate moved into
  // `ShelfLadder`, which already took `unlocked` for the ceiling readout, and
  // the premium multiple is the curve section's `Shelf climb`.
  const {
    p, status, halted, haltIsGlobal, haltTxt,
    sameBlockLock, awaitingFirstUnlock,
  } = useBondingState()
  const t = useT().bonding

  return (
    <Card
      id="P-2"
      title={fill(t.ladderTitle, { symbol: p.symbol })}
      subtitle={t.ladderSubtitle}
    >
      <ShelfLadder
        hookAddress={p.hookAddress}
        p0={p.p0}
        halted={halted}
        sameBlockLock={sameBlockLock}
        awaitingFirstUnlock={awaitingFirstUnlock}
        status={status}
      />

      {halted && (
        <div className="border border-danger/40 px-4 py-3 flex flex-col gap-1">
          <p className="font-mono text-label tracking-[0.32em] uppercase text-danger">
            {fill(haltIsGlobal ? t.suspendedGlobal : t.suspendedHook, { time: haltTxt })}
          </p>
          <p className="font-mono text-note text-text-tertiary leading-relaxed">
            {t.suspendedBody}
          </p>
        </div>
      )}

      {/* A FOUR-CELL READOUT ROW USED TO SIT HERE, under the table, and every
          cell in it was already on the screen:

            OPENING PRICE      the ladder's own footer line, `opening = …`,
                               forty pixels above it
            FIRST SHELF · +5%  the curve's shelf-#0 axis label, and again in
                               `Shelf climb`'s hint
            ACTIVE SHELF       the fifth printing of this price — the page's
                               headline figure, `HeroStats`' Price, the curve
                               header's `live · shelf #N · …`, and the table's
                               own SHELF PRICE. Its `1.00× ladder base` hint
                               was the curve's `Shelf climb` a second time.
            105% gate          the gate strip at the top of this same table.

          The gate was the one cell with something of its own — two states the
          strip could not reach — so it went up into the strip rather than out,
          and `gateLine` in `ShelfLadder` is now the only place the gate is
          rendered. The `315 / 12.60M sold` under it is the caption on
          `HeroStats`' ladder bar.

          What is genuinely gone is the `+5%` label: that shelf #0 opens a
          twentieth above the pool. It is launch geometry, fixed before anyone
          arrives here, and a buyer transacts at the ACTIVE shelf — so it
          belongs with the rest of the immutable terms on the launch page, not
          in the row above the buy button. */}
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SIDEBAR  ·  the buy form
// ─────────────────────────────────────────────────────────────────────────────

export function BondingBuyPanel() {
  const {
    p, halted, quotable, quoteCost, maxQuoteCost,
    quoteUnknown, quoteUnavailable, isDust,
    tokenAmount, setTokenAmount, txBusy, amountError, amountHint,
    gate, armed,
  } = useBondingState()
  const t = useT().bonding

  return (
    <Card
      title={fill(t.buyTitle, { symbol: p.symbol })}
      // The reference's eyebrow for this card, which sits top-right of the
      // title rather than above it. `status` is that slot.
      //
      // NO `subtitle`, deliberately. The 105% sentence is the reference's
      // ActionForm `hint`, which lives UNDER the CTA, and putting it in the
      // header instead cost more than a moved paragraph: Card's header is a
      // `flex-wrap justify-between`, so at this column's 360px a title with a
      // subtitle beside it pushed the eyebrow onto its own line, where it read
      // as an orphaned caption rather than a label on the card.
      status={<span className="font-mono text-micro uppercase text-text-quiet">{t.buyEyebrow}</span>}
      interactive={false}
    >
      <Field
        label={t.amountLabel}
        value={tokenAmount}
        onValueChange={setTokenAmount}
        placeholder={t.amountPlaceholder}
        inputMode="decimal"
        disabled={txBusy || !p.isConnected || halted}
        error={amountError}
        armed={armed}
        hint={amountHint}
      />

      {/* One column here, not the three the wide card had: `@md` is 28rem and
          the sidebar track is 360px, so the container query this already
          carried resolves to stacked on its own. It is left in place because
          the same component renders full-width below `lg`, where the sidebar
          is not a sidebar. */}
      {quotable && (
        <div className="border border-border-subtle">
          <div className="grid grid-cols-1 @md:grid-cols-3 divide-y divide-border-subtle @md:divide-x @md:divide-y-0">
            <Readout
              layout="stack"
              className="px-4 py-3"
              label={t.quotedCost}
              value={quoteUnknown ? '…' : quoteUnavailable ? t.unavailable : `${fmtQuote(quoteCost)} ${QUOTE_SYMBOL}`}
              tone={quoteUnavailable ? 'warn' : 'ink'}
            />
            <Readout
              layout="stack"
              className="px-4 py-3"
              label={t.mostYouPay}
              // Only one of these three cells used to admit it was waiting. The
              // other two read straight off `maxQuoteCost`, which is 0n until the
              // quote lands — so the panel spent every in-flight moment stating
              // that the order costs nothing and sends nothing. A ceiling of
              // "0 ETH" is not a pending state, it is a wrong answer.
              value={quoteUnknown || quoteUnavailable ? '…' : `${fmtQuote(maxQuoteCost)} ${QUOTE_SYMBOL}`}
              // Not "the difference comes back". A shelf mint is a pull, not a
              // payment: the hook charges the true cost with `transferFrom` and
              // never takes the ceiling, so there is nothing to refund and no
              // BEM ever leaves this wallet unspent. What the 0.5% buys is
              // unused ALLOWANCE, which is the wording `useQuoteApproval`
              // already uses. The old line was left over from the native-value
              // era, when the call really did carry `msg.value` and really did
              // send change back.
              hint={t.mostYouPayHint}
            />
            <Readout
              layout="stack"
              className="px-4 py-3"
              label={t.orderSize}
              value={quoteUnknown ? '…' : isDust ? t.belowMinimum : t.accepted}
              tone={isDust ? 'warn' : 'ok'}
              hint={isDust ? fill(t.orderSizeHint, { quote: QUOTE_SYMBOL }) : undefined}
            />
          </div>
        </div>
      )}

      <ActionButton gate={gate} />

      <p className="text-micro leading-relaxed text-text-quiet">
        {t.buyFooter}
      </p>
    </Card>
  )
}
