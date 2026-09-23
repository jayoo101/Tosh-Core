import type { PartialDictionary } from '../types'

/**
 * 한국어 — not translated yet.
 *
 * ⚠ An empty dictionary is a working state. Every missing key falls back to
 *   English individually; this file means "the Korean goes here". Until
 *   `NEXT_PUBLIC_LOCALES` lists `ko` it is never loaded.
 *
 * ⚠ Verb-final, like Japanese, so the no-fragments rule in `en.ts` applies with
 *   full force: write each string whole rather than translating the pieces of an
 *   English sentence that was assembled from parts.
 *
 * Read the comments in `zh-CN.ts` first — they record the reasoning behind each
 * line, which for the refund copy matters more than the phrasing.
 */
export const KO: PartialDictionary = {}
