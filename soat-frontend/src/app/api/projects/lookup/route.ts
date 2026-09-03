/**
 * GET /api/projects/lookup?address=0x… — one project row, registry or chain.
 * ───────────────────────────────────────────────────────────────────────────
 *  This was the one route in the app that adopted none of `apiGuard`'s
 *  primitives: no rate limit, no CORS, no OPTIONS. That mattered more here
 *  than the "read-only" shape suggests, because a miss is not cheap. Every
 *  call that the registry cannot answer falls through to `getProjectFromChain`
 *  — `tokenToHook`, possibly `projectToken`, then a two-call multicall — so a
 *  caller iterating addresses turns one HTTP request into three RPC
 *  round-trips against the server's own quota. Exhaust that and server-side
 *  rendering breaks for real project pages.
 *
 *  The `s-maxage` header is not the protection. Its cache key is the address,
 *  so probing distinct addresses misses on every single request; and the 404
 *  path used to carry no cache header at all, making nonexistent addresses the
 *  cheapest thing to probe and the most expensive thing to serve.
 *
 *  Three changes, in the order they cut work:
 *    1. Reject a malformed address before any I/O. Free, and it removes the
 *       broadest class of junk.
 *    2. Rate-limit by client. Read-heavy, so the bucket is generous.
 *    3. Cache the 404 too. A negative answer is as cacheable as a positive one
 *       — a launch that does not exist at 12:00 does not exist at 12:00:15 —
 *       and this is what makes repeat probing of one address cost nothing.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getProject } from '@/app/lib/getProject'
import { applyCors, applyRateLimit, corsPreflight } from '@/app/lib/apiGuard'

const CORS_OPTS = { methods: ['GET', 'OPTIONS'] as const } as const

/** Read-only and client-driven — the directory hover path calls it often. */
const RATE_LIMIT = {
  name: 'projects-lookup',
  capacity: 60,
  refillPerSec: 10,
} as const

/** Shorter than the hit TTL: a project that just launched should appear quickly. */
const MISS_CACHE = 'public, s-maxage=10, stale-while-revalidate=30'
const HIT_CACHE = 'public, s-maxage=15, stale-while-revalidate=60'

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req, CORS_OPTS)
}

export async function GET(req: NextRequest) {
  const limited = await applyRateLimit(req, RATE_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const address = (req.nextUrl.searchParams.get('address') ?? '').trim()

  // Before any I/O. `getProject` validates too, but only after it has been
  // entered; refusing here keeps a malformed address off the RPC path entirely.
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return applyCors(
      NextResponse.json(
        { error: 'address must be a 20-byte hex address' },
        { status: 400, headers: { 'Cache-Control': MISS_CACHE } },
      ),
      req,
      CORS_OPTS,
    )
  }

  const found = await getProject(address)

  // 503, not 404. "We could not reach the chain" is not "this project does not
  // exist", and the client renders the two very differently — the loader turns
  // a 404 into "No launch at this address", which is a confident denial that a
  // real, funded project exists. `no-store` because the condition is transient
  // and must not be held by a CDN for the length of the miss TTL.
  if (found.status === 'unavailable') {
    return applyCors(
      NextResponse.json(
        { error: 'registry and chain both unreachable' },
        { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } },
      ),
      req,
      CORS_OPTS,
    )
  }

  if (found.status === 'not-found') {
    return applyCors(
      NextResponse.json(
        { error: 'not found' },
        { status: 404, headers: { 'Cache-Control': MISS_CACHE } },
      ),
      req,
      CORS_OPTS,
    )
  }

  return applyCors(
    NextResponse.json(found.row, { headers: { 'Cache-Control': HIT_CACHE } }),
    req,
    CORS_OPTS,
  )
}
