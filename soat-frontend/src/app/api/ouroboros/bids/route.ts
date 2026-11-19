/** GET /api/ouroboros/bids — open L1.5 bids, best price first. The page re-reads each from the contract. */
import type { NextRequest } from 'next/server'

import { ouroReadGate } from '@/app/lib/ouroRead'
import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { dbFailure, ok } from '@/app/lib/v2Read'

const LIMIT = 200

export async function GET(req: NextRequest) {
  const gated = await ouroReadGate(req)
  if (gated) return gated
  const { data, error } = await getSupabaseAdmin()
    .from('ouro_bids')
    .select('bid_id::text, buyer, price::text, usdt_amount::text, usdt_left::text, placed_block')
    .eq('status', 'open')
    .order('price', { ascending: false })
    .limit(LIMIT)
  if (error) return dbFailure('/api/ouroboros/bids', error)
  return ok({ bids: data ?? [] })
}
