import { describe, expect, it } from 'vitest'
import { stringToHex, zeroHash } from 'viem'

import { decodeRefCode, encodeRefCode, isRefCode, randomRefCode, refMessage, SEASON_REF_BONUS_WEI } from './ref'

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

  it('randomRefCode makes a valid assigned code', () => {
    const a = randomRefCode()
    const b = randomRefCode(16)
    expect(isRefCode(a)).toBe(true)
    expect(a).toHaveLength(8)
    expect(isRefCode(b)).toBe(true)
    expect(b).toHaveLength(16)
    expect(() => randomRefCode(2)).toThrow()
  })

  it('season reward is 5 USDT in wei', () => {
    expect(SEASON_REF_BONUS_WEI).toBe('5000000000000000000')
  })

  it('signs the same text whatever the field order', () => {
    const a = refMessage({ action: 'setBonus', code: 'abc', bonus: '500' }, 1)
    const b = refMessage({ bonus: '500', code: 'abc', action: 'setBonus' } as const, 1)
    expect(a).toBe(b)
    expect(a).toBe('Ouroboros referrals\naction: setBonus\nbonus: 500\ncode: abc\nissued: 1')
  })
})
