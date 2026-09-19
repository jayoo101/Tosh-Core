/**
 * Fails if any source file is not valid UTF-8, carries the signature of a
 * round-trip through GBK, or has CRLF line endings.
 *
 * WHY THIS EXISTS: an editing pass once round-tripped two test files through a
 * lossy ANSI encoder, which turned the final byte of `—` (E2 80 94) into `?`
 * (E2 80 3F).  solc rejects the whole file with "stream did not contain valid
 * UTF-8" and names no line, so the failure is both total and untraceable.
 * Comments are full of em-dashes here, so the blast radius is wide.
 *
 * WHY THE UTF-8 CHECK ALONE IS NOT ENOUGH: the same accident has a second,
 * quieter form.  When the mangled text is *re-saved* as UTF-8 rather than left
 * as raw bytes, every byte pair that GBK could map becomes a real CJK
 * character, and the file is then perfectly valid UTF-8 full of nonsense.  That
 * is how mangled em dashes, section signs, a Greek mu and whole runs of box
 * drawing from forge call traces sat in this repo past a green encoding check.
 * So the second pass looks for the characters GBK produces from the UTF-8 lead
 * bytes of common punctuation, rather than for CJK in general: this repo has
 * deliberate CJK — a Japanese test fixture, a Chinese gloss in a contract, a
 * Chinese PRD — and banning the script wholesale would fail on all three.
 *
 *   node scripts/checkEncoding.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

/** `docs` is here because it is the highest-density em-dash surface in the
 *  repository — the prose documents use them constantly — and it was the one
 *  place the first version of this guard did not look. The targeted rules
 *  below match mangled punctuation rather than CJK, so a Chinese draft in
 *  `docs/` (if one returns) would still pass. */
const ROOTS = ['src', 'test', 'script', 'docs', 'soat-frontend/src', 'soat-frontend/scripts']
const EXTS = new Set(['.sol', '.ts', '.tsx', '.js', '.mjs', '.json', '.md'])

/** Tracked generated artefacts that no ROOT reaches. `gasreport.txt` is captured
 *  from forge's stdout, which is exactly where a non-UTF-8 console does this
 *  damage, so it is the one file most likely to reacquire it. */
const EXTRA_FILES = ['gasreport.txt']

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

/**
 * The GBK renderings of the UTF-8 lead bytes of the punctuation this repo
 * actually uses.  A three-byte UTF-8 sequence read as GBK turns its first two
 * bytes into one character, so each entry below identifies a whole Unicode
 * block: `鈥` means "something from U+2000-U+203F was mangled", and in prose
 * that is an em dash nine times out of ten.
 *
 * Every character here is a rare Han character that no plausible comment,
 * fixture or document in this repo would contain on purpose.  Deliberately NOT
 * listed: U+70EB, U+92AC, U+7039 and U+9428.  Those mark double-encoded
 * *Chinese* rather than mangled punctuation, which is a different accident from
 * the one this repo suffered; U+70EB in particular is an everyday word
 * ("scalding") and belongs to the MSVC uninitialised-memory signature, not to
 * this class.  Adding one is a single line if that day comes.
 *
 * The characters are written as escapes throughout, so that this file can never
 * fail its own check.
 */
const MOJIBAKE = [
  {
    ch: '\u9225', from: 'E2 80',
    likely: "an em dash '\u2014' (U+2014), or another U+2000-U+203F punctuation mark",
  },
  {
    ch: '\u922B', from: 'E2 86',
    likely: "an arrow '\u2192' (U+2192), or another U+2180-U+21BF arrow",
  },
  {
    ch: '\u9239', from: 'E2 94',
    likely: "box drawing '\u2502' / '\u251C\u2500' / '\u2514\u2500' (U+2500-U+253F), as in a forge call trace",
  },
  {
    ch: '\u923A', from: 'E2 95',
    likely: "box drawing '\u256D' / '\u256E' / '\u2570' / '\u256F' (U+2540-U+257F), as in a forge gas-report table",
  },
  {
    ch: '\u6402', from: 'C2 A7',
    likely: "a section sign '\u00A7' (U+00A7)",
  },
  {
    // U+6E2D is the only entry that is also a real, current word (Wei, as in
    // the Wei river), so it is scoped to the shape the gas report produces:
    // `\u03BC: 2287649`.  Unscoped it would be the one rule here capable of
    // failing a legitimate Chinese document.
    ch: '\u6E2D', from: 'CE BC', after: /^\s*[:\d]/,
    likely: "a Greek mu '\u03BC' (U+03BC), as in a fuzz gas mean",
  },
  {
    ch: '\u951F', from: 'EF BF',
    likely: "a replacement character U+FFFD \u2014 the text was already lossy before it was re-encoded",
  },
  {
    ch: '\uFFFD', from: 'EF BF BD',
    likely: 'a character the encoder could not map at all; the original is gone and must be retyped',
  },
]

