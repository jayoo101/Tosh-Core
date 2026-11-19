/**
 * Ouroboros log indexer: OuroborosMint L1/L2 mints and OuroborosBidBook bids
 * and fills, into the tables of `supabase/migrations/0008_ouroboros.sql`.
 *
 * Same shape as `v2Indexer.ts`: event rows keyed on (tx_hash, log_index) and
 * upserted, a bid's mutable fields re-read from `bids(id)` rather than summed
 * from deltas, and the cursor written only after a range is fully stored.
 * A mint's referral code is the ef its event logged, and
 * the payout Safe's USDT transfers to registered partners are recorded as paid.
 */
import { parseAbiItem, parseEventLogs, type Address, type Log, type PublicClient } from 'viem'

import { serverPublicClient } from '@/app/lib/serverRpc'
import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { OURO_BIDBOOK_ABI, OURO_MINT_ABI } from '@/lib/ouroboros/abis'
import { storePartnerPayouts } from '@/app/lib/ouroRef'
import { OURO_BIDBOOK, OURO_ENABLED, OURO_FROM_BLOCK, OURO_MINT, OURO_REF_PAYER, OURO_USDT } from '@/lib/ouroboros/config'
import { decodeRefCode } from '@/lib/ouroboros/ref'
import { passEnd } from '@/lib/ouroboros/indexPlan'
import { BSC_ID, TARGET_CHAIN_ID } from '@/lib/chain'

const CURSOR_ID = 'ouroboros'
/** Depth used when the RPC does not answer the `finalized` tag. */
const FALLBACK_CONFIRMATIONS = 15n
const LOG_CHUNK = 2_000n
const PASS_SPAN = 20_000n
const READ_BATCH = 40
/** Blocks behind the head beyond which reads report the index as stale. */
export const OURO_MAX_INDEX_LAG_BLOCKS = 400n

/**
 * The newest block a reorg cannot undo. BSC finalises within a few blocks;
 * an endpoint without the tag falls back to a fixed depth.
 */
export async function indexHead(client: PublicClient): Promise<bigint> {
  try {
    return (await client.getBlock({ blockTag: 'finalized' })).number
  } catch {
    return (await client.getBlockNumber()) - FALLBACK_CONFIRMATIONS
  }
}

export interface OuroIndexPass {
  from: bigint
  to: bigint
  head: bigint
  caughtUp: boolean
  counts: { mints: number; bids: number; fills: number; payouts: number }
}

const lower = (a: string) => a.toLowerCase()

async function getLogsChunked(client: PublicClient, address: Address[], from: bigint, to: bigint): Promise<Log[]> {
  const out: Log[] = []
  for (let a = from; a <= to; a += LOG_CHUNK) {
    const b = a + LOG_CHUNK - 1n > to ? to : a + LOG_CHUNK - 1n
    out.push(...(await client.getLogs({ address, fromBlock: a, toBlock: b })))
  }
  return out
}

async function upsert(table: string, rows: Record<string, unknown>[], onConflict: string) {
  if (rows.length === 0) return
  const { error } = await getSupabaseAdmin().from(table).upsert(rows, { onConflict })
  if (error) throw new Error(`${table} upsert: ${error.message}`)
}

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

/** The payout Safe's USDT transfers in [from, to] that paid a registered partner. */
async function indexPayouts(client: PublicClient, from: bigint, to: bigint): Promise<number> {
  if (!OURO_REF_PAYER || !OURO_USDT) return 0
  const transfers = []
  for (let a = from; a <= to; a += LOG_CHUNK) {
    const b = a + LOG_CHUNK - 1n > to ? to : a + LOG_CHUNK - 1n
    const logs = await client.getLogs({ address: OURO_USDT, event: TRANSFER, args: { from: OURO_REF_PAYER }, fromBlock: a, toBlock: b })
    for (const l of logs) {
      transfers.push({ txHash: l.transactionHash, logIndex: l.logIndex, to: l.args.to!, value: l.args.value!, blockNumber: l.blockNumber })
    }
  }
  return storePartnerPayouts(transfers, 'indexer')
}

