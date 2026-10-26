'use client'

import { useCallback, useSyncExternalStore } from 'react'
import type { Address } from 'viem'

import { useT } from '@/i18n'

const key = (hook: Address) => `toshx:v2:risk:${hook.toLowerCase()}`
const CHANGED = 'toshx:v2:risk-changed'

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGED, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGED, onChange)
  }
}

function read(hook: Address): boolean {
  try { return window.localStorage.getItem(key(hook)) === '1' } catch { return false }
}

/** Whether this browser has acknowledged the risk notice for `hook`, once per project. */
export function useRiskAck(hook: Address) {
  const acked = useSyncExternalStore(subscribe, () => read(hook), () => false)
  const setAcked = useCallback((v: boolean) => {
    try {
      if (v) window.localStorage.setItem(key(hook), '1')
      else window.localStorage.removeItem(key(hook))
    } catch { /* storage blocked: the box cannot stay ticked, so the action stays gated */ }
    window.dispatchEvent(new Event(CHANGED))
  }, [hook])
  return { acked, setAcked }
}

export function RiskAck({ acked, setAcked }: { acked: boolean; setAcked: (v: boolean) => void }) {
  const t = useT().v2
  return (
    <label className="flex cursor-pointer items-start gap-2 text-note text-text-secondary">
      <input
        type="checkbox"
        className="mt-0.5 accent-brand"
        checked={acked}
        onChange={e => setAcked(e.target.checked)}
      />
      <span>{t.riskAck}</span>
    </label>
  )
}
