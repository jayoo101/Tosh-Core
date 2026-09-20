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
import { fmt, fmtQuote } from './format'
import type { Phase } from './phase'

/**
 * Exported because the page header now carries this badge too — the mock puts
 * it beside the `$SYMBOL` headline, and `ProjectDetail` owns that markup. One
 * map, so the pill in the header and the pill in this card can never disagree
 * about what phase the page is in.
 */
export const PHASE_BADGE: Record<Phase, { label: string; tone: Tone; live: boolean }> = {
  genesis:         { label: 'Genesis',         tone: 'ok',     live: true  },
  awaiting_launch: { label: 'Awaiting launch', tone: 'warn',   live: true  },
  bonding:         { label: 'Ladder',          tone: 'info',   live: true  },
  refund:          { label: 'Refund open',     tone: 'danger', live: false },
}

export function HeroStats({
  phase, symbol,
  p0, currentPrice, shelfP0,
  totalNativeDeposited,
  phase2Minted, bondingMax,
  userEthDeposited,
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
  /** One-word status under the phase badge, when there is no live clock. */
  windowLabel?: string
  /**
   * The genesis countdown, pre-derived. `pct` is how much of the chosen
   * window REMAINS, so the track drains toward the deadline.
   */
  genesisWindow?: { pct: number; label: string; hours: number }
}) {
  const meta = PHASE_BADGE[phase]
  const price =
    phase === 'bonding' && currentPrice > 0n ? currentPrice
    : phase === 'bonding' && shelfP0 > 0n    ? shelfP0
    : p0
  const priceHint =
    phase === 'bonding' ? 'active shelf'
    : p0 > 0n           ? 'genesis P₀'
    : 'opens at launch'

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
   * and reaching the end of it actually closes deposits. It drains rather than
   * fills — see where `pct` is derived in `index.tsx`.
   *
   * The raise itself still has no percentage, because it still has no whole.
   */
  const progressIsLadder = phase === 'bonding'
  const ladderPct = bondingMax > 0n
    ? Number((phase2Minted * 10_000n) / bondingMax) / 100
    : 0

  const stakeHint =
    phase === 'refund'  ? 'claimable in full'
    : phase === 'bonding' ? 'genesis allocation unlocked at launch'
    : 'in this raise'

  return (
    <div className="grid grid-cols-2 gap-card @lg:grid-cols-4">
      {/* The unit rides on the hint line rather than beside the figure. Token
          prices here are routinely exponential ("2.50e-9"), and at figure size
          that plus the coin's ticker overruns the cell and wraps — splitting the number
          off its own unit. The hint already sits directly underneath. */}
      <Readout
        layout="stack"
        size="figure"
        label="Price"
        value={price > 0n ? fmt(price) : '—'}
        hint={price > 0n ? `${QUOTE_SYMBOL} · ${priceHint}` : priceHint}
        tone="ok"
      />
      <div className="flex flex-col gap-gap-tight border-b border-border-subtle pb-gap">
        <span className="font-mono text-label text-text-quiet">Phase</span>
        <Badge tone={meta.tone} pip live={meta.live}>{meta.label}</Badge>
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
            label="Ladder"
            caption={`${fmt(phase2Minted)} / ${fmt(bondingMax)} ${symbol}`}
          />
        ) : (
          <>
            <Readout
              layout="stack"
              size="figure"
              label="Raised"
              value={fmtQuote(totalNativeDeposited)}
              hint={genesisWindow ? undefined : QUOTE_SYMBOL}
              tone={phase === 'refund' ? 'mute' : 'ok'}
            />
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
                pct={genesisWindow.pct}
                variant="bar"
                tone="ok"
                label={`${QUOTE_SYMBOL} · ${genesisWindow.hours}h window`}
                caption={genesisWindow.label}
              />
            )}
          </>
        )}
      </div>
      <Readout
        layout="stack"
        size="figure"
        label="Your stake"
        value={`${fmtQuote(userEthDeposited)} ${QUOTE_SYMBOL}`}
        hint={stakeHint}
        tone={userEthDeposited > 0n ? 'ink' : 'mute'}
      />
    </div>
  )
}
