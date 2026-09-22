import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `POST /api/admin/featured` writes the homepage feature pin.
 *
 * What is worth pinning here is not that an UPDATE runs. It is the four things
 * that decide whether this endpoint is safe to expose and usable once exposed:
 *
 *   1. It is closed by default. With no `CONTENT_ADMIN_SECRET` the route
 *      refuses, so a deployment that has not decided about featuring cannot be
 *      featured-for by anybody.
 *   2. It refuses a credential that is not a secret. The shared
 *      `looksLikeARealSecret` exists because a previous admin variable was set
 *      to the owner's own EVM address, which anybody can read off an explorer.
 *      That guard is easy to mistake for defensive polish, so it is tested.
 *   3. Setting a pin clears the others, and in that order. The reverse order
 *      leaves two pins on a failure, which is the state an operator cannot
 *      diagnose from the page: they pinned something and it did not take.
 *   4. It will not pin a launch with no registry row. That write would report
 *      success and change nothing on the homepage.
 */

const TOKEN = '0xa783CDc72e34a174CCa57a6d9a74904d0Bec05A9'
const SECRET = 'r7Qe1pVnK4sZbX9wLmT2yHgC8dFj3aUv'   // 32 chars, not address-shaped

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://registry.test.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

/** Every builder call, in order, so a test can assert on sequence and not just effect. */
interface Op {
  kind: 'from' | 'select' | 'update' | 'eq' | 'not' | 'maybeSingle'
  arg?: unknown
}
let ops: Op[]
let lookupResult: { data: unknown; error: unknown }
let writeResult: { data: unknown; error: unknown }

vi.mock('@/app/lib/supabaseAdmin', () => {
  // A thenable mimicking the PostgREST builder: transforms return the chain,
  // awaiting it yields the write result, and `maybeSingle()` resolves the
  // lookup. Recorded rather than stubbed, because the properties above are
  // about WHICH calls happen in WHAT order.
  const chain: Record<string, unknown> = {}
  chain.from = (t: string) => { ops.push({ kind: 'from', arg: t }); return chain }
  chain.select = (c: string) => { ops.push({ kind: 'select', arg: c }); return chain }
  chain.update = (p: unknown) => { ops.push({ kind: 'update', arg: p }); return chain }
  chain.eq = (col: string, v: unknown) => { ops.push({ kind: 'eq', arg: [col, v] }); return chain }
  chain.not = (col: string, op: string, v: unknown) => {
    ops.push({ kind: 'not', arg: [col, op, v] })
    return chain
  }
  chain.abortSignal = () => chain
  chain.maybeSingle = () => {
    ops.push({ kind: 'maybeSingle' })
    return Promise.resolve(lookupResult)
  }
  chain.then = (
    resolve: (v: { data: unknown; error: unknown }) => unknown,
  ) => Promise.resolve(writeResult).then(resolve)

  class SupabaseAdminUnavailable extends Error {}
  return { getSupabaseAdmin: () => chain, SupabaseAdminUnavailable }
})

vi.mock('@/lib/observability', () => ({ reportError: () => {} }))

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0')
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337')
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined as unknown as string)
  vi.stubEnv('CONTENT_ADMIN_SECRET', SECRET)
  ops = []
  lookupResult = { data: { token_address: TOKEN, symbol: 'QMT' }, error: null }
  writeResult = { data: null, error: null }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.restoreAllMocks()
})

let ipSeq = 0
async function post(
  body: unknown,
  opts: { auth?: string | null } = { auth: `Bearer ${SECRET}` },
) {
  const { POST } = await import('./route')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // A fresh IP per call: the limiter is 10 with a slow refill, and these
    // tests would otherwise start 429ing partway through the file.
    'x-forwarded-for': `203.0.113.${ipSeq++ % 250}`,
  }
  if (opts.auth) headers.Authorization = opts.auth
  return POST(new NextRequest('https://tosh.test/api/admin/featured', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }))
}

