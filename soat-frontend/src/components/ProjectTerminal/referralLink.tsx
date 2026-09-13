'use client'

/**
 * The referral link, and the box that shows it, in one place.
 *
 * Two surfaces render this now — the referral desk, and the dialog that opens
 * when a deposit confirms — and the link is not a trivial derivation: it prefers
 * the wallet's short code when one has been minted and falls back to the long
 * `?ref=<address>` form while that request is in flight, because both bind
 * identically and a link that is present and ugly beats a box that might become
 * a link. Copied into the dialog, that logic would have been free to drift from
 * the desk's, and the two would eventually hand out different links for the same
 * wallet.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'

import { buildReferralLink, buildShortReferralLink, useReferralCode } from '@/lib/useReferral'

/** The best link this wallet can share right now, or `''` if it has none. */
export function useReferralLink(userAddress: Address | undefined, symbol: string): string {
  const { code } = useReferralCode(userAddress)
  if (code) return buildShortReferralLink(code, symbol)
  return userAddress ? buildReferralLink(userAddress) : ''
}

/**
 * The link with a copy button, and no opinion about what surrounds it.
 *
 * `children` carries the caption, so each surface can say what the link is for
 * in its own words without this component holding a copy of either.
 */
export function ReferralLinkBox({
  link, label = 'YOUR REFERRAL LINK', children,
}: {
  link:   string
  label?: string
  children?: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    if (!link) return
    void navigator.clipboard?.writeText(link).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }, [link])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2_000)
    return () => clearTimeout(id)
  }, [copied])

  if (!link) return null

  return (
    <div className="flex flex-col gap-2 border border-border-subtle px-4 py-3">
      <span className="font-mono text-label text-text-tertiary">{label}</span>
      <p className="break-all font-mono text-note leading-relaxed text-text-secondary">{link}</p>
      <button
        type="button"
        onClick={copy}
        className="self-start border border-border-subtle px-3 py-1.5 text-label font-bold
                   uppercase tracking-[0.32em] text-text-tertiary
                   transition-colors duration-150 hover:border-brand hover:text-brand"
      >
        {copied ? 'copied' : 'copy'}
      </button>
      {children}
    </div>
  )
}
