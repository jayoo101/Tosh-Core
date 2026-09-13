import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * This route exists so that a creator whose listing never published can still
 * prove which launch is theirs, and the two things it must never confuse are
 * "there is no such launch" and "I could not find out". A 404 is cached and
 * tells the panel to fall back to asking the creator to paste a hash; a 503 is
 * not cached and tells it to retry. Getting that backwards either hides a
 * recoverable launch behind a manual field forever, or spins on a hash that will
 * never resolve.
 *
 * The other contract under test is the fallback itself. `eth_getLogs` over the
 * whole chain is the fast path and works on Robinhood's own RPC, but plenty of
 * providers cap the block span and reject it — so a rejection there must reach
 * the timestamp-bounded window scan rather than surfacing as an absence.
 */

const HOOK = '0x0fbC9c29E9E6eFD390a4CaEb886b6b6fcEa7AdFE'
const CREATOR = '0xfd17ad21d6513Af0b9beBCa8D013f2943664C2ff'
const TX = '0x14b37467062e3295123ab033d1a8e9abed20ca210c3a4998d7016756d8637493'

interface Calls {
  reads:    string[]
  /** One entry per `eth_getLogs` on the CONFIGURED endpoint, `[from, to]` verbatim. */
  scans:    [string, string][]
  /** The same, for the public endpoint the route consults second. */
  publicScans: [string, string][]
  blocks:   bigint[]
}

let calls: Calls
let chainOk: boolean
/** `null` makes `creator()` revert, which is how "not one of our hooks" reads. */
let creator: string | null
/** Thrown by the first, whole-chain scan when set — the range-capped provider. */
let fullRangeError: Error | null
/** Which windowed scans should return the log. `'all'` includes the full range. */
let logVisibleIn: 'all' | 'window' | 'none'
/**
 * What the public endpoint serves, and whether there is one at all — `'absent'`
 * is the deployment already pointed at the public URL, where a second identical
 * request would only produce a second identical answer.
 */
let publicLogVisibleIn: 'all' | 'window' | 'none' | 'absent'

const HEAD = 61_795_000n
/** genesisDeadline - genesisDuration, i.e. the creation timestamp. */
const CREATED_AT = 1_789_283_281n

/**
 * One endpoint. The two the route consults differ only in what they serve and
 * where their scans are recorded, so asserting on `publicScans` proves which
 * endpoint answered rather than merely that something did.
 */
function endpoint(
  log: () => 'all' | 'window' | 'none',
  scans: () => [string, string][],
  rangeError: () => Error | null,
) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.reads.push(functionName)
      if (functionName === 'creator') {
        if (creator === null) throw new Error('execution reverted')
        return creator
      }
      if (functionName === 'genesisDeadline') return CREATED_AT + 10_800n
      if (functionName === 'genesisDuration') return 10_800n
      throw new Error(`unexpected read: ${functionName}`)
    },
    getBlockNumber: async () => HEAD,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      calls.blocks.push(blockNumber)
      // A steady 10 blocks per second, anchored so that CREATED_AT lands inside
      // the range — enough for the bisection to have something to converge on.
      return { timestamp: CREATED_AT - (HEAD - blockNumber) / 10n }
    },
    request: async ({ params }: { params: [{ fromBlock: string; toBlock: string }] }) => {
      const { fromBlock, toBlock } = params[0]
      scans().push([fromBlock, toBlock])
      const isFullRange = fromBlock === '0x0' && toBlock === 'latest'
      const err = rangeError()
      if (isFullRange && err) throw err
      if (log() === 'none') return []
      if (log() === 'window' && isFullRange) return []
      return [{ transactionHash: TX }]
    },
  }
}

