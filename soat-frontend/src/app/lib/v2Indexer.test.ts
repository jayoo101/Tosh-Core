import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, type Abi, type Address, type Hex } from 'viem'

import { V2_BIDBOOK_ABI, V2_FACTORY_ABI, V2_HOOK_ABI } from '@/lib/v2/abis'

/**
 * The v2 indexer against a fake chain and an in-memory Supabase. Logs are real
 * ABI encodings, so `parseEventLogs` and the column mapping are exercised as
 * they run in production; only transport is faked.
 */

const BOOK = '0x00000000000000000000000000000000000b00c0' as Address
const FACTORY = '0x00000000000000000000000000000000000fac70' as Address
const HOOK = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN = '0x00000000000000000000000000000000000000bb' as Address
const ALICE = '0x000000000000000000000000000000000000a11c' as Address
const BOB = '0x0000000000000000000000000000000000000b0b' as Address
const AGENT = `0x${'ab'.repeat(32)}` as Hex

type Row = Record<string, unknown>
type Tables = Record<string, Map<string, Row>>

const config = vi.hoisted(() => ({
  V2_BIDBOOK: '0x00000000000000000000000000000000000b00c0' as string | undefined,
  V2_ENABLED: true,
  V2_FACTORIES: ['0x00000000000000000000000000000000000fac70'] as string[],
  V2_FROM_BLOCK: 100n,
}))
const fake = vi.hoisted(() => ({
  tables: {} as Tables,
  failUpsert: null as string | null,
  head: 0n,
  logs: [] as { address: string; blockNumber: bigint; logIndex: number; transactionHash: string; topics: string[]; data: string }[],
  bids: new Map<bigint, readonly unknown[]>(),
  getLogsRanges: [] as [bigint, bigint][],
}))

vi.mock('@/lib/v2/config', () => config)
vi.mock('@/app/lib/serverRpc', () => ({
  serverPublicClient: () => ({
    getBlockNumber: async () => fake.head,
    getLogs: async ({ address, fromBlock, toBlock }: { address: string | string[]; fromBlock: bigint; toBlock: bigint }) => {
      fake.getLogsRanges.push([fromBlock, toBlock])
      const want = (Array.isArray(address) ? address : [address]).map(a => a.toLowerCase())
      return fake.logs
        .filter(l => want.includes(l.address.toLowerCase()) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
        .map(l => ({ ...l, blockHash: `0x${'00'.repeat(32)}`, transactionIndex: 0, removed: false }))
    },
    readContract: async ({ args }: { args: [bigint] }) => {
      const b = fake.bids.get(args[0])
      if (!b) throw new Error(`no bid ${args[0]}`)
      return b
    },
  }),
}))
vi.mock('@/app/lib/supabaseAdmin', () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      const rows = () => [...(fake.tables[table] ??= new Map()).values()]
      const where: ((r: Row) => boolean)[] = []
      const run = () => rows().filter(r => where.every(w => w(r)))
      const chain = {
        select: () => chain,
        eq: (c: string, v: unknown) => { where.push(r => r[c] === v); return chain },
        in: (c: string, vs: unknown[]) => { where.push(r => vs.includes(r[c])); return chain },
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: run(), error: null }),
        upsert: async (input: Row | Row[], { onConflict }: { onConflict: string }) => {
          if (fake.failUpsert === table) return { error: { message: 'disk full' } }
          const t = (fake.tables[table] ??= new Map())
          for (const r of Array.isArray(input) ? input : [input]) {
            const key = onConflict.split(',').map(k => String(r[k])).join('|')
            t.set(key, { ...t.get(key), ...r })
          }
          return { error: null }
        },
      }
      return chain
    },
  }),
}))

const { runIndexPass, indexStaleness, MAX_INDEX_AGE_MS } = await import('./v2Indexer')

let txCounter = 0
function emit(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>, block: bigint) {
  const event = abi.find(e => e.type === 'event' && e.name === eventName)
  if (!event || event.type !== 'event') throw new Error(eventName)
  const indexed = Object.fromEntries(event.inputs.filter(i => i.indexed).map(i => [i.name!, args[i.name!]]))
  const plain = event.inputs.filter(i => !i.indexed)
  fake.logs.push({
    address,
    blockNumber: block,
    logIndex: fake.logs.length,
    transactionHash: `0x${(++txCounter).toString(16).padStart(64, '0')}`,
    topics: encodeEventTopics({ abi: [event], eventName, args: indexed } as never) as string[],
    data: encodeAbiParameters(plain, plain.map(i => args[i.name!])),
  })
}
const bid = (bidder: Address, price: bigint, qty: bigint, filled: bigint, escrow: bigint) =>
  [bidder, HOOK, TOKEN, TOKEN, price, qty, filled, escrow] as const
const table = (name: string) => [...(fake.tables[name]?.values() ?? [])]

