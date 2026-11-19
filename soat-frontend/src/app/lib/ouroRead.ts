import { NextResponse, type NextRequest } from 'next/server'

import { applyRateLimit } from '@/app/lib/apiGuard'
import { ouroIndexStaleness } from '@/app/lib/ouroIndexer'
import { SupabaseAdminUnavailable } from '@/app/lib/supabaseAdmin'

const READ_LIMIT = { name: 'ouro-read', capacity: 60, refillPerSec: 2 } as const

/** Rate limit, then 503 while the index is stale — the client's cue to show the chain-read fallback. */
export async function ouroReadGate(req: NextRequest): Promise<NextResponse | null> {
  const limited = await applyRateLimit(req, READ_LIMIT)
  if (limited) return limited
  let stale: string | null
  try {
    stale = await ouroIndexStaleness()
  } catch (err) {
    if (err instanceof SupabaseAdminUnavailable) return NextResponse.json({ error: 'index not configured' }, { status: 503 })
    throw err
  }
  if (stale) return NextResponse.json({ error: stale }, { status: 503 })
  return null
}
