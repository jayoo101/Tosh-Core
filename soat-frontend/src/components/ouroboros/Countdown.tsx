'use client'

import { cn, useNowSec } from '@/components/ui'
import { fill } from '@/i18n'

import { useOuroCopy } from './copy'
import { phaseCountdown, type OuroState } from './useOuro'

const pad = (n: number) => String(n).padStart(2, '0')

/** The next phase boundary, large: label, hours / minutes / seconds, and the wall-clock time it lands on. */
export function Countdown({ state, className }: { state: OuroState; className?: string }) {
  const c = useOuroCopy()
  const now = useNowSec()
  const cd = phaseCountdown(state, c, now)
  if (!cd || now <= 0) return null

  const left = Math.max(0, Math.floor(cd[1]))
  const at = new Date((now + left) * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)
  const parts: [string, string][] = [
    [pad(Math.floor(left / 3600)), c.unitH],
    [pad(Math.floor((left % 3600) / 60)), c.unitM],
    [pad(left % 60), c.unitS],
  ]

  return (
    <div
      role="timer"
      aria-live="off"
      className={cn(
        'flex w-fit flex-col gap-3 rounded-card border border-brand/40 bg-brand/5 p-4 shadow-[0_0_32px_-8px_var(--tosh-brand)] md:p-5',
        className,
      )}
    >
      <span className="text-body font-bold text-brand">{cd[0]}</span>
      <div className="flex items-end gap-2 md:gap-3">
        {parts.map(([v, unit], i) => (
          <div key={unit} className="flex items-end gap-2 md:gap-3">
            {i > 0 && <span aria-hidden className="pb-6 font-mono text-3xl font-bold text-brand/60 md:text-4xl">:</span>}
            <div className="flex flex-col items-center gap-1">
              <span className="min-w-[2.4ch] rounded-input border border-border-subtle bg-bg-base/80 px-2 py-1 text-center font-mono text-4xl font-bold tabular-nums text-text-primary md:text-6xl">
                {v}
              </span>
              <span className="text-micro text-text-tertiary">{unit}</span>
            </div>
          </div>
        ))}
      </div>
      <span className="text-note text-text-secondary">{fill(c.countdownAt, { time: at })}</span>
    </div>
  )
}
