/** GET /api/v2/volume?hook= — all-time bid-book fill volume for one launch. */
import type { NextRequest } from 'next/server'

import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { addrParam, badParam, dbFailure, ok, readGate } from '@/app/lib/v2Read'

/** PostgREST's default row cap; a shorter page means the last one. */
const PAGE = 1000

export async function GET(req: NextRequest) {
  const hook = addrParam(req, 'hook')
  if (!hook) return badParam('hook')
  const gated = await readGate(req)
  if (gated) return gated

  let gross = 0n
  let fees = 0n
  let count = 0
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getSupabaseAdmin()
      .from('v2_fills')
      .select('gross::text, buyer_fee::text, seller_fee::text')
      .eq('hook', hook)
      .order('block_number', { ascending: true })
      .order('log_index', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return dbFailure('/api/v2/volume', error)
    const rows = (data ?? []) as { gross: string; buyer_fee: string; seller_fee: string }[]
    for (const r of rows) {
      gross += BigInt(r.gross)
      fees += BigInt(r.buyer_fee) + BigInt(r.seller_fee)
    }
    count += rows.length
    if (rows.length < PAGE) break
  }
  return ok({ count, gross: gross.toString(), fees: fees.toString() })
}
