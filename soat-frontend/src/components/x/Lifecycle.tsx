'use client'

import { Check } from 'lucide-react'

import { useT } from '@/i18n'

export type V2Phase = 'GENESIS' | 'PENDING' | 'TRADING'

const ORDER: readonly V2Phase[] = ['GENESIS', 'PENDING', 'TRADING']

/** Launched, else closed (sold out or past the deadline), else selling. */
export function v2Phase(s: { launched: boolean; soldOutAt: bigint; genesisDeadline: bigint }, now: number): V2Phase {
  if (s.launched) return 'TRADING'
  if (s.soldOutAt !== 0n || BigInt(now) >= s.genesisDeadline) return 'PENDING'
  return 'GENESIS'
}

export function PhaseBadge({ phase }: { phase: V2Phase }) {
  const t = useT().x
  const label = { GENESIS: t.phaseGenesis, PENDING: t.phasePending, TRADING: t.phaseTrading }[phase]
  return (
    <span className="flex items-center gap-1.5 rounded-input border border-brand/50 bg-brand/10 px-2 py-0.5 font-mono text-label uppercase text-brand">
      {phase !== 'PENDING' && <span className="size-1.5 animate-pulse rounded-pill bg-brand" aria-hidden="true" />}
      {label}
    </span>
  )
}

export function LifecycleTracker({ phase }: { phase: V2Phase }) {
  const t = useT().x
  const steps = [
    { phase: 'GENESIS' as const, title: t.lifeGenesis, desc: t.lifeGenesisDesc },
    { phase: 'PENDING' as const, title: t.lifePending, desc: t.lifePendingDesc },
    { phase: 'TRADING' as const, title: t.lifeTrading, desc: t.lifeTradingDesc },
  ]
  const current = ORDER.indexOf(phase)

  return (
    <ol className="grid grid-cols-1 gap-5 sm:grid-cols-3" aria-label={t.lifeLabel}>
      {steps.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={s.phase} className="flex items-start gap-3" aria-current={active ? 'step' : undefined}>
            <span
              className={`flex size-9 shrink-0 items-center justify-center rounded-pill border font-mono text-readout ${
                active
                  ? 'border-brand bg-brand text-bg-base'
                  : done
                    ? 'border-brand/60 text-brand'
                    : 'border-border-subtle text-text-tertiary'
              }`}
            >
              {done ? <Check className="size-4" aria-hidden="true" /> : i + 1}
            </span>
            <div className="flex flex-col gap-0.5">
              <span className={`flex items-center gap-2 font-bold ${active ? 'text-text-primary' : 'text-text-tertiary'}`}>
                {s.title}
                {active && <span className="text-note font-normal text-brand">{t.lifeNow}</span>}
                {done && <span className="sr-only">{t.lifeDone}</span>}
              </span>
              <span className="text-pretty text-note text-text-tertiary">{s.desc}</span>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
