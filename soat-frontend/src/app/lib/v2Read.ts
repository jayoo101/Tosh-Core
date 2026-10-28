import { NextResponse, type NextRequest } from 'next/server'

import { applyRateLimit } from '@/app/lib/apiGuard'
import { SupabaseAdminUnavailable } from '@/app/lib/supabaseAdmin'
import { indexStaleness } from '@/app/lib/v2Indexer'
import { reportError } from '@/lib/observability'

const ADDR = /^0x[0-9a-fA-F]{40}$/
const READ_LIMIT = { name: 'v2-read', capacity: 60, refillPerSec: 2 } as const

/** Big integers leave Postgres as text, or PostgREST rounds them through a double. */
export const BIG = {
  bid: 'bid_id::text, hook, bidder, price::text, qty::text, filled::text, escrow::text, status, placed_block, placed_tx, updated_block',
  fill: 'tx_hash, log_index, bid_id::text, hook, seller, qty::text, price::text, gross::text, buyer_fee::text, seller_fee::text, block_number',
  buy: 'tx_hash, log_index, hook, buyer, agent_key, paid::text, tokens::text, sold_after::text, block_number',
} as const

/** A lowercased address query parameter, `undefined` when absent, `null` when malformed. */
export function addrParam(req: NextRequest, name: string): string | undefined | null {
  const v = req.nextUrl.searchParams.get(name)?.trim()
  if (!v) return undefined
  return ADDR.test(v) ? v.toLowerCase() : null
}

/**
 * The shared preamble of every v2 read: rate limit, then refuse with 503 while
 * the index is stale, which is the client's cue to read the chain instead.
 */
export async function readGate(req: NextRequest): Promise<NextResponse | null> {
  const limited = await applyRateLimit(req, READ_LIMIT)
  if (limited) return limited
  let stale: string | null
  try {
    stale = await indexStaleness()
  } catch (err) {
    // A deployment without the service key: the client falls back to logs on any 503.
    if (err instanceof SupabaseAdminUnavailable) return NextResponse.json({ error: 'index not configured' }, { status: 503 })
    throw err
  }
  if (stale) return NextResponse.json({ error: stale }, { status: 503 })
  return null
}

export function dbFailure(route: string, err: { message: string }): NextResponse {
  reportError(new Error(err.message), { surface: 'api-route', extra: { route } })
  return NextResponse.json({ error: 'index unavailable' }, { status: 503 })
}

export const badParam = (name: string) => NextResponse.json({ error: `${name} is not an address` }, { status: 400 })

export const ok = (body: unknown) =>
  NextResponse.json(body, { headers: { 'cache-control': 'public, s-maxage=5, stale-while-revalidate=10' } })
