'use client'

import Link from 'next/link'

import { useT } from '@/i18n'
import { LAUNCHES_PAUSED } from '@/lib/launchGate'

/** The 404 page's content. See `app/not-found.tsx`. */
export function NotFoundBody() {
  const t = useT().chrome
  return (
    <section
      className="mx-auto flex min-h-[60vh] max-w-3xl flex-col items-stretch
                 justify-center gap-6 px-6 py-12 font-mono text-text-primary"
    >
      <header className="flex flex-col gap-2 border-b border-border-subtle pb-4">
        <span className="text-note uppercase tracking-[0.4em] text-brand">
          {t.notFoundEyebrow}
        </span>
        <h1 className="text-3xl font-light tracking-wide text-text-primary">
          {t.notFoundTitle}
        </h1>
        <p className="text-sm text-text-secondary">
          {t.notFoundBody}
        </p>
      </header>

      <nav
        aria-label={t.notFoundNav}
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
          → {t.notFoundHome}
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
          → {t.notFoundProjects}
        </Link>
        {!LAUNCHES_PAUSED && (
          <Link
            href="/launch"
            className="border border-border-strong bg-bg-base px-4 py-4 text-body
                       uppercase tracking-[0.3em] text-text-secondary
                       hover:border-border-strong hover:text-text-primary
                       focus:outline-none focus:ring-2 focus:ring-border-strong
                       focus:ring-offset-2 focus:ring-offset-black
                       transition-colors"
          >
            → {t.notFoundLaunch}
          </Link>
        )}
        <Link
          href="/admin"
          className="border border-border-strong bg-bg-base px-4 py-4 text-body
                     uppercase tracking-[0.3em] text-text-secondary
                     hover:border-border-strong hover:text-text-primary
                     focus:outline-none focus:ring-2 focus:ring-border-strong
                     focus:ring-offset-2 focus:ring-offset-black
                     transition-colors"
        >
          → {t.notFoundAdmin}
        </Link>
      </nav>

      <p className="text-label uppercase tracking-[0.25em] text-text-quiet">
        {t.notFoundFooter}
      </p>
    </section>
  )
}
