'use client'

/**
 * Project page chrome: identity + the action terminal.
 *
 * One column. The name, ticker and address sit in a single header; the
 * terminal below is the page. No manifesto, no status rail, no second card
 * wrapping the first.
 */

import Link from 'next/link'
import { AtSign, Globe, Send } from 'lucide-react'

import type { ProjectRow } from '@/app/lib/supabase'
import { testnetExplorerAddress } from '@/lib/contracts'
import ProjectTerminal from '@/components/ProjectTerminal'
import { ProjectLogo } from '@/components/ProjectLogo'

function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  const t = url.trim()
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function ProjectDetail({ project: p }: { project: ProjectRow }) {
  const tw = safeHref(p.twitter)
  const tg = safeHref(p.telegram)
  const web = safeHref(p.website)
  const desc = p.description?.trim()

  return (
    <div className="text-text-primary font-sans">
      <main className="max-w-3xl mx-auto py-6 px-4 md:px-6">
        <nav className="text-note font-mono text-text-tertiary flex items-center gap-2 mb-5">
          <Link href="/#directory" className="hover:text-brand transition-colors">Directory</Link>
          <span className="text-text-quiet">/</span>
          <span className="text-brand">{p.symbol}</span>
        </nav>

        <header className="flex items-start gap-4 mb-6 min-w-0">
          <ProjectLogo src={p.logo_url} name={p.name || p.symbol} className="w-14 h-14 rounded-2xl" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
              <h1 className="text-2xl font-bold tracking-tight text-text-primary truncate">
                {p.name}
              </h1>
              <span className="font-mono text-sm text-brand shrink-0">${p.symbol}</span>
            </div>
            {desc && (
              <p className="mt-1 text-sm text-text-secondary leading-relaxed line-clamp-2">
                {desc}
              </p>
            )}
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {p.token_address && (
                <a
                  href={testnetExplorerAddress(p.token_address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-label font-mono text-text-quiet hover:text-brand transition-colors"
                >
                  {shortAddr(p.token_address)}
                </a>
              )}
              {tw && (
                <a href={tw} target="_blank" rel="noopener noreferrer"
                   className="w-7 h-7 rounded-input border border-border-subtle flex items-center justify-center text-text-tertiary hover:text-brand hover:border-brand/40 transition-colors"
                   aria-label="X / Twitter">
                  <AtSign className="w-3.5 h-3.5" />
                </a>
              )}
              {tg && (
                <a href={tg} target="_blank" rel="noopener noreferrer"
                   className="w-7 h-7 rounded-input border border-border-subtle flex items-center justify-center text-text-tertiary hover:text-brand hover:border-brand/40 transition-colors"
                   aria-label="Telegram">
                  <Send className="w-3.5 h-3.5" />
                </a>
              )}
              {web && (
                <a href={web} target="_blank" rel="noopener noreferrer"
                   className="w-7 h-7 rounded-input border border-border-subtle flex items-center justify-center text-text-tertiary hover:text-brand hover:border-brand/40 transition-colors"
                   aria-label="Website">
                  <Globe className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          </div>
        </header>

        <ProjectTerminal project={p} />
      </main>
    </div>
  )
}
