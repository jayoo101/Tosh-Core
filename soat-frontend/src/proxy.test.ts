import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { proxy } from './proxy'

const req = (auth?: string) =>
  new NextRequest('https://admin.example/rewards', auth ? { headers: { authorization: auth } } : undefined)
const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`

afterEach(() => vi.unstubAllEnvs())

describe('site access proxy', () => {
  it('lets everything through when no password is configured', () => {
    vi.stubEnv('SITE_ACCESS_PASSWORD', '')
    expect(proxy(req()).status).toBe(200)
  })

  it('asks for credentials and refuses wrong ones', () => {
    vi.stubEnv('SITE_ACCESS_PASSWORD', 's3cret')
    const none = proxy(req())
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toMatch(/^Basic /)
    expect(proxy(req(basic('tosh', 'wrong'))).status).toBe(401)
    expect(proxy(req(basic('other', 's3cret'))).status).toBe(401)
    expect(proxy(req('Basic !!!')).status).toBe(401)
  })

  it('accepts the configured user and password', () => {
    vi.stubEnv('SITE_ACCESS_PASSWORD', 's3cret')
    expect(proxy(req(basic('tosh', 's3cret'))).status).toBe(200)
    vi.stubEnv('SITE_ACCESS_USER', 'signer')
    expect(proxy(req(basic('signer', 's3cret'))).status).toBe(200)
  })
})
