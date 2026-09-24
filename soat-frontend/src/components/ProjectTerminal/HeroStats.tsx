'use client'

/**
 * Four figures that tell you where this project is, before any panel asks
 * you to type.
 *
 *   1. Price     — P₀ during genesis; the live shelf once the ladder is open
 *   2. Phase     — the state machine, as a badge, not a sentence
 *   3. Progress  — the amount raised plus the genesis countdown, or ladder
 *                  minted vs BONDING_MAX once the ladder is open. Both bars
 *                  measure against something real; see the note on the cell.
 *   4. Your stake — the settlement coin this wallet has in, or is owed back
 */

import {
  Badge, Progress, Readout,
  type Tone,
} from '@/components/ui'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { fill, useT } from '@/i18n'
import { fmt, fmtQuote } from './format'
import type { Phase } from './phase'

/**
 * Exported because the page header now carries this badge too — the mock puts
 * it beside the `$SYMBOL` headline, and `ProjectDetail` owns that markup. One
 * map, so the pill in the header and the pill in this card can never disagree
 * about what phase the page is in.
 */
export const PHASE_BADGE: Record<Phase, {
  label: 'badgeGenesis' | 'badgeAwaiting' | 'badgeLadder' | 'badgeRefund'
  tone: Tone
  live: boolean
}> = {
  genesis:         { label: 'badgeGenesis',  tone: 'ok',     live: true  },
  awaiting_launch: { label: 'badgeAwaiting', tone: 'warn',   live: true  },
  bonding:         { label: 'badgeLadder',   tone: 'info',   live: true  },
  refund:          { label: 'badgeRefund',   tone: 'danger', live: false },
}

