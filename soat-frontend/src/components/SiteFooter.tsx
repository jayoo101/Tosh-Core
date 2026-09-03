import Link from 'next/link'

import { CHAIN_BYLINE } from '@/lib/contracts'

/**
 * The one footer, rendered by the root layout.
 *
 * It used to live inside the directory page, so `/launch`, `/projects/*` and
 * `/admin` simply ended mid-air. A server component, so the year is stamped on
 * the server and there is no client snapshot to disagree with.
 */
export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border-subtle/60">
      <div className="max-w-6xl mx-auto flex flex-col gap-gap px-4 py-card-lg md:flex-row md:items-center md:justify-between md:px-6">
        <div className="flex items-center gap-card">
          <span className="text-title text-text-primary tracking-tighter">
            Tosh<span className="text-brand"> Protocol</span>
          </span>
          <Link
            href="/launch"
            className="font-mono text-label text-text-tertiary hover:text-brand transition-colors"
          >
            Launch
          </Link>
          <a
            href="https://github.com/tosh-protocol"
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-label text-text-tertiary hover:text-brand transition-colors"
          >
            GitHub
          </a>
        </div>
        <span className="font-mono text-label text-text-quiet">
          © {new Date().getFullYear()} Tosh Protocol — {CHAIN_BYLINE}
        </span>
      </div>
    </footer>
  )
}
