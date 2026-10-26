/** GET /api/v2/trades?hook=&seller= — recent bid fills, newest first. */
import type { NextRequest } from 'next/server'

import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { BIG, addrParam, badParam, dbFailure, ok, readGate } from '@/app/lib/v2Read'

const MAX_ROWS = 200

export async function GET(req: NextRequest) {
  const hook = addrParam(req, 'hook')
  const seller = addrParam(req, 'seller')
  if (hook === null) return badParam('hook')
  if (seller === null) return badParam('seller')
  const gated = await readGate(req)
  if (gated) return gated

  let q = getSupabaseAdmin().from('v2_fills').select(BIG.fill).order('block_number', { ascending: false }).limit(MAX_ROWS)
  if (hook) q = q.eq('hook', hook)
  if (seller) q = q.eq('seller', seller)
  const { data, error } = await q
  if (error) return dbFailure('/api/v2/trades', error)
  return ok({ trades: data ?? [] })
}
