import 'server-only'

import { EN } from './dict/en'
import type { Dictionary, PartialDictionary } from './types'
import { DEFAULT_LOCALE, type Locale } from './locales'

/**
 * Loading and merging the locale dictionaries. Server side only.
 *
 * `server-only` is the point of this file being separate from the provider: the
 * loaders below name all seven dictionaries, and an accidental import of this
 * module from a client component would pull every language into the browser
 * bundle. The failure would be invisible — everything would work, just several
 * hundred kilobytes heavier — so the import is made impossible instead.
 *
 * The layout resolves one dictionary per request and hands it to
 * `I18nProvider` as props, so exactly one locale's strings ever reach the
 * client, and they arrive already merged. Nothing client-side has to know that
 * a fallback happened.
 */

/**
 * Dynamic imports, so a build serving only English never even parses the others.
 *
 * `en` resolves to an empty patch rather than to `EN`: it is already the base of
 * every merge, and a loader returning it would merge English over English on
 * every request for the common case.
 */
const LOADERS: Readonly<Record<Locale, () => Promise<PartialDictionary>>> = {
  'en':    () => Promise.resolve({}),
  'zh-CN': () => import('./dict/zh-CN').then((m) => m.ZH_CN),
  'zh-TW': () => import('./dict/zh-TW').then((m) => m.ZH_TW),
  'ja':    () => import('./dict/ja').then((m) => m.JA),
  'ko':    () => import('./dict/ko').then((m) => m.KO),
  'vi':    () => import('./dict/vi').then((m) => m.VI),
  'ru':    () => import('./dict/ru').then((m) => m.RU),
}

/**
 * English with a locale's translations laid over it, one key at a time.
 *
 * ⚠ FALLBACK IS PER KEY, NOT PER GROUP. Laying `{ refund: {...} }` over the base
 *   with a plain spread of the group would be right; replacing the group would
 *   silently delete every key the locale had not translated yet. A partly
 *   finished locale is the normal state here for months, so the merge has to be
 *   correct for it rather than for the finished case.
 *
 * ⚠ `undefined` AND `''` FALL BACK. A spread alone does not do this: `{ title:
 *   undefined }` spread over a base sets `title` to `undefined`, and the panel
 *   renders a blank where a heading was. Both are treated as "not translated",
 *   which is also what makes a half-written locale file safe to commit.
 *   `guard:i18n` rejects them at the source so they do not survive as silent
 *   fallbacks.
 */
export function mergeDictionary(base: Dictionary, over: PartialDictionary): Dictionary {
  const out: Record<string, Record<string, string>> = {}

  for (const group of Object.keys(base) as (keyof Dictionary)[]) {
    const merged: Record<string, string> = { ...base[group] }
    const patch = over[group]
    if (patch !== undefined) {
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value === 'string' && value !== '') merged[key] = value
      }
    }
    out[group as string] = merged
  }

  return out as Dictionary
}

/** The dictionary for one locale, complete, with English behind every gap. */
export async function getDictionary(locale: Locale): Promise<Dictionary> {
  if (locale === DEFAULT_LOCALE) return EN
  return mergeDictionary(EN, await LOADERS[locale]())
}
