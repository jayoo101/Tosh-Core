import { describe, expect, it } from 'vitest'

import { isContractCode } from './fmt'

describe('isContractCode', () => {
  it('accepts no code and a 7702 designator', () => {
    expect(isContractCode(undefined)).toBe(false)
    expect(isContractCode(null)).toBe(false)
    expect(isContractCode('0x')).toBe(false)
    expect(isContractCode(`0xef0100${'ab'.repeat(20)}`)).toBe(false)
    expect(isContractCode(`0xEF0100${'AB'.repeat(20)}`)).toBe(false)
  })

  it('refuses deployed code, including 23-byte code that is not a designator', () => {
    expect(isContractCode('0x6080604052')).toBe(true)
    expect(isContractCode(`0x600060${'ab'.repeat(20)}`)).toBe(true)
    expect(isContractCode(`0xef0100${'ab'.repeat(21)}`)).toBe(true)
  })
})
