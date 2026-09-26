'use client'

import Link from 'next/link'

import { useT } from '@/i18n'

/** `/launch` while `LAUNCHES_PAUSED` is set. See `lib/launchGate.ts`. */
export function LaunchesPaused() {
  const t = useT().launch
  return (
    <section
      className="mx-auto flex min-h-[60vh] max-w-3xl flex-col items-stretch
                 justify-center gap-6 px-6 py-12 font-mono text-text-primary"
    >
      <header className="flex flex-col gap-2 border-b border-border-subtle pb-4">
        <span className="text-note uppercase tracking-[0.4em] text-brand">
          {'// '}{t.pausedEyebrow}
        </span>
        <h1 className="text-3xl font-light tracking-wide text-text-primary">
          {t.pausedTitle}
        </h1>
        <p className="text-sm leading-relaxed text-text-secondary">
          {t.pausedBody}
        </p>
      </header>

      <Link
        href="/projects"
        className="border border-border-strong bg-bg-base px-4 py-4 text-body
                   uppercase tracking-[0.3em] text-text-secondary
                   hover:border-border-strong hover:text-text-primary
                   focus:outline-none focus:ring-2 focus:ring-border-strong
                   focus:ring-offset-2 focus:ring-offset-black
                   transition-colors"
      >
        → {t.pausedBrowse}
      </Link>
    </section>
  )
}
