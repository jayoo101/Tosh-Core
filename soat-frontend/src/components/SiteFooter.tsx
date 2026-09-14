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
        </div>
        <span className="font-mono text-label text-text-quiet">
          © {new Date().getFullYear()} Tosh Protocol — {CHAIN_BYLINE}
        </span>
      </div>
    </footer>
  )
}
