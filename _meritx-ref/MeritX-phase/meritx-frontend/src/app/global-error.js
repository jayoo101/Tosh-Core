'use client';

import { useEffect } from 'react';

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    console.error('[MeritX] Fatal root layout error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#050505', color: '#e4e4e7', fontFamily: 'ui-monospace, monospace' }}>
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', textAlign: 'center' }}>
          <div style={{ width: 80, height: 80, borderRadius: 16, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 32, boxShadow: '0 0 40px rgba(239,68,68,0.15)' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>

          <p style={{ color: 'rgba(239,68,68,0.8)', fontSize: 10, fontWeight: 700, letterSpacing: '0.3em', textTransform: 'uppercase', marginBottom: 12 }}>
            /// CRITICAL SYSTEM FAILURE
          </p>
          <h1 style={{ fontSize: 28, fontWeight: 900, color: '#fff', letterSpacing: '-0.02em', marginBottom: 12 }}>
            Application Error
          </h1>
          <p style={{ fontSize: 14, color: '#71717a', maxWidth: 400, lineHeight: 1.6, marginBottom: 8 }}>
            A critical error occurred in the application shell. Your funds and on-chain state are unaffected.
          </p>
          <p style={{ fontSize: 11, color: '#3f3f46', maxWidth: 360, wordBreak: 'break-all', marginBottom: 32 }}>
            {error?.message?.slice(0, 120) || 'Unknown error'}
          </p>

          <button
            onClick={reset}
            style={{ padding: '12px 32px', borderRadius: 12, fontSize: 13, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#fff', background: 'linear-gradient(to right, #dc2626, #ef4444)', border: 'none', cursor: 'pointer', boxShadow: '0 4px 20px rgba(220,38,38,0.2)' }}
          >
            Reload Application
          </button>

          <p style={{ fontSize: 9, color: '#3f3f46', marginTop: 24, letterSpacing: '0.1em' }}>
            If this persists, clear browser cache and reconnect your wallet.
          </p>
        </div>
      </body>
    </html>
  );
}
