'use client'

import { ActionButton, type ActionGate } from '@/components/ui'
import { useT } from '@/i18n'

/**
 * `ActionButton`, except with no wallet connected it is a one-line link, not a
 * full-width "Connect wallet" button. The header already has that button, and
 * most buyers hold their Agent ID in an Agentic Wallet that cannot connect, so
 * on the project page Agent mode is the primary path and this is the aside.
 */
export function WalletAction({ gate }: { gate: ActionGate }) {
  const t = useT().x
  if (gate.verdict.kind !== 'connect') return <ActionButton gate={gate} />
  const { act, disabled } = gate.verdict
  return (
    <button
      type="button"
      onClick={act ?? undefined}
      disabled={disabled || !act}
      className="w-fit text-note text-text-tertiary underline-offset-4 transition-colors hover:text-brand hover:underline disabled:opacity-50"
    >
      {t.connectHint}
    </button>
  )
}
