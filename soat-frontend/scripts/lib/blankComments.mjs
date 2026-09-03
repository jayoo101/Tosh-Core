/**
 * Blanks comments while preserving every byte offset, so line and column
 * numbers reported against the result still point at the real source.
 *
 * Shared by the source guards because each of them explains, in its own header
 * and in the code it protects, the exact pattern it is looking for — and would
 * otherwise flag those explanations. `checkSupabase.mjs` failed on the
 * paragraph in `app/lib/supabase.ts` describing `supabase.from(...)` chains
 * before this was applied.
 *
 * A regex cannot do this: `//` inside `'https://…'` starts no comment, and
 * stripping from there would blind a caller to real code later on the line.
 *
 * @param {string} text
 * @param {{ keepStrings?: boolean }} [opts] `keepStrings` leaves string bodies
 *   intact for callers scanning for literals (URLs, keys). Either way the scan
 *   steps over strings whole, so a quote inside one cannot desynchronise it.
 * @returns {string} same length as `text`
 */
export function blankComments(text, { keepStrings = true } = {}) {
  const out = text.split('')
  const n = text.length
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/') {
      let j = i
      while (j < n && text[j] !== '\n') j++
      blank(i, j)
      i = j
    } else if (c === '/' && d === '*') {
      let j = text.indexOf('*/', i + 2)
      j = j === -1 ? n : j + 2
      blank(i, j)
      i = j
    } else if (c === '"' || c === "'" || c === '`') {
      const start = i
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === c) { j++; break }
        j++
      }
      if (!keepStrings) blank(start + 1, Math.max(start + 1, j - 1))
      i = j
    } else {
      i++
    }
  }
  return out.join('')
}