vi.mock('@/app/lib/serverRpc', () => ({
  assertServerChain: async () => chainOk,
  serverPublicClient: () => endpoint(
    () => logVisibleIn,
    () => calls.scans,
    () => fullRangeError,
  ),
  publicFallbackClient: () => publicLogVisibleIn === 'absent' ? null : endpoint(
    () => publicLogVisibleIn as 'all' | 'window' | 'none',
    () => calls.publicScans,
    () => null,
  ),
}))

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0')
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337')
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined as unknown as string)
  calls = { reads: [], scans: [], publicScans: [], blocks: [] }
  chainOk = true
  creator = CREATOR
  fullRangeError = null
  logVisibleIn = 'all'
  // Default to there being no second endpoint, so each test that involves one
  // says so, and the rest assert the configured endpoint's behaviour alone.
  publicLogVisibleIn = 'absent'
})

afterEach(() => {
  vi.unstubAllEnvs()
  // The route memoises resolved hashes at module scope, so every test needs a
  // fresh module or the cache leaks across them.
  vi.resetModules()
})

let ipSeq = 0
async function get(hook: string | null) {
  const { GET } = await import('./route')
  const url = hook === null
    ? 'https://tosh.test/api/projects/launch-tx'
    : `https://tosh.test/api/projects/launch-tx?hook=${encodeURIComponent(hook)}`
  return GET(new NextRequest(url, {
    headers: { 'x-forwarded-for': `203.0.113.${ipSeq++ % 250}` },
  }))
}

