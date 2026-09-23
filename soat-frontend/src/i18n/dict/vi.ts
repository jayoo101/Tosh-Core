import type { PartialDictionary } from '../types'

/**
 * Tiếng Việt — not translated yet.
 *
 * ⚠ An empty dictionary is a working state. Every missing key falls back to
 *   English individually; this file means "the Vietnamese goes here". Until
 *   `NEXT_PUBLIC_LOCALES` lists `vi` it is never loaded.
 *
 * ⚠ RUNS LONGER THAN ENGLISH, typically 20–30%, and the diacritics add height to
 *   every line. This app's panels are mono-spaced cells with fixed widths, so
 *   this is the locale most likely to overflow a readout or wrap a button label
 *   onto two lines. Check the deposit and refund panels in a browser rather than
 *   trusting the tests, which only prove the words are right.
 *
 * Read the comments in `zh-CN.ts` first — they record why each line is worded
 * the way it is.
 */
export const VI: PartialDictionary = {}
