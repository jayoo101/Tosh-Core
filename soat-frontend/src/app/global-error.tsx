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
 *   • No imports beyond `react` + the props Next gives us.
 *
 *  If a user sees this page, the deployment shipped a critical bug.  The
 *  page is intentionally austere — black background, white text, one
 *  reset button — to communicate "system error, not normal state".
 */

import { useEffect } from 'react'

interface GlobalErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[Tosh global error boundary]', error)
    }
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          backgroundColor: '#000',
          color: '#fff',
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
            border: '1px solid #1f1f2e',
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
              color: '#00FFA3',
            }}
          >
            {'// SYSTEM // ROOT_FAULT'}
          </div>

          <h1 style={{ margin: 0, fontSize: '26px', fontWeight: 300 }}>
            Console offline.
          </h1>

          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.6, color: '#a1a1aa' }}>
            The top-level UI threw before the application chrome could load.
            Your wallet, balance, and any on-chain positions are unaffected —
            this is purely a frontend crash.
          </p>

          {error.digest && (
            <div
              style={{
                border: '1px solid #1f1f2e',
                padding: '12px',
                fontSize: '11px',
                color: '#a1a1aa',
                wordBreak: 'break-all',
              }}
            >
              <div style={{ color: '#52525b', marginBottom: '4px' }}>{'// DIGEST'}</div>
              <div style={{ color: '#e4e4e7' }}>{error.digest}</div>
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
              color: '#00FFA3',
              border: '1px solid #00FFA3',
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
