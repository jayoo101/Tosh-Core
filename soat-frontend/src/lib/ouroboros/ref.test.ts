import { describe, expect, it } from 'vitest'
import { stringToHex, zeroHash } from 'viem'

import { decodeRefCode, encodeRefCode, isRefCode, refMessage } from './ref'

describe('ouroboros referral code', () => {
  it('round-trips a code through the mint argument', () => {
    expect(decodeRefCode(encodeRefCode('alpha7'))).toBe('alpha7')
    expect(decodeRefCode(encodeRefCode('a234567890123456'))).toBe('a234567890123456')
  })

  it('passes zero without a code, and reads zero as none', () => {
    expect(encodeRefCode(undefined)).toBe(zeroHash)
    expect(decodeRefCode(zeroHash)).toBeNull()
  })

  it('reads nothing from a value that is not an assigned code', () => {
    expect(decodeRefCode(stringToHex('ALPHA', { size: 32 }))).toBeNull()
    expect(decodeRefCode(stringToHex('ab', { size: 32 }))).toBeNull()
    // Bytes after the padding.
    expect(decodeRefCode(`0x${stringToHex('alpha', { size: 32 }).slice(2, 64)}01`)).toBeNull()
  })

  it('accepts only assigned code shapes', () => {
    expect(isRefCode('abc')).toBe(true)
    expect(isRefCode('ab')).toBe(false)
    expect(isRefCode('Alpha')).toBe(false)
    expect(isRefCode('a-b-c')).toBe(false)
    expect(() => encodeRefCode('NO')).toThrow()
  })

  it('signs the same text whatever the field order', () => {
    const a = refMessage({ action: 'setRate', code: 'abc', rateBps: 500 }, 1)
    const b = refMessage({ rateBps: 500, code: 'abc', action: 'setRate' } as const, 1)
    expect(a).toBe(b)
    expect(a).toBe('Ouroboros referrals\naction: setRate\ncode: abc\nrateBps: 500\nissued: 1')
  })
})