describe('GET /api/projects/launch-tx', () => {
  it('answers the creating transaction and the creator, from one whole-chain scan', async () => {
    const res = await get(HOOK)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ txHash: TX, creator: CREATOR })
    // The fast path only. Nothing needed the bisection, so nothing paid for it.
    expect(calls.scans).toEqual([['0x0', 'latest']])
    expect(calls.blocks).toEqual([])
  })

  it('caches the answer, because a launch is created exactly once', async () => {
    const { GET } = await import('./route')
    const req = () => new NextRequest(
      `https://tosh.test/api/projects/launch-tx?hook=${HOOK}`,
      { headers: { 'x-forwarded-for': '198.51.100.7' } },
    )
    expect((await GET(req())).status).toBe(200)
    expect((await GET(req())).status).toBe(200)
    expect(calls.scans).toHaveLength(1)
  })

  it('answers 404 for an address that is not one of our hooks, without scanning', async () => {
    creator = null
    const res = await get(HOOK)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toContain('s-maxage')
    // `creator()` reverting is the whole answer. A log scan here would spend the
    // most expensive read in the app to confirm what the cheap one just said.
    expect(calls.scans).toEqual([])
  })

  it('falls back to a bounded window when the provider caps the block span', async () => {
    fullRangeError = new Error('query returned more than 10000 results')
    logVisibleIn = 'window'

    const res = await get(HOOK)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ txHash: TX, creator: CREATOR })

    expect(calls.scans).toHaveLength(2)
    const [, windowed] = calls.scans
    expect(windowed[0]).not.toBe('0x0')
    expect(windowed[1]).not.toBe('latest')

    // The window is placed by bisecting block timestamps for the creation time,
    // which is derived from the two public getters rather than guessed.
    expect(calls.reads).toContain('genesisDeadline')
    expect(calls.reads).toContain('genesisDuration')
    expect(calls.blocks.length).toBeGreaterThan(0)

    // And it actually brackets the block the timestamps point at.
    const from = BigInt(windowed[0])
    const to = BigInt(windowed[1])
    expect(to - from).toBeLessThanOrEqual(10_001n)
    expect(from).toBeLessThan(to)
  })

  it('falls back to the window when the whole-chain scan is served but comes back empty', async () => {
    // The capped provider that does not say so. Rejecting an over-wide range is
    // one behaviour; silently clamping it and answering an empty set is another,
    // and the second is indistinguishable from "no such log" at the call site.
    // Treating empty as final stranded exactly the creators this route is for:
    // production answered 503 for a hook whose log the public RPC returns in
    // under a second, and the window scan below would have found it.
    fullRangeError = null
    logVisibleIn = 'window'

    const res = await get(HOOK)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ txHash: TX, creator: CREATOR })

    expect(calls.scans).toHaveLength(2)
    expect(calls.scans[0]).toEqual(['0x0', 'latest'])
    expect(calls.scans[1][1]).not.toBe('latest')
  })

  it('asks the public endpoint when the configured one serves no logs at all', async () => {
    // The production failure. A non-archive node answers `creator()` and every
    // other read in this app, and has no `LaunchCreated` log from last week —
    // which at the call site is indistinguishable from the launch not existing.
    logVisibleIn = 'none'
    publicLogVisibleIn = 'all'

    const res = await get(HOOK)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ txHash: TX, creator: CREATOR })

    // Both legs were spent on the configured endpoint before moving on, and the
    // answer demonstrably came from the second one.
    expect(calls.scans).toHaveLength(2)
    expect(calls.publicScans).toEqual([['0x0', 'latest']])
  })

  it('does not ask the public endpoint when the configured one already answered', async () => {
    publicLogVisibleIn = 'all'
    const res = await get(HOOK)
    expect(res.status).toBe(200)
    // A second opinion on a question already answered is pure latency, and this
    // route's fast path is the common one.
    expect(calls.publicScans).toEqual([])
  })

  it('answers 503 when neither endpoint can serve the log', async () => {
    logVisibleIn = 'none'
    publicLogVisibleIn = 'none'
    const res = await get(HOOK)
    expect(res.status).toBe(503)
    expect(calls.publicScans).toHaveLength(2)
  })

  it('answers 503, uncacheable, when the hook is real but the log cannot be found', async () => {
    // The distinction this route turns on. `creator()` answered, so the launch
    // exists; the log not being served is the RPC's limit, and a 404 here would
    // send the creator to a manual paste field for a launch we can resolve from
    // a fuller node.
    logVisibleIn = 'none'
    const res = await get(HOOK)
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('retry-after')).toBe('5')
  })

  it('does not cache a failure, so a retry can still succeed', async () => {
    logVisibleIn = 'none'
    const { GET } = await import('./route')
    const req = () => new NextRequest(
      `https://tosh.test/api/projects/launch-tx?hook=${HOOK}`,
      { headers: { 'x-forwarded-for': '198.51.100.9' } },
    )
    expect((await GET(req())).status).toBe(503)

    logVisibleIn = 'all'
    const second = await GET(req())
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ txHash: TX, creator: CREATOR })
  })

  it('refuses a malformed hook before any RPC round trip', async () => {
    for (const bad of ['nope', '0x123', `${HOOK}extra`, '']) {
      const res = await get(bad)
      expect(res.status).toBe(400)
    }
    const res = await get(null)
    expect(res.status).toBe(400)
    expect(calls.reads).toEqual([])
    expect(calls.scans).toEqual([])
  })

  it('answers 503 and reads nothing when the server is on the wrong chain', async () => {
    // The creator this returns is compared against a signature by the caller's
    // next request, so naming one chain's creator for another chain's listing is
    // the failure worth refusing outright.
    chainOk = false
    const res = await get(HOOK)
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(calls.reads).toEqual([])
    expect(calls.scans).toEqual([])
  })

  it('rate-limits a single caller, because a miss is the priciest read here', async () => {
    const { GET } = await import('./route')
    const req = () => new NextRequest(
      `https://tosh.test/api/projects/launch-tx?hook=${HOOK}`,
      { headers: { 'x-forwarded-for': '198.51.100.42' } },
    )
    let limited = 0
    for (let i = 0; i < 20; i++) {
      if ((await GET(req())).status === 429) limited++
    }
    expect(limited).toBeGreaterThan(0)
  })

  it('echoes CORS headers on every branch, including the failures', async () => {
    for (const state of ['found', 'not-found', 'unavailable'] as const) {
      creator = state === 'not-found' ? null : CREATOR
      logVisibleIn = state === 'unavailable' ? 'none' : 'all'
      const res = await get(HOOK)
      expect(res.headers.get('vary')).toContain('Origin')
      vi.resetModules()
    }
  })
})
