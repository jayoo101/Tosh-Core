import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'

function credential(req: NextRequest): string | null {
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  return bearer || req.headers.get('x-cron-secret')?.trim() || null
}

function equal(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/** Null when the request carries `CRON_SECRET`; otherwise the 503, 401 or 403 to return. */
export function cronGate(req: NextRequest): NextResponse | null {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) return NextResponse.json({ error: 'CRON_SECRET is unset' }, { status: 503 })
  const got = credential(req)
  if (!got) return NextResponse.json({ error: 'no credential' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } })
  if (!equal(got, expected)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return null
}
