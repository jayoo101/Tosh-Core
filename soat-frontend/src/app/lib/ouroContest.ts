/**
 * Loads the mint index and writes `ouro_ref_contest_awards`.
 * Does not send tokens. Does not update `ouro_ref_payouts`.
 * A settlement row only records that a transfer which already exists
 * closed one prize.
 */
import type { PublicClient } from 'viem'

import { serverPublicClient } from '@/app/lib/serverRpc'
import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import {
  CONTEST_BONUS_WEI, CONTEST_END_SEC, CONTEST_START_SEC, allocateTransfer, findFirstBlockAtOrAfter, qualifyContest,
  type ContestAward, type ContestDecision, type ContestLink, type ContestMint,
} from '@/lib/ouroboros/contest'
import { OURO_FROM_BLOCK } from '@/lib/ouroboros/config'

const PAGE = 500

type DbError = { message: string } | null

function db() {
  return getSupabaseAdmin()
}

async function pages<T>(
  label: string,
  read: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: DbError }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await read(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const got = (data ?? []) as T[]
    rows.push(...got)
    if (got.length < PAGE) return rows
  }
}

function asNumber(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

async function blockTimestamp(client: PublicClient, block: number): Promise<number> {
  const got = await client.getBlock({ blockNumber: BigInt(block) })
  return Number(got.timestamp)
}

/** Fills transaction positions for mints that were indexed before this column existed. */
async function backfillTxIndex(client: PublicClient, startBlock: number): Promise<void> {
  const { data, error } = await db().from('ouro_mints')
    .select('tx_hash, block_number')
    .is('tx_index', null)
    .gte('block_number', startBlock)
    .limit(300)
  if (error) throw new Error(`mint tx index: ${error.message}`)
  const pending = (data ?? []) as { tx_hash: string; block_number: number }[]
  const wanted = new Set(pending.map(r => r.tx_hash.toLowerCase()))
  const blocks = [...new Set(pending.map(r => Number(r.block_number)))].slice(0, 20)
  for (const block of blocks) {
    const got = await client.getBlock({ blockNumber: BigInt(block) })
    const hashes = got.transactions as string[]
    for (let txIndex = 0; txIndex < hashes.length; txIndex++) {
      const hash = hashes[txIndex]!.toLowerCase()
      if (!wanted.has(hash)) continue
      const { error: upd } = await db().from('ouro_mints')
        .update({ tx_index: txIndex })
        .eq('tx_hash', hash)
        .eq('block_number', block)
        .is('tx_index', null)
      if (upd) throw new Error(`mint tx index write: ${upd.message}`)
    }
  }
}

async function loadInputs(client: PublicClient): Promise<{
  mints: ContestMint[]
  links: ContestLink[]
  reviews: ContestDecision[]
  bounds: { startBlock: number | null; endBlock: number | null; headBeforeEnd: boolean }
}> {
  const { data: saved, error } = await db().from('ouro_ref_contest_bounds')
    .select('start_block, end_block').eq('id', 1).maybeSingle()
  if (error) throw new Error(`contest bounds: ${error.message}`)
  if (!saved) throw new Error('contest bounds are not migrated')
  const head = Number(await client.getBlockNumber())
  const low = Math.max(1, Number(OURO_FROM_BLOCK || 1))
  const resolved = {
    startBlock: asNumber((saved as { start_block: unknown }).start_block),
    endBlock: asNumber((saved as { end_block: unknown }).end_block),
  }
  const headTs = await blockTimestamp(client, head)
  const headBeforeEnd = headTs < CONTEST_END_SEC
  let startBlock = resolved.startBlock
  let endBlock = resolved.endBlock
  if (startBlock == null && headTs >= CONTEST_START_SEC) {
    startBlock = await findFirstBlockAtOrAfter(low, head, CONTEST_START_SEC, b => blockTimestamp(client, b))
  }
  if (endBlock == null && !headBeforeEnd) {
    endBlock = await findFirstBlockAtOrAfter(startBlock ?? low, head, CONTEST_END_SEC, b => blockTimestamp(client, b))
  }
  if (startBlock !== resolved.startBlock || endBlock !== resolved.endBlock) {
    const { error: write } = await db().from('ouro_ref_contest_bounds').update({
      start_block: startBlock, end_block: endBlock, updated_at: new Date().toISOString(),
    }).eq('id', 1)
    if (write) throw new Error(`contest bounds write: ${write.message}`)
  }
  if (startBlock != null) await backfillTxIndex(client, startBlock)

  type MintRow = {
    tx_hash: string; log_index: number; tx_index: number | null; block_number: number
    stage: string; account: string; agent_key: string; shares: number; ref_code: string | null
  }
  const mintRows = await pages<MintRow>('mints', (from, to) => db().from('ouro_mints')
    .select('tx_hash, log_index, tx_index, block_number, stage, account, agent_key, shares, ref_code')
    .order('tx_hash', { ascending: true }).order('log_index', { ascending: true }).range(from, to))
  const linkRows = await pages<{ code: string; partner: string }>('links', (from, to) => db().from('ouro_ref_links')
    .select('code, partner').order('code', { ascending: true }).range(from, to))
  const bonusRows = await pages<{ code: string; effective_block: number }>('bonuses', (from, to) => db().from('ouro_ref_bonuses')
    .select('code, effective_block').order('id', { ascending: true }).range(from, to))
  const reviewRows = await pages<{
    agent_key: string; decision: ContestDecision['decision']; account: string | null
    code: string | null; partner: string | null; reviewed_at: string
  }>('reviews', (from, to) => db().from('ouro_ref_contest_reviews')
    .select('agent_key, decision, account, code, partner, reviewed_at')
    .order('reviewed_at', { ascending: true }).order('id', { ascending: true }).range(from, to))

  const firstBlock = new Map<string, number>()
  for (const b of bonusRows) {
    const block = Number(b.effective_block)
    const prev = firstBlock.get(b.code)
    if (prev == null || block < prev) firstBlock.set(b.code, block)
  }
  const links: ContestLink[] = linkRows
    .filter(l => firstBlock.has(l.code))
    .map(l => ({ code: l.code, partner: l.partner, effectiveBlock: firstBlock.get(l.code)! }))
  const mints: ContestMint[] = mintRows.map(r => ({
    txHash: r.tx_hash,
    logIndex: Number(r.log_index),
    txIndex: r.tx_index == null ? null : Number(r.tx_index),
    blockNumber: Number(r.block_number),
    stage: r.stage,
    account: r.account,
    agentKey: r.agent_key,
    shares: Number(r.shares),
    refCode: r.ref_code,
  }))
  const reviews: ContestDecision[] = reviewRows.map(r => ({
    agentKey: r.agent_key,
    decision: r.decision,
    account: r.account,
    code: r.code,
    partner: r.partner,
    at: r.reviewed_at,
  }))
  return { mints, links, reviews, bounds: { startBlock, endBlock, headBeforeEnd } }
}

function awardRow(a: ContestAward) {
  return {
    agent_key: a.agentKey,
    account: a.account,
    code: a.code,
    partner: a.partner,
    fill_tx_hash: a.fillTxHash,
    fill_log_index: a.fillLogIndex,
    fill_tx_index: a.fillTxIndex,
    fill_block: a.fillBlock,
    amount: a.amount,
    rank: a.rank,
    status: a.status,
    reason: a.reason,
    updated_at: new Date().toISOString(),
  }
}

/** Recomputes awards. Existing payout and settlement rows are left in place. */
export async function syncContestAwards(client: PublicClient = serverPublicClient()): Promise<number> {
  const { mints, links, reviews, bounds } = await loadInputs(client)
  const result = qualifyContest(mints, links, reviews, bounds)
  if (!result.boundsReady) return 0
  const rows = result.awards.map(awardRow)
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db().from('ouro_ref_contest_awards').upsert(rows.slice(i, i + 200), { onConflict: 'agent_key' })
    if (error) throw new Error(`contest awards: ${error.message}`)
  }
  const next = new Set(result.awards.map(a => a.agentKey))
  const existing = await pages<{ agent_key: string; status: string }>('awards', (from, to) => db().from('ouro_ref_contest_awards')
    .select('agent_key, status').order('agent_key', { ascending: true }).range(from, to))
  for (const row of existing) {
    if (next.has(row.agent_key) || row.status === 'withdrawn') continue
    const { error } = await db().from('ouro_ref_contest_awards')
      .update({ status: 'withdrawn', updated_at: new Date().toISOString() })
      .eq('agent_key', row.agent_key)
    if (error) throw new Error(`contest withdraw: ${error.message}`)
  }
  return result.awards.length
}

