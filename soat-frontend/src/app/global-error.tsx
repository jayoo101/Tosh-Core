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
import { reloadOnceForStaleBuild } from '@/lib/staleBuild'

interface GlobalErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function GlobalError({ error }: GlobalErrorProps) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[Tosh global error boundary]', error)
    }
    reportError(error, { surface: 'global-error-boundary', digest: error.digest })
    reloadOnceForStaleBuild(error)
  }, [error])

  return (
    <html lang="en" translate="no">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          backgroundColor: '#0B0E11',
          color: '#EAECEF',
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
            border: '1px solid #2B3139',
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
              color: '#F0B90B',
            }}
          >
            {'// SYSTEM // ROOT_FAULT'}
          </div>

          <h1 style={{ margin: 0, fontSize: '26px', fontWeight: 300 }}>
            Console offline.
          </h1>

          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.6, color: '#B7BDC6' }}>
            The top-level UI threw before the application chrome could load.
            Your wallet, balance, and any on-chain positions are unaffected —
            this is purely a frontend crash.
          </p>

          {/* Without the message a screenshot of this page identifies nothing,
              and a crash only some browsers hit cannot be reproduced. */}
          <div
            style={{
              border: '1px solid #2B3139',
              padding: '12px',
              fontSize: '11px',
              color: '#B7BDC6',
              wordBreak: 'break-all',
              whiteSpace: 'pre-wrap',
            }}
          >
            <div style={{ color: '#5E6673', marginBottom: '4px' }}>{'// MESSAGE'}</div>
            <div id="tosh-root-fault" style={{ color: '#EAECEF' }}>
              {`${error.name}: ${error.message || 'unknown'}`}
              {error.stack ? `\n${error.stack.split('\n').slice(1, 4).join('\n')}` : ''}
            </div>
          </div>

          {error.digest && (
            <div
              style={{
                border: '1px solid #2B3139',
                padding: '12px',
                fontSize: '11px',
                color: '#B7BDC6',
                wordBreak: 'break-all',
              }}
            >
              <div style={{ color: '#5E6673', marginBottom: '4px' }}>{'// DIGEST'}</div>
              <div style={{ color: '#EAECEF' }}>{error.digest}</div>
            </div>
          )}

          {/* A full reload, not `reset()`: re-rendering the root layout in the
              same tab re-requests the same missing or broken chunks. */}
          <button
            type="button"
            onClick={() => window.location.reload()}
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
              color: '#F0B90B',
              border: '1px solid #F0B90B',
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
