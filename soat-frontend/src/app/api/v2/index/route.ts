/**
 * /api/v2/index — advance the v2 log index (see `app/lib/v2Indexer.ts`).
 *
 *   Authorization: Bearer <CRON_SECRET>   or   x-cron-secret: <CRON_SECRET>
 *
 * Runs passes until caught up or the time budget is spent, so any pinger
 * (Vercel cron, cron-job.org) can drive it. Read APIs refuse once the index is
 * `MAX_INDEX_AGE_MS` old, so a pinger every minute or two is what keeps the
 * market off the browser's slower chain-scan fallback.
 *
 *   401  no credential    403  wrong credential    503  not configured
 *   502  the RPC or the database failed mid-pass (the cursor did not move)
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { runIndexPass, type IndexPass } from '@/app/lib/v2Indexer'
import { reportError } from '@/lib/observability'

export const maxDuration = 60
const BUDGET_MS = 45_000

function credential(req: NextRequest): string | null {
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  return bearer || req.headers.get('x-cron-secret')?.trim() || null
}

/** Digests first, so the comparison is equal-length and leaks nothing, length included. */
function equal(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

const serialise = (p: IndexPass) => ({
  from: p.from.toString(), to: p.to.toString(), head: p.head.toString(), caughtUp: p.caughtUp, counts: p.counts,
})

async function handle(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) return NextResponse.json({ error: 'CRON_SECRET is unset' }, { status: 503 })
  const got = credential(req)
  if (!got) return NextResponse.json({ error: 'no credential' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } })
  if (!equal(got, expected)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const started = Date.now()
  const passes: ReturnType<typeof serialise>[] = []
  try {
    for (;;) {
      const p = await runIndexPass()
      passes.push(serialise(p))
      if (p.caughtUp || Date.now() - started > BUDGET_MS) break
    }
    return NextResponse.json({ ok: true, passes })
  } catch (err) {
    reportError(err, { surface: 'api-route', extra: { route: '/api/v2/index', passes: passes.length } })
    const message = err instanceof Error ? err.message : String(err)
    const status = /not configured/.test(message) ? 503 : 502
    return NextResponse.json({ error: message, passes }, { status })
  }
}

export const GET = handle
export const POST = handle
