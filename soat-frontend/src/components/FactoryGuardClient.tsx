'use client'

import dynamic from 'next/dynamic'

// ssr: false — the probe is an `eth_getCode` against the live chain, which has
// no meaning during prerender and would make every static page wait on a
// network round trip. Mirrors NetworkGuardClient for the same reason.
const FactoryGuardInner = dynamic(
  () => import('./FactoryGuard').then(m => ({ default: m.FactoryGuard })),
  { ssr: false },
)

export function FactoryGuardClient() {
  return <FactoryGuardInner />
}
