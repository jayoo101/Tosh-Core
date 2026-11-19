/** GET /api/ouroboros/ref/check?code= — whether a referral code is a registered partner link. */
import { NextResponse, type NextRequest } from 'next/server'

import { applyRateLimit } from '@/app/lib/apiGuard'
import { linkExists, RefError } from '@/app/lib/ouroRef'
import { SupabaseAdminUnavailable } from '@/app/lib/supabaseAdmin'
import { isRefCode } from '@/lib/ouroboros/ref'

const RATE_LIMIT = { name: 'ouro-ref-check', capacity: 30, refillPerSec: 1 } as const

export async function GET(req: NextRequest) {
  const limited = await applyRateLimit(req, RATE_LIMIT)
  if (limited) return limited
  const code = req.nextUrl.searchParams.get('code') ?? ''
  if (!isRefCode(code)) return NextResponse.json({ registered: false })
  try {
    return NextResponse.json(
      { registered: await linkExists(code) },
      { headers: { 'cache-control': 'public, s-maxage=60' } },
    )
  } catch (err) {
    if (err instanceof RefError || err instanceof SupabaseAdminUnavailable) {
      return NextResponse.json({ error: 'unavailable' }, { status: 503 })
    }
    throw err
  }
}