export function HeroStats({
  phase, symbol,
  p0, currentPrice, shelfP0,
  totalNativeDeposited,
  phase2Minted, bondingMax,
  userEthDeposited,
  hookQuoteBalance,
  windowLabel,
  genesisWindow,
}: {
  phase: Phase
  symbol: string
  p0: bigint
  currentPrice: bigint
  shelfP0: bigint
  totalNativeDeposited: bigint
  phase2Minted: bigint
  bondingMax: bigint
  userEthDeposited: bigint
  /**
   * `quoteAsset.balanceOf(hook)` — what the round still holds. `undefined`
   * while the read is in flight, and that is NOT `0n`: zero is the verdict
   * "everything has been refunded", which must never be printed on a guess.
   *
   * Only read during `refund`, where it is exact. An unlaunched hook takes
   * money in one way (deposits) and lets it out one way (refunds), so its
   * balance IS its outstanding liability — every other outflow in the contract
   * is gated behind `launched`. The one thing that can inflate it is an
   * unsolicited transfer to the hook, which nothing stops and which would
   * overstate what is owed rather than hide a shortfall.
   */
  hookQuoteBalance?: bigint
  /** One-word status under the phase badge, when there is no live clock. */
  windowLabel?: string
  /**
   * The genesis countdown, pre-derived. `elapsedPct` is how much of the chosen
   * window is GONE, so the track fills toward the deadline.
   */
  genesisWindow?: { elapsedPct: number; label: string; hours: number }
}) {
  const t = useT().project
  const meta = PHASE_BADGE[phase]
  const price =
    phase === 'bonding' && currentPrice > 0n ? currentPrice
    : phase === 'bonding' && shelfP0 > 0n    ? shelfP0
    : p0
  const priceHint =
    phase === 'bonding' ? t.priceHintShelf
    : p0 > 0n           ? t.priceHintP0
    : t.priceHintClosed

  /*
   * ⚠ A BAR NEEDS A DENOMINATOR THAT MEANS SOMETHING. That is the whole rule
   *   this cell follows, and the soft cap is what taught it.
   *
   * This cell used to switch between `minted / BONDING_MAX` and
   * `raised / softCap`. Those look alike and are not: `BONDING_MAX` is a hard
   * ceiling — the ladder cannot mint past it, so 100% means finished — while
   * the soft cap was never a limit, a gate or a fail condition. Deposits ran
   * past it, `launch()` ignored it, and a raise that never reached it launched
   * exactly the same way. A bar filling toward it told the reader the project
   * was on its way to something, and there was nothing there.
   *
   * So the raise lost its bar and kept its figure. What took the empty slot is
   * the genesis clock, which passes the test the cap failed: the window is one
   * of three fixed durations chosen at `createLaunch`, it cannot be extended,
   * and reaching the end of it actually closes deposits. It is drawn as a fuse
   * burning left to right rather than as a fill — the lit stretch is the time
   * still to come and shrinks toward the right edge, the flame marks now, and
   * the spent side is left dark. See `elapsedPct` in `genesisWindow` for the
   * number, and `burn` in `Progress` for why the light is on that side.
   *
   * The raise itself still has no percentage, because it still has no whole.
   */
  const progressIsLadder = phase === 'bonding'
  const ladderPct = bondingMax > 0n
    ? Number((phase2Minted * 10_000n) / bondingMax) / 100
    : 0

  /*
   * ⚠ `refund` SPANS FROM THE WINDOW CLOSING TO THE LAST WALLET BEING PAID,
   *   and this hint used to be the single word "claimable in full" across all
   *   of it. `userEthDeposited` is `nativeDeposited(wallet)`, which `refund()`
   *   zeroes — so the wallet that had already taken its money back read
   *   "0 BEM · claimable in full", a figure and a caption contradicting each
   *   other in the page's own header.
   *
   *   IT DOES NOT SAY "already refunded" EITHER, tempting as that is. Zero is
   *   also what a wallet that never deposited sees, and what a pending read
   *   looks like — `ProjectTerminal` passes `userEthDeposited ?? 0n` into this
   *   prop by design, because the panels that spend the value take the
   *   `undefined` and the cells that only display it take the zero. So a
   *   refund is one of three things zero can mean here, and the only honest
   *   line is the one that claims no history. Whether the ROUND has paid out
   *   is a separate question, and the Raised cell answers it.
   */
  const stakeHint =
    phase === 'refund'
      ? (userEthDeposited > 0n ? t.stakeClaimable : t.stakeNone)
    : phase === 'bonding' ? t.stakeBonding
    : t.stakeGenesis

  /*
   * The raise's figure is a PEAK once refunds open, so the label stops calling
   * it the present tense and the line below says where the money actually is.
   *
   * "Raised at genesis" is lifted verbatim from the directory's completed-tab
   * card, which has been wording it that way all along — this cell was the one
   * place still printing the high-water mark as though it were a balance.
   */
  const raisedLabel = phase === 'refund' ? t.raisedAtGenesis : t.raised
  const outstandingTxt =
    hookQuoteBalance === undefined ? t.outstandingReading
    : hookQuoteBalance === 0n      ? t.outstandingNone
    : fill(t.outstandingSome, { amount: fmtQuote(hookQuoteBalance), quote: QUOTE_SYMBOL })

  return (
    <div className="grid grid-cols-2 gap-card @lg:grid-cols-4">
      {/* The unit rides on the hint line rather than beside the figure. Token
          prices here are routinely exponential ("2.50e-9"), and at figure size
          that plus the coin's ticker overruns the cell and wraps — splitting the number
          off its own unit. The hint already sits directly underneath. */}
      <Readout
        layout="stack"
        size="figure"
        label={t.priceLabel}
        value={price > 0n ? fmtQuote(price) : '—'}
        hint={price > 0n ? `${QUOTE_SYMBOL} · ${priceHint}` : priceHint}
        tone="ok"
      />
      <div className="flex flex-col gap-gap-tight border-b border-border-subtle pb-gap">
        <span className="font-mono text-label text-text-quiet">{t.phaseLabel}</span>
        <Badge tone={meta.tone} pip live={meta.live}>{t[meta.label]}</Badge>
        {/* Nothing where the symbol used to be. This cell fell back to
            printing `{symbol}` under the badge whenever there was no
            countdown, and the symbol is the page's `$RHRSL` headline, the
            ladder card's title, the buy panel's button and the caption on the
            bar in the next cell along. A phase badge needs no subtitle; an
            empty line under it is not a gap, it is the absence of a fifth
            copy. */}
        {windowLabel && (
          <span className="font-mono text-note text-text-tertiary tabular-nums">{windowLabel}</span>
        )}
      </div>
      <div className="col-span-2 flex flex-col gap-gap-tight @lg:col-span-1">
        {progressIsLadder ? (
          <Progress
            pct={ladderPct}
            variant="bar"
            tone="ok"
            label={t.ladderLabel}
            caption={`${fmt(phase2Minted)} / ${fmt(bondingMax)} ${symbol}`}
          />
        ) : (
          <>
            <Readout
              layout="stack"
              size="figure"
              label={raisedLabel}
              value={fmtQuote(totalNativeDeposited)}
              hint={genesisWindow ? undefined : QUOTE_SYMBOL}
              tone={phase === 'refund' ? 'mute' : 'ok'}
            />
            {/* Takes the slot the countdown holds during genesis, which is free
                here: `genesisWindow` is `undefined` in every phase but that
                one, so the two can never stack. */}
            {phase === 'refund' && (
              <span className="font-mono text-note tabular-nums text-text-tertiary">
                {outstandingTxt}
              </span>
            )}
            {/* The clock takes the slot the soft-cap bar used to hold, and it
                is the one meter on this card during genesis — so it gets
                `bar` rather than the hairline, per the note in Progress.tsx.
                The ladder's bar never coexists with it: that one only renders
                once `phase === 'bonding'`, in the branch above.

                `hint` on the readout collapses when this is showing, because
                the unit is already on the caption line and the cell would
                otherwise stack two sub-labels under one figure. */}
            {genesisWindow && (
              <Progress
                pct={genesisWindow.elapsedPct}
                variant="bar"
                burn
                label={fill(t.windowCaption, { quote: QUOTE_SYMBOL, hours: genesisWindow.hours })}
                caption={genesisWindow.label}
              />
            )}
          </>
        )}
      </div>
      <Readout
        layout="stack"
        size="figure"
        label={t.stakeLabel}
        value={`${fmtQuote(userEthDeposited)} ${QUOTE_SYMBOL}`}
        hint={stakeHint}
        tone={userEthDeposited > 0n ? 'ink' : 'mute'}
      />
    </div>
  )
}
