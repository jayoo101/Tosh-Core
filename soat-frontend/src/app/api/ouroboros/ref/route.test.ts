import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/app/lib/apiGuard', () => ({
  applyRateLimit: async () => null,
  readJsonBody: async (req: Request) => ({ data: await req.json(), error: null }),
}))
vi.mock('@/app/lib/ouroRef', async importOriginal => ({
  ...(await importOriginal<typeof import('@/app/lib/ouroRef')>()),
  verifyRefSigner: async () => '0x00000000000000000000000000000000000000aa',
  isSafeSigner: async () => true,
  refReport: async () => ({ links: [], payouts: [], partners: [] }),
  setRate: vi.fn(async () => {}),
}))

vi.mock('@/app/lib/ouroAutopay', () => ({
  autopayState: async () => ({ enabled: false, lastRunAt: null, lastStatus: null, lastDetail: null }),
}))

import { POST } from './route'

const call = (request: unknown) => POST(new NextRequest('http://x/api/ouroboros/ref', {
  method: 'POST', body: JSON.stringify({ request, issuedAt: 0, address: '0x', signature: '0x' }),
}))

describe('referral admin switch', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('refuses admin actions where OURO_REF_ADMIN is unset, even for a Safe signer', async () => {
    vi.stubEnv('OURO_REF_ADMIN', '')
    expect((await call({ action: 'setRate', code: 'abc', rateBps: 500 })).status).toBe(403)
    expect((await call({ action: 'list' })).status).toBe(403)
  })

  it('still serves partners their own view', async () => {
    vi.stubEnv('OURO_REF_ADMIN', '')
    const res = await call({ action: 'view' })
    expect(res.status).toBe(200)
    expect((await res.json()).role).toBe('partner')
  })

  it('applies admin actions where it is enabled', async () => {
    vi.stubEnv('OURO_REF_ADMIN', '1')
    const res = await call({ action: 'setRate', code: 'abc', rateBps: 500 })
    expect(res.status).toBe(200)
    expect((await res.json()).role).toBe('admin')
  })
})
