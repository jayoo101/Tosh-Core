import { describe, expect, it } from 'vitest'

import { V31 } from './config'
import { untilNext, v31Split } from './l2Math'

const E18 = 10n ** 18n

describe('untilNext', () => {
  it('counts down to the next boundary after the anchor', () => {
    expect(untilNext(1_000, 1_000n, 60)).toBe(60)
    expect(untilNext(1_059, 1_000n, 60)).toBe(1)
    expect(untilNext(1_060, 1_000n, 60)).toBe(60)
    expect(untilNext(1_250, 1_000n, 600)).toBe(350)
  })

  it('is zero without an anchor and never negative before it', () => {
    expect(untilNext(1_000, 0n, 60)).toBe(0)
    expect(untilNext(900, 1_000n, 60)).toBe(60)
  })
})

describe('v31Split', () => {
  it('fills the whole supply at the hard cap', () => {
    const s = v31Split(V31.SALE_SUPPLY, 20_000n * E18, 20_000n * E18)
    expect(s.pool).toBe(90_000_000n * E18)
    expect(s.l2).toBe(V31.L2_SUPPLY)
    expect(s.unminted).toBe(0n)
  })

  it('scales the pool and the curve with the raise', () => {
    const s = v31Split(90_000_000n * E18, 5_000n * E18, 10_000n * E18)
    expect(s.pool).toBe(45_000_000n * E18)
    expect(s.l2).toBe(365_000_000n * E18)
    expect(s.sold + s.pool + s.l2 + s.unminted).toBe(V31.MAX_SUPPLY)
  })

  it('mints nothing beyond genesis with no hard cap read', () => {
    const s = v31Split(0n, 0n, 0n)
    expect(s.pool + s.l2).toBe(0n)
    expect(s.unminted).toBe(V31.MAX_SUPPLY)
  })
})
