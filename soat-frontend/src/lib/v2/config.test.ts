import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAddress } from 'viem'

const LENS = '0xE525aB5634F05aFdB8B5436da27cC1DA30728425'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('v2 config addresses', () => {
  it('re-checksums an address pasted with its case mangled', async () => {
    vi.stubEnv('NEXT_PUBLIC_V2_LENS', '0xE525aB5634F05afDB8B5436da27cC1DA30728425')
    const { V2_LENS } = await import('./config')
    expect(V2_LENS).toBe(LENS)
    expect(isAddress(V2_LENS!)).toBe(true)
  })

  it('still refuses something that is not 20 bytes of hex', async () => {
    vi.stubEnv('NEXT_PUBLIC_V2_LENS', '0xE525aB5634F05aFdB8B5436da27cC1DA3072842')
    await expect(import('./config')).rejects.toThrow('not a 20-byte hex address')
  })
})
