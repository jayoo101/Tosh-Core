import { describe, expect, it } from 'vitest'
import { fmtClock, fmtPrice, pct, priceAfterWei, priceAt, SALE_TOKENS } from './curve'

const E18 = 10n ** 18n

describe('curve', () => {
  it('runs from P to 1.5P and stops there', () => {
    expect(priceAt(0, 2)).toBe(2)
    expect(priceAt(SALE_TOKENS / 2, 2)).toBe(2.5)
    expect(priceAt(SALE_TOKENS, 2)).toBe(3)
    expect(priceAt(SALE_TOKENS * 2, 2)).toBe(3)
  })

  it('prices the post-buy point in wei, clamped at the sale supply', () => {
    const p = 1000n
    expect(priceAfterWei(p, 0n, 0n)).toBe(1000n)
    const sale = BigInt(SALE_TOKENS) * E18
    expect(priceAfterWei(p, sale / 2n, 0n)).toBe(1250n)
    expect(priceAfterWei(p, sale, sale)).toBe(1500n)
  })

  it('spells small prices out', () => {
    expect(fmtPrice(0.0001093)).toBe('0.0001093')
    expect(fmtPrice(0.00000012345)).toBe('0.0000001234')
    expect(fmtPrice(1.23456)).toBe('1.235')
    expect(fmtPrice(0)).toBe('0')
  })

  it('formats a countdown and a percentage', () => {
    expect(fmtClock(46 * 3600 + 7 * 60 + 7)).toBe('46:07:07')
    expect(fmtClock(-5)).toBe('00:00:00')
    expect(pct(1n, 3n)).toBe(33.33)
    expect(pct(1n, 0n)).toBe(0)
  })
})
