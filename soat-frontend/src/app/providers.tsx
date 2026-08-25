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
// metaMask() from wagmi/connectors does not implement getChainId in all
// wagmi v2 patch versions and causes "getChainId is not a function" errors.
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
        {/* Global toaster — square corners, hairline border, monospace,
            phase-tinted via the `success` / `error` / default duration
            paths.  Mounted once at the root so any client component can
            `import { toast } from 'react-hot-toast'` and emit.
            Tx callers SHOULD prefer toast.promise(writeContractAsync, ...)
            so the same toast updates through pending → confirmed → minted. */}
        <Toaster
          position="bottom-right"
          gutter={8}
          toastOptions={{
            duration: 4500,
            // Square box, hairline frame, JetBrains Mono — matches the rest
            // of the cyber-minimal chrome so the toaster doesn't visually
            // collide with the page when it slides in.
            style: {
              background:    '#000000',
              color:         '#FFFFFF',
              border:        '1px solid #1F1F2E',
              borderRadius:  '12px',
              fontFamily:    'var(--font-jbm, ui-monospace, monospace)',
              fontSize:      '12px',
              letterSpacing: '0.04em',
              boxShadow:     'none',
              padding:       '12px 14px',
              maxWidth:      '380px',
            },
            success: {
              iconTheme: { primary: '#00FFA3', secondary: '#000000' },
              style:     { border: '1px solid #003A27' },
            },
            error: {
              iconTheme: { primary: '#FF3355', secondary: '#000000' },
              style:     { border: '1px solid #3D0A14' },
            },
            loading: {
              iconTheme: { primary: '#FFFFFF', secondary: '#000000' },
            },
          }}
        />
      </QueryClientProvider>
    </WagmiProvider>
  )
}