/**
 * WHY LINE ENDINGS ARE CHECKED BY AN *ENCODING* GUARD: both failures are the
 * same failure. A file's bytes are an input to something that hashes them, and
 * an editor changed the bytes without changing the text.
 *
 * `.gitattributes` spells out the consequence and is worth reading in full, but
 * the short version is that solc hashes the source bytes into the contract
 * metadata, the metadata hash goes into the creation code, and the creation
 * code determines the CREATE2 address the frontend mines against. A `.sol` file
 * saved CRLF therefore produces a hook at an address nobody predicted:
 * `InvalidHookSalt` at launch, and explorer verification that fails against the
 * deployed bytecode.
 *
 * ⚠ THAT COMMENT ENDS "THAT IS LUCK, NOT A PROPERTY", AND IT WAS RIGHT. Nothing
 *   enforced it. At the time this pass was added the working tree held five
 *   CRLF files — none of them `.sol`, which is the whole of why the warning had
 *   stayed theoretical. `core.autocrlf=true` is the Git for Windows default and
 *   `* text=auto eol=lf` only governs what a *checkout* writes; an editor
 *   saving CRLF afterwards is outside it, and git then shows the file as
 *   modified with an empty diff, which reads as noise rather than as a warning.
 *
 * CI checks out fresh and gets LF from `.gitattributes`, so this passes there
 * by construction. Its value is local: it catches the editor before the habit
 * reaches a `.sol` file.
 */
function crlfLines(buf) {
  const lines = []
  for (let i = 1, line = 1; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (buf[i - 1] === 0x0d) lines.push(line)
      line++
    }
  }
  return lines
}

/** Returns one hit per offending character, with 1-based line and column. */
function mojibakeHits(text) {
  const hits = []
  text.split('\n').forEach((line, li) => {
    for (let ci = 0; ci < line.length; ci++) {
      const entry = MOJIBAKE.find(m => m.ch === line[ci])
      if (!entry) continue
      if (entry.after && !entry.after.test(line.slice(ci + 1))) continue
      hits.push({ line: li + 1, col: ci + 1, text: line, entry })
    }
  })
  return hits
}

const files = [...ROOTS.flatMap(r => walk(r)), ...EXTRA_FILES]

let failed = 0
for (const file of files) {
  let buf
  try { buf = readFileSync(file) } catch { continue }

  const bad = invalidSequences(buf)
  if (bad.length > 0) {
    failed++
    const first = bad[0].offset
    const hex = [...buf.subarray(first, first + 3)].map(x => x.toString(16).padStart(2, '0')).join(' ')
    const ctx = buf.subarray(Math.max(0, first - 40), first + 40).toString('latin1').replace(/\n/g, '\\n')
    console.error(`${file}: ${bad.length} invalid UTF-8 sequence(s), first @${first} [${hex}]`)
    console.error(`  ...${ctx}...`)
    // Decoding this file would substitute U+FFFD everywhere it is broken, so the
    // mojibake pass below would only restate what was just reported.
    continue
  }

  // Reported independently of the mojibake pass rather than with `continue`:
  // a file can be both CRLF and mangled, they are fixed by different actions,
  // and a guard that hides the second until the first is cleared costs a round
  // trip for no reason.
  const crlf = crlfLines(buf)
  if (crlf.length > 0) {
    failed++
    const shown = crlf.slice(0, 5).join(', ')
    console.error(`${file}: ${crlf.length} CRLF line ending(s), first at line ${crlf[0]}` +
                  (crlf.length > 5 ? ` (lines ${shown}, …)` : ` (lines ${shown})`))
    console.error(`  Source bytes are hashed into contract metadata and thence into the CREATE2`)
    console.error(`  address — see .gitattributes. Re-save as LF.`)
  }

  const hits = mojibakeHits(buf.toString('utf8'))
  if (hits.length === 0) continue

  failed++
  console.error(`${file}: ${hits.length} mojibake character(s) from a GBK round-trip`)
  for (const h of hits) {
    const cp = 'U+' + h.entry.ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
    console.error(`  ${file}:${h.line}:${h.col}: '${h.entry.ch}' ${cp} <- UTF-8 ${h.entry.from} read as GBK; should be ${h.entry.likely}`)
    console.error(`    ...${h.text.trim().slice(0, 100)}...`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) with broken encoding.`)
  process.exit(1)
}
console.log(`All ${files.length} source files are valid UTF-8 and LF-only, with no GBK round-trip damage.`)
