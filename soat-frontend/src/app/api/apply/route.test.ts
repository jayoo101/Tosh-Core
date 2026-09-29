import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `POST /api/apply` relays a project application into the review group.
 *
 * The group is the only inbox, so the property pinned hardest is that nothing
 * answers 200 unless Telegram accepted the card — an unset bot, a refused send
 * and a timeout all have to reach the applicant as "not sent".
 */

const TOKEN = '123456:test-bot-token'
const CHAT = '-1001234567890'

const VALID = {
  projectName: 'TapeLens',
  demoOrRepo: 'https://github.com/example/tapelens 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  ecosystemIntegration: '调用电路 ID 42，每次查询消耗 1 $BEM',
  telegramHandle: 't.me/tapelens_dev',
  rulesAccepted: true,
  locale: 'zh-CN',
}

let reported: unknown[]
vi.mock('@/lib/observability', () => ({ reportError: (e: unknown) => { reported.push(e) } }))

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined as unknown as string)
  vi.stubEnv('APPLY_TELEGRAM_BOT_TOKEN', TOKEN)
  vi.stubEnv('APPLY_TELEGRAM_CHAT_ID', CHAT)
  reported = []
  fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

let ipSeq = 0
async function post(body: unknown, ip = `203.0.113.${++ipSeq}`) {
  const { POST } = await import('./route')
  const req = new NextRequest('http://localhost/api/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return POST(req)
}

function sentCard(): { chat_id: string; text: string; parse_mode?: string } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
  return JSON.parse(init.body as string)
}

describe('POST /api/apply', () => {
  it('relays a valid application as one plain-text card', async () => {
    const res = await post(VALID)
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const card = sentCard()
    expect(card.chat_id).toBe(CHAT)
    expect(card.parse_mode).toBeUndefined()
    expect(card.text).toContain('Project: TapeLens')
    expect(card.text).toContain('Telegram: @tapelens_dev  https://t.me/tapelens_dev')
    expect(card.text).toContain('https://github.com/example/tapelens\n0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0')
    expect(card.text).toContain('调用电路 ID 42')
    expect(card.text).toContain('Locale: zh-CN')
  })

  it('refuses an invalid application field by field, and sends nothing', async () => {
    const res = await post({
      projectName: '',
      demoOrRepo: 'just trust me',
      ecosystemIntegration: 'x'.repeat(201),
      telegramHandle: '@ab',
      rulesAccepted: false,
    })
    expect(res.status).toBe(400)
    expect((await res.json()).fields).toEqual({
      projectName: 'required',
      demoOrRepo: 'invalid',
      ecosystemIntegration: 'tooLong',
      telegramHandle: 'invalid',
      rulesAccepted: 'required',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('counts the 200-character limit in characters, not UTF-16 units', async () => {
    const res = await post({ ...VALID, ecosystemIntegration: '链'.repeat(190) + '🔗'.repeat(10) })
    expect(res.status).toBe(200)
  })

  it('drops a filled honeypot with a 200 and sends nothing', async () => {
    const res = await post({ ...VALID, company: 'Acme' })
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 503 rather than pretending, when the bot is not configured', async () => {
    vi.stubEnv('APPLY_TELEGRAM_BOT_TOKEN', '')
    const res = await post(VALID)
    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reported).toHaveLength(1)
  })

  it('answers 503 when Telegram refuses the send', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":false,"description":"chat not found"}', { status: 400 }))
    const res = await post(VALID)
    expect(res.status).toBe(503)
    expect(String(reported[0])).toContain('chat not found')
  })

  it('answers 503 when Telegram cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'))
    expect((await post(VALID)).status).toBe(503)
  })

  it('rate-limits one address after three submissions', async () => {
    const ip = '198.51.100.7'
    for (let i = 0; i < 3; i++) expect((await post(VALID, ip)).status).toBe(200)
    expect((await post(VALID, ip)).status).toBe(429)
  })

  it('refuses an oversized body before parsing it', async () => {
    const res = await post({ ...VALID, ecosystemIntegration: 'x'.repeat(5000) })
    expect(res.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