export interface RecordedTransfer {
  txHash: string
  logIndex: number
  to: string
  value: bigint
}

/**
 * Marks whole 5 USDT prizes covered by transfers that were already recorded.
 * Does not broadcast a transaction and does not change payout rows.
 */
export async function settleContestTransfers(transfers: RecordedTransfer[], recordedBy: string): Promise<number> {
  if (transfers.length === 0) return 0
  const awardRows = await pages<{
    agent_key: string; partner: string; amount: string; rank: number; status: string
    account: string; code: string; fill_tx_hash: string; fill_log_index: number; fill_tx_index: number; fill_block: number
    reason: string | null
  }>('awards', (from, to) => db().from('ouro_ref_contest_awards')
    .select('agent_key, partner, amount::text, rank, status, account, code, fill_tx_hash, fill_log_index, fill_tx_index, fill_block, reason')
    .order('rank', { ascending: true }).range(from, to))
  const settledRows = await pages<{ agent_key: string }>('settlements', (from, to) => db().from('ouro_ref_contest_settlements')
    .select('agent_key').order('agent_key', { ascending: true }).range(from, to))
  const awards: ContestAward[] = awardRows.map(r => ({
    agentKey: r.agent_key,
    account: r.account,
    code: r.code,
    partner: r.partner,
    fillTxHash: r.fill_tx_hash,
    fillLogIndex: Number(r.fill_log_index),
    fillTxIndex: Number(r.fill_tx_index),
    fillBlock: Number(r.fill_block),
    amount: r.amount,
    rank: Number(r.rank),
    status: r.status === 'payable' ? 'payable' : r.status === 'held' ? 'held' : 'over_cap',
    reason: r.reason,
  }))
  const settled = new Set(settledRows.map(r => r.agent_key))
  let wrote = 0
  for (const t of [...transfers].sort((a, b) => a.logIndex - b.logIndex)) {
    const pieces = allocateTransfer(awards, settled, t.to, t.value)
    for (const piece of pieces) {
      if (piece.amount !== CONTEST_BONUS_WEI) continue
      const { error } = await db().from('ouro_ref_contest_settlements').insert({
        agent_key: piece.agentKey,
        partner: t.to.toLowerCase(),
        amount: piece.amount.toString(),
        tx_hash: t.txHash.toLowerCase(),
        log_index: t.logIndex,
        recorded_by: recordedBy,
        reason: null,
      })
      if (error) {
        if (error.message.includes('duplicate') || (error as { code?: string }).code === '23505') {
          settled.add(piece.agentKey)
          continue
        }
        throw new Error(`contest settlement: ${error.message}`)
      }
      settled.add(piece.agentKey)
      wrote++
    }
  }
  return wrote
}
