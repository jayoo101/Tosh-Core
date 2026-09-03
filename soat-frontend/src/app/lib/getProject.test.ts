import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The distinction under test is `not-found` versus `unavailable`.
 *
 * They used to be the same `null`, which the route turned into a 404 and the
 * loader rendered as "No launch at this address" — so an RPC outage produced a
 * confident denial that a real, funded project exists. One is a cacheable fact
 * about the chain; the other is a transient fact about us.
 */

const TOKEN = '0xa783CDc72e34a174CCa57a6d9a74904d0Bec05A9'
const HOOK  = '0x21A52C56C15258B3f36B6455dA92d1241fB875FD'
const ZERO  = '0x0000000000000000000000000000000000000000'

/** `readContract` responses, keyed by function name, set per test. */
let reads: Record<string, () => unknown>
/** What the registry query resolves to, set per test. */
let registry: () => Promise<{ data: unknown[] | null; error: unknown }>
/** `.eq()` calls the query carried, so the chain scoping can be asserted. */
const filters: [string, unknown][] = []

vi.mock('@/app/lib/serverRpc', () => ({
  serverPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      const handler = reads[functionName]
      if (!handler) throw new Error(`unexpected read: ${functionName}`)
      return handler()
    },
  }),
}))

vi.mock('@/app/lib/supabase', () => ({
  // `abortSignal` is the last link, and the query is only issued there.
  // Building it earlier would leave a rejected promise unobserved whenever a
  // test makes the registry throw, which surfaces as an unhandled rejection
  // that Vitest reports against whichever test happens to be running.
  supabase: {
    from: () => ({
      select: () => ({
        // The nesting is the assertion. `eq` sits between `select` and `or`
        // because that is where the chain filter goes, so a build that drops
        // it does not silently read every chain's rows — it fails here with
        // "or is not a function". An address is not unique across chains, so
        // an unfiltered lookup can answer with a different chain's project.
        eq: (column: string, value: unknown) => {
          filters.push([column, value])
          return {
            or: () => ({
              order: () => ({
                limit: () => ({
                  abortSignal: (signal: AbortSignal) => {
                    // The production path must pass a real deadline here; a
                    // mock that accepted anything would keep passing if the
                    // argument were dropped.
                    if (!(signal instanceof AbortSignal)) {
                      throw new Error('registry query was issued without a deadline')
                    }
                    return registry()
                  },
                }),
              }),
            }),
          }
        },
      }),
    }),
  },
  REGISTRY_READ_DEADLINE_MS: 1_200,
  REGISTRY_WRITE_DEADLINE_MS: 5_000,
}))

