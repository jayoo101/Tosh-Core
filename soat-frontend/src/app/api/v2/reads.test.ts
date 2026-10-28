import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

/**
 * The v2 read routes besides `bids` (which has its own file). All three share
 * `readGate`: a malformed address is a 400 before the index is consulted, a
 * stale index is a 503 so the browser falls back to scanning the chain, and a
 * database error is a 503 rather than an empty list that reads as "no trades".
 */

interface Query { table: string; select?: string; eqs: [string, unknown][]; order?: string; limit?: number }

let limited: NextResponse | null
let stale: string | null
let queries: Query[]
let results: Record<string, { data: unknown; error: unknown }>

vi.mock('@/app/lib/apiGuard', () => ({ applyRateLimit: async () => limited }))
vi.mock('@/app/lib/v2Indexer', () => ({ indexStaleness: async () => stale }))
vi.mock('@/lib/observability', () => ({ reportError: () => {} }))
vi.mock('@/app/lib/supabaseAdmin', () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      const q: Query = { table, eqs: [] }
      queries.push(q)
      const chain = {
        select: (s: string) => { q.select = s; return chain },
        eq: (c: string, v: unknown) => { q.eqs.push([c, v]); return chain },
        order: (c: string) => { q.order = c; return chain },
        limit: (n: number) => { q.limit = n; return chain },
        then: (resolve: (v: unknown) => unknown) => resolve(results[table] ?? { data: [], error: null }),
      }
      return chain
    },
  }),
}))

const genesisBuys = await import('./genesis-buys/route')
const trades = await import('./trades/route')
const portfolio = await import('./portfolio/route')
const { BIG } = await import('@/app/lib/v2Read')

const HOOK = '0x00000000000000000000000000000000000000AA'
const WHO = '0x00000000000000000000000000000000000000Bb'
const req = (path: string, qs: string) => new NextRequest(`https://tosh.test/api/v2/${path}?${qs}`)

beforeEach(() => {
  limited = null
  stale = null
  queries = []
  results = {}
})

describe.each([
  { path: 'genesis-buys', GET: genesisBuys.GET, table: 'v2_genesis_buys', party: 'buyer', key: 'buys', select: BIG.buy },
  { path: 'trades', GET: trades.GET, table: 'v2_fills', party: 'seller', key: 'trades', select: BIG.fill },
])('GET /api/v2/$path', ({ path, GET, table, party, key, select }) => {
  it('rejects a malformed hook or party address before touching the index', async () => {
    stale = 'index has never run'
    expect((await GET(req(path, 'hook=0x1234'))).status).toBe(400)
    expect((await GET(req(path, `hook=${HOOK}&${party}=nope`))).status).toBe(400)
    expect(queries).toEqual([])
  })

  it('passes the rate limiter response through untouched', async () => {
    limited = NextResponse.json({ error: 'slow down' }, { status: 429 })
    expect((await GET(req(path, ''))).status).toBe(429)
    expect(queries).toEqual([])
  })

  it('answers 503 while the index is stale', async () => {
    stale = 'index is 900s old'
    const res = await GET(req(path, `hook=${HOOK}`))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'index is 900s old' })
  })

  it('lists newest first, capped, with big integers selected as text', async () => {
    results[table] = { data: [{ tx_hash: '0x01' }], error: null }
    const res = await GET(req(path, ''))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ [key]: [{ tx_hash: '0x01' }] })
    expect(res.headers.get('cache-control')).toContain('s-maxage=5')
    expect(queries).toEqual([{ table, select, eqs: [], order: 'block_number', limit: 200 }])
  })

  it('filters by lowercased hook and party', async () => {
    await GET(req(path, `hook=${HOOK}&${party}=${WHO}`))
    expect(queries[0].eqs).toEqual([['hook', HOOK.toLowerCase()], [party, WHO.toLowerCase()]])
  })

  it('reads a null result as an empty list', async () => {
    results[table] = { data: null, error: null }
    expect(await (await GET(req(path, ''))).json()).toEqual({ [key]: [] })
  })

  it('reports a database failure as 503, not as an empty list', async () => {
    results[table] = { data: null, error: { message: 'boom' } }
    const res = await GET(req(path, `hook=${HOOK}`))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'index unavailable' })
  })
})

describe('GET /api/v2/portfolio', () => {
  it('requires an account, and a well-formed one', async () => {
    expect((await portfolio.GET(req('portfolio', ''))).status).toBe(400)
    expect((await portfolio.GET(req('portfolio', 'account=0xzz'))).status).toBe(400)
    expect(queries).toEqual([])
  })

  it('answers 503 while the index is stale', async () => {
    stale = 'index has never run'
    expect((await portfolio.GET(req('portfolio', `account=${WHO}`))).status).toBe(503)
  })

  it("reads the account's bids, sales and buys, each by its own column", async () => {
    results.v2_bids = { data: [{ bid_id: '1' }], error: null }
    results.v2_fills = { data: null, error: null }
    results.v2_genesis_buys = { data: [{ paid: '5' }], error: null }
    const res = await portfolio.GET(req('portfolio', `account=${WHO}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bids: [{ bid_id: '1' }], sales: [], buys: [{ paid: '5' }] })
    const who = WHO.toLowerCase()
    expect(queries).toEqual([
      { table: 'v2_bids', select: BIG.bid, eqs: [['bidder', who]], order: 'placed_block', limit: 200 },
      { table: 'v2_fills', select: BIG.fill, eqs: [['seller', who]], order: 'block_number', limit: 200 },
      { table: 'v2_genesis_buys', select: BIG.buy, eqs: [['buyer', who]], order: 'block_number', limit: 200 },
    ])
  })

  it('fails the whole answer when any one of the three reads fails', async () => {
    results.v2_fills = { data: null, error: { message: 'boom' } }
    expect((await portfolio.GET(req('portfolio', `account=${WHO}`))).status).toBe(503)
  })
})
