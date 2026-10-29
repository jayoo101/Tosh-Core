import { describe, expect, it } from 'vitest'

import { EN } from './dict/en'
import { V3_PATCH } from './v3Patch'

type Groups = Record<string, Record<string, string> | undefined>
const base = EN as unknown as Groups
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

describe('V3_PATCH', () => {
  for (const [locale, patch] of Object.entries(V3_PATCH)) {
    for (const [group, keys] of Object.entries(patch as Groups)) {
      for (const [key, value] of Object.entries(keys ?? {})) {
        it(`${locale} ${group}.${key} overrides a real key with the same placeholders`, () => {
          const en = base[group]?.[key]
          expect(en, 'not a key of the base dictionary').toBeTypeOf('string')
          expect((V3_PATCH.en as Groups)[group]?.[key], 'missing from the en patch').toBeTypeOf('string')
          expect(placeholders(value)).toEqual(placeholders(en!))
        })

        it(`${locale} ${group}.${key} states no v2 ladder numbers`, () => {
          expect(value).not.toMatch(/4,000|0\.19|5\.6M|3,150|99 ?%/)
        })
      }
    }
  }
})
