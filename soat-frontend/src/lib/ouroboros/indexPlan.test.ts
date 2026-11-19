import { describe, expect, it } from 'vitest'

import { passEnd } from './indexPlan'

const tx = (hash: string, block: number) => ({ hash, block: BigInt(block) })

describe('index pass length', () => {
  it('reads the whole span while it holds few mints', () => {
    expect(passEnd([tx('a', 10), tx('b', 12)], 10n, 99n, 2)).toBe(99n)
  })

  it('ends before the block that holds the first mint over the cap', () => {
    expect(passEnd([tx('c', 14), tx('a', 10), tx('b', 12)], 10n, 99n, 2)).toBe(13n)
  })

  it('counts a transaction with several mint logs once', () => {
    expect(passEnd([tx('a', 10), tx('a', 10), tx('b', 12), tx('b', 12)], 10n, 99n, 2)).toBe(99n)
  })

  it('never splits a block, and always takes the first one', () => {
    expect(passEnd([tx('a', 10), tx('b', 10), tx('c', 10), tx('d', 11)], 10n, 99n, 2)).toBe(10n)
    expect(passEnd([tx('a', 10), tx('b', 10), tx('c', 10)], 10n, 99n, 2)).toBe(99n)
  })
})
