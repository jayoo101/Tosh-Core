import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type Row = { gross: string; buyer_fee: string; seller_fee: string }

let stale: string | null
let rows: Row[]
let failAt: number | null
let ranges: [number, number][]

vi.mock('@/app/lib/apiGuard', () => ({ applyRateLimit: async () => null }))
vi.mock('@/app/lib/v2Indexer', () => ({ indexStaleness: async () => stale }))
vi.mock('@/lib/observability', () => ({ reportError: () => {} }))
vi.mock('@/app/lib/supabaseAdmin', () => ({
  getSupabaseAdmin: () => ({
    from() {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        range: async (from: number, to: number) => {
          ranges.push([from, to])
          if (failAt === from) return { data: null, error: { message: 'boom' } }
          return { data: rows.slice(from, to + 1), error: null }
        },
      }
      return chain
    },
  }),
}))

const { GET } = await import('./route')
const HOOK = '0x00000000000000000000000000000000000000AA'
const req = (qs: string) => new NextRequest(`https://tosh.test/api/v2/volume?${qs}`)
const row = (gross: bigint): Row => ({ gross: gross.toString(), buyer_fee: '1', seller_fee: '2' })

beforeEach(() => {
  stale = null
  rows = []
  failAt = null
  ranges = []
})

describe('GET /api/v2/volume', () => {
  it('requires a well-formed hook', async () => {
    expect((await GET(req(''))).status).toBe(400)
    expect((await GET(req('hook=0x12'))).status).toBe(400)
    expect(ranges).toEqual([])
  })

  it('answers 503 while the index is stale', async () => {
    stale = 'index is 900s old'
    expect((await GET(req(`hook=${HOOK}`))).status).toBe(503)
  })

  it('sums every page, past the 1000-row cap, without losing wei', async () => {
    const big = 10n ** 30n + 7n
    rows = Array.from({ length: 2500 }, () => row(big))
    const res = await GET(req(`hook=${HOOK}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ count: 2500, gross: (big * 2500n).toString(), fees: '7500' })
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('stops after a full last page with one empty read', async () => {
    rows = Array.from({ length: 1000 }, () => row(5n))
    expect(await (await GET(req(`hook=${HOOK}`))).json()).toEqual({ count: 1000, gross: '5000', fees: '3000' })
    expect(ranges).toHaveLength(2)
  })

  it('reports a failure on any page as 503 rather than a short total', async () => {
    rows = Array.from({ length: 1500 }, () => row(1n))
    failAt = 1000
    expect((await GET(req(`hook=${HOOK}`))).status).toBe(503)
  })
})
