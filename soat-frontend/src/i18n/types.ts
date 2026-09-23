import type { EN } from './dict/en'

/**
 * The complete set of strings a render can ask for, derived from the English
 * dictionary rather than declared.
 *
 * Derived on purpose: a hand-written interface beside `en.ts` would be a second
 * place for the shape to live, and the two would drift the first time somebody
 * added a key in a hurry. This way English IS the schema — adding a key there
 * is what makes it referenceable, and removing one breaks every reference at
 * compile time instead of at render time.
 */
export type Dictionary = {
  readonly [K in keyof typeof EN]: { readonly [P in keyof (typeof EN)[K]]: string }
}

/**
 * What a non-English locale file is allowed to be: any subset.
 *
 * ⚠ INCOMPLETENESS IS A FEATURE HERE, not laxness. Six languages times the
 *   money copy is a great deal of review that has to be done by someone who
 *   understands the contracts, and a type that demanded every key would block
 *   the first language from shipping until the sixth was finished. Anything
 *   absent falls back to English per key — mixed language is ugly and safe,
 *   where a missing key rendering as `refund.noneReason` is neither.
 *
 *   Completeness is a POLICY question, so it lives in `guard:i18n`, which can
 *   require it for the surfaces and locales that have been promised and stay
 *   quiet about the rest. See `TIER0_SURFACES` in `dict/en.ts`.
 *
 * Keys are still checked: a locale cannot invent one, and cannot misspell one.
 */
export type PartialDictionary = {
  readonly [K in keyof Dictionary]?: {
    readonly [P in keyof Dictionary[K]]?: string
  }
}
