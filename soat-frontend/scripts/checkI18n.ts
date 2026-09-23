/**
 * Every locale dictionary agrees with English about what exists.
 *
 *   node scripts/runTsGuard.mjs scripts/checkI18n.ts
 *
 * ── Why a guard and not just types ──────────────────────────────────────────
 *
 * `PartialDictionary` already stops a locale inventing or misspelling a key, so
 * that part is covered at compile time and is re-checked here only because it is
 * free. What TypeScript cannot express is the part that actually goes wrong:
 *
 *   · A TRANSLATOR DROPPING A PLACEHOLDER. `'已确认 —— {action}'` with the brace
 *     expression deleted still typechecks as a string, still renders, and quietly
 *     loses the one part of the sentence that says WHICH transaction confirmed.
 *     `fill()` leaves an unknown placeholder on screen precisely so the opposite
 *     mistake is loud; this catches the silent one.
 *
 *   · AN EMPTY OR WHITESPACE VALUE. `mergeDictionary` treats those as "not
 *     translated" and falls back, which makes a half-written file safe to commit
 *     — and also makes a genuinely blank string invisible forever. The fallback
 *     is a safety net, not a place to leave things.
 *
 *   · HALF-WIDTH PUNCTUATION IN CJK TEXT. `太小,无法` instead of `太小，无法`
 *     is not a wrong word, so it survives every review a non-reader can give and
 *     every snapshot test. It is also the clearest signal a reader gets that
 *     nobody who speaks their language looked at the page.
 *
 *   · A TIER-0 SURFACE ONLY PART DONE in a locale that has been promised. The
 *     types deliberately allow an incomplete locale, because six languages of
 *     money copy cannot land in one commit. Which locales have finished is a
 *     promise, and a promise belongs in a guard.
 *
 * ⚠ IT ALSO FAILS ON A LOCALE NOBODY TOLD IT ABOUT. `LOCALES` is the list the
 *   app serves; the table below is the list this guard inspects. If the two
 *   disagree, a language could ship with no checking at all — so disagreeing is
 *   itself the error, rather than being silently skipped.
 */

import { EN, TIER0_SURFACES, TIER0_REQUIRED_LOCALES } from '@/i18n/dict/en'
import { LOCALES, isLocale, type Locale } from '@/i18n/locales'
import { placeholdersIn } from '@/i18n/fill'
import type { PartialDictionary } from '@/i18n/types'

import { ZH_CN } from '@/i18n/dict/zh-CN'
import { ZH_TW } from '@/i18n/dict/zh-TW'
import { JA } from '@/i18n/dict/ja'
import { KO } from '@/i18n/dict/ko'
import { VI } from '@/i18n/dict/vi'
import { RU } from '@/i18n/dict/ru'

/** Every locale but English, which is the base rather than an overlay. */
const OVERLAYS: Readonly<Record<Exclude<Locale, 'en'>, PartialDictionary>> = {
  'zh-CN': ZH_CN,
  'zh-TW': ZH_TW,
  'ja': JA,
  'ko': KO,
  'vi': VI,
  'ru': RU,
}

const problems: string[] = []
const notes: string[] = []

const fail = (msg: string) => problems.push(msg)
const note = (msg: string) => notes.push(msg)

/*
 * ── Half-width punctuation in CJK text ──────────────────────────────────────
 *
 * Chinese and Japanese punctuation marks occupy a full character cell; the ASCII
 * ones occupy about a third of one and carry no trailing space. Typing `,` where
 * `，` belongs is the single most common tell of untouched machine translation,
 * and it is invisible to a reviewer who does not read the language — it is not a
 * wrong word, so nothing in a diff or a snapshot looks off. It showed up in the
 * first hand-written dictionary in this repo, which is why it is checked.
 *
 * NOT Korean. Korean sets ASCII commas and periods normally, so the same rule
 * there would be wrong. And the check only fires when the character immediately
 * before the mark is CJK, which leaves the protocol terms alone: `GENESIS, PoG`
 * has an ASCII `S` in front of the comma and is correct as written.
 */
