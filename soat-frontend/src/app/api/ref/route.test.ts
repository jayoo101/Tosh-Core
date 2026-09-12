import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { getAddress } from 'viem'

/**
 * `/api/ref` — the referral code registry.
 *
 * These tests exist because of an asymmetry, not because the route is complex.
 * A referral binds a wallet to a referrer once, platform-wide and
 * permanently, and pays that referrer a cut of every genesis deposit the
 * wallet makes. So:
 *
 *   • Failing to resolve a code costs a commission and is recoverable — no
 *     binding exists until the first deposit, so the visitor can click the
 *     link again.
 *   • Resolving to the WRONG address hands a stranger a permanent claim. That
 *     is not recoverable by anything the interface can do afterwards.
 *
 * Everything below pins the second one shut: a 503 must not be reported as a
 * 404, a row that fails address validation must be treated as no row, and an
 * address must never be mistaken for a code.
 */

const ADDRESS_LOWER = '0x30ad7d2d9a1b0f4e3c8b5a6d7e8f9a0b1c2d3e9e'
/** Derived, not typed out. `isAddress` validates the EIP-55 checksum, so a
 *  hand-written mixed-case address is rejected as malformed and every
 *  assertion about casing below would be testing the wrong thing. */
const ADDRESS_CHECKSUMMED = getAddress(ADDRESS_LOWER)

// `app/lib/supabase.ts` throws at module load without these, and `vi.mock`
// factories are hoisted above `beforeEach`.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://registry.test.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

type Chain = Record<string, unknown>
type Result = { data: unknown; error: unknown }

/** Queued so a single request can see two different answers to the same
 *  query — which is exactly what the unique-violation retry depends on. */
let selectResults: Result[]
let insertResult: Result
let insertedRows: Record<string, unknown>[]
let adminAvailable: boolean

/**
 * One query. `from()` below hands out a fresh one per call, which is what
 * supabase-js does and what this mock originally got wrong: sharing a single
 * chain let the `inserting` flag set by a failed insert leak into the SELECT
 * that follows it, so the retry path read `insertResult` instead of the next
 * queued answer and no amount of queueing could express the race.
 */
/**
 * Every query this mock saw, and whether it carried a deadline.
 *
 * Recorded rather than ignored because `checkSupabase.mjs` cannot see these
 * call sites: it matches an identifier containing "supabase" before `.from(`,
 * and the write path here goes through a local binding. The guard found the
 * one query it could see and missed three. So the deadline is asserted here
 * as well — a source guard with a documented blind spot needs a test covering
 * exactly the spot.
 */
let deadlines: (number | undefined)[]

function makeQuery(): Chain {
  const chain: Chain = {}
  let inserting = false

  for (const method of ['select', 'eq', 'maybeSingle', 'single', 'order', 'limit', 'not']) {
    chain[method] = () => chain
  }
  // `AbortSignal.timeout(ms)` hides its own duration, so the route hands over
  // a signal and not a number. `.timeout` is non-standard but Node and the
  // browsers both attach it; when it is absent the entry is `undefined`,
  // which still proves a signal was passed.
  chain.abortSignal = (signal: AbortSignal) => {
    deadlines.push((signal as AbortSignal & { timeout?: number }).timeout)
    return chain
  }
  chain.insert = (row: Record<string, unknown>) => {
    inserting = true
    insertedRows.push(row)
    return chain
  }
  chain.then = (resolve: (v: Result) => unknown) => {
    const next = inserting
      ? insertResult
      : selectResults.shift() ?? { data: null, error: null }
    return Promise.resolve(next).then(resolve)
  }
  return chain
}

function builder(): Chain {
  return { from: () => makeQuery() }
}

vi.mock('../../lib/supabase', async () => {
  const actual = await vi.importActual<typeof import('./../../lib/supabase')>('../../lib/supabase')
  return { ...actual, supabase: builder() as never }
})

