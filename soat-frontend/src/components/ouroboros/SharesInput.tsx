'use client'

import { Minus, Plus } from 'lucide-react'

import { cn } from '@/components/ui'
import { NATIVE_SYMBOL } from '@/lib/chain'

const stepCls =
  'flex size-11 shrink-0 items-center justify-center text-text-secondary transition-colors hover:bg-surface-hover hover:text-brand disabled:cursor-not-allowed disabled:opacity-30'

const PRESETS = [1, 5, 10, 30] as const

export function SharesInput({ label, value, max, onChange }: {
  label: string
  value: number
  max: number
  onChange: (n: number) => void
}) {
  const top = Math.max(max, 1)
  const set = (n: number) => onChange(Math.min(Math.max(Math.floor(n) || 1, 1), top))
  return (
    <div className="flex flex-col gap-2">
      <span className="text-note text-text-tertiary">{label}</span>
      <div className="flex h-11 items-stretch overflow-hidden rounded-input border border-border-subtle bg-bg-subtle focus-within:border-brand">
        <button type="button" aria-label="-1" className={stepCls} onClick={() => set(value - 1)} disabled={value <= 1}>
          <Minus className="size-4" aria-hidden />
        </button>
        <input
          type="number" inputMode="numeric" min={1} max={top} value={value}
          onChange={e => set(Number(e.target.value))}
          className="w-14 min-w-0 flex-1 bg-transparent text-center font-mono text-lg font-bold text-text-primary outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <button type="button" aria-label="+1" className={stepCls} onClick={() => set(value + 1)} disabled={value >= top}>
          <Plus className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => set(top)}
          disabled={max === 0 || value >= top}
          className="border-l border-border-subtle px-4 font-mono text-label font-bold uppercase text-brand transition-colors hover:bg-brand/10 disabled:cursor-not-allowed disabled:text-text-quiet"
        >
          MAX
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map(p => {
          const disabled = max === 0 || p > top
          const active = value === p && !disabled
          return (
            <button
              key={p}
              type="button"
              disabled={disabled}
              onClick={() => set(p)}
              className={cn(
                'rounded-pill border px-2.5 py-0.5 font-mono text-micro transition-colors disabled:cursor-not-allowed disabled:opacity-35',
                active
                  ? 'border-brand bg-brand/15 font-bold text-brand'
                  : 'border-border-subtle text-text-tertiary hover:border-brand/50 hover:text-text-primary',
              )}
            >
              {p === 30 ? '30 MAX' : p}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** USDT or the native coin. */
export function PayToggle({ label, bnb, onChange }: { label: string; bnb: boolean; onChange: (bnb: boolean) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-note text-text-tertiary">{label}</span>
      <div className="flex h-11 overflow-hidden rounded-input border border-border-subtle">
        {(['USDT', NATIVE_SYMBOL] as const).map((name, i) => (
          <button
            key={name} type="button" onClick={() => onChange(i === 1)}
            className={cn('min-w-[4.5rem] px-4 font-mono text-note font-bold transition-colors',
              bnb === (i === 1) ? 'bg-brand text-bg-base' : 'text-text-secondary hover:bg-surface-hover')}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  )
}