export async function runOuroIndexPass(): Promise<OuroIndexPass> {
  const mint = OURO_MINT
  const book = OURO_BIDBOOK
  if (!OURO_ENABLED || !mint || !book) throw new Error('ouroboros is not configured (NEXT_PUBLIC_OURO_*)')
  if (OURO_FROM_BLOCK === 0n && TARGET_CHAIN_ID === BSC_ID) throw new Error('ouroboros is not configured: NEXT_PUBLIC_OURO_FROM_BLOCK is unset')
  const db = getSupabaseAdmin()
  const client = serverPublicClient()

  const { data: cursor, error: cursorErr } = await db
    .from('v2_indexer_state').select('last_block').eq('id', CURSOR_ID).maybeSingle()
  if (cursorErr) throw new Error(`v2_indexer_state read: ${cursorErr.message}`)

  const head = await indexHead(client)
  const from = cursor ? BigInt(cursor.last_block) + 1n : OURO_FROM_BLOCK
  const counts = { mints: 0, bids: 0, fills: 0, payouts: 0 }
  if (from > head) return { from, to: head, head, caughtUp: true, counts }
  const spanEnd = from + PASS_SPAN - 1n > head ? head : from + PASS_SPAN - 1n

  const fetched = await getLogsChunked(client, [mint, book], from, spanEnd)
  const isMint = (l: Log) => lower(l.address) === lower(mint)
  const to = passEnd(
    fetched.filter(isMint).map(l => ({ hash: l.transactionHash!, block: l.blockNumber! })), from, spanEnd,
  )
  const logs = fetched.filter(l => l.blockNumber! <= to)
  const mintLogs = parseEventLogs({
    abi: OURO_MINT_ABI,
    eventName: ['L1Minted', 'L2Minted'],
    logs: logs.filter(isMint),
  })
  const bookLogs = parseEventLogs({
    abi: OURO_BIDBOOK_ABI,
    eventName: ['BidPlaced', 'BidFilled', 'BidCancelled'],
    logs: logs.filter(l => lower(l.address) === lower(book)),
  })

  const mints: Record<string, unknown>[] = mintLogs.map(l => {
    const base = {
      tx_hash: l.transactionHash, log_index: l.logIndex, account: lower(l.args.user), agent_key: l.args.agentKey,
      ref_code: decodeRefCode(l.args.ref),
      shares: Number(l.args.shares), cost: l.args.cost.toString(), paid_in_bnb: l.args.paidInBnb,
      block_number: Number(l.blockNumber),
    }
    return l.eventName === 'L1Minted'
      ? { ...base, stage: 'L1', tokens: '0', first_share: null }
      : { ...base, stage: 'L2', tokens: l.args.tokens.toString(), first_share: Number(l.args.firstShare) }
  })
  await upsert('ouro_mints', mints, 'tx_hash,log_index')
  counts.mints = mints.length

  const placedAt = new Map<bigint, number>()
  const cancelled = new Set<bigint>()
  const touched = new Set<bigint>()
  const fills: Record<string, unknown>[] = []
  for (const l of bookLogs) {
    touched.add(l.args.id)
    if (l.eventName === 'BidPlaced') placedAt.set(l.args.id, Number(l.blockNumber))
    else if (l.eventName === 'BidCancelled') cancelled.add(l.args.id)
    else {
      fills.push({
        tx_hash: l.transactionHash, log_index: l.logIndex, bid_id: l.args.id.toString(),
        buyer: lower(l.args.buyer), seller: lower(l.args.seller), tokens: l.args.tokens.toString(),
        usdt_gross: l.args.usdtGross.toString(), block_number: Number(l.blockNumber),
      })
    }
  }

  const ids = [...touched]
  const priorAmount = new Map<string, { placed_block: number; usdt_amount: string }>()
  const missing = ids.filter(id => !placedAt.has(id)).map(String)
  for (let i = 0; i < missing.length; i += 200) {
    const { data, error } = await db.from('ouro_bids')
      .select('bid_id::text, placed_block, usdt_amount::text').in('bid_id', missing.slice(i, i + 200))
    if (error) throw new Error(`ouro_bids read: ${error.message}`)
    for (const r of (data ?? []) as unknown as { bid_id: string; placed_block: number; usdt_amount: string }[]) {
      priorAmount.set(r.bid_id, r)
    }
  }
  const placedAmount = new Map<bigint, string>()
  for (const l of bookLogs) if (l.eventName === 'BidPlaced') placedAmount.set(l.args.id, l.args.usdtAmount.toString())

  const bidRows: Record<string, unknown>[] = []
  for (let i = 0; i < ids.length; i += READ_BATCH) {
    const batch = ids.slice(i, i + READ_BATCH)
    const reads = await Promise.all(batch.map(id =>
      client.readContract({ address: book, abi: OURO_BIDBOOK_ABI, functionName: 'bids', args: [id] }),
    ))
    batch.forEach((id, j) => {
      const [buyer, price, usdtLeft] = reads[j]
      const prior = priorAmount.get(id.toString())
      bidRows.push({
        bid_id: id.toString(), buyer: lower(buyer), price: price.toString(),
        usdt_amount: placedAmount.get(id) ?? prior?.usdt_amount ?? usdtLeft.toString(),
        usdt_left: usdtLeft.toString(),
        status: cancelled.has(id) ? 'cancelled' : usdtLeft === 0n ? 'filled' : 'open',
        placed_block: placedAt.get(id) ?? prior?.placed_block ?? Number(to),
        updated_block: Number(to),
      })
    })
  }
  await upsert('ouro_bids', bidRows, 'bid_id')
  await upsert('ouro_fills', fills, 'tx_hash,log_index')
  counts.bids = bidRows.length
  counts.fills = fills.length
  counts.payouts = await indexPayouts(client, from, to)

  const { error: cursorWriteErr } = await db.from('v2_indexer_state')
    .upsert({ id: CURSOR_ID, last_block: Number(to), updated_at: new Date().toISOString() }, { onConflict: 'id' })
  if (cursorWriteErr) throw new Error(`v2_indexer_state write: ${cursorWriteErr.message}`)

  return { from, to, head, caughtUp: to >= head, counts }
}

export const OURO_MAX_INDEX_AGE_MS = 10 * 60_000

/** Why the index cannot be served as current, or null: it must have run lately and be near the head. */
export async function ouroIndexStaleness(): Promise<string | null> {
  if (!OURO_ENABLED) return 'ouroboros is not configured'
  const { data, error } = await getSupabaseAdmin()
    .from('v2_indexer_state').select('last_block, updated_at').eq('id', CURSOR_ID).maybeSingle()
  if (error) return `index unavailable: ${error.message}`
  if (!data) return 'index has never run'
  const age = Date.now() - Date.parse(data.updated_at as string)
  if (age > OURO_MAX_INDEX_AGE_MS) return `index is ${Math.round(age / 1000)}s old`
  const head = await indexHead(serverPublicClient()).catch(() => null)
  if (head === null) return null
  const lag = head - BigInt(data.last_block as number)
  return lag > OURO_MAX_INDEX_LAG_BLOCKS ? `index is ${lag} blocks behind` : null
}