vi.mock('../../lib/supabaseAdmin', async () => {
  const actual =
    await vi.importActual<typeof import('./../../lib/supabaseAdmin')>('../../lib/supabaseAdmin')
  return {
    ...actual,
    getSupabaseAdmin: () => {
      if (!adminAvailable) throw new actual.SupabaseAdminUnavailable('SUPABASE_SERVICE_ROLE_KEY')
      return builder() as never
    },
  }
})

vi.mock('@/lib/observability', () => ({ reportError: () => {} }))

const { GET, POST } = await import('./route')

/**
 * A DISTINCT CLIENT PER REQUEST, and that is not cosmetic.
 *
 * The rate limiter buckets by client and the in-memory store outlives a
 * `beforeEach`, so every request in this file used to share one bucket. POST
 * allows 10, the file was at 9, and adding one deadline test made the LAST
 * test in the file fail with 429 — a failure with nothing to do with the
 * behaviour it asserts, in a test whose number nobody would think to count.
 *
 * `x-vercel-forwarded-for` is the one header `clientIp` trusts
 * unconditionally, because the platform overwrites it on the way in. Giving
 * each request its own means a test is limited only if it makes eleven calls
 * itself, which is the only case where the limiter is the thing under test.
 */
let client = 0
function freshClient(): Record<string, string> {
  client++
  return { 'x-vercel-forwarded-for': `198.51.100.${client % 200}:${client}` }
}

function get(code: string) {
  return GET(new NextRequest(
    `http://localhost/api/ref?code=${encodeURIComponent(code)}`,
    { headers: freshClient() },
  ))
}

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/ref', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...freshClient() },
    body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined as unknown as string)
  selectResults = []
  insertResult = { data: null, error: null }
  insertedRows = []
  adminAvailable = true
  deadlines = []
})

describe('deadlines', () => {
  // supabase-js ships no default timeout and retries four times with backoff,
  // so an unreachable registry settles after ~14 s instead of failing. On GET
  // that is a shared link's first paint; on POST it is three queries in a
  // retry loop.
  it('bounds the resolve query', async () => {
    selectResults = [{ data: { address: ADDRESS_LOWER }, error: null }]
    await get('swift-amber-otter')
    expect(deadlines).toHaveLength(1)
  })

  it('bounds every query on the mint path, including the retry', async () => {
    // Miss, then a word collision, then a redraw that lands: four queries —
    // the address lookup, the losing insert, the race re-check, the winning
    // insert.
    selectResults = [
      { data: null, error: null },
      { data: null, error: null },
    ]
    insertResult = { data: null, error: { code: '23505' } }

    await post({ address: ADDRESS_CHECKSUMMED })
    expect(deadlines.length).toBeGreaterThanOrEqual(4)
  })
})

describe('GET — resolving a code', () => {
  it('returns the address, checksummed for comparison against a wallet', async () => {
    selectResults = [{ data: { address: ADDRESS_LOWER }, error: null }]

    const res = await get('swift-amber-otter')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ address: ADDRESS_CHECKSUMMED })
  })

  it('lowercases the code from the URL before looking it up', async () => {
    selectResults = [{ data: { address: ADDRESS_LOWER }, error: null }]

    const res = await get('Swift-Amber-Otter')
    expect(res.status).toBe(200)
  })

  it('rejects junk before it reaches the database', async () => {
    for (const bad of ['', 'nope', 'swift-amber', 'swift amber otter', 'a-b-c']) {
      const res = await get(bad)
      expect(res.status, `"${bad}" should not be accepted`).toBe(400)
    }
    // Nothing was queried, which is the point of validating first.
    expect(selectResults).toHaveLength(0)
  })

  // The rename's whole purpose is that a code is not an address. Accepting one
  // here would mean the old links kept working through a path with none of the
  // registry's guarantees.
  it('refuses an address in place of a code', async () => {
    const res = await get(ADDRESS_LOWER)
    expect(res.status).toBe(400)
  })

  it('404s an unknown code', async () => {
    selectResults = [{ data: null, error: null }]

    const res = await get('swift-amber-otter')
    expect(res.status).toBe(404)
  })

  // "We cannot answer" is not "this code does not exist". `/r/[code]` reads a
  // 404 as a settled fact; reporting a transient outage as one would turn a
  // retryable miss into a silently discarded referral.
  it('503s, not 404s, when the registry errors', async () => {
    selectResults = [{ data: null, error: { message: 'connection refused' } }]

    const res = await get('swift-amber-otter')
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  // The column has a CHECK constraint. This asserts the route does not rely on
  // it: the value is about to be handed to a deposit as a payee, so a row that
  // cannot be a payee is no row at all.
  it('treats a row with an unusable address as no row', async () => {
    for (const bad of ['not-an-address', '0x1234', '', null]) {
      selectResults = [{ data: { address: bad }, error: null }]
      const res = await get('swift-amber-otter')
      expect(res.status, `address ${JSON.stringify(bad)} should not resolve`).toBe(404)
    }
  })
})

