'use client'

/**
 * Truncated address or transaction hash, with an explorer link and copy.
 *
 * One job: render an on-chain identifier so it can be read, opened and copied
 * without the caller re-deriving the explorer URL.
 *
 * NON-OBVIOUS CONSTRAINT — `undefined` renders an em dash rather than nothing.
 * Half of these sit on the right-hand side of a <Readout>, and a value that
 * collapses to zero width while a read is in flight makes the whole row jump.
 *
 * REPLACES: `AddressLink` in admin/page.tsx (full address, no copy), the
 * `basescanTx(hash)` anchors in ProjectTerminal's `TxLine` and launch/page,
 * and `shortAddr()` in UserDrawer.tsx.
 */

import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { testnetExplorerAddress, testnetExplorerTx } from '@/lib/contracts'
import { EM_DASH, truncateHex, truncateTxHash } from './format'
import { cn } from './cn'
import { useT } from '@/i18n'

export type ExplorerKind = 'address' | 'tx'

export interface AddressLinkProps {
  value: string | undefined | null
  /** `address` links to /address/…, `tx` to /tx/…. Default `address`. */
  kind?: ExplorerKind
  /** `short` truncates, `full` prints the whole thing. Default `short`. */
  display?: 'short' | 'full'
  /** Copy-to-clipboard control. Default true. */
  copyable?: boolean
  /** Explorer anchor. Default true. */
  linked?: boolean
  /** Render this instead of the address itself (e.g. an ENS name). */
  label?: string
  /** Additive only — layout, not colour. */
  className?: string
}

export function AddressLink({
  value,
  kind = 'address',
  display = 'short',
  copyable = true,
  linked = true,
  label,
  className,
}: AddressLinkProps) {
  const [copied, setCopied] = useState(false)
  const t = useT().chrome

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1_800)
    return () => clearTimeout(id)
  }, [copied])

  const copy = useCallback(() => {
    if (!value) return
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }, [value])

  if (!value) return <span className={cn('font-mono text-text-quiet', className)}>{EM_DASH}</span>

  const text =
    label ??
    (display === 'full'
      ? value
      : kind === 'tx'
        ? truncateTxHash(value)
        : truncateHex(value))

  const href = kind === 'tx' ? testnetExplorerTx(value) : testnetExplorerAddress(value)

  return (
    <span className={cn('inline-flex items-center gap-gap-tight font-mono', className)}>
      {linked ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={value}
          className="inline-flex items-center gap-1 break-all underline decoration-dotted underline-offset-2 transition-colors hover:text-brand"
        >
          {text}
          <ExternalLink aria-hidden className="size-3 shrink-0 opacity-60" />
        </a>
      ) : (
        <span title={value} className="break-all">
          {text}
        </span>
      )}

      {copyable && (
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? t.copied : kind === 'tx' ? t.copyTx : t.copyAddress}
          title={copied ? t.copied : kind === 'tx' ? t.copyTx : t.copyAddress}
          className="shrink-0 text-text-quiet transition-colors hover:text-brand"
        >
          {copied ? (
            <Check aria-hidden className="size-3 text-brand" />
          ) : (
            <Copy aria-hidden className="size-3" />
          )}
        </button>
      )}
    </span>
  )
}
