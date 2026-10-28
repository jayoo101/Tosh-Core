/** GET /api/v2/genesis-buys?hook=&buyer= — recent GENESIS purchases, newest first. */
import type { NextRequest } from 'next/server'

import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { BIG, addrParam, badParam, dbFailure, ok, readGate } from '@/app/lib/v2Read'

const MAX_ROWS = 200

export async function GET(req: NextRequest) {
  const hook = addrParam(req, 'hook')
  const buyer = addrParam(req, 'buyer')
  if (hook === null) return badParam('hook')
  if (buyer === null) return badParam('buyer')
  const gated = await readGate(req)
  if (gated) return gated

  let q = getSupabaseAdmin().from('v2_genesis_buys').select(BIG.buy).order('block_number', { ascending: false }).limit(MAX_ROWS)
  if (hook) q = q.eq('hook', hook)
  if (buyer) q = q.eq('buyer', buyer)
  const { data, error } = await q
  if (error) return dbFailure('/api/v2/genesis-buys', error)
  return ok({ buys: data ?? [] })
}