describe('POST — minting a code', () => {
  it('rejects anything that is not an address', async () => {
    for (const bad of [undefined, '', 'swift-amber-otter', '0x1234', 42]) {
      const res = await post({ address: bad })
      expect(res.status, `${JSON.stringify(bad)} should not be accepted`).toBe(400)
    }
    expect(insertedRows).toHaveLength(0)
  })

  // THE PROPERTY THAT MAKES A LINK PERMANENT. The panel asks on every mount,
  // and a second code would leave links already pasted somewhere working but
  // no longer matching what the panel shows.
  it('returns the existing code instead of minting a second one', async () => {
    selectResults = [{ data: { code: 'swift-amber-otter' }, error: null }]

    const res = await post({ address: ADDRESS_CHECKSUMMED })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ code: 'swift-amber-otter' })
    expect(insertedRows).toHaveLength(0)
  })

  // Wallets hand out EIP-55 mixed case, and `address UNIQUE` is TEXT — so
  // without lowercasing, one account could hold two codes and the permanence
  // above would quietly stop being true.
  it('stores the address lowercased', async () => {
    selectResults = [{ data: null, error: null }]
    insertResult = { data: { code: 'x' }, error: null }

    const res = await post({ address: ADDRESS_CHECKSUMMED })
    expect(res.status).toBe(200)
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0].address).toBe(ADDRESS_LOWER)
    expect(insertedRows[0].code).toMatch(/^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/)
  })

  // Two tabs opening the panel at once is ordinary, and both must end up with
  // the SAME code. The insert loses on `address UNIQUE`, and the route has to
  // read the winner's code rather than draw new words and try again.
  it('hands back the winner of a concurrent mint', async () => {
    selectResults = [
      { data: null, error: null },                              // nothing yet
      { data: { code: 'quiet-cobalt-heron' }, error: null },     // the other tab won
    ]
    insertResult = { data: null, error: { code: '23505', message: 'duplicate key' } }

    const res = await post({ address: ADDRESS_LOWER })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ code: 'quiet-cobalt-heron' })
  })

  // A word collision is a different 23505: the address is still unclaimed, so
  // the correct response is to draw again rather than to give up.
  it('redraws when the words collide but the address is free', async () => {
    selectResults = [
      { data: null, error: null },  // nothing yet
      { data: null, error: null },  // still nothing after the failed insert
      { data: null, error: null },  // and again, for the second attempt
    ]
    insertResult = { data: null, error: { code: '23505', message: 'duplicate key' } }

    const res = await post({ address: ADDRESS_LOWER })
    // Every attempt collides in this setup, so it exhausts and says so rather
    // than returning a code it did not manage to store.
    expect(res.status).toBe(503)
    expect(insertedRows.length).toBeGreaterThan(1)
  })

  it('degrades to 503 when the writer is not configured', async () => {
    adminAvailable = false

    const res = await post({ address: ADDRESS_LOWER })
    expect(res.status).toBe(503)
    // The long `?ref=<address>` link still works, so nothing about who gets
    // paid depends on this succeeding.
    await expect(res.json()).resolves.toEqual({ error: 'short links are unavailable right now' })
  })
})
