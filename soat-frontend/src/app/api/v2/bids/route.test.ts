import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `GET /api/v2/bids` tells the market which bid ids to read. Its one job
 * beyond the query is to REFUSE while the index is stale: an empty 200 from a
 * dead indexer would look like an empty book, while a 503 sends the browser to
 * scan the chain itself.
 */

let stale: string | null
let filters: [string, unknown][]
let result: { data: unknown; error: unknown }

vi.mock('@/app/lib/apiGuard', () => ({ applyRateLimit: async () => null }))
vi.mock('@/app/lib/v2Indexer', () => ({ indexStaleness: async () => stale }))
vi.mock('@/app/lib/supabaseAdmin', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'select', 'order', 'limit']) chain[m] = () => chain
  chain.eq = (c: string, v: unknown) => { filters.push([c, v]); return chain }
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
  return { getSupabaseAdmin: () => chain }
})

const { GET } = await import('./route')

const HOOK = '0x00000000000000000000000000000000000000AA'
const req = (qs: string) => new NextRequest(`https://tosh.test/api/v2/bids?${qs}`)

beforeEach(() => {
  stale = null
  filters = []
  result = { data: [{ bid_id: '7' }], error: null }
})

describe('GET /api/v2/bids', () => {
  it('rejects a malformed address before touching the index', async () => {
    stale = 'index has never run'
    const res = await GET(req('hook=0x1234'))
    expect(res.status).toBe(400)
  })

  it('answers 503 while the index is stale, so the client scans the chain', async () => {
    stale = 'index is 900s old'
    const res = await GET(req(`hook=${HOOK}`))
    expect(res.status).toBe(503)
  })

  it('filters by lowercased hook and open status by default', async () => {
    const res = await GET(req(`hook=${HOOK}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bids: [{ bid_id: '7' }] })
    expect(filters).toEqual([['hook', HOOK.toLowerCase()], ['status', 'open']])
  })

  it('drops the status filter for status=all', async () => {
    await GET(req(`hook=${HOOK}&status=all`))
    expect(filters).toEqual([['hook', HOOK.toLowerCase()]])
  })

  it('reports a database failure as 503, not as an empty book', async () => {
    result = { data: null, error: { message: 'boom' } }
    const res = await GET(req(`hook=${HOOK}`))
    expect(res.status).toBe(503)
  })
})
