/**
 * Fails if any source file is not valid UTF-8.
 *
 * WHY THIS EXISTS: an editing pass once round-tripped two test files through a
 * lossy ANSI encoder, which turned the final byte of `—` (E2 80 94) into `?`
 * (E2 80 3F).  solc rejects the whole file with "stream did not contain valid
 * UTF-8" and names no line, so the failure is both total and untraceable.
 * Comments are full of em-dashes here, so the blast radius is wide.
 *
 *   node scripts/checkEncoding.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['src', 'test', 'script', 'soat-frontend/src', 'soat-frontend/scripts']
const EXTS = new Set(['.sol', '.ts', '.tsx', '.js', '.mjs', '.json', '.md'])

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXTS.has(extname(p))) out.push(p)
  }
  return out
}

/** Returns the byte offsets of malformed sequences, with context. */
function invalidSequences(buf) {
  const bad = []
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    if (b < 0x80) { i++; continue }

    let len
    if ((b & 0xe0) === 0xc0) len = 2
    else if ((b & 0xf0) === 0xe0) len = 3
    else if ((b & 0xf8) === 0xf0) len = 4
    else { bad.push({ offset: i, buf }); i++; continue }

    let ok = i + len <= buf.length
    if (ok) for (let k = 1; k < len; k++) if ((buf[i + k] & 0xc0) !== 0x80) ok = false

    if (!ok) { bad.push({ offset: i, buf }); i += 1 } else i += len
  }
  return bad
}

let failed = 0
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const buf = readFileSync(file)
    const bad = invalidSequences(buf)
    if (bad.length === 0) continue

    failed++
    const first = bad[0].offset
    const hex = [...buf.subarray(first, first + 3)].map(x => x.toString(16).padStart(2, '0')).join(' ')
    const ctx = buf.subarray(Math.max(0, first - 40), first + 40).toString('latin1').replace(/\n/g, '\\n')
    console.error(`${file}: ${bad.length} invalid UTF-8 sequence(s), first @${first} [${hex}]`)
    console.error(`  ...${ctx}...`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) with broken encoding.`)
  process.exit(1)
}
console.log('All source files are valid UTF-8.')
