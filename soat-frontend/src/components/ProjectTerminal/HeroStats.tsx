'use client'

/**
 * Four figures that tell you where this project is, before any panel asks
 * you to type.
 *
 *   1. Price     — P₀ during genesis; the live shelf once the ladder is open
 *   2. Phase     — the state machine, as a badge, not a sentence
 *   3. Progress  — raise vs soft cap, or ladder minted vs BONDING_MAX
 *   4. Your stake — ETH this wallet has in, or is owed back
 */

import {
  Badge, Progress, Readout,
  type Tone,
} from '@/components/ui'
import { fmt } from './format'
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
  totalNativeDeposited, softCap,
  phase2Minted, bondingMax,
  userEthDeposited,
  windowLabel,
}: {
  phase: Phase
  symbol: string
  p0: bigint
  currentPrice: bigint
  shelfP0: bigint
  totalNativeDeposited: bigint
  softCap: bigint
  phase2Minted: bigint
  bondingMax: bigint
  userEthDeposited: bigint
  /** Genesis / launch-window countdown, already formatted. */
  windowLabel?: string
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

  const raisePct = softCap > 0n
    ? Number((totalNativeDeposited * 10_000n) / softCap) / 100
    : 0
  const ladderPct = bondingMax > 0n
    ? Number((phase2Minted * 10_000n) / bondingMax) / 100
    : 0
  const progressIsLadder = phase === 'bonding'
  const pct = progressIsLadder ? ladderPct : raisePct
  const progressCaption = progressIsLadder
    ? `${fmt(phase2Minted)} / ${fmt(bondingMax)} ${symbol}`
    : `${fmt(totalNativeDeposited)} / ${fmt(softCap)} ETH`

  const stakeHint =
    phase === 'refund'  ? 'claimable in full'
    : phase === 'bonding' ? 'genesis allocation unlocked at launch'
    : 'in this raise'

  return (
    <div className="grid grid-cols-2 gap-card @lg:grid-cols-4">
      {/* The unit rides on the hint line rather than beside the figure. Token
          prices here are routinely exponential ("2.50e-9"), and at figure size
          that plus " ETH" overruns the cell and wraps — splitting the number
          off its own unit. The hint already sits directly underneath. */}
      <Readout
        layout="stack"
        size="figure"
        label="Price"
        value={price > 0n ? fmt(price) : '—'}
        hint={price > 0n ? `ETH · ${priceHint}` : priceHint}
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
        <Progress
          pct={pct}
          variant="bar"
          tone={phase === 'refund' ? 'warn' : 'ok'}
          label={progressIsLadder ? 'Ladder' : 'Raise'}
          caption={progressCaption}
        />
      </div>
      <Readout
        layout="stack"
        size="figure"
        label="Your stake"
        value={`${fmt(userEthDeposited)} ETH`}
        hint={stakeHint}
        tone={userEthDeposited > 0n ? 'ink' : 'mute'}
      />
    </div>
  )
}
