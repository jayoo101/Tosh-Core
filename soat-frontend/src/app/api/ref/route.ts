/**
 * /api/ref — short referral codes.
 * ───────────────────────────────────────────────────────────────────────────
 *  GET  ?code=swift-amber-otter  → { address }   resolve, for `/r/[code]`
 *  POST { address }              → { code }      mint or return the existing one
 *
 *  ── The one thing this route must never do ────────────────────────────────
 *
 *  Resolve to the WRONG address. A referral binds a wallet to a referrer once,
 *  platform-wide and permanently, and pays that referrer a cut of every
 *  genesis deposit the wallet makes. So the failure modes are not symmetric:
 *
 *    • Failing to resolve costs the referrer a commission. Bad, recoverable,
 *      and the deposit still succeeds — `resolveReferrerNow` falls through to
 *      `ZERO_ADDRESS` and the factory sweeps the cut to the buyback reservoir.
 *    • Resolving to somebody else's address hands a stranger a permanent claim
 *      on that wallet's deposits. That is theft, and it cannot be undone.
 *
 *  Everything below is written for that asymmetry: exact matches only, no
 *  normalisation beyond lowercasing, no fuzzy or prefix lookup, and the
 *  address is re-validated on the way out of the database as well as on the
 *  way in. A row that fails validation is treated as no row.
 *
 *  ── Why minting needs no signature ───────────────────────────────────────
 *
 *  Minting a code for an address does not prove control of it, and does not
 *  need to: a code pointing at someone else's address pays THEM. There is
 *  nothing to gain, so the only abuse left is table spam, which is what the
 *  rate limit is for. What minting must NOT do is let the requester choose the
 *  words — see `generateRefCode`.
 *
 *  ── No chain_id ──────────────────────────────────────────────────────────
 *
 *  Unlike `projects`, a row here is chain-agnostic. It says "this word triple
 *  names this address" and nothing about a deployment, so the same code is
 *  correct on every chain the factory is deployed to.
 */

