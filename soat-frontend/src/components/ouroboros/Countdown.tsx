'use client'

import { Badge, cn, useNowSec } from '@/components/ui'

import { useOuroCopy } from './copy'
import { phaseCountdown, type OuroState } from './useOuro'

const pad = (n: number) => String(n).padStart(2, '0')

export function CountdownClock({
  label,
  targetSec,
  className,
}: {
  label: string
  targetSec: number
  className?: string
}) {
  const c = useOuroCopy()
  const now = useNowSec()
  if (now <= 0) return null

  const left = Math.floor(targetSec - now)
  if (left <= 0) {
    return (
      <div className={cn('flex items-center', className)}>
        <Badge tone="ok" pip live>{c.l2LiveNow}</Badge>
      </div>
    )
  }

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
      <span className="font-mono text-label uppercase text-brand">{label}</span>
      <div className="flex items-end gap-2 md:gap-2.5">
        {parts.map(([v, unit], i) => (
          <div key={unit} className="flex items-end gap-2 md:gap-2.5">
            {i > 0 && <span aria-hidden className="pb-5 font-mono text-figure text-brand/60">:</span>}
            <div className="flex flex-col items-center gap-1">
              <span className="min-w-[2.4ch] rounded-input border border-border-subtle bg-bg-base/80 px-2.5 py-1.5 text-center font-mono text-3xl font-bold tabular-nums text-text-primary md:text-hero">
                {v}
              </span>
              <span className="font-mono text-micro text-text-tertiary">{unit}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function Countdown({ state, className }: { state: OuroState; className?: string }) {
  const c = useOuroCopy()
  const now = useNowSec()
  const cd = phaseCountdown(state, c, now)
  if (!cd || now <= 0) return null

  return <CountdownClock label={cd[0]} targetSec={now + Math.max(0, Math.floor(cd[1]))} className={className} />
}
