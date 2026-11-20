'use client'

import type { HTMLAttributes } from 'react'

/** Shared labelled input used by bid book and reward-contest forms. */
export function Field({ label, value, onChange, inputMode = 'decimal' }: {
  label: string
  value: string
  onChange: (v: string) => void
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode']
}) {
  return (
    <label className="flex flex-col gap-1.5 text-note text-text-tertiary">
      {label}
      <input
        inputMode={inputMode}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-11 w-full rounded-input border border-border-subtle bg-bg-subtle px-3 font-mono text-text-primary outline-none focus:border-brand"
      />
    </label>
  )
}
