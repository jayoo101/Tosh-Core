'use client'

import { Card } from '@/components/ui'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { formatGasScanChainList } from '@/app/lib/gasScanCopy'
import { fmt } from './format'

/**
 * What the deposit panel becomes for a wallet the gas floor has refused.
 *
 * WHY THIS REPLACES THE FORM RATHER THAN DISABLING IT
 *
 * Because the disabled form was lying, and it was lying in the direction that
 * cost us an outage. A wallet 3,000× below the floor was shown: a greyed-out
 * amount field, a `MAX` affix, the hint `THIS PROJECT ALLOWS 46.4 BEM PER
 * WALLET · 46.4 BEM LEFT FOR YOU`, a ledger footer reading `→ WITHIN YOUR
 * LIMIT`, and a button reading `Enter an amount`. Four separate surfaces
 * agreeing that the only missing thing was a number, and one bordered callout
 * off to the side saying the actual truth.
 *
 * A reader resolves that contradiction the way anyone would — by trying again.
 * Which is exactly what happened: repeated scans exhausted the shared
 * Proof-of-Gas credit budget, `/api/pog-scan` started answering `503 at
 * capacity`, and the raise funnel went down for everybody for 26 minutes. The
 * form was the cause. So there is no form here.
 *
 * ⚠ AND NO RETRY BUTTON. Deliberately. A scan is 5-25 upstream calls against a
 *   shared budget, and re-running it cannot change the answer: the floor is
 *   measured against LIFETIME gas already spent, which does not move because
 *   someone pressed a button. The one thing that does change it — connecting a
 *   different wallet — already triggers a fresh scan on its own. Offering
 *   "try again" here would rebuild the loop this component exists to break.
 *
 * The per-chain breakdown stays, because it answers the one reasonable
 * objection ("you missed a chain I use") and costs nothing — the figures are
 * already in hand and the dialog is local.
 */
export function GenesisIneligible({
  totalGasWei, floorWei, onOpenBreakdown,
}: {
  /** Lifetime gas this wallet has spent, ETH-equivalent, 18 decimals. */
  totalGasWei: bigint
  /** The floor it was measured against, same units. */
  floorWei: bigint
  onOpenBreakdown: () => void
}) {
  /**
   * How far short, as a multiple.
   *
   * The two absolute figures are the honest statement but they are nearly
   * unreadable against each other — `7.62e-6` and `0.025` differ by three
   * orders of magnitude and look adjacent in a column. The multiple is what
   * makes "this is not a near miss" land, and telling a near miss from a
   * structural one is the entire decision this panel is helping the reader make.
   *
   * Guarded against a zero denominator: a wallet with no history at all is the
   * common case here, not an edge one.
   */
  const shortfall = totalGasWei > 0n
    ? Number(floorWei) / Number(totalGasWei)
    : null

  return (
    <Card
      id="DEPOSIT"
      title="This wallet cannot deposit"
      subtitle="Proof-of-Gas sizes every deposit quota from gas already spent on-chain. This address has not spent enough for a quota to exist."
      interactive={false}
    >
      <div className="border border-warning/40 px-4 py-3 flex flex-col gap-2">
        <p className="font-mono text-label tracking-[0.32em] uppercase text-warning">
          → BELOW THE GAS FLOOR
        </p>

        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-label text-text-tertiary">THIS WALLET</span>
            <span className="font-mono text-note text-text-primary tabular-nums">
              {fmt(totalGasWei)} ETH
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-label text-text-tertiary">FLOOR</span>
            <span className="font-mono text-note text-text-primary tabular-nums">
              {fmt(floorWei)} ETH
            </span>
          </div>
          {shortfall !== null && (
            <div className="flex items-baseline justify-between gap-4 border-t border-border-subtle/60 pt-1.5">
              <span className="font-mono text-label text-text-tertiary">SHORT BY</span>
              <span className="font-mono text-note text-warning tabular-nums">
                {shortfall >= 100
                  ? `${Math.round(shortfall).toLocaleString('en-US')}×`
                  : `${shortfall.toFixed(1)}×`}
              </span>
            </div>
          )}
        </div>
      </div>

      {/*
        The part that makes this actionable, and the part the old panel never
        said: this is not a wait. "Try again in 26 min" was the message a
        reader used to get, and it was false in the way that matters — no
        amount of waiting closes a 3,000× gap, so every minute spent waiting
        was a minute spent on the wrong plan.
      */}
      <p className="font-mono text-note text-text-tertiary leading-relaxed">
        This is not a queue and not a cooldown — there is nothing here to wait for.
        The floor is measured against gas this address has <span className="text-text-primary">already
        spent</span>, across {formatGasScanChainList()}, so it only moves as that history grows.
      </p>

      <div className="border border-border-subtle px-4 py-3 flex flex-col gap-1.5">
        <span className="text-label tracking-[0.4em] uppercase text-text-tertiary font-bold">
          {'// WHAT WOULD WORK'}
        </span>
        <p className="font-mono text-note text-text-tertiary leading-relaxed">
          Connect an address you have actually used — a main wallet with a real transaction
          history will usually clear the floor on its own. Switching wallets re-reads the
          history automatically; there is nothing to press here.
        </p>
        <p className="font-mono text-note text-text-quiet leading-relaxed">
          A fresh address cannot be made eligible by funding it with {QUOTE_SYMBOL}. The
          quota comes from gas spent, which is the whole point of the mechanism.
        </p>
      </div>

      <button
        type="button"
        onClick={onOpenBreakdown}
        className="self-start font-mono text-label tracking-[0.2em] uppercase
                   text-brand hover:underline"
      >
        View per-chain breakdown
      </button>
    </Card>
  )
}
