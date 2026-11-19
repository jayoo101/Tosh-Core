/**
 * /api/ouroboros/ref/autopay — one automatic rebate payout run (see `app/lib/ouroAutopay.ts`).
 *
 *   Authorization: Bearer <CRON_SECRET>   or   x-cron-secret: <CRON_SECRET>
 *
 * 200 with the run's outcome, including `held` and `short`, which are reported
 * to observability so a person sees them; 502 when the run failed.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { cronGate } from '@/app/lib/cronAuth'
import { runAutopay } from '@/app/lib/ouroAutopay'
import { reportError } from '@/lib/observability'

export const maxDuration = 300

async function handle(req: NextRequest): Promise<NextResponse> {
  const gated = cronGate(req)
  if (gated) return gated
  try {
    const result = await runAutopay()
    if (result.status === 'held' || result.status === 'short' || result.status === 'failed') {
      reportError(new Error(`ouroboros autopay ${result.status}: ${result.detail}`), {
        surface: 'api-route', extra: { route: '/api/ouroboros/ref/autopay' },
      })
    }
    return NextResponse.json(result, { status: result.status === 'failed' ? 502 : 200 })
  } catch (err) {
    reportError(err, { surface: 'api-route', extra: { route: '/api/ouroboros/ref/autopay' } })
    return NextResponse.json({ status: 'failed', detail: 'the run could not start; see the error report' }, { status: 502 })
  }
}

export const GET = handle
export const POST = handle
