'use client'

/**
 * Per-chain gas history after an unsigned PoG lookup.
 *
 * Shown automatically when a connected wallet's scan finishes, so the depositor
 * sees what the oracle read before (or instead of) registering quota on-chain.
 */

import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { Address } from 'viem'

import { fmt } from './format'
import type { PogChainSpend, PogScanResult } from './pogScanClient'
import { ActionButton, useActionGate } from '@/components/ui'

function shortAddr(a: Address): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function ChainRow({ c }: { c: PogChainSpend }) {
  const note = c.unavailable
    ? 'unavailable'
    : c.skipped
      ? 'skipped (cap reached)'
      : c.truncated
        ? 'lower bound'
        : null
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border-subtle py-2 last:border-0">
      <div className="min-w-0">
        <p className="font-mono text-label tracking-[0.2em] uppercase text-text-primary">
          {c.chain}
        </p>
        {note && (
          <p className="font-mono text-note text-text-tertiary">{note}</p>
        )}
      </div>
      <div className="shrink-0 text-right">
        <p className="font-mono text-note text-text-primary">
          {c.unavailable ? '—' : `${fmt(BigInt(c.gasWei))} ETH`}
        </p>
        {!c.unavailable && !c.skipped && (
          <p className="font-mono text-note text-text-tertiary">
            {c.sentTxs.toLocaleString()} tx
          </p>
        )}
      </div>
    </div>
  )
}

export function GasHistoryDialog({
  open,
  onClose,
  userAddress,
  scan,
  onActivate,
  activating,
}: {
  open: boolean
  onClose: () => void
  userAddress: Address
  scan: (PogScanResult & { totalGasWei: string; chains: PogChainSpend[] }) | null
  /** Register on-chain quota. Only offered when eligible and still unattested. */
  onActivate?: () => void
  activating?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const activateGate = useActionGate({
    action: activating ? 'Activating quota…' : 'Activate deposit quota',
    onAct: () => { onActivate?.() },
    requiresWallet: false,
    requiresNetwork: false,
    bypassAmbientGate: true,
    tx: { isBusy: Boolean(activating), isPending: Boolean(activating), isConfirming: false },
  })

  if (!open || !scan) return null

  const missing = scan.unavailableChains ?? []
  const eligible = Boolean(scan.eligible)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-base/80 px-6"
      role="dialog"
      aria-modal="true"
      aria-label="Gas history"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-md max-h-[85vh] flex-col gap-4 overflow-y-auto rounded-panel
                   border border-border-subtle bg-surface-elevated p-card-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-title text-text-primary">Gas history</h4>
            <p className="mt-0.5 font-mono text-note text-text-tertiary">
              {shortAddr(userAddress)}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-input
                       border border-border-subtle text-text-tertiary
                       transition-colors hover:border-brand/40 hover:text-brand"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>

        <p className="font-mono text-note leading-relaxed text-text-secondary">
          Lifetime gas spent sending transactions, read from public explorers.
          No wallet signature was required for this lookup.
        </p>

        <div>
          {scan.chains.map(c => (
            <ChainRow key={c.chainId} c={c} />
          ))}
        </div>

        <div className="flex flex-col gap-1 border-t border-border-subtle pt-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-label tracking-[0.2em] uppercase text-text-tertiary">
              Total
            </span>
            <span className="font-mono text-note text-text-primary">
              {fmt(BigInt(scan.totalGasWei))} ETH
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-label tracking-[0.2em] uppercase text-text-tertiary">
              Floor
            </span>
            <span className="font-mono text-note text-text-tertiary">
              {fmt(BigInt(scan.floorWei))} ETH
            </span>
          </div>
          {scan.maxAllocWei && eligible && (
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-label tracking-[0.2em] uppercase text-text-tertiary">
                Quota sized
              </span>
              <span className="font-mono text-note text-success">
                {fmt(BigInt(scan.maxAllocWei))} ETH
              </span>
            </div>
          )}
        </div>

        {missing.length > 0 && (
          <p className="font-mono text-note text-warning leading-relaxed">
            {missing.join(' and ')} could not be read, so this total may be a
            lower bound.
          </p>
        )}

        {eligible ? (
          onActivate ? (
            <div className="flex flex-col gap-2">
              <p className="font-mono text-note text-text-secondary leading-relaxed">
                Eligible. Activating writes the quota on-chain (one signature and
                one transaction). After that, Deposit works with no further gas check.
              </p>
              <ActionButton gate={activateGate} size="lg" />
            </div>
          ) : (
            <p className="font-mono text-note text-success leading-relaxed">
              Eligible — deposit quota is already on file for this wallet.
            </p>
          )
        ) : (
          <p className="font-mono text-note text-warning leading-relaxed">
            Below the floor — {fmt(BigInt(scan.totalGasWei))} ETH of historical
            gas against a floor of {fmt(BigInt(scan.floorWei))} ETH. Deposits stay
            locked for this wallet until that changes.
          </p>
        )}
      </div>
    </div>
  )
}
