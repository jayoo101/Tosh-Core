import { afterEach, describe, expect, it, vi } from 'vitest'

const CURRENT = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
const LEGACY  = '0x20dE906A96FfB89BE6fd6267A0876A68017792F7'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function load(legacy?: string) {
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', CURRENT)
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '97')
  if (legacy !== undefined) vi.stubEnv('NEXT_PUBLIC_LEGACY_FACTORY_ADDRESSES', legacy)
  return import('./contracts')
}

describe('listed factories', () => {
  it('lists only the current factory when no retired one is configured', async () => {
    const c = await load()
    expect(c.LISTED_FACTORIES).toEqual([CURRENT])
    expect(c.LEGACY_FACTORY_ADDRESSES).toEqual([])
  })

  it('lists the current factory first, then each retired one', async () => {
    const c = await load(` ${LEGACY} ,`)
    expect(c.LISTED_FACTORIES).toEqual([CURRENT, LEGACY])
    expect(c.isListedFactory(LEGACY.toLowerCase())).toBe(true)
    expect(c.isListedFactory('0x0000000000000000000000000000000000000001')).toBe(false)
  })

  it('drops duplicates, including the current factory repeated as retired', async () => {
    const c = await load(`${LEGACY},${LEGACY.toLowerCase()},${CURRENT}`)
    expect(c.LISTED_FACTORIES).toEqual([CURRENT, LEGACY])
  })

  it('refuses a malformed entry rather than silently hiding a factory', async () => {
    await expect(load('0x1234')).rejects.toThrow()
  })
})
