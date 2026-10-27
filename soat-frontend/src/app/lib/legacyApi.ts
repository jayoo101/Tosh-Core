import { LEGACY_V1 } from '@/lib/legacy'

/**
 * `404` for a v1-only route once v2 is configured, `null` otherwise.
 *
 * The v1 pages redirect away, but a route handler is still reachable by URL.
 * Left open, PoG scans and referral minting would keep spending Blockscout
 * credits, RPC and database rows on a flow nobody can use.
 */
export function legacyGone(): Response | null {
  if (LEGACY_V1) return null
  return Response.json({ error: 'Not found' }, { status: 404 })
}
