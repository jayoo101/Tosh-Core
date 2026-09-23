import type { PartialDictionary } from '../types'

/**
 * 日本語 — not translated yet.
 *
 * ⚠ An empty dictionary is a working state, not a broken one. Every missing key
 *   falls back to English individually, so this file means "the Japanese goes
 *   here", not "Japanese is broken". Until `NEXT_PUBLIC_LOCALES` lists `ja` it
 *   is never even loaded.
 *
 * ⚠ THE VERB COMES LAST, which is why `en.ts` forbids concatenated fragments.
 *   Anything in English built by joining a stem to a shared clause cannot be
 *   reproduced here by translating the pieces — each string has to be written
 *   whole. If a key ever appears that seems to want splitting, the split belongs
 *   in English, not here.
 *
 * Read the comments in `zh-CN.ts` before starting: they record why each line is
 * worded the way it is, which matters more than the wording itself for the
 * refund and deposit copy.
 */
export const JA: PartialDictionary = {}
