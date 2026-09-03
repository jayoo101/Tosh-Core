'use client'

import { useBytecode } from 'wagmi'
import {
  FACTORY_ADDRESS,
  TARGET_CHAIN_ID,
  ACTIVE_CHAIN_LABEL,
  testnetExplorerAddress,
} from '@/lib/contracts'
import { useIsHydrated } from '@/components/ui'

/**
 * Misconfigured-factory strip — the configured address holds no contract.
 *
 * `contracts.ts` can only check the SHAPE of `NEXT_PUBLIC_FACTORY_ADDRESS`, and
 * shape is not the property that matters. A syntactically perfect address for a
 * factory that was never deployed here fails in the most expensive way
 * available: silently.
 *
 * Every read returns `0x` because nothing answers, viem decodes that to
 * `undefined`, react-query records a successful query with no data, and each
 * panel renders its empty state. The result is an admin console that looks
 * completely healthy and reports an em dash for every value on the page — no
 * error boundary, no console output, no failed request. Reaching the actual
 * cause means reading RPC calldata to notice the `to:` address is one nobody
 * configured.
 *
 * The shape check cannot be tightened to cover it either. The placeholder that
 * caused this, `0x11…11`, is deliberately set by
 * `.github/workflows/frontend.yml` and `scripts/runTsGuard.mjs` so a checkout
 * with no deployment can still build, so rejecting it at import time would
 * break CI. Presence of code is the honest test, it is one `eth_getCode`, and
 * it is only answerable at runtime against a live chain — which is exactly why
 * it belongs here rather than in a build-time guard.
 *
 * Deliberately not a hard block. The public pages degrade into empty states
 * that are indistinguishable from a quiet chain, and someone reading a project
 * page has no ability to fix the deployment anyway; the cost of being wrong is
 * a visible strip, while the cost of staying silent is the debugging session
 * above.
 */
export function FactoryGuard() {
  const hydrated = useIsHydrated()

  const { data: bytecode, isLoading, isError } = useBytecode({
    address: FACTORY_ADDRESS,
    query: {
      // An address either holds code or it does not, and on a chain that has
      // finalised that answer does not change. Retry once for transport, then
      // stop — a wrong address must not generate traffic forever.
      staleTime: Infinity,
      gcTime: Infinity,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  })

  // `isError` is transport, not a verdict — an unreachable RPC says nothing
  // about whether the factory exists, and claiming otherwise would put a false
  // alarm on the page every time a public endpoint rate-limits.
  if (!hydrated || isLoading || isError) return null

  const hasCode = typeof bytecode === 'string' && bytecode !== '0x'
  if (hasCode) return null

  const explorer = testnetExplorerAddress(FACTORY_ADDRESS)

  return (
    <div className="border-b border-danger/20 bg-danger/5 px-4 py-2">
      <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2">
        <p className="text-note font-mono text-danger tracking-wide">
          No contract at the configured factory{' '}
          <span className="font-bold">{FACTORY_ADDRESS}</span> on{' '}
          {ACTIVE_CHAIN_LABEL} (chain {TARGET_CHAIN_ID}). Every on-chain value on
          this page will read blank until{' '}
          <span className="font-bold">NEXT_PUBLIC_FACTORY_ADDRESS</span> points
          at a deployment. A variable of that name exported in the shell
          outranks <span className="font-bold">.env.local</span>.
        </p>
        {explorer && (
          <a
            href={explorer}
            target="_blank"
            rel="noopener noreferrer"
            className="text-label font-bold uppercase tracking-wider px-3 py-1 rounded-md
                       border border-danger/40 text-danger hover:bg-danger/10 transition-colors"
          >
            View on explorer
          </a>
        )}
      </div>
    </div>
  )
}
