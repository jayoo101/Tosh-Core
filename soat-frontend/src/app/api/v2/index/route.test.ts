import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `/api/v2/index` is the only write path into the v2 tables, so it is guarded
 * by `CRON_SECRET` and fails closed when the secret is unset. It loops passes
 * until the indexer reports caught up, and maps a failure to 503 when v2 is
 * not configured and 502 when the RPC or database broke mid-pass.
 */

type Pass = { from: bigint; to: bigint; head: bigint; caughtUp: boolean; counts: Record<string, number> }

let passes: (Pass | Error)[]
let calls: number

vi.mock('@/lib/observability', () => ({ reportError: () => {} }))
vi.mock('@/app/lib/v2Indexer', () => ({
  runIndexPass: async () => {
    calls++
    const next = passes.shift()
    if (!next) throw new Error('test ran out of passes')
    if (next instanceof Error) throw next
    return next
  },
}))

const { GET, POST } = await import('./route')

const SECRET = 'cron-secret-for-tests'
const pass = (from: number, to: number, head: number): Pass => ({
  from: BigInt(from), to: BigInt(to), head: BigInt(head), caughtUp: to >= head,
  counts: { launches: 0, hookEvents: 0, bookEvents: 0, bids: 0 },
})
const req = (headers: Record<string, string> = {}) =>
  new NextRequest('https://tosh.test/api/v2/index', { headers })

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET)
  passes = []
  calls = 0
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/v2/index', () => {
  it('fails closed with 503 when CRON_SECRET is unset, even with a credential', async () => {
    vi.stubEnv('CRON_SECRET', '  ')
    const res = await GET(req({ authorization: 'Bearer anything' }))
    expect(res.status).toBe(503)
    expect(calls).toBe(0)
  })

  it('answers 401 with a challenge when no credential is sent', async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect(calls).toBe(0)
  })

  it('answers 403 to a wrong credential, including a prefix of the right one', async () => {
    expect((await GET(req({ authorization: 'Bearer nope' }))).status).toBe(403)
    expect((await GET(req({ 'x-cron-secret': SECRET.slice(0, -1) }))).status).toBe(403)
    expect(calls).toBe(0)
  })

  it('accepts the secret as a bearer token or as x-cron-secret, on GET and POST', async () => {
    passes = [pass(1, 10, 10), pass(11, 11, 11)]
    expect((await GET(req({ authorization: `bearer  ${SECRET}` }))).status).toBe(200)
    expect((await POST(req({ 'x-cron-secret': SECRET }))).status).toBe(200)
    expect(calls).toBe(2)
  })

  it('keeps running passes until caught up and reports each with bigints as strings', async () => {
    passes = [pass(1, 20_000, 50_000), pass(20_001, 40_000, 50_000), pass(40_001, 50_000, 50_000)]
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(calls).toBe(3)
    expect(body.ok).toBe(true)
    expect(body.passes.map((p: { from: string; to: string; caughtUp: boolean }) => [p.from, p.to, p.caughtUp])).toEqual([
      ['1', '20000', false], ['20001', '40000', false], ['40001', '50000', true],
    ])
  })

  it('maps a mid-pass failure to 502 and still reports the passes that landed', async () => {
    passes = [pass(1, 20_000, 50_000), new Error('eth_getLogs: range too wide')]
    const res = await GET(req({ authorization: `Bearer ${SECRET}` }))
    const body = await res.json()
    expect(res.status).toBe(502)
    expect(body.error).toContain('range too wide')
    expect(body.passes).toHaveLength(1)
  })

  it('maps an unconfigured v2 to 503', async () => {
    passes = [new Error('v2 is not configured (NEXT_PUBLIC_V2_BIDBOOK / NEXT_PUBLIC_V2_LENS)')]
    expect((await GET(req({ authorization: `Bearer ${SECRET}` }))).status).toBe(503)
  })
})
