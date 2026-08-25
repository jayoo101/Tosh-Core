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
                 justify-center gap-6 px-6 py-12 font-mono text-zinc-200"
    >
      <header className="flex flex-col gap-2 border-b border-zinc-800 pb-4">
        <span className="text-[11px] uppercase tracking-[0.4em] text-brand">
          {'// RUNTIME // ANOMALY_DETECTED'}
        </span>
        <h1 className="text-2xl font-light tracking-wide text-zinc-50">
          Something cracked.
        </h1>
        <p className="text-sm text-zinc-400">
          A client-side surface threw mid-render.  The protocol on-chain state
          is unaffected — your wallet, balance, and any open positions are
          fine.  We just need to reseat the UI.
        </p>
      </header>

      <dl className="grid grid-cols-[140px,1fr] gap-x-4 gap-y-2 border border-zinc-800 p-4 text-xs">
        <dt className="text-zinc-500">{'// SCOPE'}</dt>
        <dd>Route segment ({typeof window === 'undefined' ? 'server' : 'client'})</dd>

        <dt className="text-zinc-500">{'// MESSAGE'}</dt>
        <dd className="break-all text-zinc-300">{error.message || 'unknown'}</dd>

        {error.digest && (
          <>
            <dt className="text-zinc-500">{'// DIGEST'}</dt>
            <dd className="break-all text-zinc-300">{error.digest}</dd>
          </>
        )}
      </dl>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={reset}
          className="flex-1 border border-brand bg-black px-4 py-3 text-[12px]
                     uppercase tracking-[0.3em] text-brand
                     hover:bg-brand/10 focus:outline-none focus:ring-2
                     focus:ring-brand focus:ring-offset-2 focus:ring-offset-black
                     transition-colors"
        >
          ● RETRY_SEGMENT
        </button>
        <Link
          href="/"
          className="flex-1 border border-zinc-700 bg-black px-4 py-3 text-center
                     text-[12px] uppercase tracking-[0.3em] text-zinc-300
                     hover:border-zinc-400 hover:text-zinc-50
                     focus:outline-none focus:ring-2 focus:ring-zinc-400
                     focus:ring-offset-2 focus:ring-offset-black
                     transition-colors"
        >
          ↩ RETURN_HOME
        </Link>
      </div>

      <p className="text-[10px] uppercase tracking-[0.25em] text-zinc-600">
        {'// If this persists, share the digest above with @tosh-support'}
      </p>
    </section>
  )
}
