'use client'

import dynamic from 'next/dynamic'

// ssr: false — NetworkGuard reads wagmi chainId + isConnected which are only
// available on the client. A null SSR render is already fine, but using dynamic
// makes it explicit and removes any residual hydration comparison risk.
const NetworkGuardInner = dynamic(
  () => import('./NetworkGuard').then(m => ({ default: m.NetworkGuard })),
  { ssr: false },
)

export function NetworkGuardClient() {
  return <NetworkGuardInner />
}
