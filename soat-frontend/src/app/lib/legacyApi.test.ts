import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('legacyGone', () => {
  it('leaves v1 routes open while v1 is the deployment', async () => {
    vi.stubEnv('NEXT_PUBLIC_V2_BIDBOOK', '')
    vi.stubEnv('NEXT_PUBLIC_V2_LENS', '')
    const { legacyGone } = await import('./legacyApi')
    expect(legacyGone()).toBeNull()
  })

  it('answers 404 once v2 is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_V2_BIDBOOK', '0x00000000000000000000000000000000000000b1')
    vi.stubEnv('NEXT_PUBLIC_V2_LENS', '0x00000000000000000000000000000000000000b2')
    const { legacyGone } = await import('./legacyApi')
    expect(legacyGone()?.status).toBe(404)
  })
})
