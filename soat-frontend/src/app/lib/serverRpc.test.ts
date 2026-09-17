import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The property under test: an endpoint returned for chain X always belongs to
 * chain X. Never "the value is read", which is what a naive test of a config
 * module checks and what the original bug would have passed.
 *
 * `serverRpc` and the `@/lib/chain` module it reads both resolve env at module
 * load, so every case has to reset the registry and re-import rather than
 * mutate a live binding. That is also faithful to production: these values are
 * fixed at process start and a running server cannot be reconfigured.
 */
async function load(env: Record<string, string | undefined>) {
  vi.resetModules()
  // Clear the names this module consults so a variable exported in the shell
  // running the tests cannot decide the result — which is precisely the
  // mechanism that produced the bug in the first place.
  for (const key of [
    'NEXT_PUBLIC_CHAIN_ID',
    'NEXT_PUBLIC_RPC_URL',
    'BSC_RPC',
    'NEXT_PUBLIC_BSC_RPC',
    'BSC_TESTNET_RPC',
    'NEXT_PUBLIC_BSC_TESTNET_RPC',
    'LOCAL_RPC',
  ]) {
    vi.stubEnv(key, undefined as unknown as string)
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) vi.stubEnv(k, v)
  }
  return import('./serverRpc')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const MAINNET = '56'
const TESTNET = '97'
const FOUNDRY = '31337'

const MAINNET_URL = 'https://bsc-dataseed1.bnbchain.org'
const TESTNET_URL = 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'

describe('serverRpcUrl — chain-named variables are scoped to their chain', () => {
  it('ignores BSC_TESTNET_RPC when the target chain is mainnet', async () => {
    // The exact shape of configuration this guard exists for: a testnet
    // endpoint exported in the deploy shell, which Next's env loader will not
    // override, silently beating .env.production.
    const { serverRpcUrl } = await load({
      NEXT_PUBLIC_CHAIN_ID: MAINNET,
      BSC_TESTNET_RPC: 'https://testnet.example/leftover',
    })
    const url = serverRpcUrl()
    expect(url).not.toContain('testnet')
    expect(url).toBe(MAINNET_URL)
  })

  it('ignores NEXT_PUBLIC_BSC_TESTNET_RPC when the target chain is mainnet', async () => {
    const { serverRpcUrl } = await load({
      NEXT_PUBLIC_CHAIN_ID: MAINNET,
      NEXT_PUBLIC_BSC_TESTNET_RPC: 'https://testnet.example/leftover',
    })
    expect(serverRpcUrl()).not.toContain('testnet')
  })

  it('ignores BSC_RPC when the target chain is the testnet', async () => {
    // The mirror image, and the one a BSC-only address book makes easy to
    // get wrong: mainnet and testnet differ by a single word in the hostname,
    // so a resolver that merely pattern-matched "bsc" would pass the case
    // above and fail this one.
    const { serverRpcUrl } = await load({
      NEXT_PUBLIC_CHAIN_ID: TESTNET,
      BSC_RPC: 'https://mainnet.example/leftover',
    })
    expect(serverRpcUrl()).toBe(TESTNET_URL)
  })

  it('falls back to the target chain, not the testnet, when nothing is set', async () => {
    // The old code hardcoded a single testnet default, so a deployment that
    // simply forgot to configure an endpoint read the wrong chain.
    const { serverRpcUrl } = await load({ NEXT_PUBLIC_CHAIN_ID: MAINNET })
    expect(serverRpcUrl()).toBe(MAINNET_URL)
  })

  it('honours BSC_TESTNET_RPC when the target chain really is the testnet', async () => {
    const { serverRpcUrl } = await load({
      NEXT_PUBLIC_CHAIN_ID: TESTNET,
      BSC_TESTNET_RPC: 'https://testnet.example/premium',
    })
    expect(serverRpcUrl()).toBe('https://testnet.example/premium')
  })

  it('honours LOCAL_RPC only for the devnet', async () => {
    const local = await load({
      NEXT_PUBLIC_CHAIN_ID: FOUNDRY,
      LOCAL_RPC: 'http://127.0.0.1:9999',
    })
    expect(local.serverRpcUrl()).toBe('http://127.0.0.1:9999')

    const mainnet = await load({
      NEXT_PUBLIC_CHAIN_ID: MAINNET,
      LOCAL_RPC: 'http://127.0.0.1:9999',
    })
    expect(mainnet.serverRpcUrl()).toBe(MAINNET_URL)
  })
})

