'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig, http, fallback } from 'wagmi'
import { foundry } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import type { ToasterProps } from 'react-hot-toast'
import { targetChain, ROBINHOOD_ID, ROBINHOOD_TESTNET_ID, FOUNDRY_CHAIN_ID } from '@/lib/chain'

// ssr: false — react-hot-toast maintains an internal toast store; the SSR
// snapshot of that store never matches the hydration snapshot, producing a
// DOM structure difference that triggers removeChild on every page load.
// Rendering only on the client sidesteps the mismatch entirely.
const Toaster = dynamic<ToasterProps>(
  () => import('react-hot-toast').then(m => ({ default: m.Toaster })),
  { ssr: false },
)

// ─── Multi-RPC fallback ─────────────────────────────────────────────────────
// Pre-mainnet item #24 (PM-F2 in `docs/PRE_MAINNET_CHECKLIST.md`): a single
// hard-coded HTTP endpoint is a single point of
// failure.  Robinhood Chain's public endpoint is rate-limited and carries no
// SLA, so it throttles and transiently 5xxs like any other.  `fallback()`
// cycles through a ranked
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

// Takes the VALUE, not the variable name.  `process.env[name]` looks
// equivalent and is not: Next.js inlines `NEXT_PUBLIC_*` by substituting the
// literal source text `process.env.NEXT_PUBLIC_FOO` at build time, so a
// computed member access is never a substitution target and `process.env` is
// an empty object in the browser.  This function used to take a name, which
// meant the premium-endpoint leg below was dead in every deployed build —
// silently, because the public endpoint that follows it does work.  The only
// symptom was throttling under load.  Spell the access out at the call site.
function trimmedEnv(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

function buildTargetTransport() {
  const candidates: string[] = []
  // A chain-named variable only means anything when that chain is the target.
  // Taking one unconditionally put a testnet endpoint in the candidate list of
  // a production build — and `rank: true` sorts by latency, not by correctness,
  // so a healthy wrong-chain leg could win the ranking and answer every
  // balance, allowance and quote read from the testnet.
  // `NEXT_PUBLIC_RPC_URL` names no chain and stays the universal override.
  const premium =
    trimmedEnv(process.env.NEXT_PUBLIC_RPC_URL) ??
    (targetChain.id === ROBINHOOD_ID
      ? trimmedEnv(process.env.NEXT_PUBLIC_ROBINHOOD_RPC)
      : targetChain.id === ROBINHOOD_TESTNET_ID
        ? trimmedEnv(process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC)
        : null)
  if (premium) candidates.push(premium)
  // Read off the chain definition instead of a parallel list of literals. The
  // literals were a second place for the endpoint to be wrong, and they had no
  // entry for the chain this build now targets.
  const publicUrl = targetChain.rpcUrls.default.http[0] ?? null
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
  const url = trimmedEnv(process.env.NEXT_PUBLIC_FOUNDRY_RPC) ?? 'http://127.0.0.1:8545'
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
            /* These two borders were the exception to the claim above: they
               restated `success` and `danger` as literals, so the v0 recolour
               moved both tokens and left the toast outlines on the old mint and
               the old red. `color-mix` is what lets a 35% tint reference the
               token instead of hard-coding a pre-multiplied copy of it, which
               is the only reason this is not two more `--tosh-*` entries. */
            success: {
              iconTheme: { primary: 'var(--tosh-success)', secondary: 'var(--tosh-bg-base)' },
              style:     { border: '1px solid color-mix(in srgb, var(--tosh-success) 35%, transparent)' },
            },
            error: {
              iconTheme: { primary: 'var(--tosh-danger)', secondary: 'var(--tosh-bg-base)' },
              style:     { border: '1px solid color-mix(in srgb, var(--tosh-danger) 35%, transparent)' },
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
