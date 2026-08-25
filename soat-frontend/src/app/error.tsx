'use client'

/*
 * error.tsx — per-route error boundary
 * ───────────────────────────────────────────────────────────────────────────
 *  Next.js renders this when a Client or Server component inside `app/`
 *  throws.  Without an error boundary, an uncaught exception nukes the
 *  whole route segment to a stack trace.  In production we render a
 *  cryptographic-console-styled fallback that:
 *
 *   • Confines the breakage to the failing segment (the navbar + chrome
 *     above us stay alive).
 *   • Surfaces a short, copy-pastable digest of the error so support can
 *     trace it from a screenshot — without leaking the full stack.
 *   • Exposes Next's `reset()` action as a primary CTA, so the user can
 *     retry without a full reload.
 *
 *  The component lives at the `app/` root so it catches errors from ALL
 *  routes that don't ship their own boundary.  Sub-routes can add their
 *  own `error.tsx` for finer-grained recovery (e.g. just retry the
 *  failed contract read instead of unmounting the whole page).
 */

import Link from 'next/link'
import { useEffect } from 'react'

interface ErrorBoundaryProps {
  /** The thrown value, normalized by Next.js to `Error` with a `.digest`. */
  error: Error & { digest?: string }
  /** Next-supplied callback that retries the failed segment. */
  reset: () => void
}

export default function GlobalRouteError({ error, reset }: ErrorBoundaryProps) {
  useEffect(() => {
    // Console-log in dev for fast triage; in production this gets surfaced
    // through Sentry / Defender once those are wired in (#26).
    if (process.env.NODE_ENV !== 'production') {
      console.error('[Tosh error boundary]', error)
    }
  }, [error])

  return (
    <section
      role="alert"
      aria-live="assertive"
      className="mx-auto flex min-h-[60vh] max-w-3xl flex-col items-stretch
                 justify-center gap-6 px-6 py-12 font-mono text-text-primary"
    >
      <header className="flex flex-col gap-2 border-b border-border-subtle pb-4">
        <span className="text-note uppercase tracking-[0.4em] text-brand">
          {'// RUNTIME // ANOMALY_DETECTED'}
        </span>
        <h1 className="text-2xl font-light tracking-wide text-text-primary">
          Something cracked.
        </h1>
        <p className="text-sm text-text-secondary">
          A client-side surface threw mid-render.  The protocol on-chain state
          is unaffected — your wallet, balance, and any open positions are
          fine.  We just need to reseat the UI.
        </p>
      </header>

      <dl className="grid grid-cols-[140px,1fr] gap-x-4 gap-y-2 border border-border-subtle p-4 text-xs">
        <dt className="text-text-tertiary">{'// SCOPE'}</dt>
        <dd>Route segment ({typeof window === 'undefined' ? 'server' : 'client'})</dd>

        <dt className="text-text-tertiary">{'// MESSAGE'}</dt>
        <dd className="break-all text-text-secondary">{error.message || 'unknown'}</dd>

        {error.digest && (
          <>
            <dt className="text-text-tertiary">{'// DIGEST'}</dt>
            <dd className="break-all text-text-secondary">{error.digest}</dd>
          </>
        )}
      </dl>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={reset}
          className="flex-1 border border-brand bg-bg-base px-4 py-3 text-body
                     uppercase tracking-[0.3em] text-brand
                     hover:bg-brand/10 focus:outline-none focus:ring-2
                     focus:ring-brand focus:ring-offset-2 focus:ring-offset-black
                     transition-colors"
        >
          ● RETRY_SEGMENT
        </button>
        <Link
          href="/"
          className="flex-1 border border-border-strong bg-bg-base px-4 py-3 text-center
                     text-body uppercase tracking-[0.3em] text-text-secondary
                     hover:border-border-strong hover:text-text-primary
                     focus:outline-none focus:ring-2 focus:ring-border-strong
                     focus:ring-offset-2 focus:ring-offset-black
                     transition-colors"
        >
          ↩ RETURN_HOME
        </Link>
      </div>

      <p className="text-label uppercase tracking-[0.25em] text-text-quiet">
        {'// If this persists, share the digest above with @tosh-support'}
      </p>
    </section>
  )
}
