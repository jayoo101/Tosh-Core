import type { PartialDictionary } from '../types'

/**
 * Русский — not translated yet.
 *
 * ⚠ An empty dictionary is a working state. Every missing key falls back to
 *   English individually; this file means "the Russian goes here". Until
 *   `NEXT_PUBLIC_LOCALES` lists `ru` it is never loaded.
 *
 * ⚠ THE LONGEST LOCALE THIS BUILD OFFERS — reckon on 30% over English, and
 *   individual words far worse than that. Combined with mono-spaced fixed-width
 *   cells, this is the locale that decides whether a layout survives, so review
 *   it in a browser before enabling it.
 *
 * ⚠ CASE ENDINGS ARE THE TRAP FOR `{action}`. The three `tx` templates put a
 *   noun into a slot ("Awaiting signature — {action}"), and Russian inflects a
 *   noun by its role in the sentence. Write the templates so the slot takes the
 *   nominative — e.g. a colon or a dash followed by the bare noun — rather than
 *   a preposition that would demand a different case for every action fed in.
 *
 * Read the comments in `zh-CN.ts` first for the reasoning behind each line.
 */
export const RU: PartialDictionary = {}
