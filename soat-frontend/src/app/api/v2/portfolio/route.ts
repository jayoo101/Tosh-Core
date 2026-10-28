/** GET /api/v2/portfolio?account= — one wallet's bids, sales into bids and GENESIS buys. */
import type { NextRequest } from 'next/server'

import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { BIG, addrParam, badParam, dbFailure, ok, readGate } from '@/app/lib/v2Read'

const MAX_ROWS = 200

export async function GET(req: NextRequest) {
  const account = addrParam(req, 'account')
  if (!account) return badParam('account')
  const gated = await readGate(req)
  if (gated) return gated

  const db = getSupabaseAdmin()
  const [bids, sales, buys] = await Promise.all([
    db.from('v2_bids').select(BIG.bid).eq('bidder', account).order('placed_block', { ascending: false }).limit(MAX_ROWS),
    db.from('v2_fills').select(BIG.fill).eq('seller', account).order('block_number', { ascending: false }).limit(MAX_ROWS),
    db.from('v2_genesis_buys').select(BIG.buy).eq('buyer', account).order('block_number', { ascending: false }).limit(MAX_ROWS),
  ])
  const failed = bids.error ?? sales.error ?? buys.error
  if (failed) return dbFailure('/api/v2/portfolio', failed)
  return ok({ bids: bids.data ?? [], sales: sales.data ?? [], buys: buys.data ?? [] })
}
