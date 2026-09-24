'use client'

/**
 * LAUNCH LIFECYCLE  ·  where this raise is, as a rail
 *
 * Ported from the v0 skeleton's `LifecycleTracker`: a numbered-disc-and-rail
 * vertical list, a tick for cleared steps, a `current` marker on the live one,
 * and a destructive banner when the raise is over.
 *
 * Rendered for the three pre-trading phases only. Once the pool is open the
 * ladder, the chart and the buy form say everything this rail would, and a
 * three-step tracker with all three steps done is noise.
 */

import { Check } from 'lucide-react'
import { Card, cn } from '@/components/ui'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { fill, useT, type Dictionary } from '@/i18n'
import type { Phase } from './phase'

/**
 * Three steps, and the reference's own copy for two of them.
 *
 * STEP 2 IS DELIBERATELY NOT THE MOCK'S WORDING. The mock reads "Floor cleared
 * · ladder deploying", which describes a deployment happening on its own. In
 * this protocol nothing deploys on its own: `launch()` is creator-only, and if
 * the creator never calls it the LAUNCH_WINDOW lapses and every depositor is
 * refunded instead. Telling a depositor their ladder is "deploying" while it is
 * in fact waiting on one address to act — and might never happen — is the
 * difference between a progress bar and a promise. Same correction as the
 * directory card's `launching` body; see v0 audit §D2.
 */
function lifecycle(t: Dictionary['project']): { key: Phase; label: string; body: string }[] {
  return [
    { key: 'genesis',         label: t.stepFunding,  body: fill(t.stepFundingBody, { quote: QUOTE_SYMBOL }) },
    { key: 'awaiting_launch', label: t.stepAwaiting, body: t.stepAwaitingBody },
    { key: 'bonding',         label: t.stepTrading,  body: t.stepTradingBody },
  ]
}

export function LifecycleTracker({ phase }: { phase: Phase }) {
  const t = useT().project
  const LIFECYCLE = lifecycle(t)
  // A failed raise is not "step 1 of 3 in progress". The mock parks `archived`
  // at index 0 with nothing active, which reads correctly: the rail greys out
  // and the banner below carries the outcome.
  const archived = phase === 'refund'
  const activeIndex = archived ? 0 : LIFECYCLE.findIndex(s => s.key === phase)

  return (
    <Card title={t.lifecycleTitle} interactive={false}>
      <ol className="mt-2 flex flex-col gap-0">
        {LIFECYCLE.map((step, i) => {
          const done = !archived && i < activeIndex
          const active = !archived && i === activeIndex
          const last = i === LIFECYCLE.length - 1
          return (
            <li key={step.key} className="flex gap-4">
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-pill border font-mono text-note font-bold',
                    active && 'border-brand bg-brand/15 text-brand',
                    done && 'border-success/50 bg-success/10 text-success',
                    !active && !done && 'border-border-subtle text-text-quiet',
                  )}
                >
                  {done ? <Check aria-hidden className="h-3.5 w-3.5" /> : i + 1}
                </span>
                {!last && (
                  <span
                    aria-hidden
                    className={cn('my-1 w-px flex-1', done ? 'bg-success/40' : 'bg-border-subtle')}
                  />
                )}
              </div>
              <div className={cn('pb-6', last && 'pb-0')}>
                <div
                  className={cn(
                    'font-mono text-readout font-semibold',
                    active ? 'text-text-primary' : 'text-text-secondary',
                  )}
                >
                  {step.label}
                  {active && <span className="ml-2 font-normal text-note text-brand">{t.stepCurrent}</span>}
                </div>
                <p className="mt-0.5 text-note text-text-secondary">{step.body}</p>
              </div>
            </li>
          )
        })}
      </ol>

      {archived && (
        <div className="flex items-center gap-gap-tight rounded-input border border-danger/30 bg-danger/5 px-3 py-2.5 text-note text-danger">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-pill bg-danger" />
          {t.archivedBanner}
        </div>
      )}
    </Card>
  )
}
