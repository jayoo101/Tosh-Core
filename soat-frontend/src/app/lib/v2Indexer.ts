/**
 * ToshX v2 log indexer: BidBook bids and fills, hook genesis buys and
 * lifecycle events, into the tables of `supabase/migrations/0006_v2_market.sql`.
 *
 * Idempotent by construction. Event rows are keyed on (tx_hash, log_index) and
 * upserted; a bid's mutable fields are never accumulated from deltas but
 * re-read from `bids(id)` on the contract, so replaying a range rewrites the
 * same values. The cursor only advances after a range is fully written.
 * Bids are read at the latest block, not the range's end: a public RPC keeps
 * no archive state, and the latest value is the one a later pass would write.
 *
 * Reorgs: the indexer stays `CONFIRMATIONS` behind the head. A deeper reorg
 * can leave a stale event row, which costs a list entry — the market re-reads
 * every bid from the chain before it shows one.
 */
import { parseEventLogs, type Address, type Log, type PublicClient } from 'viem'

import { serverPublicClient } from '@/app/lib/serverRpc'
import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { V2_BIDBOOK_ABI, V2_FACTORY_ABI, V2_HOOK_ABI } from '@/lib/v2/abis'
import { V2_BIDBOOK, V2_ENABLED, V2_FACTORIES, V2_FROM_BLOCK } from '@/lib/v2/config'

const CURSOR_ID = 'v2'
const CONFIRMATIONS = 3n
/** Blocks per `eth_getLogs`; public BSC endpoints refuse much wider ranges. */
const LOG_CHUNK = 2_000n
/** Blocks per indexer pass, so one invocation fits its time budget. */
const PASS_SPAN = 20_000n
const READ_BATCH = 40

const HOOK_EVENTS = ['GenesisBuy', 'SoldOut', 'Launched', 'ProjectFundChanged', 'FundWithdrawn'] as const
const BOOK_EVENTS = ['BidPlaced', 'BidCancelled', 'BidFilled'] as const

export interface IndexPass {
  from: bigint
  to: bigint
  head: bigint
  caughtUp: boolean
  counts: { launches: number; hookEvents: number; bookEvents: number; bids: number }
}

const lower = (a: string) => a.toLowerCase()

function jsonArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'bigint' ? v.toString() : v
  return out
}

async function getLogsChunked(client: PublicClient, address: Address | Address[], from: bigint, to: bigint): Promise<Log[]> {
  const out: Log[] = []
  for (let a = from; a <= to; a += LOG_CHUNK) {
    const b = a + LOG_CHUNK - 1n > to ? to : a + LOG_CHUNK - 1n
    out.push(...(await client.getLogs({ address, fromBlock: a, toBlock: b })))
  }
  return out
}

async function knownHooks(): Promise<Address[]> {
  const { data, error } = await getSupabaseAdmin()
    .from('v2_project_events')
    .select('hook')
    .eq('kind', 'LaunchCreated')
  if (error) throw new Error(`v2_project_events read: ${error.message}`)
  return [...new Set((data ?? []).map(r => r.hook as string))] as Address[]
}

async function upsert(table: string, rows: Record<string, unknown>[], onConflict: string) {
  if (rows.length === 0) return
  const { error } = await getSupabaseAdmin().from(table).upsert(rows, { onConflict })
  if (error) throw new Error(`${table} upsert: ${error.message}`)
}