import { NextRequest, NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'

import { applyCors, applyRateLimit, corsPreflight, readJsonBody } from '@/app/lib/apiGuard'
import { getSupabaseAdmin, SupabaseAdminUnavailable } from '@/app/lib/supabaseAdmin'
import {
  supabase, REGISTRY_READ_DEADLINE_MS, REGISTRY_WRITE_DEADLINE_MS,
} from '@/app/lib/supabase'
import { generateRefCode, isRefCodeShape } from '@/lib/refCode'
import { reportError } from '@/lib/observability'

const CORS_OPTS = { methods: ['GET', 'POST', 'OPTIONS'] as const } as const

/** Read-only and on the critical path of a first page load, so generous. */
const GET_LIMIT = { name: 'ref-resolve', capacity: 60, refillPerSec: 10 } as const

/** A write, and one wallet only ever needs to succeed once. */
const POST_LIMIT = { name: 'ref-mint', capacity: 10, refillPerSec: 0.5 } as const

/** `{"address":"0x…"}` and nothing else. */
const MAX_BODY_BYTES = 256

/**
 * A code→address row is immutable once written, so a hit is cacheable for a
 * long time. A miss is not: the usual reason a code is unknown is that it was
 * minted a moment ago in another region, and a long negative TTL would make a
 * fresh link dead for exactly the people the sharer just gave it to.
 */
const HIT_CACHE = 'public, s-maxage=300, stale-while-revalidate=3600'
const MISS_CACHE = 'public, s-maxage=5'

/** Postgres unique violation. */
const UNIQUE_VIOLATION = '23505'

/** Draws before giving up. At the vocabulary's size this is astronomically
 *  generous; it exists so a corrupted generator cannot spin forever. */
const MINT_ATTEMPTS = 5

function json(body: unknown, init: ResponseInit, req: NextRequest) {
  return applyCors(NextResponse.json(body, init), req, CORS_OPTS)
}

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req, CORS_OPTS)
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — resolve a code
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const limited = await applyRateLimit(req, GET_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const code = (req.nextUrl.searchParams.get('code') ?? '').trim().toLowerCase()

  // Before any I/O, and shape-only by design — `isRefCodeShape` deliberately
  // does not check the word lists, so that growing them never invalidates a
  // code already pasted somewhere. See `src/lib/refCode.ts`.
  if (!isRefCodeShape(code)) {
    return json({ error: 'not a referral code' }, { status: 400, headers: { 'cache-control': MISS_CACHE } }, req)
  }

  // The ANON client, not the admin one: this is the read RLS was opened for,
  // and using the service role here would spend a key that bypasses RLS on a
  // query that does not need it.
  let row: { address: string } | null = null
  try {
    const { data, error } = await supabase
      .from('referral_codes')
      .select('address')
      .eq('code', code)
      // supabase-js has no default timeout and retries four times with
      // backoff, so an unreachable registry settles after ~14 s rather than
      // failing. This route is on the critical path of a shared link's first
      // paint, so it gets the read budget. See `checkSupabase.mjs`.
      .abortSignal(AbortSignal.timeout(REGISTRY_READ_DEADLINE_MS))
      .maybeSingle()

    // A registry that cannot answer is not a code that does not exist. The
    // difference matters: `/r/[code]` turns "unknown" into a redirect with no
    // referrer, which silently discards a real referral. 503 lets it say so.
    if (error) {
      reportError(error, { surface: 'api-route', extra: { route: 'GET /api/ref', stage: 'select' } })
      return json(
        { error: 'referral registry unreachable' },
        { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '5' } },
        req,
      )
    }
    row = (data as { address: string } | null) ?? null
  } catch (err) {
    reportError(err, { surface: 'api-route', extra: { route: 'GET /api/ref', stage: 'select' } })
    return json(
      { error: 'referral registry unreachable' },
      { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '5' } },
      req,
    )
  }

  if (!row) {
    return json({ error: 'not found' }, { status: 404, headers: { 'cache-control': MISS_CACHE } }, req)
  }

  // Re-validated on the way out. The column has a CHECK constraint, but this
  // value is about to be handed to a deposit as a payee and the cost of being
  // wrong is permanent — so it is verified where it is used, not trusted
  // because of where it came from.
  if (!isAddress(row.address)) {
    reportError(new Error('referral_codes row failed address validation'), {
      surface: 'api-route',
      extra: { route: 'GET /api/ref', code },
    })
    return json({ error: 'not found' }, { status: 404, headers: { 'cache-control': 'no-store' } }, req)
  }

  // Checksummed on the way out, because that is what `useReferral` stores and
  // compares against a connected wallet.
  return json({ address: getAddress(row.address) }, { headers: { 'cache-control': HIT_CACHE } }, req)
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — mint, or hand back the code this address already has
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const limited = await applyRateLimit(req, POST_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const body = await readJsonBody<{ address?: unknown }>(req, MAX_BODY_BYTES)
  if (body.error) return applyCors(body.error, req, CORS_OPTS)

  const raw = typeof body.data?.address === 'string' ? body.data.address.trim() : ''
  if (!isAddress(raw)) {
    return json({ error: 'address must be a 20-byte hex address' }, { status: 400 }, req)
  }

  // Lowercased for storage, which is what makes `address UNIQUE` mean one code
  // per wallet — wallets hand out EIP-55 mixed case, and `0xAbC…` and `0xabc…`
  // are two distinct TEXT values for one account. The column's CHECK enforces
  // the same thing from below.
  const address = raw.toLowerCase()

  // NAMED `supabaseWriter`, NOT `admin`, AND THAT IS LOAD-BEARING.
  // `checkSupabase.mjs` finds queries by matching an identifier CONTAINING
  // "supabase" before `.from(`, and says so in its own docstring: "a client
  // bound to a name with no 'supabase' in it is not seen." Bound to `admin`,
  // all three queries below were invisible to the guard — it reported 3 of 6
  // unbounded and the three it could not see were the ones on the write path.
  let supabaseWriter
  try {
    supabaseWriter = getSupabaseAdmin()
  } catch (err) {
    if (err instanceof SupabaseAdminUnavailable) {
      console.error('[Tosh API] referral code writer unavailable:', err.message)
      reportError(err, { surface: 'api-route', extra: { route: 'POST /api/ref', stage: 'getSupabaseAdmin' } })
      // The long `?ref=<address>` link still works, so this degrades the
      // cosmetics of sharing and nothing about who gets paid.
      return json(
        { error: 'short links are unavailable right now' },
        { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '5' } },
        req,
      )
    }
    throw err
  }

  try {
    // Fast path, and the common one: the panel asks again every time it
    // mounts, and the answer has to be the same code every time.
    const existing = await supabaseWriter
      .from('referral_codes')
      .select('code')
      .eq('address', address)
      .abortSignal(AbortSignal.timeout(REGISTRY_READ_DEADLINE_MS))
      .maybeSingle()

    if (existing.error) throw existing.error
    if (existing.data) {
      return json({ code: (existing.data as { code: string }).code }, { headers: { 'cache-control': 'no-store' } }, req)
    }

    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      const code = generateRefCode()
      const inserted = await supabaseWriter
        .from('referral_codes')
        .insert({ code, address })
        .select('code')
        // The write budget, unlike the two selects around it. Losing this
        // insert is not the same as losing a read: the caller gets a 503 and
        // falls back to the long link, so the cost is cosmetic — but the
        // retry loop around it means a short budget here multiplies.
        .abortSignal(AbortSignal.timeout(REGISTRY_WRITE_DEADLINE_MS))
        .maybeSingle()

      if (!inserted.error) {
        return json({ code }, { headers: { 'cache-control': 'no-store' } }, req)
      }

      if (inserted.error.code !== UNIQUE_VIOLATION) throw inserted.error

      // 23505 is either constraint, and rather than parse which one out of the
      // message, ask the question that distinguishes them: did this address
      // get a code in the meantime? Two tabs opening the panel at once is a
      // real and ordinary race, and the answer must be one shared code.
      const raced = await supabaseWriter
        .from('referral_codes')
        .select('code')
        .eq('address', address)
        .abortSignal(AbortSignal.timeout(REGISTRY_READ_DEADLINE_MS))
        .maybeSingle()

      if (raced.error) throw raced.error
      if (raced.data) {
        return json({ code: (raced.data as { code: string }).code }, { headers: { 'cache-control': 'no-store' } }, req)
      }

      // Otherwise the word triple was taken by a different address. Draw again.
    }

    // Out of attempts. Reported rather than shrugged off: at this vocabulary
    // size it means the table is far larger than the lists can comfortably
    // serve, and the fix is to extend NOUNS — see `src/lib/refCode.ts`.
    reportError(new Error(`referral code mint exhausted ${MINT_ATTEMPTS} attempts`), {
      surface: 'api-route',
      extra: { route: 'POST /api/ref' },
    })
    return json(
      { error: 'could not allocate a referral code' },
      { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '5' } },
      req,
    )
  } catch (err) {
    reportError(err, { surface: 'api-route', extra: { route: 'POST /api/ref', stage: 'mint' } })
    return json(
      { error: 'short links are unavailable right now' },
      { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '5' } },
      req,
    )
  }
}
