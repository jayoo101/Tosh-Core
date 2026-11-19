/**
 * POST /api/ouroboros/ref — partner referrals (see `app/lib/ouroRef.ts`).
 *
 *   { request: RefAction, issuedAt: number, address, signature }
 *
 * `signature` is the wallet's signature over `refMessage(request, issuedAt)`.
 * `view` returns the signer's own links; every other action needs a signer of
 * the treasury Safe and returns the full report after it is applied.
 *
 * Admin actions run only where `OURO_REF_ADMIN=1` is set, which is meant to be
 * a signer's own machine running the site locally; the public deployment
 * leaves it unset and serves partners their views alone.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { applyRateLimit, readJsonBody } from '@/app/lib/apiGuard'
import { autopayState } from '@/app/lib/ouroAutopay'
import {
  approvePayout, createLink, isSafeSigner, parseRefAction, recordPayout, RefError, refReport, setRate, verifyRefSigner,
} from '@/app/lib/ouroRef'
import { SupabaseAdminUnavailable } from '@/app/lib/supabaseAdmin'
import { reportError } from '@/lib/observability'

const RATE_LIMIT = { name: 'ouro-ref', capacity: 20, refillPerSec: 0.5 } as const
const PRIVATE = { 'cache-control': 'no-store' }

interface Body { request?: unknown; issuedAt?: unknown; address?: unknown; signature?: unknown }

export async function POST(req: NextRequest) {
  const limited = await applyRateLimit(req, RATE_LIMIT)
  if (limited) return limited
  const parsed = await readJsonBody<Body>(req)
  if (parsed.error) return parsed.error
  const body = parsed.data

  try {
    const request = parseRefAction(body.request)
    const signer = await verifyRefSigner(request, body.issuedAt, body.address, body.signature)

    if (request.action === 'view') {
      return NextResponse.json({ role: 'partner', report: await refReport(signer) }, { headers: PRIVATE })
    }
    if (process.env.OURO_REF_ADMIN !== '1') throw new RefError(403, 'referral admin is disabled on this deployment')
    if (!(await isSafeSigner(signer))) throw new RefError(403, 'only a signer of the treasury Safe can do this')

    let recorded: number | undefined
    if (request.action === 'createLink') await createLink(request, signer)
    else if (request.action === 'setRate') await setRate(request, signer)
    else if (request.action === 'recordPayout') recorded = await recordPayout(request, signer)
    else if (request.action === 'approvePayout') await approvePayout(request, signer, body.issuedAt as number)
    if (request.action !== 'list') console.log(`[ouro-ref] ${request.action} by ${signer}`)

    const [report, autopay] = await Promise.all([refReport(), autopayState()])
    return NextResponse.json({ role: 'admin', recorded, report, autopay }, { headers: PRIVATE })
  } catch (err) {
    if (err instanceof RefError) return NextResponse.json({ error: err.message }, { status: err.status, headers: PRIVATE })
    if (err instanceof SupabaseAdminUnavailable) {
      return NextResponse.json({ error: 'referrals are not configured' }, { status: 503, headers: PRIVATE })
    }
    reportError(err, { surface: 'api-route', extra: { route: 'POST /api/ouroboros/ref' } })
    return NextResponse.json({ error: 'referral service failed' }, { status: 502, headers: PRIVATE })
  }
}