/** Run one pass of at most `PASS_SPAN` blocks. */
export async function runIndexPass(): Promise<IndexPass> {
  const book = V2_BIDBOOK
  if (!V2_ENABLED || !book) throw new Error('v2 is not configured (NEXT_PUBLIC_V2_BIDBOOK / NEXT_PUBLIC_V2_LENS)')
  const db = getSupabaseAdmin()
  const client = serverPublicClient()

  const { data: cursor, error: cursorErr } = await db
    .from('v2_indexer_state').select('last_block').eq('id', CURSOR_ID).maybeSingle()
  if (cursorErr) throw new Error(`v2_indexer_state read: ${cursorErr.message}`)

  const head = (await client.getBlockNumber()) - CONFIRMATIONS
  const from = cursor ? BigInt(cursor.last_block) + 1n : V2_FROM_BLOCK
  const counts = { launches: 0, hookEvents: 0, bookEvents: 0, bids: 0 }
  if (from > head) return { from, to: head, head, caughtUp: true, counts }
  const to = from + PASS_SPAN - 1n > head ? head : from + PASS_SPAN - 1n

  // 1. New launches, so this same pass already covers their hooks' logs.
  const launchRows: Record<string, unknown>[] = []
  if (V2_FACTORIES.length > 0) {
    const logs = parseEventLogs({
      abi: V2_FACTORY_ABI,
      eventName: 'LaunchCreated',
      logs: await getLogsChunked(client, [...V2_FACTORIES], from, to),
    })
    for (const l of logs) {
      launchRows.push({
        tx_hash: l.transactionHash, log_index: l.logIndex, hook: lower(l.args.hook),
        kind: 'LaunchCreated', data: jsonArgs(l.args), block_number: Number(l.blockNumber),
      })
    }
  }
  await upsert('v2_project_events', launchRows, 'tx_hash,log_index')
  counts.launches = launchRows.length

  // 2. Hook events.
  const hooks = await knownHooks()
  const buys: Record<string, unknown>[] = []
  const lifecycle: Record<string, unknown>[] = []
  if (hooks.length > 0) {
    const logs = parseEventLogs({
      abi: V2_HOOK_ABI,
      eventName: [...HOOK_EVENTS],
      logs: await getLogsChunked(client, hooks, from, to),
    })
    for (const l of logs) {
      const base = { tx_hash: l.transactionHash, log_index: l.logIndex, hook: lower(l.address), block_number: Number(l.blockNumber) }
      if (l.eventName === 'GenesisBuy') {
        buys.push({
          ...base, buyer: lower(l.args.buyer), agent_key: l.args.agentKey,
          paid: l.args.paid.toString(), tokens: l.args.tokens.toString(), sold_after: l.args.soldAfter.toString(),
        })
      } else {
        lifecycle.push({ ...base, kind: l.eventName, data: jsonArgs(l.args as Record<string, unknown>) })
      }
    }
  }
  await upsert('v2_genesis_buys', buys, 'tx_hash,log_index')
  await upsert('v2_project_events', lifecycle, 'tx_hash,log_index')
  counts.hookEvents = buys.length + lifecycle.length

  // 3. Bid book events.
  const bookLogs = parseEventLogs({
    abi: V2_BIDBOOK_ABI,
    eventName: [...BOOK_EVENTS],
    logs: await getLogsChunked(client, book, from, to),
  })
  const placed = new Map<bigint, { hook: string; bidder: string; block: number; tx: string }>()
  const cancelled = new Set<bigint>()
  const touched = new Set<bigint>()
  const fills: Record<string, unknown>[] = []
  for (const l of bookLogs) {
    touched.add(l.args.bidId)
    if (l.eventName === 'BidPlaced') {
      placed.set(l.args.bidId, {
        hook: lower(l.args.hook), bidder: lower(l.args.bidder), block: Number(l.blockNumber), tx: l.transactionHash,
      })
    } else if (l.eventName === 'BidCancelled') {
      cancelled.add(l.args.bidId)
    } else {
      fills.push({
        tx_hash: l.transactionHash, log_index: l.logIndex, bid_id: l.args.bidId.toString(),
        hook: lower(l.args.hook), seller: lower(l.args.seller), qty: l.args.qty.toString(),
        price: l.args.price.toString(), gross: l.args.gross.toString(),
        buyer_fee: l.args.buyerFee.toString(), seller_fee: l.args.sellerFee.toString(),
        block_number: Number(l.blockNumber),
      })
    }
  }
  counts.bookEvents = bookLogs.length

  // Placement metadata for bids placed before this range lives in the table already.
  const ids = [...touched]
  const prior = new Map<string, { placed_block: number; placed_tx: string }>()
  const missing = ids.filter(id => !placed.has(id)).map(String)
  for (let i = 0; i < missing.length; i += 200) {
    const { data, error } = await db.from('v2_bids')
      .select('bid_id::text, placed_block, placed_tx').in('bid_id', missing.slice(i, i + 200))
    if (error) throw new Error(`v2_bids read: ${error.message}`)
    for (const r of (data ?? []) as unknown as { bid_id: string; placed_block: number; placed_tx: string }[]) {
      prior.set(r.bid_id, r)
    }
  }

  const bidRows: Record<string, unknown>[] = []
  for (let i = 0; i < ids.length; i += READ_BATCH) {
    const batch = ids.slice(i, i + READ_BATCH)
    const reads = await Promise.all(batch.map(id =>
      client.readContract({ address: book, abi: V2_BIDBOOK_ABI, functionName: 'bids', args: [id] }),
    ))
    batch.forEach((id, j) => {
      const [bidder, hook, , , price, qty, filled, escrow] = reads[j] as readonly [
        Address, Address, Address, Address, bigint, bigint, bigint, bigint,
      ]
      const p = placed.get(id)
      const q = prior.get(id.toString())
      bidRows.push({
        bid_id: id.toString(), hook: lower(hook), bidder: lower(bidder),
        price: price.toString(), qty: qty.toString(), filled: filled.toString(), escrow: escrow.toString(),
        status: cancelled.has(id) ? 'cancelled' : escrow === 0n ? 'filled' : 'open',
        placed_block: p?.block ?? q?.placed_block ?? Number(to),
        placed_tx: p?.tx ?? q?.placed_tx ?? '',
        updated_block: Number(to),
      })
    })
  }
  await upsert('v2_bids', bidRows, 'bid_id')
  await upsert('v2_fills', fills, 'tx_hash,log_index')
  counts.bids = bidRows.length

  const { error: cursorWriteErr } = await db.from('v2_indexer_state')
    .upsert({ id: CURSOR_ID, last_block: Number(to), updated_at: new Date().toISOString() }, { onConflict: 'id' })
  if (cursorWriteErr) throw new Error(`v2_indexer_state write: ${cursorWriteErr.message}`)

  return { from, to, head, caughtUp: to >= head, counts }
}

/** How far behind the index may be before read APIs refuse and clients scan the chain. */
export const MAX_INDEX_AGE_MS = 10 * 60_000

/** `null` when the index is fresh enough to answer from, else the reason it is not. */
export async function indexStaleness(): Promise<string | null> {
  if (!V2_ENABLED) return 'v2 is not configured'
  const { data, error } = await getSupabaseAdmin()
    .from('v2_indexer_state').select('updated_at').eq('id', CURSOR_ID).maybeSingle()
  if (error) return `index unavailable: ${error.message}`
  if (!data) return 'index has never run'
  const age = Date.now() - Date.parse(data.updated_at as string)
  return age > MAX_INDEX_AGE_MS ? `index is ${Math.round(age / 1000)}s old` : null
}
