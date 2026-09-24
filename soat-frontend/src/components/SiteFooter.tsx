import { CHAIN_BYLINE } from '@/lib/contracts'
import { EN } from '@/i18n/dict/en'
import type { Dictionary } from '@/i18n'

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
            className="font-mono text-label text-text-tertiary hover:text-brand transition-colors"
          >
            GitHub
          </a>
          {/* Written in x.com's own canonical casing, which is what its oEmbed
              endpoint returns for this handle, so a reader who copies the link
              gets the same URL X would have given them. */}
        <a
          href="https://x.com/ToshProtocol"
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-label text-text-tertiary hover:text-brand transition-colors"
        >
          X
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
        </div>
        <span className="font-mono text-label text-text-quiet">
          © {new Date().getFullYear()} Tosh Protocol — {CHAIN_BYLINE}
        </span>
      </div>
    </footer>
  )
}
