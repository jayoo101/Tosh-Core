'use client'

import { useCallback } from 'react'
import { useReadContract } from 'wagmi'
import { CheckCircle2, Fuel } from 'lucide-react'

import { FACTORY_ABI, FACTORY_ADDRESS, QUOTE_SYMBOL } from '@/lib/contracts'
import { useActionGate } from '@/components/ui'
import { usePogLookup } from '@/components/ProjectTerminal/PogLookupProvider'
import { fmtQuote } from '@/components/ProjectTerminal/format'
import { fill, useT } from '@/i18n'

/**
 * The homepage entry to the gas lookup, so a wallet can activate quota before
 * any raise is open. `registerPoG` is factory-wide and the quota it writes never
 * lapses, so activating here is the same act as activating on a project page.
 *
 * A scan spends the shared upstream budget, so it starts only on a click, never
 * on connect, and a wallet whose quota is already on file is shown the figure
 * instead of a button.
 */
export function QuotaCheckCta() {
  const t = useT().home
  const pog = usePogLookup()

  const { data: quota } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: 'pogQuota',
    args: pog.userAddress ? [pog.userAddress] : undefined,
    query: { enabled: Boolean(pog.userAddress) },
  })

  const { phase, setDialogOpen, startLookup } = pog
  const openLookup = useCallback(() => {
    setDialogOpen(true)
    if (phase === 'idle') void startLookup()
  }, [phase, setDialogOpen, startLookup])

  const gate = useActionGate({
    action: t.ctaQuota,
    onAct: openLookup,
    bypassAmbientGate: true,
  })

  if (gate.isConnected && typeof quota === 'bigint' && quota > 0n) {
    return (
      <span className="inline-flex min-h-11 items-center gap-2 rounded-input border border-success/40 bg-success/10 px-5 py-3 text-readout font-semibold text-success">
        <CheckCircle2 size={16} />
        {fill(t.quotaActive, { amount: fmtQuote(quota), quote: QUOTE_SYMBOL })}
      </span>
    )
  }

  const { verdict } = gate
  return (
    <button
      type="button"
      onClick={() => verdict.act?.()}
      disabled={verdict.disabled}
      className="inline-flex min-h-11 items-center gap-2 rounded-input border border-brand/40 bg-brand/10 px-5 py-3 text-readout font-semibold text-brand transition-colors hover:border-brand disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Fuel size={16} />
      {verdict.kind === 'switch' || verdict.kind === 'busy' ? verdict.label : t.ctaQuota}
    </button>
  )
}