beforeEach(() => {
  // `@/lib/contracts` throws at import if this is unset.
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0')
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337')
  reads = {}
  registry = async () => ({ data: [], error: null })
  filters.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function getProject(addr: string) {
  const mod = await import('./getProject')
  return mod.getProject(addr)
}

describe('getProject — absence and unavailability are different answers', () => {
  it('reports not-found when the chain positively says there is no launch', async () => {
    // Factory has no hook for it, and it is not a hook itself: two answers, both
    // received. That is a fact, and the route may cache it.
    reads = {
      tokenToHook: () => ZERO,
      projectToken: () => { throw new Error('execution reverted') },
    }
    await expect(getProject(TOKEN)).resolves.toEqual({ status: 'not-found' })
  })

  it('reports unavailable when the factory read itself fails', async () => {
    // Nothing was learned about whether the project exists. Saying "not found"
    // here is the bug: it renders as a denial during an outage.
    reads = {
      tokenToHook: () => { throw new Error('fetch failed') },
    }
    await expect(getProject(TOKEN)).resolves.toEqual({ status: 'unavailable' })
  })

  it('reports unavailable when metadata cannot be read for a launch that exists', async () => {
    // A Tosh token's name() does not revert, so a failure here is the RPC. The
    // old code substituted `token.slice(0, 10)` as the display name and stamped
    // `created_at: now`, producing a row indistinguishable from a real one.
    reads = {
      tokenToHook: () => HOOK,
      name: () => { throw new Error('fetch failed') },
      symbol: () => 'E2ERU8',
    }
    await expect(getProject(TOKEN)).resolves.toEqual({ status: 'unavailable' })
  })

  it('never invents a name or a created_at when it does answer found', async () => {
    reads = {
      tokenToHook: () => HOOK,
      name: () => 'E2E Clone MT9YCRU8',
      symbol: () => 'E2ERU8',
    }
    const result = await getProject(TOKEN)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.row.name).toBe('E2E Clone MT9YCRU8')
    expect(result.row.token_address).toBe(TOKEN)
    expect(result.row.hook_address).toBe(HOOK)
    // Assembled from chain reads: nobody knows when the launch happened, and a
    // plausible timestamp is worse than an absent one.
    expect(result.row.created_at).toBe('')
  })

  it('resolves a hook address to its token', async () => {
    reads = {
      tokenToHook: () => ZERO,
      projectToken: () => TOKEN,
      name: () => 'E2E Clone MT9YCRU8',
      symbol: () => 'E2ERU8',
    }
    const result = await getProject(HOOK)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.row.token_address).toBe(TOKEN)
    expect(result.row.hook_address).toBe(HOOK)
  })

  it('rejects a malformed address without touching the chain or the registry', async () => {
    reads = {
      tokenToHook: () => { throw new Error('should not be called') },
    }
    registry = async () => { throw new Error('should not be called') }
    await expect(getProject('nope')).resolves.toEqual({ status: 'not-found' })
  })
})

describe('getProject — the registry wins when it has a row', () => {
  it('prefers registry metadata over the chain fallback', async () => {
    // Only the registry carries logo, links and description, so a row there is
    // strictly better than what the chain can assemble.
    registry = async () => ({
      data: [{
        id: TOKEN,
        token_address: TOKEN,
        hook_address: HOOK,
        name: 'Registry Name',
        symbol: 'REG',
        logo_url: 'https://cdn.test/logo.png',
        website: null, twitter: null, telegram: null, description: null,
        tx_hash: '0xabc', created_at: '2026-01-01T00:00:00Z',
      }],
      error: null,
    })
    reads = {
      tokenToHook: () => HOOK,
      name: () => 'Chain Name',
      symbol: () => 'CHAIN',
    }

    const result = await getProject(TOKEN)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.row.name).toBe('Registry Name')
    expect(result.row.logo_url).toBe('https://cdn.test/logo.png')
    // Scoped to this deployment's chain. CREATE2 is designed to put the same
    // address on every chain from the same inputs, so an unfiltered match here
    // can hand a visitor a different chain's project under a legitimate
    // address — its name, its logo, its outbound links.
    expect(filters).toContainEqual(['chain_id', 31337])
  })

  it('stamps the chain fallback row with the chain it was read from', async () => {
    // The fallback assembles a row from contract reads rather than the
    // registry. `created_at` is deliberately left empty there because nobody
    // knows when the launch happened — but the chain is not a guess of the
    // same kind, it is the one every read above went to.
    reads = {
      tokenToHook: () => HOOK,
      name: () => 'Chain Name',
      symbol: () => 'CHAIN',
    }
    const result = await getProject(TOKEN)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.row.chain_id).toBe(31337)
  })

  it('falls through to the chain when the registry errors, without reporting its failure as absence', async () => {
    registry = async () => ({ data: null, error: { message: 'fetch failed' } })
    reads = {
      tokenToHook: () => HOOK,
      name: () => 'Chain Name',
      symbol: () => 'CHAIN',
    }
    const result = await getProject(TOKEN)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.row.name).toBe('Chain Name')
  })

  it('is unavailable, not not-found, when the registry and the chain are both down', async () => {
    registry = async () => { throw new Error('fetch failed') }
    reads = {
      tokenToHook: () => { throw new Error('fetch failed') },
    }
    await expect(getProject(TOKEN)).resolves.toEqual({ status: 'unavailable' })
  })
})
