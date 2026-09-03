import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * The route's job is to turn `getProject`'s three states into HTTP that a CDN
 * and a browser will treat correctly. The status code alone is not the whole
 * contract: caching a transient failure is how a five-second outage becomes a
 * ten-second one for every visitor behind the same edge, so the `Cache-Control`
 * on each branch is asserted too.
 */

const TOKEN = '0xa783CDc72e34a174CCa57a6d9a74904d0Bec05A9'
const HOOK  = '0x21A52C56C15258B3f36B6455dA92d1241fB875FD'

type Lookup =
  | { status: 'found'; row: Record<string, unknown> }
  | { status: 'not-found' }
  | { status: 'unavailable' }

let lookup: () => Promise<Lookup>

vi.mock('@/app/lib/getProject', () => ({
  getProject: () => lookup(),
}))

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0')
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337')
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined as unknown as string)
  lookup = async () => ({ status: 'not-found' })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

/** A distinct source IP per call so the route's own rate limit never fires. */
let ipSeq = 0
async function get(address: string | null) {
  const { GET } = await import('./route')
  const url = address === null
    ? 'https://tosh.test/api/projects/lookup'
    : `https://tosh.test/api/projects/lookup?address=${encodeURIComponent(address)}`
  return GET(new NextRequest(url, {
    headers: { 'x-forwarded-for': `203.0.113.${ipSeq++ % 250}` },
  }))
}

describe('GET /api/projects/lookup', () => {
  it('answers 200 with the row, cacheable, for a launch that exists', async () => {
    lookup = async () => ({
      status: 'found',
      row: { token_address: TOKEN, hook_address: HOOK, name: 'E2E Clone', symbol: 'E2E' },
    })
    const res = await get(TOKEN)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ token_address: TOKEN, name: 'E2E Clone' })
    expect(res.headers.get('cache-control')).toContain('s-maxage')
  })

  it('answers 404, cacheable, when the chain says there is no such launch', async () => {
    lookup = async () => ({ status: 'not-found' })
    const res = await get(TOKEN)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toContain('s-maxage')
  })

  it('answers 503 and forbids caching when the chain could not be reached', async () => {
    // The distinction that matters: a 404 here would be cached as a denial that
    // a real project exists, and the loader renders it as "No launch at this
    // address".
    lookup = async () => ({ status: 'unavailable' })
    const res = await get(TOKEN)
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('retry-after')).toBe('5')
  })

  it('rejects a malformed address without consulting the chain at all', async () => {
    // The point is not the 400; it is that a probe with a junk address cannot
    // cost an RPC round trip, or the endpoint is an amplifier for someone
    // else's quota.
    let consulted = false
    lookup = async () => { consulted = true; return { status: 'not-found' } }

    for (const bad of ['nope', '0x123', `${TOKEN}extra`, '']) {
      const res = await get(bad)
      expect(res.status).toBe(400)
    }
    expect(consulted).toBe(false)
  })

  it('rejects a missing address parameter the same way', async () => {
    let consulted = false
    lookup = async () => { consulted = true; return { status: 'not-found' } }
    const res = await get(null)
    expect(res.status).toBe(400)
    expect(consulted).toBe(false)
  })

  it('rate-limits a single caller rather than leaving the RPC path open', async () => {
    lookup = async () => ({ status: 'not-found' })
    const { GET } = await import('./route')
    const req = () => new NextRequest(
      `https://tosh.test/api/projects/lookup?address=${TOKEN}`,
      { headers: { 'x-forwarded-for': '198.51.100.42' } },
    )

    let limited = 0
    for (let i = 0; i < 90; i++) {
      const res = await GET(req())
      if (res.status === 429) limited++
    }
    expect(limited).toBeGreaterThan(0)
  })

  it('echoes CORS headers on every branch, including the failures', async () => {
    for (const state of ['found', 'not-found', 'unavailable'] as const) {
      lookup = async () =>
        state === 'found' ? { status: 'found', row: { token_address: TOKEN } } : { status: state }
      const res = await get(TOKEN)
      expect(res.headers.get('vary')).toContain('Origin')
    }
  })
})
