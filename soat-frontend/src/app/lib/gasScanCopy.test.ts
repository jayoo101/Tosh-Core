import { describe, expect, it } from 'vitest'

import { EN } from '@/i18n/dict/en'
import { ZH_CN } from '@/i18n/dict/zh-CN'

import { formatGasScanChainList, formatMissingChainList } from './gasScanCopy'

const ZH = { ...EN.gas, ...ZH_CN.gas }

describe('formatGasScanChainList', () => {
  it('reads as English by default, with no comma before the last name', () => {
    expect(formatGasScanChainList([])).toBe('')
    expect(formatGasScanChainList(['A'])).toBe('A')
    expect(formatGasScanChainList(['A', 'B'])).toBe('A and B')
    expect(formatGasScanChainList(['A', 'B', 'C'])).toBe('A, B and C')
    expect(formatGasScanChainList(['A', 'B', 'C', 'D'])).toBe('A, B, C and D')
  })

  it('is the same with the English dictionary passed explicitly', () => {
    expect(formatGasScanChainList(['A', 'B', 'C', 'D'], EN.gas)).toBe('A, B, C and D')
  })

  it('takes its joiners from the dictionary', () => {
    expect(formatGasScanChainList(['A'], ZH)).toBe('A')
    expect(formatGasScanChainList(['A', 'B'], ZH)).toBe('A 和 B')
    expect(formatGasScanChainList(['A', 'B', 'C', 'D'], ZH)).toBe('A、B、C 和 D')
  })
})

describe('formatMissingChainList', () => {
  it('joins every name with "and" in English, as the lower-bound notes always have', () => {
    expect(formatMissingChainList([])).toBe('')
    expect(formatMissingChainList(['A'])).toBe('A')
    expect(formatMissingChainList(['A', 'B', 'C'], EN.gas)).toBe('A and B and C')
  })

  it('takes its joiner from the dictionary', () => {
    expect(formatMissingChainList(['A', 'B', 'C'], ZH)).toBe('A、B、C')
  })
})
