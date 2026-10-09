import Link from 'next/link'

import { CHAIN_BYLINE } from '@/lib/contracts'
import { EN } from '@/i18n/dict/en'
import type { Dictionary } from '@/i18n'

/** Brand marks from Simple Icons (CC0). lucide-react dropped its brand icons. */
const BRAND_PATHS = {
  github: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  telegram: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
} as const

function BrandIcon({ name }: { name: keyof typeof BRAND_PATHS }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden className="shrink-0">
      <path d={BRAND_PATHS[name]} />
    </svg>
  )
}

const brandLinkCls =
  'inline-flex items-center gap-1.5 font-mono text-label text-text-tertiary hover:text-brand transition-colors'

/**
 * The one footer, rendered by the root layout.
 *
 * It used to live inside the directory page, so `/launch`, `/projects/*` and
 * `/admin` simply ended mid-air. A server component, so the year is stamped on
 * the server and there is no client snapshot to disagree with.
 *
 * Takes the dictionary as a prop because `useT()` is a client hook and this
 * renders on the server. The layout already holds the merged dictionary for the
 * request; English is the default so a caller that passes nothing gets what the
 * footer said before localisation.
 */
export function SiteFooter({ t = EN }: { t?: Dictionary }) {
  return (
    <footer className="mt-auto border-t border-border-subtle/60">
      <div className="max-w-7xl mx-auto flex flex-col gap-gap px-4 py-card-lg sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-card">
          <span className="text-title text-text-primary tracking-tighter">
            Tosh<span className="text-brand"> Protocol</span>
          </span>
          {/* The repository, not an organisation. This read
              `github.com/tosh-protocol` until 2026-09-12 — a plausible name for
              an org that has never existed, so the one link on the site that
              invites a reader to check the source for themselves answered 404.
              `checkFooterLinks.mjs` now resolves it. */}
          <a
            href="https://github.com/jayoo101/Tosh-Core"
            target="_blank"
            rel="noopener noreferrer"
            className={brandLinkCls}
          >
            <BrandIcon name="github" />
            GitHub
          </a>
          {/* Written in x.com's own canonical casing, which is what its oEmbed
              endpoint returns for this handle, so a reader who copies the link
              gets the same URL X would have given them. */}
        <a
          href="https://x.com/ToshProtocol"
          target="_blank"
          rel="noopener noreferrer"
          className={brandLinkCls}
        >
          <BrandIcon name="x" />
          X
        </a>
        <a
          href="https://t.me/toshxprotocol"
          target="_blank"
          rel="noopener noreferrer"
          className={brandLinkCls}
        >
          <BrandIcon name="telegram" />
          Telegram
        </a>
        {/* "Security", not "Audit", and the distinction is the point rather
            than modesty. A reader who sees "Audit" in a footer takes it to mean
            a firm reviewed this and put its name behind the result. What this
            links to is two static analysers with pinned baselines and a triage
            record — real work, and not that. Naming it the stronger thing on a
            site holding user quote would be claiming an assurance nobody has
            given. Rename it only alongside an actual audit to point it at. */}
        <a
          href="https://github.com/jayoo101/Tosh-Core/blob/main/docs/AUDIT.md"
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-label text-text-tertiary hover:text-brand transition-colors"
        >
          {t.site.footerSecurity}
        </a>
        <Link
          href="/apply"
          className="font-mono text-label text-text-tertiary hover:text-brand transition-colors"
        >
          {t.site.navApply}
        </Link>
        </div>
        <span className="font-mono text-label text-text-quiet">
          © {new Date().getFullYear()} Tosh Protocol — {CHAIN_BYLINE}
        </span>
      </div>
    </footer>
  )
}
