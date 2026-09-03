import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `GET /api/projects` is the directory's metadata registry.
 *
 * Two properties are pinned here, and both were wrong at once.
 *
 * The first is the deadline. supabase-js ships no timeout AND retries four
 * times with backoff, so against a host that refuses the TLS handshake the
 * call did not fail — it settled after 13.9 s, measured. This route had no
 * ceiling of its own and paid that on every request. A `Promise.race` would
 * not have been enough either: it bounds the wait while leaving the retry
 * chain running, which is why the fix is `.abortSignal()` and why the test
 * asserts the query received a signal rather than asserting on wall-clock
 * time, which would be flaky and would pass against a race.
 *
 * The second is the status code. A registry that cannot be reached is a
 * transient condition the caller should retry, not a defect in the request it
 * just made — the same distinction `lookup` already draws when it answers 503
 * instead of 404. It must not be cacheable, or one edge holds the outage for
 * every visitor behind it.
 */

const ROW = { token_address: '0xa783CDc72e34a174CCa57a6d9a74904d0Bec05A9', name: 'E2E Clone' }

// `vi.mock` factories are hoisted above everything, including `beforeEach`, and
// `app/lib/supabase.ts` throws at module load without these. Setting them in
// `vi.hoisted` is what lets the factory import the real module for its
// constants instead of restating them, which would leave the deadline
// assertion below pinning a copy rather than the value the routes use.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://registry.test.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

interface Recorded { signal?: AbortSignal }
let recorded: Recorded
let result: { data: unknown; error: unknown }

vi.mock('../../lib/supabase', async () => {
  const actual = await vi.importActual<typeof import('./../../lib/supabase')>('../../lib/supabase')
  // A thenable that mimics the PostgREST builder: every transform returns the
  // chain, and awaiting it yields `{ data, error }`.
  const chain: Record<string, unknown> = {}
  for (const method of ['from', 'select', 'order', 'or', 'limit', 'insert', 'single']) {
    chain[method] = () => chain
  }
  chain.abortSignal = (signal: AbortSignal) => {
    recorded.signal = signal
    return chain
  }
  chain.then = (
    resolve: (v: { data: unknown; error: unknown }) => unknown,
  ) => Promise.resolve(result).then(resolve)
  return {
    ...actual,
    supabase: chain,
  }
})

vi.mock('@/lib/observability', () => ({ reportError: () => {} }))

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0')
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337')
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined as unknown as string)
  recorded = {}
  result = { data: [ROW], error: null }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

let ipSeq = 0
async function get() {
  const { GET } = await import('./route')
  return GET(new NextRequest('https://tosh.test/api/projects', {
    headers: { 'x-forwarded-for': `198.51.100.${ipSeq++ % 250}` },
  }))
}

describe('GET /api/projects', () => {
  it('returns the rows when the registry answers', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, data: [ROW] })
  })

  it('bounds the query with an abort signal, not just its own wait', async () => {
    await get()
    // The signal is the whole point: `Promise.race` would bound this function
    // while the four-attempt retry chain kept running behind it.
    expect(recorded.signal).toBeInstanceOf(AbortSignal)
  })

  it('uses a deadline short enough that a dead registry does not stall a page', async () => {
    await get()
    const { REGISTRY_READ_DEADLINE_MS } = await import('../../lib/supabase')
    // Pins the budget, not merely its presence. The measured failure was 13.9 s;
    // anything in that neighbourhood would satisfy "has a signal" while still
    // being a hang from the visitor's side.
    expect(REGISTRY_READ_DEADLINE_MS).toBeLessThanOrEqual(2_000)
  })

  it('answers 503, not 500, when the registry is unreachable', async () => {
    result = { data: null, error: { message: 'TypeError: fetch failed', code: '' } }
    const res = await get()
    // 500 says "this request was bad". The request was fine; the dependency
    // was not, and the caller should come back rather than give up.
    expect(res.status).toBe(503)
  })

  it('never lets a CDN cache the unreachable answer', async () => {
    result = { data: null, error: { message: 'TypeError: fetch failed', code: '' } }
    const res = await get()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('retry-after')).toBe('5')
  })

  it('distinguishes an empty registry from an unreachable one', async () => {
    result = { data: [], error: null }
    const res = await get()
    // "No projects yet" is a real, cacheable answer and must not be dressed up
    // as an outage — the inverse of the 503 above, and the same not-found vs
    // unavailable split `getProject` draws.
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, data: [] })
  })
})
