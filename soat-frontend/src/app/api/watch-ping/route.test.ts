import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/app/lib/apiGuard', () => ({
  applyRateLimit: async () => null,
}))

vi.mock('@/lib/observability', () => ({
  reportError: vi.fn(),
}))

import { GET, POST } from './route'

const dispatch = vi.fn()

vi.stubGlobal('fetch', dispatch)

function req(headers: Record<string, string> = {}, method = 'GET') {
  return new NextRequest('http://localhost/api/watch-ping', { method, headers })
}

describe('/api/watch-ping', () => {
  beforeEach(() => {
    dispatch.mockReset()
    process.env.CRON_SECRET = 'test-cron'
    process.env.WATCH_DISPATCH_TOKEN = 'test-pat'
    delete process.env.WATCH_DISPATCH_REPO
  })

  it('refuses when CRON_SECRET is unset rather than firing unauthenticated', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req({ authorization: 'Bearer test-cron' }))
    expect(res.status).toBe(503)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('answers a missing credential with 401 and names the headers it reads', async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    const body = await res.json()
    expect(body.detail).toContain('x-cron-secret')
    expect(dispatch).not.toHaveBeenCalled()
  })

  // The two ways a pinger fails have to be told apart from the outside, where
  // the only signal is the status code.
  it('answers a credential that was read but does not match with 403, not 401', async () => {
    const res = await GET(req({ authorization: 'Bearer wrong' }))
    expect(res.status).toBe(403)
    expect((await GET(req({ 'x-cron-secret': 'wrong' }))).status).toBe(403)
    expect(dispatch).not.toHaveBeenCalled()
  })

  // cron-job.org's Authentication fields send Basic, not Bearer, so this reads
  // as "no credential" however carefully the operator typed the secret.
  it('names the scheme when the authorization header is not Bearer', async () => {
    const res = await GET(req({ authorization: 'Basic dXNlcjpwYXNz' }))
    expect(res.status).toBe(401)
    expect((await res.json()).detail).toContain('Basic')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('treats a blank x-cron-secret as absent rather than as a mismatch', async () => {
    expect((await GET(req({ 'x-cron-secret': '   ' }))).status).toBe(401)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('refuses when the dispatch token is unset', async () => {
    delete process.env.WATCH_DISPATCH_TOKEN
    const res = await GET(req({ authorization: 'Bearer test-cron' }))
    expect(res.status).toBe(503)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches repository_dispatch=watch on a valid secret', async () => {
    dispatch.mockResolvedValue(new Response(null, { status: 204 }))
    const res = await POST(req({ 'x-cron-secret': 'test-cron' }, 'POST'))
    expect(res.status).toBe(200)
    expect(dispatch).toHaveBeenCalledOnce()
    const [url, init] = dispatch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/jayoo101/Tosh-Core/dispatches')
    expect(JSON.parse(String(init.body))).toEqual({ event_type: 'watch' })
  })

  it('returns 502 when GitHub refuses the dispatch', async () => {
    dispatch.mockResolvedValue(new Response('bad credentials', { status: 401 }))
    const res = await GET(req({ authorization: 'Bearer test-cron' }))
    expect(res.status).toBe(502)
  })
})
