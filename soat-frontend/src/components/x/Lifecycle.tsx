'use client'

import { useT } from '@/i18n'

export type V2Phase = 'GENESIS' | 'PENDING' | 'TRADING'

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
