import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

/**
 * The Proof-of-Gas chain allowlist.
 *
 * Two things are pinned here, and the second is the one that matters.
 *
 * 1. The devnet is accepted only when this is not a production build. It was
 *    unconditional, so a deployed production build accepted `chainId: 31337` and
 *    carried the request as far as an RPC attempt against loopback. That fails
 *    closed — but only because nothing listens there, which is not a control.
 *
 * 2. The decision lives in exactly one place. It used to be written twice: the
 *    predicate in `chain.ts` and an inline
 *    `chainId !== TARGET_CHAIN_ID && chainId !== FOUNDRY_CHAIN_ID` in
 *    `onchainNonce.ts`. Tightening one would have left the other accepting what
 *    the first had just refused. `chain.ts` is now the only source, and this test
 *    is what stops a third copy from appearing next to a caller that needs one.
 *
 * The allowlist is read at module load, so each environment is exercised in a
 * fresh module registry rather than by re-reading a cached binding.
 */

const SRC = join(process.cwd(), 'src')

async function loadChain(nodeEnv: string, chainId: string) {
  const prevEnv = process.env.NODE_ENV
  const prevChain = process.env.NEXT_PUBLIC_CHAIN_ID
  // `NODE_ENV` is readonly in the Node types but writable at runtime, and the
  // module under test reads it exactly the way the bundler inlines it.
  ;(process.env as Record<string, string>).NODE_ENV = nodeEnv
  process.env.NEXT_PUBLIC_CHAIN_ID = chainId
  try {
    // A fresh registry, not a cache-busting query string: the latter makes vite
    // warn about a non-static import specifier on every run.
    vi.resetModules()
    return await import('./chain')
  } finally {
    ;(process.env as Record<string, string>).NODE_ENV = prevEnv as string
    if (prevChain === undefined) delete process.env.NEXT_PUBLIC_CHAIN_ID
    else process.env.NEXT_PUBLIC_CHAIN_ID = prevChain
  }
}

describe('PoG chain allowlist', () => {
  it('refuses the devnet in a production build pointed at mainnet', async () => {
    const { isSupportedPogChain } = await loadChain('production', '4663')
    expect(isSupportedPogChain(4663)).toBe(true)
    expect(isSupportedPogChain(31337)).toBe(false)
  })

  it('refuses the devnet in a production build pointed at the public testnet', async () => {
    // A deployed testnet build has no loopback node either, so this is not a
    // mainnet-only tightening.
    const { isSupportedPogChain } = await loadChain('production', '46630')
    expect(isSupportedPogChain(46630)).toBe(true)
    expect(isSupportedPogChain(31337)).toBe(false)
  })

  it('keeps the devnet for a developer running against the public testnet', async () => {
    const { isSupportedPogChain } = await loadChain('development', '46630')
    expect(isSupportedPogChain(46630)).toBe(true)
    expect(isSupportedPogChain(31337)).toBe(true)
  })

  it('accepts the devnet in production when it IS the target', async () => {
    // Otherwise a local production build would refuse the only chain it has.
    const { isSupportedPogChain } = await loadChain('production', '31337')
    expect(isSupportedPogChain(31337)).toBe(true)
  })

  it('never accepts a chain that is neither the target nor the devnet', async () => {
    const { isSupportedPogChain } = await loadChain('development', '46630')
    for (const foreign of [1, 8453, 10, 42161, 4663, 0, -1]) {
      expect(isSupportedPogChain(foreign)).toBe(false)
    }
  })

  it('names what it accepts, for the error messages that quote it', async () => {
    const { supportedPogChainLabel } = await loadChain('production', '46630')
    expect(supportedPogChainLabel()).toBe('46630')
  })

  it('is decided in exactly one module', () => {
    // The regression this file exists for. Any caller comparing a chain id
    // against FOUNDRY_CHAIN_ID by hand is a second allowlist, whatever it is
    // named. `serverRpc.ts` is exempt: it maps an id to an endpoint, which is a
    // different question from whether the id is allowed.
    const offenders: string[] = []
    const files = [
      'app/lib/onchainNonce.ts',
      'app/api/sign-allocation/route.ts',
      'app/api/pog-scan/route.ts',
      'components/ProjectTerminal/usePogFlow.ts',
      'components/ProjectTerminal/pogScanClient.ts',
      'components/ProjectTerminal/PogScanButton.tsx',
      'components/ProjectTerminal/PogLookupProvider.tsx',
    ]
    for (const rel of files) {
      const text = readFileSync(join(SRC, rel), 'utf8')
      // Comments may name the old shape to explain why it went; code may not.
      const code = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      if (/FOUNDRY_CHAIN_ID/.test(code)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})
