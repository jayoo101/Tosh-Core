import { describe, expect, it } from 'vitest'

import { rosterCandidates, safeBatch, twapReady, type RosterProject } from './v2Roster'

const F = '0x00000000000000000000000000000000000000f1'
const G = '0x00000000000000000000000000000000000000f2'
const p = (n: number, over: Partial<RosterProject> = {}): RosterProject => ({
  token: `0x${n.toString(16).padStart(40, '0')}`,
  hook: `0x${(n + 100).toString(16).padStart(40, '0')}`,
  factory: F,
  launched: true,
  symbol: `T${n}`,
  ...over,
})

describe('rosterCandidates', () => {
  it("keeps this factory's launched, unlisted projects", () => {
    const projects = [p(1), p(2), p(3, { launched: false }), p(4, { factory: G })]
    const listed = [p(2).token.toUpperCase().replace('0X', '0x') as `0x${string}`]
    expect(rosterCandidates(projects, F, listed).map(x => x.symbol)).toEqual(['T1'])
  })
})

describe('twapReady', () => {
  it('is ready only on a non-zero read', () => {
    expect(twapReady({ status: 'success', result: 79228162514264337593543950336n })).toBe(true)
    expect(twapReady({ status: 'success', result: 0n })).toBe(false)
    expect(twapReady({ status: 'failure' })).toBe(false)
    expect(twapReady(undefined)).toBe(false)
  })
})

describe('safeBatch', () => {
  it('writes the Transaction Builder shape', () => {
    const b = safeBatch(97, 'n', 'd', [{ to: F, data: '0x1234' }])
    expect(b.chainId).toBe('97')
    expect(b.transactions).toEqual([{ to: F, value: '0', data: '0x1234', contractMethod: null, contractInputsValues: null }])
  })
})