beforeEach(() => {
  Object.assign(config, { V2_BIDBOOK: BOOK, V2_ENABLED: true, V2_FACTORIES: [FACTORY], V2_FROM_BLOCK: 100n })
  fake.tables = {}
  fake.failUpsert = null
  fake.head = 0n
  fake.logs = []
  fake.bids = new Map()
  fake.getLogsRanges = []
})

describe('runIndexPass', () => {
  it('refuses to run unconfigured, with the message the route maps to 503', async () => {
    config.V2_BIDBOOK = undefined
    await expect(runIndexPass()).rejects.toThrow(/not configured/)
  })

  it('stays CONFIRMATIONS behind the head and reports caught up with nothing to do', async () => {
    fake.head = 102n
    const p = await runIndexPass()
    expect(p).toMatchObject({ from: 100n, to: 99n, head: 99n, caughtUp: true })
    expect(fake.getLogsRanges).toEqual([])
    expect(table('v2_indexer_state')).toEqual([])
  })

  it('indexes a launch and that hook\'s events in the same pass', async () => {
    emit(V2_FACTORY_ABI, FACTORY, 'LaunchCreated', { launchId: 1n, token: TOKEN, hook: HOOK, creator: ALICE, name: 'Inv', symbol: 'INV' }, 101n)
    emit(V2_HOOK_ABI, HOOK, 'GenesisBuy', { buyer: ALICE, agentKey: AGENT, paid: 10n ** 18n, tokens: 7n * 10n ** 21n, soldAfter: 7n * 10n ** 21n }, 102n)
    emit(V2_HOOK_ABI, HOOK, 'SoldOut', { timestamp: 1_700_000_000n }, 103n)
    fake.head = 110n

    const p = await runIndexPass()

    expect(p).toMatchObject({ from: 100n, to: 107n, caughtUp: true, counts: { launches: 1, hookEvents: 2, bookEvents: 0, bids: 0 } })
    const events = table('v2_project_events')
    expect(events.map(e => e.kind)).toEqual(['LaunchCreated', 'SoldOut'])
    expect(events[0]).toMatchObject({ hook: HOOK.toLowerCase(), block_number: 101 })
    expect(events[0].data).toMatchObject({ launchId: '1', name: 'Inv', symbol: 'INV' })
    expect(events[1].data).toEqual({ timestamp: '1700000000' })
    expect(table('v2_genesis_buys')).toEqual([expect.objectContaining({
      hook: HOOK.toLowerCase(), buyer: ALICE.toLowerCase(), agent_key: AGENT,
      paid: '1000000000000000000', tokens: '7000000000000000000000', sold_after: '7000000000000000000000', block_number: 102,
    })])
    expect(table('v2_indexer_state')).toEqual([expect.objectContaining({ id: 'v2', last_block: 107 })])
  })

  it('ignores a look-alike event from a hook it never saw launched', async () => {
    emit(V2_HOOK_ABI, '0x00000000000000000000000000000000000000cc', 'GenesisBuy',
      { buyer: ALICE, agentKey: AGENT, paid: 1n, tokens: 1n, soldAfter: 1n }, 101n)
    fake.head = 110n
    await runIndexPass()
    expect(table('v2_genesis_buys')).toEqual([])
  })

  it('writes bids from contract state, not from event deltas, and records fills', async () => {
    emit(V2_BIDBOOK_ABI, BOOK, 'BidPlaced', { bidId: 1n, hook: HOOK, bidder: ALICE, price: 5n, qty: 100n, escrow: 500n }, 101n)
    emit(V2_BIDBOOK_ABI, BOOK, 'BidPlaced', { bidId: 2n, hook: HOOK, bidder: BOB, price: 4n, qty: 10n, escrow: 40n }, 101n)
    emit(V2_BIDBOOK_ABI, BOOK, 'BidFilled', { bidId: 1n, hook: HOOK, seller: BOB, qty: 30n, price: 5n, gross: 150n, buyerFee: 1n, sellerFee: 2n }, 102n)
    emit(V2_BIDBOOK_ABI, BOOK, 'BidCancelled', { bidId: 2n, hook: HOOK, refund: 40n }, 103n)
    fake.bids.set(1n, bid(ALICE, 5n, 100n, 30n, 350n))
    fake.bids.set(2n, bid(BOB, 4n, 10n, 0n, 0n))
    fake.head = 110n

    const p = await runIndexPass()

    expect(p.counts).toMatchObject({ bookEvents: 4, bids: 2 })
    const byId = Object.fromEntries(table('v2_bids').map(b => [b.bid_id, b]))
    expect(byId['1']).toMatchObject({
      hook: HOOK.toLowerCase(), bidder: ALICE.toLowerCase(), price: '5', qty: '100', filled: '30', escrow: '350',
      status: 'open', placed_block: 101, updated_block: 107,
    })
    expect(byId['2']).toMatchObject({ status: 'cancelled', escrow: '0' })
    expect(table('v2_fills')).toEqual([expect.objectContaining({
      bid_id: '1', seller: BOB.toLowerCase(), qty: '30', price: '5', gross: '150', buyer_fee: '1', seller_fee: '2', block_number: 102,
    })])
  })

  it('marks a bid filled when its escrow is gone, and keeps placement data from an earlier pass', async () => {
    emit(V2_BIDBOOK_ABI, BOOK, 'BidPlaced', { bidId: 9n, hook: HOOK, bidder: ALICE, price: 5n, qty: 10n, escrow: 50n }, 101n)
    fake.bids.set(9n, bid(ALICE, 5n, 10n, 0n, 50n))
    fake.head = 108n
    await runIndexPass()
    const placedTx = table('v2_bids')[0].placed_tx

    emit(V2_BIDBOOK_ABI, BOOK, 'BidFilled', { bidId: 9n, hook: HOOK, seller: BOB, qty: 10n, price: 5n, gross: 50n, buyerFee: 0n, sellerFee: 0n }, 106n)
    fake.bids.set(9n, bid(ALICE, 5n, 10n, 10n, 0n))
    fake.head = 112n
    const p = await runIndexPass()

    expect(p).toMatchObject({ from: 106n, to: 109n })
    expect(table('v2_bids')).toEqual([expect.objectContaining({
      bid_id: '9', status: 'filled', filled: '10', placed_block: 101, placed_tx: placedTx, updated_block: 109,
    })])
  })

  it('is idempotent: replaying a range rewrites the same rows', async () => {
    emit(V2_FACTORY_ABI, FACTORY, 'LaunchCreated', { launchId: 1n, token: TOKEN, hook: HOOK, creator: ALICE, name: 'A', symbol: 'A' }, 101n)
    emit(V2_HOOK_ABI, HOOK, 'GenesisBuy', { buyer: ALICE, agentKey: AGENT, paid: 1n, tokens: 2n, soldAfter: 2n }, 102n)
    emit(V2_BIDBOOK_ABI, BOOK, 'BidFilled', { bidId: 3n, hook: HOOK, seller: BOB, qty: 1n, price: 1n, gross: 1n, buyerFee: 0n, sellerFee: 0n }, 103n)
    fake.bids.set(3n, bid(ALICE, 1n, 1n, 1n, 0n))
    fake.head = 110n
    await runIndexPass()
    const snapshot = JSON.stringify(Object.keys(fake.tables).filter(t => t !== 'v2_indexer_state').map(t => table(t)))

    fake.tables.v2_indexer_state.clear()
    await runIndexPass()

    expect(JSON.stringify(Object.keys(fake.tables).filter(t => t !== 'v2_indexer_state').map(t => table(t)))).toBe(snapshot)
  })

  it('caps a pass at PASS_SPAN blocks and asks for logs in LOG_CHUNK pieces', async () => {
    fake.head = 100n + 50_000n
    const p = await runIndexPass()
    expect(p).toMatchObject({ from: 100n, to: 20_099n, caughtUp: false })
    const bookRanges = fake.getLogsRanges.slice(-10)
    expect(bookRanges[0]).toEqual([100n, 2_099n])
    expect(bookRanges[9]).toEqual([18_100n, 20_099n])
    expect(fake.getLogsRanges.every(([a, b]) => b - a < 2_000n)).toBe(true)

    expect((await runIndexPass()).from).toBe(20_100n)
  })

  it('does not advance the cursor when a write fails mid-pass', async () => {
    emit(V2_BIDBOOK_ABI, BOOK, 'BidFilled', { bidId: 3n, hook: HOOK, seller: BOB, qty: 1n, price: 1n, gross: 1n, buyerFee: 0n, sellerFee: 0n }, 101n)
    fake.bids.set(3n, bid(ALICE, 1n, 1n, 1n, 0n))
    fake.head = 110n
    fake.failUpsert = 'v2_fills'
    await expect(runIndexPass()).rejects.toThrow('v2_fills upsert: disk full')
    expect(table('v2_indexer_state')).toEqual([])

    fake.failUpsert = null
    expect((await runIndexPass()).from).toBe(100n)
  })
})

describe('indexStaleness', () => {
  const stamp = (msAgo: number) => {
    fake.tables.v2_indexer_state = new Map([['v2', { id: 'v2', last_block: 1, updated_at: new Date(Date.now() - msAgo).toISOString() }]])
  }

  it('reports unconfigured and never-run as reasons to refuse', async () => {
    config.V2_ENABLED = false
    expect(await indexStaleness()).toBe('v2 is not configured')
    config.V2_ENABLED = true
    expect(await indexStaleness()).toBe('index has never run')
  })

  it('is fresh inside MAX_INDEX_AGE_MS and stale past it', async () => {
    stamp(MAX_INDEX_AGE_MS - 5_000)
    expect(await indexStaleness()).toBeNull()
    stamp(MAX_INDEX_AGE_MS + 60_000)
    expect(await indexStaleness()).toMatch(/^index is \d+s old$/)
  })
})
