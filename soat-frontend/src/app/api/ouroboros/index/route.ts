/**
 * /api/ouroboros/index — advance the Ouroboros log index (see `app/lib/ouroIndexer.ts`).
 *
 *   Authorization: Bearer <CRON_SECRET>   or   x-cron-secret: <CRON_SECRET>
 *
 *   401  no credential    403  wrong credential    503  not configured
 *   502  the RPC or the database failed mid-pass (the cursor did not move)
 */
import { NextResponse, type NextRequest } from 'next/server'

import { cronGate } from '@/app/lib/cronAuth'
import { runOuroIndexPass, type OuroIndexPass } from '@/app/lib/ouroIndexer'
import { getSupabaseAdmin } from '@/app/lib/supabaseAdmin'
import { OURO_ENABLED } from '@/lib/ouroboros/config'
import { reportError } from '@/lib/observability'

export const maxDuration = 60
const BUDGET_MS = 45_000
const LOCK_NAME = 'ouro_index'

const serialise = (p: OuroIndexPass) => ({
  from: p.from.toString(), to: p.to.toString(), head: p.head.toString(), caughtUp: p.caughtUp, counts: p.counts,
})

async function handle(req: NextRequest): Promise<NextResponse> {
  const gated = cronGate(req)
  if (gated) return gated
  // The cron runs every minute before launch too; an unset deployment is not an error to report.
  if (!OURO_ENABLED) return NextResponse.json({ error: 'ouroboros is not configured (NEXT_PUBLIC_OURO_*)' }, { status: 503 })

  const started = Date.now()
  const passes: ReturnType<typeof serialise>[] = []
  let token: string | null = null
  try {
    // Two overlapping runs would both write the same range; the second one yields.
    const lock = await getSupabaseAdmin().rpc('ouro_try_lock', { lock_name: LOCK_NAME, seconds: maxDuration + 30 })
    if (lock.error) throw new Error(`ouro_try_lock: ${lock.error.message}`)
    token = lock.data as string | null
    if (!token) return NextResponse.json({ ok: true, skipped: 'another index run holds the lock', passes })
    for (;;) {
      const p = await runOuroIndexPass()
      passes.push(serialise(p))
      if (p.caughtUp || Date.now() - started > BUDGET_MS) break
    }
    return NextResponse.json({ ok: true, passes })
  } catch (err) {
    reportError(err, { surface: 'api-route', extra: { route: '/api/ouroboros/index', passes: passes.length } })
    const message = err instanceof Error ? err.message : String(err)
    const status = /not configured/.test(message) ? 503 : 502
    return NextResponse.json({ error: message, passes }, { status })
  } finally {
    if (token) await getSupabaseAdmin().rpc('ouro_release_lock', { lock_name: LOCK_NAME, token }).then(() => {}, () => {})
  }
}

export const GET = handle
export const POST = handle
