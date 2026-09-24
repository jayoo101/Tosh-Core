'use client'

/**
 * Per-chain gas history after an unsigned PoG lookup.
 *
 * Opens as soon as a connected wallet's scan starts, so the depositor sees
 * progress (and then the figures) without having to be on a genesis project.
 */

import { useEffect } from 'react'
import { Loader2, X } from 'lucide-react'
import type { Address } from 'viem'

import { QUOTE_SYMBOL } from '@/lib/contracts'
import { fmt, fmtQuote } from './format'
import type { PogChainSpend, PogScanResult } from './pogScanClient'
import type { PogLookupPhase } from './usePogFlow'
import { ActionButton, useActionGate } from '@/components/ui'
import { formatGasScanChainList, formatMissingChainList, gasScanChainLabel } from '@/app/lib/gasScanCopy'
import { fill, useT } from '@/i18n'

function shortAddr(a: Address): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function ChainRow({ c }: { c: PogChainSpend }) {
  const t = useT().gas
  const note = c.unavailable
    ? t.noteUnavailable
    : c.skipped
      ? t.noteSkipped
      : c.truncated
        ? t.noteLowerBound
        : null
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border-subtle py-2 last:border-0">
      <div className="min-w-0">
        <p className="font-mono text-label tracking-[0.2em] uppercase text-text-primary">
          {gasScanChainLabel(c.chainId, c.chain)}
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
            {fill(t.txCount, { n: c.sentTxs.toLocaleString() })}
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
  phase,
  scan,
  error,
  onRetry,
  quotaKnown = true,
  onActivate,
  activating,
}: {
  open: boolean
  onClose: () => void
  userAddress: Address
  phase: PogLookupPhase
  scan: (PogScanResult & { totalGasWei: string; chains: PogChainSpend[] }) | null
  error: string | null
  onRetry?: () => void
  /** False while `factory.pogQuota` has not landed; hides the attested copy. */
  quotaKnown?: boolean
  /** Register on-chain quota. Only offered when eligible and still unattested. */
  onActivate?: () => void
  activating?: boolean
}) {
  const t = useT().gas

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /*
   * ⚠ `requiresWallet` AND `requiresNetwork` WERE BOTH OFF, AND THIS IS A
   *   WRITE. `onActivate` runs `registerQuota`, which ends in
   *   `send({ functionName: 'registerPoG' })`. `requiresNetwork` is documented
   *   as being "off for off-chain actions (a signed API call)"; this action
   *   makes such a call and then signs a transaction with the result.
   *
   *   Turning the gate off did not remove the check, only moved it past the
   *   click: `registerQuota` opens with `isSupportedPogChain(chainId)` and
   *   toasts `Unsupported chain (got 4663)` — a dead end naming a number, where
   *   the gate would have offered `Switch to …` and fixed it in one press. That
   *   is the same shape as the `useChainId` bug, one layer up: the thing built
   *   to catch a wrong chain before the click was disabled rather than wrong.
   *
   *   It also mattered on a chain the check ACCEPTS. In `next dev` against the
   *   testnet, `isSupportedPogChain(31337)` is true, so a wallet on Foundry got
   *   an attestation bound to 31337 while `send` pins the target — a signature
   *   the factory cannot accept, discovered at execution. With the gate on, a
   *   wallet that is not on the settlement chain is asked to switch and never
   *   reaches the signing path at all.
   */
  const activateGate = useActionGate({
    action: activating ? t.activating : t.activate,
    onAct: () => { onActivate?.() },
    bypassAmbientGate: true,
    tx: { isBusy: Boolean(activating), isPending: Boolean(activating), isConfirming: false },
  })

  if (!open) return null

  const scanning = phase === 'scanning' || phase === 'idle'
  const failed = phase === 'failed'
  const missing = scan?.unavailableChains ?? []
  const eligible = Boolean(scan?.eligible)

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-bg-base/80 px-6"
      role="dialog"
      aria-modal="true"
      aria-label={t.title}
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-md max-h-[85vh] flex-col gap-4 overflow-y-auto rounded-panel
                   border border-border-subtle bg-surface-elevated p-card-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-title text-text-primary">{t.title}</h4>
            <p className="mt-0.5 font-mono text-note text-text-tertiary">
              {shortAddr(userAddress)}
            </p>
          </div>
          <button
            type="button"
            aria-label={t.close}
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-input
                       border border-border-subtle text-text-tertiary
                       transition-colors hover:border-brand/40 hover:text-brand"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>

        {scanning && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 aria-hidden className="h-6 w-6 animate-spin text-brand" />
            <p className="font-mono text-note leading-relaxed text-text-secondary text-center">
              {fill(t.scanning, { chains: formatGasScanChainList(undefined, t) })}
            </p>
          </div>
        )}

        {failed && (
          <div className="flex flex-col gap-3">
            <p className="font-mono text-note leading-relaxed text-warning">
              {error ?? t.failed}
            </p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="self-start font-mono text-label tracking-[0.2em] uppercase
                           text-brand hover:underline"
              >
                {t.retry}
              </button>
            )}
          </div>
        )}

        {phase === 'ready' && scan && (
          <>
            <p className="font-mono text-note leading-relaxed text-text-secondary">
              {t.intro}
            </p>

            <div>
              {scan.chains.map(c => (
                <ChainRow key={c.chainId} c={c} />
              ))}
            </div>

            <div className="flex flex-col gap-1 border-t border-border-subtle pt-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-label tracking-[0.2em] uppercase text-text-tertiary">
                  {t.total}
                </span>
                <span className="font-mono text-note text-text-primary">
                  {fmt(BigInt(scan.totalGasWei))} ETH
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-label tracking-[0.2em] uppercase text-text-tertiary">
                  {t.floor}
                </span>
                <span className="font-mono text-note text-text-tertiary">
                  {fmt(BigInt(scan.floorWei))} ETH
                </span>
              </div>
              {/*
                * ⚠ THIS ROW CHANGES CURRENCY, and the two above it do not.
                *
                * Total and Floor are gas burned on ETH-settled chains, so they are
                * ETH and stay ETH. This row is what the wallet may then DEPOSIT,
                * which is the quote asset. That renders "1.16 BEM" directly beneath
                * "0.025 ETH", which looks like a bug and is not.
                *
                * IT ALSO CHANGES SCALE, which the previous version of this note did
                * not have to mention. The rows above are 18-decimal; this one is
                * 8-decimal, so it is formatted by `fmtQuote` and the two neighbours
                * by `fmt`. Swapping them does not fail — it prints a number 10^10
                * out, in a place where small numbers are entirely plausible.
                *
                * The note below the block exists so a user does not read the unit
                * change as an error. Do not "fix" this by unifying the symbols: the
                * rate is quote-per-ETH, and making both sides agree would either
                * overstate eligibility or misname the deposit.
                */}
              {scan.maxAllocWei && eligible && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-label tracking-[0.2em] uppercase text-text-tertiary">
                    {t.quotaSized}
                  </span>
                  <span className="font-mono text-note text-success">
                    {fmtQuote(BigInt(scan.maxAllocWei))} {QUOTE_SYMBOL}
                  </span>
                </div>
              )}
            </div>

            {/* UNCONDITIONAL NOW, where it used to be `NATIVE_SYMBOL !== 'ETH'`.
                That guard was a way of saying "only explain the two units when they
                differ", and it was correct on a chain whose own coin was ETH: gas
                and quota were then the same thing and the sentence would have been
                noise. The quota is an ERC-20 the chain has no opinion about, so the
                two units differ on every chain and the explanation always applies.
                Leaving the guard would have hidden it on exactly one chain —
                Ethereum mainnet — which is the one where a reader is most likely to
                assume a number labelled with a ticker is native. */}
            {scan.maxAllocWei && eligible && (
              <p className="font-mono text-note text-text-tertiary leading-relaxed">
                {/* "ETH-settled" rather than "that is what you burned", which is what
                    this said. Both are true, but `checkChainCopy.mjs` allows a
                    hard-coded ticker only where the surrounding SOURCE names a gas
                    figure, and the marker it had been reading here was the
                    `NATIVE_SYMBOL` in the condition above — which this change
                    removed. Rewording to name the reason is the honest fix; adding
                    `QUOTE_SYMBOL` to the guard's marker list would have let every
                    label on the site claim the gas exception. */}
                {fill(t.unitsNote, { quote: QUOTE_SYMBOL })}
              </p>
            )}

            {missing.length > 0 && (
              <p className="font-mono text-note text-warning leading-relaxed">
                {fill(t.missing, { chains: formatMissingChainList(missing, t) })}
              </p>
            )}

            {eligible ? (
              onActivate ? (
                <div className="flex flex-col gap-2">
                  <p className="font-mono text-note text-text-secondary leading-relaxed">
                    {t.activateBody}
                  </p>
                  <ActionButton gate={activateGate} size="lg" />
                </div>
              ) : quotaKnown ? (
                <p className="font-mono text-note text-success leading-relaxed">
                  {t.onFile}
                </p>
              ) : null
            ) : (
              <p className="font-mono text-note text-warning leading-relaxed">
                {fill(t.belowFloor, { total: fmt(BigInt(scan.totalGasWei)), floor: fmt(BigInt(scan.floorWei)) })}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
