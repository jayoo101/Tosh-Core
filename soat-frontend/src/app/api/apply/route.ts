/**
 * /api/apply — project applications from `/apply`.
 * ───────────────────────────────────────────────────────────────────────────
 *  POST { projectName, demoOrRepo, ecosystemIntegration, telegramHandle,
 *         rulesAccepted, locale?, company? }  → { ok: true }
 *
 *  Nothing is stored. A valid application is formatted into one plain-text
 *  card and pushed by the review bot into the private review group, and the
 *  group IS the inbox. So the failure that matters is a card that silently
 *  never arrives: every path that does not reach Telegram answers non-2xx, and
 *  the form tells the applicant to try again rather than thanking them.
 *
 *  ── Plain text, on purpose ────────────────────────────────────────────────
 *
 *  No `parse_mode`. Every field is applicant-controlled, and with Markdown or
 *  HTML an underscore in a project name fails the send with "can't parse
 *  entities" — or worse, a crafted one renders as a link the reviewer did not
 *  expect. `monitoring/report.mjs` made the same call for the same reason.
 *
 *  ── Spam ──────────────────────────────────────────────────────────────────
 *
 *  A tight per-IP limit, a size cap, and a honeypot: `company` is a field the
 *  page renders off-screen, so a filled one is a bot. It is answered 200 so
 *  the bot learns nothing, and dropped.
 *
 *  ENV  APPLY_TELEGRAM_BOT_TOKEN  bot token (secret)
 *       APPLY_TELEGRAM_CHAT_ID    review group id, e.g. -100…
 *  Either unset → 503, never a pretend success.
 */

import { NextRequest, NextResponse } from 'next/server'

import { applyCors, applyRateLimit, corsPreflight, readJsonBody } from '@/app/lib/apiGuard'
import { reportError } from '@/lib/observability'
import { formatApplicationCard, validateApplication } from '@/lib/projectApplication'

const CORS_OPTS = { methods: ['POST', 'OPTIONS'] as const } as const

/** Three per IP, one more every twenty minutes. A real team applies once. */
const POST_LIMIT = { name: 'apply', capacity: 3, refillPerSec: 1 / 1200 } as const

/** The four text fields at their limits, in CJK, fit well inside this. */
const MAX_BODY_BYTES = 4 * 1024

const TELEGRAM_DEADLINE_MS = 8_000

function json(body: unknown, init: ResponseInit, req: NextRequest) {
  return applyCors(
    NextResponse.json(body, { ...init, headers: { 'cache-control': 'no-store', ...init.headers } }),
    req,
    CORS_OPTS,
  )
}

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req, CORS_OPTS)
}

export async function POST(req: NextRequest) {
  const limited = await applyRateLimit(req, POST_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const body = await readJsonBody<Record<string, unknown>>(req, MAX_BODY_BYTES)
  if (body.error) return applyCors(body.error, req, CORS_OPTS)
  const data = body.data && typeof body.data === 'object' ? body.data : {}

  if (typeof data.company === 'string' && data.company.trim() !== '') {
    return json({ ok: true }, { status: 200 }, req)
  }

  const { value, errors } = validateApplication(data)
  if (!value) return json({ error: 'invalid application', fields: errors }, { status: 400 }, req)

  const token = process.env.APPLY_TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.APPLY_TELEGRAM_CHAT_ID?.trim()
  if (!token || !chatId) {
    reportError(new Error('APPLY_TELEGRAM_BOT_TOKEN / APPLY_TELEGRAM_CHAT_ID unset'), {
      surface: 'api-route', extra: { route: 'POST /api/apply', stage: 'config' },
    })
    return json({ error: 'applications are unavailable right now' }, { status: 503, headers: { 'retry-after': '60' } }, req)
  }

  const locale = typeof data.locale === 'string' && /^[a-zA-Z-]{2,10}$/.test(data.locale) ? data.locale : 'unknown'
  const text = formatApplicationCard(value, { locale, at: new Date() })

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TELEGRAM_DEADLINE_MS),
    })
    if (!res.ok) {
      // Telegram's body names the reason (401 revoked token, 400 chat not
      // found, 403 bot removed) and none of it is for the applicant.
      throw new Error(`telegram sendMessage → ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
  } catch (err) {
    reportError(err, { surface: 'api-route', extra: { route: 'POST /api/apply', stage: 'telegram' } })
    return json({ error: 'applications are unavailable right now' }, { status: 503, headers: { 'retry-after': '30' } }, req)
  }

  return json({ ok: true }, { status: 200 }, req)
}
