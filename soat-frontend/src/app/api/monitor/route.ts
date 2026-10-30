/**
 * /api/monitor — run the on-chain checks in `app/lib/monitor.ts` and post what
 * they find to Telegram.
 *
 *   Authorization: Bearer <CRON_SECRET>   or   x-cron-secret: <CRON_SECRET>
 *
 * Each alert is sent once and then stays quiet for its `quietSeconds`, using an
 * Upstash `SET NX EX` key; without Upstash it is sent on every run, which is
 * noisy but never silent.
 *
 *   ENV  MONITOR_TELEGRAM_BOT_TOKEN / MONITOR_TELEGRAM_CHAT_ID
 *        (fall back to APPLY_TELEGRAM_BOT_TOKEN / APPLY_TELEGRAM_CHAT_ID)
 *
 *   401  no credential    403  wrong credential    503  not configured
 *   502  an alert could not be delivered
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import type { Address } from 'viem'

import { runChecks, type Alert } from '@/app/lib/monitor'
import { serverPublicClient } from '@/app/lib/serverRpc'
import { indexStaleness } from '@/app/lib/v2Indexer'
import { V2_BIDBOOK, V2_FACTORY_BNB, V2_FACTORY_USDT } from '@/lib/v2/config'
import { reportError } from '@/lib/observability'

export const maxDuration = 60

function credential(req: NextRequest): string | null {
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  return bearer || req.headers.get('x-cron-secret')?.trim() || null
}

function equal(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/** `true` when this alert has not been sent inside its quiet period. */
async function firstSighting(alert: Alert): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim()
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  if (!url || !token) return true
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(['SET', `tosh:monitor:${alert.id}`, '1', 'NX', 'EX', String(alert.quietSeconds)]),
    cache: 'no-store',
  })
  if (!res.ok) return true
  return ((await res.json()) as { result?: string | null }).result === 'OK'
}

async function send(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `[ToshX 监控]\n${text}`, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`telegram sendMessage → ${res.status} ${(await res.text()).slice(0, 300)}`)
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) return NextResponse.json({ error: 'CRON_SECRET is unset' }, { status: 503 })
  const got = credential(req)
  if (!got) return NextResponse.json({ error: 'no credential' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } })
  if (!equal(got, expected)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const token = (process.env.MONITOR_TELEGRAM_BOT_TOKEN || process.env.APPLY_TELEGRAM_BOT_TOKEN)?.trim()
  const chatId = (process.env.MONITOR_TELEGRAM_CHAT_ID || process.env.APPLY_TELEGRAM_CHAT_ID)?.trim()
  if (!token || !chatId) return NextResponse.json({ error: 'Telegram is not configured' }, { status: 503 })

  const client = serverPublicClient()
  const alerts = await runChecks(
    (address, abi, functionName) => client.readContract({ address, abi, functionName } as never) as never,
    { factories: [V2_FACTORY_BNB, V2_FACTORY_USDT].filter((a): a is Address => !!a), bidBook: V2_BIDBOOK },
    indexStaleness,
  )

  const sent: string[] = []
  try {
    for (const a of alerts) {
      if (!(await firstSighting(a))) continue
      await send(token, chatId, a.text)
      sent.push(a.id)
    }
  } catch (err) {
    reportError(err, { surface: 'api-route', extra: { route: '/api/monitor', sent: sent.length } })
    return NextResponse.json({ error: 'delivery failed', alerts: alerts.map(a => a.id), sent }, { status: 502 })
  }
  return NextResponse.json({ ok: true, alerts: alerts.map(a => a.id), sent })
}

export const GET = handle
export const POST = handle
