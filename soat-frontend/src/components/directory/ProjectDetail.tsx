'use client'

/**
 * Project page shell: back link, identity header, About section. The v2
 * terminal owns the grid below and passes its own aside into the header.
 */

import Link from 'next/link'
import { ArrowLeft, AtSign, Globe, Send } from 'lucide-react'

import type { ProjectRow } from '@/app/lib/supabase'
import { ProjectLogo } from '@/components/ProjectLogo'
import { AddressLink } from '@/components/ui'
import { useT } from '@/i18n'
import { V2Terminal } from '@/components/v2/V2Terminal'
import { useIsV2Hook } from '@/lib/v2/useV2'
import type { ReactNode } from 'react'
import type { Address } from 'viem'

function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  const t = url.trim()
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

const SOCIAL_CLS =
  'flex h-7 w-7 items-center justify-center rounded-input border border-border-subtle ' +
  'text-text-tertiary transition-colors hover:border-brand/40 hover:text-brand'

/** The v2 terminal once BidBook confirms a v2 factory registered the hook. */
function Terminal({ project: p, header }: {
  project: ProjectRow
  header: (aside?: ReactNode) => ReactNode
}) {
  const isV2 = useIsV2Hook(p.hook_address as Address | undefined)
  const t = useT().project
  if (isV2 === undefined) return null
  if (!isV2) {
    return (
      <>
        {header()}
        <p className="mt-6 rounded-panel border border-border-subtle bg-surface-card p-6 text-body text-text-secondary">
          {t.legacyRetired}
        </p>
      </>
    )
  }
  return <V2Terminal hook={p.hook_address as Address} symbol={p.symbol} header={header} />
}

export function ProjectDetail({ project: p }: { project: ProjectRow }) {
  const t = useT().project
  const tw = safeHref(p.twitter)
  const tg = safeHref(p.telegram)
  const web = safeHref(p.website)

  const header = (aside?: ReactNode) => (
    <>
      <Link
        href="/launchpad"
        className="inline-flex items-center gap-1.5 text-note text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
        {t.backToAll}
      </Link>

      <div className="mt-5 flex flex-col gap-5 border-b border-border-subtle pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <ProjectLogo src={p.logo_url} name={p.name || p.symbol} className="h-16 w-16" />

          <div className="min-w-0">
            <h1 className="font-mono text-section font-bold tracking-tight text-text-primary sm:text-hero">
              ${p.symbol}
            </h1>
            <p className="mt-0.5 text-readout text-text-secondary">{p.name}</p>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-note text-text-secondary">
              {p.token_address && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-text-quiet">{t.tokenLabel}</span>
                  <AddressLink value={p.token_address} className="text-note text-text-primary" />
                </span>
              )}
              {tw && (
                <a href={tw} target="_blank" rel="noopener noreferrer"
                   className={SOCIAL_CLS} aria-label={t.socialX}>
                  <AtSign aria-hidden className="h-3.5 w-3.5" />
                </a>
              )}
              {tg && (
                <a href={tg} target="_blank" rel="noopener noreferrer"
                   className={SOCIAL_CLS} aria-label={t.socialTg}>
                  <Send aria-hidden className="h-3.5 w-3.5" />
                </a>
              )}
              {web && (
                <a href={web} target="_blank" rel="noopener noreferrer"
                   className={SOCIAL_CLS} aria-label={t.socialWeb}>
                  <Globe aria-hidden className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          </div>
        </div>

        {aside}
      </div>
    </>
  )

  return (
    <div className="font-sans text-text-primary">
      <main className="mx-auto max-w-[1440px] px-4 py-8 sm:px-6">
        <Terminal project={p} header={header} />
      </main>
    </div>
  )
}
