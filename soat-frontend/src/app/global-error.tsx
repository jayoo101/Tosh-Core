'use client'

/*
 * global-error.tsx — last-resort error boundary
 * ───────────────────────────────────────────────────────────────────────────
 *  Next.js renders this when `app/error.tsx` itself throws, OR when the root
 *  layout throws.  At this point we cannot rely on any provider context
 *  (wagmi, toast, theme) — even the navbar may not have mounted — so this
 *  page MUST be 100% self-contained:
 *
 *   • Own `<html>` / `<body>` because there is no surrounding layout.
 *   • Inline styles instead of Tailwind utility classes — global CSS has
 *     not necessarily loaded.
 *   • No imports that reach for provider context (wagmi, toast, theme).
 *     `reportError` is the one exception: the Sentry client is initialised in
 *     `instrumentation-client.ts` before any application code, needs no
 *     context, and no-ops without a DSN.  A root-layout crash is precisely
 *     the failure nobody would otherwise hear about (#26).
 *
 *  If a user sees this page, the deployment shipped a critical bug.  The
 *  page is intentionally austere — one surface, one accent, one reset
 *  button — to communicate "system error, not normal state".
 *
 *  THE HEX LITERALS BELOW ARE COPIES OF TOKENS AND CANNOT READ THEM.
 *  `globals.css` may not have loaded, which is the whole reason this file
 *  uses inline styles, so `var(--tosh-brand)` would resolve to nothing and
 *  render an unstyled button. That makes this the one file a palette change
 *  has to be applied to by hand, and the one file `checkTokens.mjs` cannot
 *  catch when nobody does: it greps utility classes, and there are none here.
 *  Kept in step with the v0 recolour on 2026-09-11.
 */

import { useEffect } from 'react'

import { reportError } from '@/lib/observability'

interface GlobalErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[Tosh global error boundary]', error)
    }
    reportError(error, { surface: 'global-error-boundary', digest: error.digest })
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          backgroundColor: '#0B0811',
          color: '#F8F3F8',
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
        }}
      >
        <section
          role="alert"
          aria-live="assertive"
          style={{
            maxWidth: '560px',
            width: '100%',
            border: '1px solid #2D2534',
            padding: '32px',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
          }}
        >
          <div
            style={{
              fontSize: '11px',
              letterSpacing: '0.4em',
              textTransform: 'uppercase',
              color: '#F946A7',
            }}
          >
            {'// SYSTEM // ROOT_FAULT'}
          </div>

          <h1 style={{ margin: 0, fontSize: '26px', fontWeight: 300 }}>
            Console offline.
          </h1>

          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.6, color: '#9F93A6' }}>
            The top-level UI threw before the application chrome could load.
            Your wallet, balance, and any on-chain positions are unaffected —
            this is purely a frontend crash.
          </p>

          {error.digest && (
            <div
              style={{
                border: '1px solid #2D2534',
                padding: '12px',
                fontSize: '11px',
                color: '#9F93A6',
                wordBreak: 'break-all',
              }}
            >
              <div style={{ color: '#4C4455', marginBottom: '4px' }}>{'// DIGEST'}</div>
              <div style={{ color: '#F8F3F8' }}>{error.digest}</div>
            </div>
          )}

          <button
            type="button"
            onClick={reset}
            style={{
              all: 'unset',
              boxSizing: 'border-box',
              display: 'block',
              width: '100%',
              padding: '14px 16px',
              textAlign: 'center',
              fontSize: '12px',
              letterSpacing: '0.3em',
              textTransform: 'uppercase',
              color: '#F946A7',
              border: '1px solid #F946A7',
              cursor: 'pointer',
            }}
          >
            ● RELOAD_CONSOLE
          </button>
        </section>
      </body>
    </html>
  )
}
