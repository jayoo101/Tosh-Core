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
 *        HALT_KEEPER_PRIVATE_KEY — optional. A gas-only wallet that calls
 *        `renewAll()` on a gateway whose permanent halt was last armed over a
 *        day ago. `renewAll` is open to anyone, so the key holds no role;
 *        unset, the monitor only alerts as a halt nears its end.
 *
 *   401  no credential    403  wrong credential    503  not configured
 *   502  an alert could not be delivered
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { HALT_GATEWAY_ABI, gatewaysToRenew, permanentHalts, runChecks, type Alert, type Reader } from '@/app/lib/monitor'
import { serverPublicClient, serverRpcUrl } from '@/app/lib/serverRpc'
import { targetChain } from '@/lib/chain'
import { indexStaleness } from '@/app/lib/v2Indexer'
import { V2_BIDBOOK, V2_FACTORIES } from '@/lib/v2/config'
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
  const read: Reader = (address, abi, functionName, args) =>
    client.readContract({ address, abi, functionName, args } as never) as never
  const factories = [...V2_FACTORIES]

  const renewed = await renewHalts(read, factories).catch((err: unknown) => {
    reportError(err, { surface: 'api-route', extra: { route: '/api/monitor', step: 'renewAll' } })
    return [] as string[]
  })
  const alerts = await runChecks(read, { factories, bidBook: V2_BIDBOOK }, indexStaleness)

  const sent: string[] = []
  try {
    for (const a of alerts) {
      if (!(await firstSighting(a))) continue
      await send(token, chatId, a.text)
      sent.push(a.id)
    }
  } catch (err) {
    reportError(err, { surface: 'api-route', extra: { route: '/api/monitor', sent: sent.length } })
    return NextResponse.json({ error: 'delivery failed', alerts: alerts.map(a => a.id), sent, renewed }, { status: 502 })
  }
  return NextResponse.json({ ok: true, alerts: alerts.map(a => a.id), sent, renewed })
}

/** Send `renewAll()` to each gateway that is due; returns the transaction hashes. */
async function renewHalts(read: Reader, factories: Address[]): Promise<string[]> {
  const key = process.env.HALT_KEEPER_PRIVATE_KEY?.trim()
  if (!key) return []
  const due = gatewaysToRenew(await permanentHalts(read, factories), BigInt(Math.floor(Date.now() / 1000)))
  if (due.length === 0) return []

  const wallet = createWalletClient({
    account: privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex),
    chain: targetChain,
    transport: http(serverRpcUrl(), { timeout: 10_000 }),
  })
  const hashes: string[] = []
  for (const gateway of due) {
    hashes.push(await wallet.writeContract({ address: gateway, abi: HALT_GATEWAY_ABI, functionName: 'renewAll' }))
  }
  return hashes
}

export const GET = handle
export const POST = handle
