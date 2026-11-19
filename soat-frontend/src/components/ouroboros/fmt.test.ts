import { describe, expect, it } from 'vitest'
import { parseEther } from 'viem'

import { fmtPrice, openingPrice, parseAmount } from './fmt'

describe('ouroboros fmt', () => {
  it('opens at the signer price only above L1 and with enough L1.5 volume', () => {
    expect(openingPrice(300n, 100n, true)).toBe(300n)
    expect(openingPrice(50n, 100n, true)).toBe(100n)
    expect(openingPrice(300n, 100n, false)).toBe(100n)
  })

  it('prints ordinary prices plainly', () => {
    expect(fmtPrice(parseEther('0.8'))).toBe('0.8')
    expect(fmtPrice(parseEther('14.78'))).toBe('14.78')
    expect(fmtPrice(0n)).toBe('0')
  })

  it('folds leading zeros of tiny prices into a subscript', () => {
    expect(fmtPrice(7_200_000_000n)).toBe('0.0₈72')
    expect(fmtPrice(parseEther('0.00000685'))).toBe('0.0₅685')
  })

  it('parses decimals and rejects junk', () => {
    expect(parseAmount('1.5')).toBe(parseEther('1.5'))
    expect(parseAmount('')).toBeUndefined()
    expect(parseAmount('1e5')).toBeUndefined()
  })
})
