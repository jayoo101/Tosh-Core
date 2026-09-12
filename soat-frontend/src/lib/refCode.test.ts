import { describe, expect, it } from 'vitest'

import {
  CODE_SPACE,
  MAX_CODE_LENGTH,
  REF_CODE_LISTS,
  generateRefCode,
  isRefCodeShape,
} from './refCode'

const { ADJECTIVES, TONES, NOUNS } = REF_CODE_LISTS

describe('the vocabulary', () => {
  it('has no repeated word inside a list', () => {
    for (const [name, list] of Object.entries(REF_CODE_LISTS)) {
      expect(new Set(list).size, `${name} contains a duplicate`).toBe(list.length)
    }
  })

  // The module promises "no code ever repeats a word, which would look like a
  // bug". That is a property of the lists, not of any code, so it is checked
  // here rather than by drawing samples — an overlap between TONES and NOUNS
  // would surface in about one code in six thousand.
  it('keeps the three positions disjoint', () => {
    const adjectives = new Set<string>(ADJECTIVES)
    const tones = new Set<string>(TONES)
    const nouns = new Set<string>(NOUNS)

    expect([...tones].filter(w => adjectives.has(w))).toEqual([])
    expect([...nouns].filter(w => adjectives.has(w))).toEqual([])
    expect([...nouns].filter(w => tones.has(w))).toEqual([])
  })

  it('holds only lowercase letters, so codes survive a URL unchanged', () => {
    for (const list of Object.values(REF_CODE_LISTS)) {
      for (const word of list) expect(word).toMatch(/^[a-z]{2,12}$/)
    }
  })

  // `MAX_CODE_LENGTH` is the bound the SQL CHECK constraint and the URL are
  // sized against, so a word added past it would be rejected by the database
  // at mint time rather than here.
  it('cannot produce a code longer than MAX_CODE_LENGTH', () => {
    const longest = (list: readonly string[]) =>
      list.reduce((max, w) => Math.max(max, w.length), 0)

    const worst = longest(ADJECTIVES) + longest(TONES) + longest(NOUNS) + 2
    expect(worst).toBeLessThanOrEqual(MAX_CODE_LENGTH)
  })

  it('reports the code space the collision math in the header assumes', () => {
    expect(CODE_SPACE).toBe(64 * 64 * 96)
    expect(CODE_SPACE).toBe(393_216)
  })
})

describe('generateRefCode', () => {
  it('always produces something the shape check and the database accept', () => {
    const sqlCheck = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/
    for (let i = 0; i < 500; i++) {
      const code = generateRefCode()
      expect(isRefCodeShape(code)).toBe(true)
      expect(code).toMatch(sqlCheck)
      expect(code.length).toBeLessThanOrEqual(MAX_CODE_LENGTH)
    }
  })

  it('draws words from the right list in the right position', () => {
    for (let i = 0; i < 300; i++) {
      const [a, t, n] = generateRefCode().split('-')
      expect(ADJECTIVES).toContain(a)
      expect(TONES).toContain(t)
      expect(NOUNS).toContain(n)
    }
  })

  // The point of `randomIndex`'s rejection sampling is that every index stays
  // reachable and none is favoured. NOUNS at 96 is the list that does not
  // divide 2^32 and so the one a naive `% n` would bias, so it is the one
  // worth checking: with 5000 draws each noun is expected ~52 times, and a
  // list position that is unreachable or a modulo that truncates the tail
  // shows up as a missing word.
  it('reaches every noun, including the ones a biased modulo would clip', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5_000; i++) seen.add(generateRefCode().split('-')[2])
    expect(seen.size).toBe(NOUNS.length)
  })

  it('does not return the same code twice in a row in practice', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 500; i++) codes.add(generateRefCode())
    // 500 draws from 393,216 collide with probability ~0.3%, so this asserts
    // the generator is not stuck rather than that it is collision-free.
    expect(codes.size).toBeGreaterThan(480)
  })
})

describe('isRefCodeShape', () => {
  it('accepts a well-formed code', () => {
    expect(isRefCodeShape('swift-amber-otter')).toBe(true)
    expect(isRefCodeShape('apt-tin-owl')).toBe(true)
  })

  // Shape only, deliberately: the lists must be free to grow without
  // invalidating codes that are already pasted somewhere, so words that are
  // not in any list today still have to pass.
  it('accepts words the current lists do not contain', () => {
    expect(isRefCodeShape('zzz-yyy-xxx')).toBe(true)
  })

  it('rejects the things that actually arrive in a bad link', () => {
    expect(isRefCodeShape('')).toBe(false)
    expect(isRefCodeShape('swift-amber')).toBe(false)            // truncated paste
    expect(isRefCodeShape('swift-amber-otter-extra')).toBe(false)
    expect(isRefCodeShape('Swift-Amber-Otter')).toBe(false)      // not lowercased first
    expect(isRefCodeShape('swift_amber_otter')).toBe(false)
    expect(isRefCodeShape('swift amber otter')).toBe(false)
    expect(isRefCodeShape('swift--otter')).toBe(false)
    expect(isRefCodeShape('a-b-c')).toBe(false)                  // under the 2-char floor
  })

  // The whole point of the change: an address must not be mistaken for a code,
  // in either direction.
  it('rejects an address', () => {
    expect(isRefCodeShape('0x30ad7d2d9a1b0f4e3c8b5a6d7e8f9a0b1c2d3e9e')).toBe(false)
  })

  it('rejects a code long enough to be a denial-of-service on the column', () => {
    expect(isRefCodeShape(`${'a'.repeat(13)}-amber-otter`)).toBe(false)
    expect(isRefCodeShape(`${'a'.repeat(500)}-b-c`)).toBe(false)
  })
})
