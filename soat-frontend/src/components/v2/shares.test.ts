import { describe, expect, it } from 'vitest'

import type { V2Quote } from '@/lib/v2/config'
import { agentShares, sharesLeft } from './shares'

const BNB: V2Quote = { asset: '0x0000000000000000000000000000000000000001', symbol: 'BNB', decimals: 18, native: true }
const USDT: V2Quote = { ...BNB, symbol: 'USDT', native: false }
const CENT = 10n ** 16n

describe('agentShares', () => {
  it('reads a 0.1 BNB allowance as ten 0.01 BNB shares', () => {
    expect(agentShares(BNB, CENT, 10n * CENT)).toEqual({ size: CENT, count: 10n })
  })

  it('falls back to an amount for USDT, a part-share cap, or too many shares', () => {
    expect(agentShares(USDT, CENT, 10n * CENT)).toBeNull()
    expect(agentShares(BNB, CENT, 10n * CENT + 1n)).toBeNull()
    expect(agentShares(BNB, CENT, 101n * CENT)).toBeNull()
    expect(agentShares(BNB, undefined, 10n * CENT)).toBeNull()
  })
})

describe('sharesLeft', () => {
  it('rounds a part-share up so the last of the allowance can still be bought', () => {
    const s = { size: CENT, count: 10n }
    expect(sharesLeft(s, 10n * CENT)).toBe(10n)
    expect(sharesLeft(s, 3n * CENT + 1n)).toBe(4n)
    expect(sharesLeft(s, 0n)).toBe(0n)
  })
})
