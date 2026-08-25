'use client'

/**
 * Labelled text input.
 *
 * One job: label, control, and exactly one line of feedback underneath —
 * error if there is one, hint otherwise.
 *
 * NON-OBVIOUS CONSTRAINTS
 *   • `error` and `hint` never render together.  An error is the more urgent
 *     of the two and stacking them pushed the CTA below the fold on mobile.
 *   • `armed` is presentational only.  It draws the accent border when the
 *     input holds a value the gate has accepted — it does not gate anything
 *     itself.  Derive it from `useActionGate`'s verdict, never in parallel.
 *   • `multiline` is discriminated: `rows` is meaningless without it and the
 *     type says so.
 *
 * REPLACES: `Field` in ProjectTerminal.tsx (with its `suffix` slot), `Field`
 * and `TextAreaField` in admin/page.tsx, and `MeritXField` / `MeritXTextarea`
 * in launch/page.tsx.
 */

import { useId, type ReactNode } from 'react'
import { cn } from './cn'

type FieldShape =
  | { multiline?: false; rows?: never }
  | { multiline: true; rows?: number }

export type FieldProps = FieldShape & {
  label: ReactNode
  value: string
  onValueChange: (value: string) => void
  /** Quiet explanation under the control. Suppressed while `error` is set. */
  hint?: ReactNode
  /** Non-empty means invalid: red border, red message, `aria-invalid`. */
  error?: string | null
  /** Accent border — the value is valid and the action is ready to fire. */
  armed?: boolean
  /** Right-hand slot inside the control row. Use <FieldAffix/>. */
  affix?: ReactNode
  placeholder?: string
  disabled?: boolean
  readOnly?: boolean
  inputMode?: 'text' | 'numeric' | 'decimal'
  /** Force uppercase as the user types — tickers, symbols. */
  uppercase?: boolean
  name?: string
  /** Additive only — layout, not padding or colour. */
  className?: string
}

const CONTROL =
  'w-full rounded-input border bg-surface-elevated px-3 py-2.5 ' +
  'font-mono text-readout text-text-primary placeholder:text-text-quiet ' +
  'transition-colors ' +
  'disabled:cursor-not-allowed disabled:opacity-40 ' +
  'read-only:cursor-default'

export function Field({
  label,
  value,
  onValueChange,
  hint,
  error,
  armed = false,
  affix,
  placeholder,
  disabled = false,
  readOnly = false,
  inputMode = 'text',
  uppercase = false,
  multiline,
  rows = 4,
  name,
  className,
}: FieldProps) {
  const id = useId()
  const invalid = typeof error === 'string' && error.length > 0
  const describedBy = `${id}-msg`

  const border = invalid
    ? 'border-danger/60 focus:border-danger'
    : armed
      ? 'border-brand focus:border-brand'
      : 'border-border-subtle focus:border-brand'

  const handle = (next: string) => onValueChange(uppercase ? next.toUpperCase() : next)

  return (
    <div className={cn('flex flex-col gap-gap-tight', className)}>
      <label htmlFor={id} className="font-mono text-label text-text-tertiary">
        {label}
      </label>

      <div className="flex items-stretch gap-gap-tight">
        {multiline === true ? (
          <textarea
            id={id}
            name={name}
            rows={rows}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            readOnly={readOnly}
            spellCheck={false}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid || hint !== undefined ? describedBy : undefined}
            onChange={(e) => handle(e.target.value)}
            className={cn(CONTROL, border, 'resize-y')}
          />
        ) : (
          <input
            id={id}
            name={name}
            type="text"
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            readOnly={readOnly}
            inputMode={inputMode}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid || hint !== undefined ? describedBy : undefined}
            onChange={(e) => handle(e.target.value)}
            className={cn(CONTROL, border, 'flex-1')}
          />
        )}
        {affix}
      </div>

      {(invalid || hint !== undefined) && (
        <span
          id={describedBy}
          className={cn(
            'font-mono text-label tracking-[0.12em]',
            invalid ? 'text-danger' : 'text-text-quiet',
          )}
        >
          {invalid ? error : hint}
        </span>
      )}
    </div>
  )
}

/**
 * The `MAX` button that sits inside a Field's control row.
 *
 * Deliberately not a <Button>: it has to match the input's height exactly, and
 * a Button that could be told to be `lg` inside a `md` field is a bug waiting
 * to happen.
 */
export function FieldAffix({
  label = 'max',
  onClick,
  disabled = false,
  title,
}: {
  label?: ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'shrink-0 rounded-input border border-border-subtle px-3',
        'font-mono text-label uppercase text-text-tertiary',
        'transition-colors hover:border-brand hover:text-brand',
        'disabled:cursor-not-allowed disabled:opacity-40',
      )}
    >
      {label}
    </button>
  )
}