describe('serverRpcUrl — NEXT_PUBLIC_RPC_URL is the chain-agnostic override', () => {
  it('wins over the public fallback on the target chain', async () => {
    const { serverRpcUrl } = await load({
      NEXT_PUBLIC_CHAIN_ID: MAINNET,
      NEXT_PUBLIC_RPC_URL: 'https://alchemy.example/key',
    })
    expect(serverRpcUrl()).toBe('https://alchemy.example/key')
  })

  it('outranks a chain-named variable for the chain they both name', async () => {
    const { serverRpcUrl } = await load({
      NEXT_PUBLIC_CHAIN_ID: TESTNET,
      NEXT_PUBLIC_RPC_URL: 'https://generic.example',
      BSC_TESTNET_RPC: 'https://scoped.example',
    })
    expect(serverRpcUrl()).toBe('https://generic.example')
  })

  it('does NOT leak to a chain that is not the target', async () => {
    // It names no chain, so it means "the endpoint for whatever this build
    // targets". Applying it to an explicitly requested other chain would
    // reintroduce the same class of mismatch from the opposite direction.
    const { serverRpcUrl } = await load({
      NEXT_PUBLIC_CHAIN_ID: MAINNET,
      NEXT_PUBLIC_RPC_URL: 'https://alchemy.example/mainnet-key',
    })
    expect(serverRpcUrl(31337)).toBe('http://127.0.0.1:8545')
  })

  it('ignores a variable set to whitespace rather than treating it as an endpoint', async () => {
    const { serverRpcUrl } = await load({
      NEXT_PUBLIC_CHAIN_ID: MAINNET,
      NEXT_PUBLIC_RPC_URL: '   ',
    })
    expect(serverRpcUrl()).toBe(MAINNET_URL)
  })
})

describe('publicFallbackClient — a second opinion, never a second chain', () => {
  it('dials this chain\'s public endpoint when the deployment is configured elsewhere', async () => {
    const { publicFallbackClient } = await load({
      NEXT_PUBLIC_CHAIN_ID: MAINNET,
      NEXT_PUBLIC_RPC_URL: 'https://nd-471-397-430.example/key',
    })
    const client = publicFallbackClient()
    expect(client?.chain?.id).toBe(56)
    expect(client?.transport.url).toBe(MAINNET_URL)
  })

  it('is null when the configured endpoint already IS the public one', async () => {
    // Otherwise a caller reads a second identical answer to a second identical
    // request as new information, and a real absence looks like two failures.
    const { publicFallbackClient } = await load({
      NEXT_PUBLIC_CHAIN_ID: MAINNET,
      NEXT_PUBLIC_RPC_URL: MAINNET_URL,
    })
    expect(publicFallbackClient()).toBeNull()
  })

  it('is null when nothing was configured, for the same reason', async () => {
    const { publicFallbackClient } = await load({ NEXT_PUBLIC_CHAIN_ID: MAINNET })
    expect(publicFallbackClient()).toBeNull()
  })

  it('never hands out another chain\'s public endpoint', async () => {
    // The invariant this whole module exists for, restated for the new arm: a
    // fallback is only ever the asked-for chain's own endpoint.
    const { publicFallbackClient } = await load({
      NEXT_PUBLIC_CHAIN_ID: MAINNET,
      NEXT_PUBLIC_RPC_URL: 'https://keyed.example/mainnet',
      BSC_TESTNET_RPC: 'https://keyed.example/testnet',
    })
    expect(publicFallbackClient()?.transport.url).toBe(MAINNET_URL)
    expect(publicFallbackClient(97)?.transport.url).toBe(TESTNET_URL)
    expect(publicFallbackClient(97)?.chain?.id).toBe(97)
  })
})

describe('serverPublicClient — chain and transport cannot disagree', () => {
  it('binds the client to the chain whose endpoint it dialled', async () => {
    // The original defect was structural: `chain:` and `transport:` were chosen
    // by two unrelated expressions. This asserts they are one decision.
    const { serverPublicClient, serverRpcUrl } = await load({
      NEXT_PUBLIC_CHAIN_ID: MAINNET,
      BSC_TESTNET_RPC: 'https://testnet.example/leftover',
    })
    const client = serverPublicClient()
    expect(client.chain?.id).toBe(56)
    expect(client.transport.url).toBe(serverRpcUrl())
    expect(client.transport.url).not.toContain('testnet')
  })

  it('gives an explicitly requested chain that chain, not the target', async () => {
    const { serverPublicClient } = await load({ NEXT_PUBLIC_CHAIN_ID: MAINNET })
    expect(serverPublicClient(31337).chain?.id).toBe(31337)
  })

  it('refuses a chain it has no endpoint for instead of guessing one', async () => {
    const { serverPublicClient, serverRpcUrl } = await load({ NEXT_PUBLIC_CHAIN_ID: MAINNET })
    expect(() => serverRpcUrl(999_999)).toThrow(/No endpoint known for chain 999999/)
    expect(() => serverPublicClient(999_999)).toThrow()
  })
})

describe('the target chain itself must be one this build knows', () => {
  /**
   * `chain.ts` used to answer an unrecognised `NEXT_PUBLIC_CHAIN_ID` with
   * `?? baseSepolia`, which meant a typo produced a working UI pointed at a
   * chain nobody asked for — right explorer-shaped links, wrong network, no
   * error anywhere. Refusing to boot is the only outcome an operator cannot
   * miss, so it is worth a test of its own rather than riding along with the
   * endpoint cases above.
   */
  it('throws on an unregistered chain id instead of substituting a default', async () => {
    await expect(load({ NEXT_PUBLIC_CHAIN_ID: '8453' })).rejects.toThrow(
      /NEXT_PUBLIC_CHAIN_ID=8453 is not a chain this build knows/,
    )
  })

  it('names the chains it does support, so the fix does not need a source dive', async () => {
    await expect(load({ NEXT_PUBLIC_CHAIN_ID: '84532' })).rejects.toThrow(/56/)
  })
})
