/**
 * Fails if any source file is not valid UTF-8, contains a NUL byte, carries the
 * signature of a round-trip through GBK, or has CRLF line endings.
 *
 * WHY THIS EXISTS: an editing pass once round-tripped two test files through a
 * lossy ANSI encoder, which turned the final byte of `—` (E2 80 94) into `?`
 * (E2 80 3F).  solc rejects the whole file with "stream did not contain valid
 * UTF-8" and names no line, so the failure is both total and untraceable.
 * Comments are full of em-dashes here, so the blast radius is wide.
 *
 * ⚠ THE ENCODER IS USUALLY POWERSHELL, AND IT DAMAGES FILES THREE SEPARATE
 *   WAYS. All three have been caught in this repo, all three from scripted
 *   bulk edits, and they fail differently enough to be worth telling apart:
 *
 *     1. READING.  `Get-Content -Raw` on Windows decodes UTF-8 as the ANSI
 *        code page, so every em dash is already wrong before any edit is
 *        applied; writing the string back mangles the whole file at once.
 *        This is the accident described above.
 *     2. WRITING an escape by accident.  In a double-quoted PowerShell string
 *        `` `0 `` is the null character, so a replacement containing the text
 *        `` `0x1111` `` writes a NUL — see `nulOffsets` below for what that
 *        then costs.
 *     3. LINE ENDINGS.  A PowerShell write defaults to CRLF, which
 *        `.gitattributes` forbids and `crlfLines` below explains.
 *
 *   The conclusion this repo has reached twice is the same one: do not edit
 *   tracked files through PowerShell string replacement. Use an editor, or
 *   node with an explicit `'utf8'` on both ends.
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

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extname } from 'node:path'

const EXTS = new Set(['.sol', '.ts', '.tsx', '.js', '.mjs', '.json', '.md'])

/**
 * Generated artefacts, excluded by prefix.
 *
 * `broadcast/` and `verify-out/` are forge's own JSON output. They are tracked
 * as deployment provenance and are never hand-edited, so they cannot acquire
 * the damage this guard looks for — and they are 38 files of machine noise in
 * any failure listing.
 */
const GENERATED = ['broadcast/', 'verify-out/']

/**
 * Every tracked file of a source extension, asked of git rather than walked.
 *
 * ⚠ THIS USED TO BE A HARDCODED LIST OF SIX DIRECTORIES, AND THE LIST WAS THE
 *   BUG. It read `['src', 'test', 'script', 'docs', 'soat-frontend/src',
 *   'soat-frontend/scripts']` plus one named extra, which covered 219 of the
 *   327 tracked source files in this repository. The 108 it did not see
 *   included:
 *
 *     - `scripts/` — 41 files, among them `preflightMainnet.mjs` and this
 *       guard itself. Note `script/` (forge) was listed and `scripts/` (node)
 *       was not, which is a one-character difference between covered and not.
 *     - `README.md` and `SECURITY.md` — the two longest prose documents in the
 *       repo and, after `docs/`, the densest em-dash surfaces in it. `docs/`
 *       had been added by name after an earlier miss; the root-level documents
 *       were never added, so the fix that occasioned that comment stopped one
 *       directory short.
 *     - `monitoring/` — 8 files including `alerts.json`, whose contents are
 *       read by an on-call human at the worst possible moment.
 *
 *   The list could be extended again, and would go stale again the next time
 *   somebody adds a directory. Asking git removes the failure mode instead of
 *   patching this instance of it: anything tracked is checked, and the only
 *   maintained set is the generated output above, which is a much slower-
 *   moving thing than the source tree.
 *
 * Tracked, not on-disk: an untracked scratch file is not going to be committed
 * with damage in it, and node_modules is not ours to police.
 */
function trackedSourceFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  return out.split('\0')
    .filter(Boolean)
    .filter(f => EXTS.has(extname(f)))
    .filter(f => !GENERATED.some(g => f.startsWith(g)))
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
 * block: U+9225 means "something from U+2000-U+203F was mangled", and in prose
 * that is an em dash nine times out of ten.
 *
 * ⚠ THAT SENTENCE USED TO PRINT THE CHARACTER ITSELF, and the header's claim
 *   that this file "can never fail its own check" was true only because the
 *   file was not in scope. The first run after the scan widened to every
 *   tracked file flagged line 104 of this guard — correctly. Codepoints, not
 *   glyphs, anywhere the table is discussed.
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
 * fail its own check — which it is now subject to, and was not when that
 * sentence was written.
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

/**
 * Returns the byte offsets of NUL bytes, which are valid UTF-8 and are still
 * corruption.
 *
 * ⚠ ADDED AFTER THIS GUARD PASSED A FILE IT SHOULD HAVE FAILED. A scripted edit
 *   to `FactoryDials.tsx` wrote a PowerShell double-quoted string containing
 *   `` `0 ``, which is that shell's escape for the null character, so a literal
 *   NUL landed mid-comment. U+0000 is perfectly well-formed UTF-8, carries no
 *   GBK signature and is not a line ending, so all three passes above said the
 *   file was clean.
 *
 *   Git was not fooled: it re-classified the file as BINARY, which silently
 *   costs every diff, every blame and every merge on it — `git diff` reported
 *   `Bin 17577 -> 17820 bytes` where the review needed to see nineteen changed
 *   lines. That is the damage, and it is the kind that survives review because
 *   the file still opens, still compiles and still passes tsc.
 *
 * Zero tolerance rather than a heuristic: no source file in any of these
 * extensions has a legitimate reason to contain a NUL, so there is no
 * false-positive case to scope around the way `U+6E2D` needed scoping.
 */
function nulOffsets(buf) {
  const hits = []
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x00) hits.push(i)
  return hits
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

const files = trackedSourceFiles()

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

  const nuls = nulOffsets(buf)
  if (nuls.length > 0) {
    failed++
    const first = nuls[0]
    const ctx = buf.subarray(Math.max(0, first - 40), first + 40)
      .toString('utf8').replace(/\n/g, '\\n').replace(/\u0000/g, '<NUL>')
    console.error(`${file}: ${nuls.length} NUL byte(s), first @${first}`)
    console.error(`  ...${ctx}...`)
    console.error(`  Valid UTF-8, but git treats the file as binary — no diff, no blame, no merge.`)
    console.error(`  Usually a shell escape that ran: PowerShell reads \`0 in a double-quoted`)
    console.error(`  string as the null character.`)
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
console.log(`All ${files.length} source files are valid UTF-8, NUL-free and LF-only, with no GBK round-trip damage.`)
