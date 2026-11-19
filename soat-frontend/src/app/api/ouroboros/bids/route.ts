/** GET /api/ouroboros/bids — open L1.5 bids, best price first. The page re-reads each from the contract. */
import type { NextRequest } from 'next/server'

import { ouroReadGate } from '@/app/lib/ouroRead'
import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { dbFailure, ok } from '@/app/lib/v2Read'

const LIMIT = 200
const FILL_PAGE = 1_000

/** Highest fill price (USDT wei per token) from indexed fills: usdt_gross · 1e18 / tokens. */
function highFillPrice(rows: { tokens: string; usdt_gross: string }[]): string | null {
  let high = 0n
  for (const r of rows) {
    const tokens = BigInt(r.tokens)
    if (tokens === 0n) continue
    const price = (BigInt(r.usdt_gross) * 10n ** 18n) / tokens
    if (price > high) high = price
  }
  return high === 0n ? null : high.toString()
}

export async function GET(req: NextRequest) {
  const gated = await ouroReadGate(req)
  if (gated) return gated
  const db = getSupabaseAdmin()
  const [bids, fills] = await Promise.all([
    db.from('ouro_bids')
      .select('bid_id::text, buyer, price::text, usdt_amount::text, usdt_left::text, placed_block')
      .eq('status', 'open')
      .order('price', { ascending: false })
      .limit(LIMIT),
    db.from('ouro_fills')
      .select('tokens::text, usdt_gross::text')
      .order('block_number', { ascending: false })
      .limit(FILL_PAGE),
  ])
  if (bids.error) return dbFailure('/api/ouroboros/bids', bids.error)
  if (fills.error) return dbFailure('/api/ouroboros/bids', fills.error)
  return ok({
    bids: bids.data ?? [],
    highFill: highFillPrice((fills.data ?? []) as { tokens: string; usdt_gross: string }[]),
  })
}