const CJK_PUNCTUATION_LOCALES = new Set<Locale>(['zh-CN', 'zh-TW', 'ja'])

/** Ideographs, kana, CJK punctuation, and the full-width forms block. */
const CJK_RANGES = '\u3400-\u9FFF\u3040-\u30FF\u3000-\u303F\uFF00-\uFFEF'

const FULL_WIDTH: Readonly<Record<string, string>> = {
  ',': '\uFF0C', '.': '\u3002', ';': '\uFF1B',
  ':': '\uFF1A', '!': '\uFF01', '?': '\uFF1F',
}

function asciiPunctuationAfterCjk(locale: Locale, value: string): [string, string][] {
  const hits: [string, string][] = []
  const re = new RegExp(`[${CJK_RANGES}]([,.;:!?])`, 'g')
  for (const m of value.matchAll(re)) {
    const ascii = m[1]
    // Japanese separates clauses with 、 where Chinese uses ，. Everything else
    // is shared, so only the comma needs to know which language it is in.
    const wanted = ascii === ',' && locale === 'ja' ? '\u3001' : FULL_WIDTH[ascii]
    hits.push([ascii, wanted])
  }
  return hits
}

// ─── 1 · the guard's table covers exactly what the app serves ────────────────

const inspected = new Set<string>(['en', ...Object.keys(OVERLAYS)])
for (const locale of LOCALES) {
  if (!inspected.has(locale)) {
    fail(`\`LOCALES\` offers "${locale}" but this guard has no entry for it — add it to OVERLAYS or it ships unchecked`)
  }
}
for (const locale of inspected) {
  if (!isLocale(locale)) fail(`this guard inspects "${locale}", which is not in \`LOCALES\``)
}

// ─── 2 · English itself is well formed ───────────────────────────────────────

const enGroups = Object.keys(EN) as (keyof typeof EN)[]

for (const group of enGroups) {
  const entries = EN[group] as Readonly<Record<string, string>>
  for (const [key, value] of Object.entries(entries)) {
    if (value.trim() === '') fail(`en.${String(group)}.${key} is empty`)
    if (value !== value.trim()) {
      fail(`en.${String(group)}.${key} has leading or trailing whitespace — it will show up in the layout`)
    }
  }
}

for (const surface of TIER0_SURFACES) {
  if (!enGroups.includes(surface)) {
    fail(`\`TIER0_SURFACES\` names "${surface}", which is not a group in the English dictionary`)
  }
}

// ─── 3 · every overlay agrees with English ───────────────────────────────────

for (const [locale, overlay] of Object.entries(OVERLAYS) as [Locale, PartialDictionary][]) {
  for (const [group, entries] of Object.entries(overlay)) {
    // Both of these are compile errors under `PartialDictionary`. Re-checked
    // because a cast, a JSON import or a hand-edited build artefact would get
    // past the type and this guard is the last thing between that and a user.
    if (!(group in EN)) {
      fail(`${locale}.${group} is not a group in the English dictionary`)
      continue
    }
    const base = EN[group as keyof typeof EN] as Readonly<Record<string, string>>

    for (const [key, value] of Object.entries(entries as Record<string, string>)) {
      const path = `${locale}.${group}.${key}`

      if (!(key in base)) {
        fail(`${path} is not a key in the English dictionary`)
        continue
      }

      if (typeof value !== 'string' || value.trim() === '') {
        fail(`${path} is empty — delete the key instead, which falls back to English on purpose`)
        continue
      }

      if (value !== value.trim()) {
        fail(`${path} has leading or trailing whitespace`)
      }

      /*
       * Set comparison, not sequence: word order is exactly what a translation is
       * allowed to change, so requiring `{a}` before `{b}` would reject correct
       * work. What must hold is that no placeholder is lost and none is invented.
       */
      const want = new Set(placeholdersIn(base[key]))
      const got = new Set(placeholdersIn(value))
      for (const p of want) {
        if (!got.has(p)) fail(`${path} drops {${p}}, which English fills — the value it carries would vanish`)
      }
      for (const p of got) {
        if (!want.has(p)) fail(`${path} invents {${p}}, which nothing fills — it would render literally`)
      }

      if (CJK_PUNCTUATION_LOCALES.has(locale)) {
        for (const [ascii, wanted] of asciiPunctuationAfterCjk(locale, value)) {
          fail(
            `${path} uses the half-width "${ascii}" against CJK text — use "${wanted}". `
            + `A half-width mark carries no width of its own, so the sentence closes up around it `
            + `and reads as machine output next to the full-width marks beside it.`,
          )
        }
      }
    }
  }
}