describe('POST /api/admin/featured: getting in', () => {
  it('is closed when no credential is configured', async () => {
    vi.stubEnv('CONTENT_ADMIN_SECRET', '')
    const res = await post({ tokenAddress: TOKEN, hours: 24 })
    expect(res.status).toBe(503)
    // Nothing was read or written, so an unconfigured deployment cannot be
    // probed for which launches exist.
    expect(ops).toEqual([])
  })

  it('refuses a request with no credential', async () => {
    const res = await post({ tokenAddress: TOKEN, hours: 24 }, { auth: null })
    expect(res.status).toBe(401)
    expect(ops).toEqual([])
  })

  it('refuses the wrong credential', async () => {
    const res = await post({ tokenAddress: TOKEN, hours: 24 }, { auth: 'Bearer not-the-secret' })
    expect(res.status).toBe(401)
  })

  it('refuses a credential that is an address rather than a secret', async () => {
    // The failure this guard was written for: an admin variable set to the
    // owner's own address, which is a public read away for anyone.
    const asAddress = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
    vi.stubEnv('CONTENT_ADMIN_SECRET', asAddress)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await post({ tokenAddress: TOKEN, hours: 24 }, { auth: `Bearer ${asAddress}` })

    expect(res.status).toBe(401)
    // Loud, not silent: a misconfiguration that disables authentication has to
    // be findable in the logs rather than looking like a wrong password.
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('CONTENT_ADMIN_SECRET'))
  })

  it('refuses a credential too short to be one', async () => {
    const short = 'hunter2'
    vi.stubEnv('CONTENT_ADMIN_SECRET', short)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await post({ tokenAddress: TOKEN, hours: 24 }, { auth: `Bearer ${short}` })

    expect(res.status).toBe(401)
  })
})

describe('POST /api/admin/featured: what it accepts', () => {
  it('rejects something that is not an address', async () => {
    const res = await post({ tokenAddress: 'QMT', hours: 24 })
    expect(res.status).toBe(422)
  })

  it('rejects a window beyond the ceiling', async () => {
    // 14 days. A pin good for a year is the boolean this column was chosen over,
    // spelled differently.
    const res = await post({ tokenAddress: TOKEN, hours: 24 * 14 + 1 })
    expect(res.status).toBe(422)
    expect(ops).toEqual([])
  })

  it('accepts the ceiling itself', async () => {
    const res = await post({ tokenAddress: TOKEN, hours: 24 * 14 })
    expect(res.status).toBe(200)
  })

  it('will not pin a launch with no registry row', async () => {
    // Without this the UPDATE matches nothing, answers 200, and the homepage is
    // unchanged with nothing saying why.
    lookupResult = { data: null, error: null }

    const res = await post({ tokenAddress: TOKEN, hours: 24 })

    expect(res.status).toBe(404)
    expect(ops.some(o => o.kind === 'update')).toBe(false)
  })

  it('looks the launch up on this deployment\'s chain only', async () => {
    await post({ tokenAddress: TOKEN, hours: 24 })
    expect(ops).toContainEqual({ kind: 'eq', arg: ['chain_id', 31337] })
  })
})

describe('POST /api/admin/featured: the write', () => {
  it('sets a future expiry on the chosen launch', async () => {
    const before = Date.now()
    const res = await post({ tokenAddress: TOKEN, hours: 24 })
    expect(res.status).toBe(200)

    const { featuredUntil } = await res.json()
    const ms = Date.parse(featuredUntil)
    // A day out, from the SERVER's clock: a browser with a skewed clock would
    // otherwise set an expiry already past, or months away.
    expect(ms).toBeGreaterThanOrEqual(before + 24 * 3_600_000)
    expect(ms).toBeLessThan(before + 25 * 3_600_000)
  })

  it('clears every other pin before setting this one', async () => {
    await post({ tokenAddress: TOKEN, hours: 24 })

    const updates = ops.filter(o => o.kind === 'update')
    expect(updates).toHaveLength(2)
    // Order is the property. Clearing first and failing leaves no pin, which is
    // the page's default. Setting first and failing to clear leaves two, and an
    // operator whose pin did not take cannot see why from the page.
    expect(updates[0].arg).toEqual({ featured_until: null })
    expect((updates[1].arg as { featured_until: string }).featured_until).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    )
  })

  it('scopes the clear to pinned rows on this chain', async () => {
    await post({ tokenAddress: TOKEN, hours: 24 })
    // Without the `not(... is null)` the UPDATE rewrites every row in the
    // table on every pin.
    expect(ops).toContainEqual({ kind: 'not', arg: ['featured_until', 'is', null] })
  })

  it('treats zero hours as clearing, and writes no expiry', async () => {
    const res = await post({ tokenAddress: TOKEN, hours: 0 })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, featuredUntil: null })
    const updates = ops.filter(o => o.kind === 'update')
    expect(updates).toEqual([{ kind: 'update', arg: { featured_until: null } }])
  })

  it('reports a failed clear rather than setting a second pin', async () => {
    writeResult = { data: null, error: { code: '42501', message: 'denied' } }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await post({ tokenAddress: TOKEN, hours: 24 })

    expect(res.status).toBe(500)
    // One update attempted, then stopped. Carrying on would produce the
    // two-pin state the ordering above exists to avoid.
    expect(ops.filter(o => o.kind === 'update')).toHaveLength(1)
  })
})
