/**
 * POST /api/admin/featured — pin one launch to the top of the homepage teaser.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * `AgentDirectoryHome` ranks the three launches in "Active markets" by amount
 * raised, and gives the first one a double-width card. Early in a deployment
 * every raise sits near zero, so that slot goes to whoever deposits one more
 * unit of quote than the current leader — and a raise too small to carry a
 * ladder refunds when its window closes, so the deposit can be taken back
 * afterwards. The most prominent slot on the site was rentable for gas.
 *
 * This route is the editorial override: it writes `projects.featured_until`,
 * and a row whose value is in the future sorts first. See
 * `supabase/migrations/0005_projects_featured.sql` for why the column is an
 * expiry rather than a flag.
 *
 * ── Authorisation, and why it is not the owner signature ──────────────────
 *
 * `POST /api/admin/config` authenticates by recovering an owner signature and
 * checking it against `ToshFactory.owner()` — correct there, because everything
 * that route changes is a protocol dial. This is not a protocol dial. Nothing
 * here touches a contract, moves a balance, or changes what any launch can do;
 * it changes which of three eligible cards is drawn widest.
 *
 * Putting it behind the owner path would price it at a 2-of-3 Safe signature
 * collected across two devices, for a decision that is reversed by waiting.
 * And it would not work from the admin page at all: `/admin` connects through
 * `injected()` alone, so the browser can never hold the Safe's pen — the reason
 * `ExchangeRatePanel` renders a blocker instead of a button and the working
 * path for the PoG rate is a CLI script.
 *
 * So this takes a bearer credential of its own, `CONTENT_ADMIN_SECRET`, and
 * the separation is the point rather than a shortcut: a token that can reorder
 * a teaser cannot pause the factory, and the credential that can pause the
 * factory is not typed into a browser to promote a project. `bearerMatches`
 * is shared with the config route, including its refusal to accept a
 * credential that is not actually a secret.
 *
 * UNSET MEANS CLOSED. With no `CONTENT_ADMIN_SECRET` the route 503s and the
 * homepage keeps its computed order, which is the posture a deployment that
 * has not decided about this should have.
 */

import { NextRequest, NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'

import { bearerMatches } from '@/app/lib/adminBearer'
import { getSupabaseAdmin, SupabaseAdminUnavailable } from '@/app/lib/supabaseAdmin'
import { REGISTRY_WRITE_DEADLINE_MS } from '@/app/lib/supabase'
import { applyCors, applyRateLimit, corsPreflight, readJsonBody } from '@/app/lib/apiGuard'
import { targetChain } from '@/lib/chain'
import { reportError } from '@/lib/observability'

const CORS_OPTS = { methods: ['POST', 'OPTIONS'] as const } as const

/** An operator clicking a button, not a service. Tight on purpose. */
const RATE_LIMIT = {
  name: 'admin-featured',
  capacity: 10,
  refillPerSec: 0.2,
} as const

const CONTENT_ADMIN_SECRET = process.env.CONTENT_ADMIN_SECRET ?? ''

const BEARER_LABEL = { route: 'admin/featured', varName: 'CONTENT_ADMIN_SECRET' } as const

/**
 * The longest a pin may run, in hours. Fourteen days.
 *
 * A ceiling rather than a guess at the right length: the panel offers 6h, 24h,
 * 72h and 7d, and this exists so that a hand-rolled request cannot write a
 * value so far out that the expiry stops being an expiry. A pin good for a year
 * is the boolean this column was chosen over, spelled differently.
 */
const MAX_PIN_HOURS = 24 * 14

export interface FeaturedPayload {
  /** The launch's ERC-20 address, as it appears in the registry. */
  tokenAddress: string
  /** How long the pin should last. `0` clears the pin on this launch. */
  hours: number
}

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req, CORS_OPTS)
}