// ─── 4 · promised locales have finished the Tier-0 surfaces ──────────────────

for (const locale of TIER0_REQUIRED_LOCALES) {
  if (locale === 'en') continue
  const overlay = OVERLAYS[locale as Exclude<Locale, 'en'>]
  if (overlay === undefined) {
    fail(`\`TIER0_REQUIRED_LOCALES\` names "${locale}", which has no dictionary`)
    continue
  }

  for (const surface of TIER0_SURFACES) {
    const base = EN[surface] as Readonly<Record<string, string>>
    const got = (overlay[surface] ?? {}) as Record<string, string>
    const missing = Object.keys(base).filter((k) => typeof got[k] !== 'string' || got[k].trim() === '')
    if (missing.length > 0) {
      fail(
        `${locale} is required to have finished "${surface}" but is missing `
        + `${missing.length}: ${missing.join(', ')}`,
      )
    }
  }
}

// ─── 5 · a Tier-0 string identical to English is probably untranslated ───────

/*
 * A NOTE, NOT A FAILURE. Some strings legitimately stay English in every locale
 * — protocol terms, tickers — and a rule that forbade it would eventually be
 * worked around rather than obeyed. But on the surfaces a user needs to operate,
 * a line byte-identical to English is far more often a copy-paste left behind
 * than a deliberate choice, and it is invisible on screen to anyone who does not
 * read English.
 */
for (const locale of TIER0_REQUIRED_LOCALES) {
  if (locale === 'en') continue
  const overlay = OVERLAYS[locale as Exclude<Locale, 'en'>]
  if (overlay === undefined) continue

  for (const surface of TIER0_SURFACES) {
    const base = EN[surface] as Readonly<Record<string, string>>
    const got = (overlay[surface] ?? {}) as Record<string, string>
    for (const [key, value] of Object.entries(got)) {
      if (value === base[key]) note(`${locale}.${surface}.${key} is byte-identical to English — translated, or left behind?`)
    }
  }
}

// ─── 6 · the env var, when it is set, names languages that exist ─────────────

const configured = process.env.NEXT_PUBLIC_LOCALES
if (typeof configured === 'string' && configured.trim() !== '') {
  for (const raw of configured.split(',')) {
    const name = raw.trim()
    if (name === '') continue
    if (!isLocale(name)) {
      fail(`NEXT_PUBLIC_LOCALES lists "${name}", which is not a known locale — it would be silently dropped`)
    }
  }
}

// ─── report ──────────────────────────────────────────────────────────────────

const counted = enGroups.reduce((n, g) => n + Object.keys(EN[g]).length, 0)

for (const n of notes) console.log(`  note  ${n}`)

if (problems.length > 0) {
  console.error(`\n✗ i18n: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`)
  for (const p of problems) console.error(`  · ${p}`)
  console.error('')
  process.exit(1)
}

const done = (Object.keys(OVERLAYS) as Exclude<Locale, 'en'>[])
  .filter((l) => Object.keys(OVERLAYS[l]).length > 0)

console.log(
  `✓ i18n: ${counted} English strings across ${enGroups.length} surfaces; `
  + `${done.length === 0 ? 'no locale has started' : `started: ${done.join(', ')}`}; `
  + `tier-0 complete in ${TIER0_REQUIRED_LOCALES.join(', ')}`,
)
