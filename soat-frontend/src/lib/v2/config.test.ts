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

describe('legacy factories', () => {
  const NEW_BNB = '0x00000000000000000000000000000000000b0001'
  const NEW_USDT = '0x00000000000000000000000000000000000a0001'
  const OLD_BNB = '0x091d0cBD1e3B7D8b2a6fd8e0795b784EdDFfb590'
  const OLD_USDT = '0x8296fa2d430dcF25233A39CC3306EE503967a6bB'

  async function load(legacy: boolean) {
    vi.stubEnv('NEXT_PUBLIC_TOSH_STACK', 'v3')
    vi.stubEnv('NEXT_PUBLIC_V2_FACTORY_BNB', NEW_BNB)
    vi.stubEnv('NEXT_PUBLIC_V2_FACTORY_USDT', NEW_USDT)
    vi.stubEnv('NEXT_PUBLIC_V2_WBNB', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c')
    if (legacy) {
      vi.stubEnv('NEXT_PUBLIC_V2_LEGACY_FACTORIES_BNB', ` ${OLD_BNB.toLowerCase()} ,`)
      vi.stubEnv('NEXT_PUBLIC_V2_LEGACY_FACTORIES_USDT', OLD_USDT)
    }
    return import('./config')
  }

  it('lists the legacy factories beside the current pair', async () => {
    const c = await load(true)
    expect(c.V2_FACTORIES).toHaveLength(4)
    expect(c.isV2Factory(OLD_BNB)).toBe(true)
    expect(c.isLegacyFactory(OLD_BNB)).toBe(true)
    expect(c.isLegacyFactory(NEW_BNB)).toBe(false)
  })

  it('quotes a legacy BNB factory in the native coin', async () => {
    const c = await load(true)
    expect(c.v2QuoteConfig(OLD_BNB).wrapsNative).toBe(true)
    expect(c.v2QuoteConfig(OLD_USDT).wrapsNative).toBe(false)
  })

  it('gives the spot gate to the current pair only once a legacy pair is configured', async () => {
    const c = await load(true)
    expect(c.hasSpotShelfGate(NEW_BNB)).toBe(true)
    expect(c.hasSpotShelfGate(NEW_USDT.toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(c.hasSpotShelfGate(OLD_BNB)).toBe(false)
    expect(c.hasSpotShelfGate(undefined)).toBe(false)
    vi.unstubAllEnvs()
    vi.resetModules()
    const before = await load(false)
    expect(before.hasSpotShelfGate(NEW_BNB)).toBe(false)
  })
})