export async function POST(req: NextRequest) {
  const limited = await applyRateLimit(req, RATE_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  // Before the body is read, so a caller without the credential learns nothing
  // about what shape the body should be.
  if (CONTENT_ADMIN_SECRET.length === 0) {
    console.error(
      '[admin/featured] CONTENT_ADMIN_SECRET is unset, so pinning is disabled and the ' +
      'homepage keeps its computed order. Set it in the server environment to enable this.',
    )
    return applyCors(
      NextResponse.json(
        { error: 'Featuring is not configured on this deployment' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      ),
      req,
      CORS_OPTS,
    )
  }

  if (!bearerMatches(req.headers.get('authorization'), CONTENT_ADMIN_SECRET, BEARER_LABEL)) {
    return applyCors(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      req,
      CORS_OPTS,
    )
  }

  const parsed = await readJsonBody<FeaturedPayload>(req)
  if (parsed.error) return applyCors(parsed.error, req, CORS_OPTS)
  const { tokenAddress, hours } = parsed.data

  if (typeof tokenAddress !== 'string' || !isAddress(tokenAddress)) {
    return applyCors(
      NextResponse.json({ error: 'tokenAddress must be an EVM address' }, { status: 422 }),
      req,
      CORS_OPTS,
    )
  }

  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > MAX_PIN_HOURS) {
    return applyCors(
      NextResponse.json(
        { error: `hours must be between 0 and ${MAX_PIN_HOURS}` },
        { status: 422 },
      ),
      req,
      CORS_OPTS,
    )
  }

  let supabaseAdmin
  try {
    supabaseAdmin = getSupabaseAdmin()
  } catch (err) {
    if (err instanceof SupabaseAdminUnavailable) {
      console.error('[admin/featured] registry writer unavailable:', err.message)
      reportError(err, {
        surface: 'api-route',
        extra: { route: 'POST /api/admin/featured', stage: 'getSupabaseAdmin' },
      })
      return applyCors(
        NextResponse.json(
          { error: 'The project registry is not accepting writes right now' },
          { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '5' } },
        ),
        req,
        CORS_OPTS,
      )
    }
    throw err
  }

  // Checksummed, because `token_address` was written by `POST /api/projects`
  // straight from the receipt and viem returns the checksummed form there. The
  // panel round-trips the address it read out of the same table, so this only
  // matters for a hand-rolled request typed in lowercase — which would
  // otherwise match no row and be reported as "unknown launch".
  const token = getAddress(tokenAddress)

  const { data: row, error: lookupError } = await supabaseAdmin
    .from('projects')
    .select('token_address, symbol')
    .eq('chain_id', targetChain.id)
    .eq('token_address', token)
    .abortSignal(AbortSignal.timeout(REGISTRY_WRITE_DEADLINE_MS))
    .maybeSingle()

  if (lookupError) {
    console.error('[admin/featured] lookup failed:', lookupError)
    reportError(lookupError, {
      surface: 'api-route',
      extra: { route: 'POST /api/admin/featured', stage: 'lookup', code: lookupError.code },
    })
    return applyCors(
      NextResponse.json({ error: 'Could not read the registry' }, { status: 500 }),
      req,
      CORS_OPTS,
    )
  }

  // A 404 rather than a write that succeeds against nothing. Pinning a launch
  // that has no registry row is the failure this catches: the write would
  // report success, and the homepage would be unchanged with no indication why.
  if (!row) {
    return applyCors(
      NextResponse.json(
        {
          error:
            'No launch with that token address is listed on this chain. Only launches ' +
            'whose creator published metadata can be featured.',
        },
        { status: 404 },
      ),
      req,
      CORS_OPTS,
    )
  }

  // ── Clearing every other pin is part of setting one ───────────────────────
  //
  // The sort tolerates several pinned rows — it puts them all ahead of the
  // computed order and ranks them among themselves by amount raised — so
  // nothing breaks if two exist. What breaks is the operator's model: they
  // pinned a project, it did not take the big card, and the reason is a pin
  // set weeks ago on something else. "Pin this one" has to mean "and not the
  // others" for the control to be usable without reading the table.
  //
  // Done before the set, and not conditioned on the set succeeding, because the
  // orders are only wrong in one direction. Clearing first and failing leaves
  // no pin, which is the page's default state. Setting first and failing to
  // clear leaves two, which is the confusing state above.
  const clearing = hours === 0
  const { error: clearError } = await supabaseAdmin
    .from('projects')
    .update({ featured_until: null })
    .eq('chain_id', targetChain.id)
    .not('featured_until', 'is', null)
    .abortSignal(AbortSignal.timeout(REGISTRY_WRITE_DEADLINE_MS))

  if (clearError) {
    console.error('[admin/featured] could not clear existing pins:', clearError)
    reportError(clearError, {
      surface: 'api-route',
      extra: { route: 'POST /api/admin/featured', stage: 'clear', code: clearError.code },
    })
    return applyCors(
      NextResponse.json({ error: 'Could not update the registry' }, { status: 500 }),
      req,
      CORS_OPTS,
    )
  }

  if (clearing) {
    console.log(`[admin/featured] pins cleared (requested via ${row.symbol})`)
    return applyCors(
      NextResponse.json({ ok: true, featuredUntil: null, symbol: row.symbol }, { status: 200 }),
      req,
      CORS_OPTS,
    )
  }

  // Server clock, not the caller's. A browser with a skewed clock would
  // otherwise set an expiry that is already past, or months out.
  const featuredUntil = new Date(Date.now() + hours * 3_600_000).toISOString()

  const { error: setError } = await supabaseAdmin
    .from('projects')
    .update({ featured_until: featuredUntil })
    .eq('chain_id', targetChain.id)
    .eq('token_address', token)
    .abortSignal(AbortSignal.timeout(REGISTRY_WRITE_DEADLINE_MS))

  if (setError) {
    console.error('[admin/featured] could not set the pin:', setError)
    reportError(setError, {
      surface: 'api-route',
      extra: { route: 'POST /api/admin/featured', stage: 'set', code: setError.code },
    })
    return applyCors(
      NextResponse.json({ error: 'Could not update the registry' }, { status: 500 }),
      req,
      CORS_OPTS,
    )
  }

  console.log(`[admin/featured] ${row.symbol} pinned until ${featuredUntil}`)
  return applyCors(
    NextResponse.json({ ok: true, featuredUntil, symbol: row.symbol }, { status: 200 }),
    req,
    CORS_OPTS,
  )
}
