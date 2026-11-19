import { describe, expect, it } from 'vitest'
import { parseEther } from 'viem'

import { TIERS, ladderCost, ladderPrice, sharesWithin, tierEnd } from './ladder'

describe('ouroboros ladder', () => {
  it('matches the contract at every tier edge', () => {
    const cases: [number, string][] = [
      [1, '1.2'], [10_000, '1.2'], [10_001, '1.28'], [11_001, '1.36'], [20_000, '2'],
      [20_001, '2.08'], [100_000, '3.344'], [100_001, '3.36'], [1_000_000, '4.784'],
      [1_000_001, '4.8'], [5_000_000, '8.78'], [5_000_001, '8.8'], [21_000_000, '15.18'],
    ]
    for (const [n, p] of cases) expect(ladderPrice(n)).toBe(parseEther(p))
  })

  it('prices a crossing purchase share by share', () => {
    expect(ladderCost(9_995, 10)).toBe(parseEther('6') + parseEther('6.4'))
  })

  it('fits shares under the pool cap', () => {
    expect(sharesWithin(0, parseEther('6'), 30)).toBe(5)
    expect(sharesWithin(0, parseEther('5.99'), 30)).toBe(4)
    expect(sharesWithin(9_995, parseEther('7.28'), 30)).toBe(6)
    expect(sharesWithin(0, parseEther('1000'), 30)).toBe(30)
    expect(sharesWithin(0, 0n, 30)).toBe(0)
  })

  it('reports each tier end', () => {
    expect(TIERS.map(t => tierEnd(t))).toEqual(
      ['1.2', '2', '3.344', '4.784', '8.78', '15.18'].map(p => parseEther(p)),
    )
  })
})
