/**
 * GET /api/v2/bids?hook=&bidder=&status=open|all
 *
 * Which bid ids exist, from the index. The client re-reads every id from the
 * contract, so this answers "what to look at", never "what is true".
 * 503 while the index is stale — the client then scans logs itself.
 */
import type { NextRequest } from 'next/server'

import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { BIG, addrParam, badParam, dbFailure, ok, readGate } from '@/app/lib/v2Read'

const MAX_ROWS = 500

export async function GET(req: NextRequest) {
  const hook = addrParam(req, 'hook')
  const bidder = addrParam(req, 'bidder')
  if (hook === null) return badParam('hook')
  if (bidder === null) return badParam('bidder')
  const gated = await readGate(req)
  if (gated) return gated

  let q = getSupabaseAdmin().from('v2_bids').select(BIG.bid).order('placed_block', { ascending: false }).limit(MAX_ROWS)
  if (hook) q = q.eq('hook', hook)
  if (bidder) q = q.eq('bidder', bidder)
  if (req.nextUrl.searchParams.get('status') !== 'all') q = q.eq('status', 'open')
  const { data, error } = await q
  if (error) return dbFailure('/api/v2/bids', error)
  return ok({ bids: data ?? [] })
}
