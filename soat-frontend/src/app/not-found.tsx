import Link from 'next/link'

/*
 * not-found.tsx — 404 page for unmatched routes
 * ───────────────────────────────────────────────────────────────────────────
 *  Replaces Next.js's default un-styled 404 with a cryptographic-console
 *  variant so a wrong URL still feels like part of the protocol UI rather
 *  than a framework default.
 *
 *  Server-rendered (no `'use client'`) — the page is fully static, no
 *  client-side state needed.
 */

export const metadata = {
  title: 'TOSH // 404 // NO_SUCH_ROUTE',
}

export default function NotFound() {
  return (
    <section
      className="mx-auto flex min-h-[60vh] max-w-3xl flex-col items-stretch
                 justify-center gap-6 px-6 py-12 font-mono text-text-primary"
    >
      <header className="flex flex-col gap-2 border-b border-border-subtle pb-4">
        <span className="text-note uppercase tracking-[0.4em] text-brand">
          {'// ROUTE // 404 · UNMAPPED_PATH'}
        </span>
        <h1 className="text-3xl font-light tracking-wide text-text-primary">
          That endpoint is not on the registry.
        </h1>
        <p className="text-sm text-text-secondary">
          You either followed a stale link or mistyped a path.  The protocol
          surfaces only the routes shipped in the current build — nothing
          dynamic gets resolved client-side, so this is a hard miss.
        </p>
      </header>

      <nav
        aria-label="Common destinations"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <Link
          href="/"
          className="border border-border-strong bg-bg-base px-4 py-4 text-body
                     uppercase tracking-[0.3em] text-text-secondary
                     hover:border-border-strong hover:text-text-primary
                     focus:outline-none focus:ring-2 focus:ring-border-strong
                     focus:ring-offset-2 focus:ring-offset-black
                     transition-colors"
        >
          → CONSOLE_HOME
        </Link>
        <Link
          href="/projects"
          className="border border-border-strong bg-bg-base px-4 py-4 text-body
                     uppercase tracking-[0.3em] text-text-secondary
                     hover:border-border-strong hover:text-text-primary
                     focus:outline-none focus:ring-2 focus:ring-border-strong
                     focus:ring-offset-2 focus:ring-offset-black
                     transition-colors"
        >
          → PROJECTS_RADAR
        </Link>
        <Link
          href="/launch"
          className="border border-border-strong bg-bg-base px-4 py-4 text-body
                     uppercase tracking-[0.3em] text-text-secondary
                     hover:border-border-strong hover:text-text-primary
                     focus:outline-none focus:ring-2 focus:ring-border-strong
                     focus:ring-offset-2 focus:ring-offset-black
                     transition-colors"
        >
          → LAUNCH_TERMINAL
        </Link>
        <Link
          href="/admin"
          className="border border-border-strong bg-bg-base px-4 py-4 text-body
                     uppercase tracking-[0.3em] text-text-secondary
                     hover:border-border-strong hover:text-text-primary
                     focus:outline-none focus:ring-2 focus:ring-border-strong
                     focus:ring-offset-2 focus:ring-offset-black
                     transition-colors"
        >
          → ADMIN_PANEL
        </Link>
      </nav>

      <p className="text-label uppercase tracking-[0.25em] text-text-quiet">
        {'// PROTOCOL_STATE_IS_FINE · ONLY_THIS_URL_IS_NOT_REGISTERED'}
      </p>
    </section>
  )
}
