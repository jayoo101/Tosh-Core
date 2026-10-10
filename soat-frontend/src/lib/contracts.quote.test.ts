import { afterEach, describe, expect, it, vi } from 'vitest'

const CURRENT     = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
const WBNB        = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const BEM         = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'
const BEM_FACTORY = '0xBCa66f7382aaC0C6EE2b833fc2072CA607367f2c'
const V1_FACTORY  = '0x20dE906A96FfB89BE6fd6267A0876A68017792F7'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function load(quote: string, decimals?: string) {
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', CURRENT)
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '56')
  vi.stubEnv('NEXT_PUBLIC_QUOTE_ASSET', quote)
  vi.stubEnv('NEXT_PUBLIC_QUOTE_SYMBOL', '')
  vi.stubEnv('NEXT_PUBLIC_QUOTE_DECIMALS', decimals ?? '')
  return import('./contracts')
}

describe('quote asset resolution', () => {
  it('reads WBNB at 18 decimals as BNB, whatever the env says about decimals', async () => {
    const c = await load(WBNB, '8')
    expect(c.QUOTE_DECIMALS).toBe(18)
    expect(c.QUOTE_SYMBOL).toBe('BNB')
    expect(c.QUOTE_WRAPS_NATIVE).toBe(true)
    expect(c.MIN_HARD_CAP).toBe(10n ** 18n)
    expect(c.MAX_HARD_CAP).toBe(500n * 10n ** 18n)
    expect(c.MAX_POG_ALLOCATION_LIMIT).toBe(500n * 10n ** 18n)
  })

  it('maps both retired factories to BEM at 8 decimals and the current one to WBNB', async () => {
    const c = await load(WBNB)
    for (const f of [BEM_FACTORY, V1_FACTORY, BEM_FACTORY.toLowerCase()]) {
      const q = c.quoteForFactory(f)
      expect(q.asset.toLowerCase()).toBe(BEM.toLowerCase())
      expect(q.decimals).toBe(8)
      expect(q.wrapsNative).toBe(false)
    }
    expect(c.quoteForFactory(CURRENT)).toBe(c.CURRENT_QUOTE)
    expect(c.quoteForFactory(undefined)).toBe(c.CURRENT_QUOTE)
  })

  it('resolves a hook asset it knows and refuses to guess one it does not', async () => {
    const c = await load(WBNB)
    expect(c.quoteForAsset(WBNB.toLowerCase())).toBe(c.CURRENT_QUOTE)
    expect(c.quoteForAsset(BEM)?.decimals).toBe(8)
    expect(c.quoteForAsset('0x3333333333333333333333333333333333333333')).toBeUndefined()
    expect(c.quoteForAsset(undefined)).toBeUndefined()
  })

  it('requires stated decimals for an asset outside the table', async () => {
    await expect(load('0x2222222222222222222222222222222222222222')).rejects.toThrow(/NEXT_PUBLIC_QUOTE_DECIMALS/)
    vi.resetModules()
    const c = await load('0x2222222222222222222222222222222222222222', '6')
    expect(c.QUOTE_DECIMALS).toBe(6)
  })
})
