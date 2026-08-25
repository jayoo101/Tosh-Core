'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig, http, fallback } from 'wagmi'
import { foundry } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import type { ToasterProps } from 'react-hot-toast'
import { targetChain, FOUNDRY_CHAIN_ID } from '@/lib/chain'

// ssr: false — react-hot-toast maintains an internal toast store; the SSR
// snapshot of that store never matches the hydration snapshot, producing a
// DOM structure difference that triggers removeChild on every page load.
// Rendering only on the client sidesteps the mismatch entirely.
const Toaster = dynamic<ToasterProps>(
  () => import('react-hot-toast').then(m => ({ default: m.Toaster })),
  { ssr: false },
)

// ─── Multi-RPC fallback ─────────────────────────────────────────────────────
// Pre-mainnet item #24: a single hard-coded HTTP endpoint is a single point of
// failure.  In production, the public Base / Ethereum / Optimism endpoints
// commonly throttle or transiently 5xx.  `fallback()` cycles through a ranked
// list and demotes flapping endpoints with an exponential back-off; combined
// with a small `retryCount` per leg, this is the smallest-possible defence
// against transient RPC failures killing user write transactions mid-flow.
//
// Endpoint precedence:
//   1. Premium key from env (Alchemy / Infura / drpc / etc.) — fastest, only
//      present in production.  Read from public env so we don't ship secrets,
//      and treat absent / blank as "skip this leg".
//   2. Public official endpoint (Base, etc.) — last-resort, frequently
//      throttled but always reachable.
//
// `rank: true` lets wagmi probe latency + stability and prefer the snappier
// leg automatically.  `retryCount: 1` on each `http()` means transient 5xx
// triggers ONE quick retry before promoting to the next fallback leg.

function trimmedEnv(name: string): string | null {
  const v = process.env[name]
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

function buildTargetTransport() {
  const candidates: string[] = []
  const premium = trimmedEnv('NEXT_PUBLIC_RPC_URL') ?? trimmedEnv('NEXT_PUBLIC_BASE_SEPOLIA_RPC')
  if (premium) candidates.push(premium)
  const publicUrl =
    targetChain.id === 84532 ? 'https://sepolia.base.org'
    : targetChain.id === 8453 ? 'https://mainnet.base.org'
    : targetChain.id === 1 ? 'https://eth.llamarpc.com'
    : null
  if (publicUrl && !candidates.includes(publicUrl)) candidates.push(publicUrl)

  if (candidates.length === 0) {
    return http(undefined, { retryCount: 2, retryDelay: 250, timeout: 15_000 })
  }
  if (candidates.length === 1) {
    return http(candidates[0], { retryCount: 2, retryDelay: 250, timeout: 15_000 })
  }
  return fallback(
    candidates.map((url) =>
      http(url, { retryCount: 1, retryDelay: 200, timeout: 12_000 }),
    ),
    { rank: true },
  )
}

function buildFoundryTransport() {
  const url = trimmedEnv('NEXT_PUBLIC_FOUNDRY_RPC') ?? 'http://127.0.0.1:8545'
  // Local-only — keep it simple, no fallback leg.
  return http(url, { retryCount: 0, timeout: 6_000 })
}

// Use injected() only — it handles MetaMask, Coinbase Wallet, Rabby, etc.
// This is also what `useActionGate` reaches for when it renders the
// Connect Wallet verdict: it takes `connectors[0]`, so the order of this
// array is the connect UX.
function makeConfig() {
  const chains = targetChain.id === FOUNDRY_CHAIN_ID
    ? [foundry] as const
    : [targetChain, foundry] as const
  return createConfig({
    chains,
    connectors: [
      injected({ shimDisconnect: true }),
    ],
    transports: {
      [targetChain.id]: buildTargetTransport(),
      [foundry.id]:     buildFoundryTransport(),
    },
  })
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [config]      = useState(makeConfig)
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {children}
        {/* THE toaster.  Mounted here rather than in layout.tsx for two
            reasons: layout.tsx is a server component, so hosting it there
            would need a second client boundary purely to carry this; and the
            `ssr: false` dynamic wrapper above exists for a real hydration bug
            (react-hot-toast's internal store never matches between the SSR
            snapshot and the client one, producing a removeChild on load), so
            the mount point has to live inside a client tree anyway.

            Every value below reads a design token from globals.css.  Nothing
            in the app should mount a second <Toaster/>, and nothing should
            call react-hot-toast directly — go through `toshToast` /
            `useTxAction` in @/components/ui so the copy and the lifecycle
            stay consistent. */}
        <Toaster
          position="bottom-right"
          gutter={8}
          toastOptions={{
            duration: 4500,
            style: {
              background:    'var(--tosh-surface-elevated)',
              color:         'var(--tosh-text-primary)',
              border:        '1px solid var(--tosh-border-subtle)',
              borderRadius:  'var(--radius-card, 0.875rem)',
              fontFamily:    'var(--font-jbm, ui-monospace, monospace)',
              fontSize:      '12px',
              lineHeight:    '1.5',
              letterSpacing: '0.02em',
              boxShadow:     '0 24px 64px -12px rgb(0 0 0 / 0.9)',
              padding:       '12px 14px',
              maxWidth:      '380px',
            },
            success: {
              iconTheme: { primary: 'var(--tosh-success)', secondary: 'var(--tosh-bg-base)' },
              style:     { border: '1px solid rgb(0 229 143 / 0.35)' },
            },
            error: {
              iconTheme: { primary: 'var(--tosh-danger)', secondary: 'var(--tosh-bg-base)' },
              style:     { border: '1px solid rgb(255 51 85 / 0.35)' },
            },
            loading: {
              iconTheme: { primary: 'var(--tosh-text-tertiary)', secondary: 'var(--tosh-bg-base)' },
            },
          }}
        />
      </QueryClientProvider>
    </WagmiProvider>
  )
}
