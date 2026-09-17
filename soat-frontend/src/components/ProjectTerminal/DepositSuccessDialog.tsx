'use client'

/**
 * What to say in the one moment the referral programme is worth explaining.
 *
 * The referral desk has always been on this page, and it was reliably missed:
 * before a wallet has deposited, its 8% project leg is dark, its claim button
 * says "Nothing to claim", and it reads as a description of a programme rather
 * than an offer. A reader in that state has no reason to stop on it.
 *
 * A confirmed deposit is the state change that makes the same panel mean
 * something else. `canBindProjectReferral` requires the referrer to hold a
 * deposit in the project, so until this transaction landed the sharer's link
 * paid 2% and forfeited the 8% to the buyback reservoir — and now it pays both.
 * That is the fact this dialog exists to deliver, and it is only true from here
 * on.
 *
 * ── Why a dialog, when a dialog is the thing people close ────────────────────
 *
 * Because it is not the only copy. The referral desk stays on the page and says
 * the same thing permanently, so dismissing this costs nothing — which is
 * exactly the licence a modal needs. It is shown on a confirmed deposit and not
 * on a schedule of its own, and the factory's 24h per-hook cooldown means that
 * is at most once a day per project.
 */

import { useEffect } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import type { Address } from 'viem'

import { PROJECT_REFERRAL_BPS, LIFETIME_REFERRAL_BPS } from '@/lib/contracts'
import { NATIVE_SYMBOL } from '@/lib/chain'
import { fmt } from './format'
import { ReferralLinkBox, useReferralLink } from './referralLink'

const PROJECT_PCT = PROJECT_REFERRAL_BPS / 100
const LIFETIME_PCT = LIFETIME_REFERRAL_BPS / 100

export function DepositSuccessDialog({
  open, onClose, userAddress, symbol, deposited,
}: {
  open:        boolean
  onClose:     () => void
  userAddress: Address | undefined
  symbol:      string
  /** This wallet's total stake in the project, after the deposit that fired. */
  deposited:   bigint
}) {
  const link = useReferralLink(userAddress, symbol)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-base/80 px-6"
      role="dialog"
      aria-modal="true"
      aria-label="Deposit confirmed"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-md flex-col gap-4 rounded-panel border border-success/40
                   bg-surface-elevated p-card-lg shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-title text-text-primary">You are in ${symbol}</h4>
            <p className="mt-0.5 font-mono text-note text-success">
              {fmt(deposited)} {NATIVE_SYMBOL} staked in this genesis
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

        <p className="text-note leading-relaxed text-text-secondary">
          Your referral link just became worth more: the {PROJECT_PCT}% project
          commission only binds to a referrer who already holds a deposit here,
          and you now do. Share it and you earn {PROJECT_PCT}% of every genesis
          deposit made through it on {symbol}, plus {LIFETIME_PCT}% for life on
          any wallet whose first Tosh link was yours.
        </p>

        <ReferralLinkBox link={link} />

        <p className="text-label leading-relaxed tracking-wider text-text-quiet">
          {'// '}Commission accrues as deposits arrive and unlocks when the
          project launches. Claim it from the referral desk further down this
          page, or from{' '}
          <Link
            href="/referrals"
            onClick={onClose}
            className="text-text-tertiary underline decoration-dotted underline-offset-2 hover:text-brand"
          >
            your referral ledger
          </Link>
          {' '}for every project at once. Nothing expires.
        </p>
      </div>
    </div>
  )
}
