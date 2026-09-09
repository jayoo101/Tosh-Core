/**
 * Guard: every `NEXT_PUBLIC_*` variable the production template asks an
 * operator to set must actually be readable by the built app, and no source
 * file may read env through a computed key.
 *
 * The bug this exists to prevent was invisible in every way a bug can be. Two
 * helpers took a variable NAME and did `process.env[name]`:
 *
 *   envAddress('NEXT_PUBLIC_POSITION_MANAGER', SEPOLIA_FALLBACK)
 *   trimmedEnv('NEXT_PUBLIC_RPC_URL')
 *
 * Next.js does not evaluate `process.env` in the browser. It performs a
 * TEXTUAL substitution at build time, replacing the literal source characters
 * `process.env.NEXT_PUBLIC_FOO` with the value. A computed member access is not
 * that string, so it is never substituted, and the bundled `process.env` is an
 * empty object. Both helpers therefore returned their fallback in every build
 * that has ever shipped.
 *
 * Nothing could catch it downstream:
 *   - Types are fine; `process.env[name]` is a legal `string | undefined`.
 *   - Lint is fine.
 *   - `next build` is fine.
 *   - It WORKS under `next dev` and in every server-side route, because there
 *     the code runs in Node against a real `process.env`. So the natural way to
 *     test it — set the var, load the page locally — passes.
 *   - The fallbacks are the Base Sepolia addresses, so staging behaved exactly
 *     as intended.
 *
 * The one moment it would have surfaced is the mainnet cutover: an operator
 * follows PM-B4, sets `NEXT_PUBLIC_POSITION_MANAGER` to the Ethereum posm,
 * builds, and ships a bundle whose LP panel still encodes calls to a Sepolia
 * contract that does not exist on L1. No runtime assertion can defend against
 * this, because the value is discarded at build time, not at run time. Only a
 * source-level check can.
 *
 * Scope: this file checks the WIRING — that each documented variable is one the
 * build can actually read. It has no opinion on values, and PM-C7 shipped with
 * both checks below green because the values themselves disagreed (mainnet
 * contract addresses under a testnet chain id). `checkDeployedChain.mjs` is the
 * companion that cross-checks those against `broadcast/`.
 *
 * Hence two checks, both cheap:
 *
 *   A. No computed `process.env[...]` under `src/`. A blanket ban rather than a
 *      client-only ban: server code has no need for one either, and a rule with
 *      no exceptions cannot be misapplied at review time.
 *
 *   B. Every `NEXT_PUBLIC_*` key in `.env.production.example` appears somewhere
 *      under `src/` (or the instrumentation entrypoints) as the exact literal
 *      `process.env.THAT_NAME`. This is the direct test of the property that
 *      actually matters: the template is the operator's instruction sheet, so a
 *      key listed there that no file reads statically is a promise the build
 *      cannot keep.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = 'src'
const TEMPLATE = '.env.production.example'
const EXTRA_ENTRYPOINTS = ['instrumentation.ts', 'instrumentation-client.ts', 'next.config.ts']
const EXTS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'])

/** `foo.test.ts` — never bundled, so it cannot satisfy either check. */
const isTest = (name) => /\.test\.[cm]?[jt]sx?$/.test(name)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      walk(p, out)
    // Excluded from check B in particular: a template key that only a test
    // mentions is still a key no shipped code reads, and counting it would
    // report green on exactly the promise this guard exists to verify.
    } else if (EXTS.has(name.slice(name.lastIndexOf('.'))) && !isTest(name)) {
      out.push(p)
    }
  }
  return out
}

const files = walk(SRC)
for (const f of EXTRA_ENTRYPOINTS) if (existsSync(f)) files.push(f)

const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))

let failures = 0
const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`) }

// ── Check A — computed env access ───────────────────────────────────────────
// Matches `process.env[` with any whitespace, which is the only spelling that
// defeats the build-time substitution.
const COMPUTED = /process\s*\.\s*env\s*\[/g

/**
 * Blank out comments and string bodies, preserving line count and column
 * positions so reported line numbers stay honest.
 *
 * Comments have to go or this guard flags the paragraphs that explain the bug
 * it guards against — including the one at the top of this file. Strings go
 * too, so a name held in a lookup table (`const KEYS = ['process.env[...]']`)
 * cannot trip it either. This is a lexer's job and a regex cannot do it: `//`
 * inside `'http://…'` starts no comment, and stripping from there would hide
 * real code later on the line.
 */
function blankNonCode(text) {
  const out = text.split('')
  let i = 0
  const n = text.length
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }
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
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === c) { j++; break }
        j++
      }
      blank(i + 1, Math.max(i + 1, j - 1))
      i = j
    } else {
      i++
    }
  }
  return out.join('')
}

/** Comment- and string-free view of each file. Both checks read from this. */
const code = new Map([...sources].map(([f, t]) => [f, blankNonCode(t)]))

let computedHits = 0
for (const [file, text] of code) {
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    COMPUTED.lastIndex = 0
    if (COMPUTED.test(line)) {
      computedHits++
      fail(
        `${relative('.', file)}:${i + 1} reads env through a computed key — ` +
        `Next.js will not inline it and it is undefined in the browser\n` +
        `        ${text.split('\n')[i].trim()}`,
      )
    }
  })
}
if (computedHits === 0) {
  console.log('A. no computed process.env[...] access under src/  — ok')
}

// ── Check B — template keys are statically read ─────────────────────────────
const template = readFileSync(TEMPLATE, 'utf8')
const declared = [...new Set(
  template
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .map((l) => l.match(/^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=/)?.[1])
    .filter(Boolean),
)]

if (declared.length === 0) {
  fail(`${TEMPLATE} declares no NEXT_PUBLIC_* keys — the parser or the template is wrong`)
}

// Deliberately the comment-stripped view: a mutation test caught this reading
// the raw text and passing, because the docstring on `envAddress` shows the
// correct call as an EXAMPLE. A guard that a nearby comment can satisfy is
// worse than none — it reports green while the code it describes is wrong.
const allText = [...code.values()].join('\n')

console.log(`\nB. ${declared.length} NEXT_PUBLIC_* key(s) declared in ${TEMPLATE}`)
for (const key of declared) {
  // The exact literal Next.js substitutes. Anything else is not a read.
  const statically = allText.includes(`process.env.${key}`)
  console.log(`   ${statically ? 'ok  ' : 'MISS'} ${key}`)
  if (!statically) {
    fail(
      `${key} is in ${TEMPLATE} but no file contains the literal ` +
      `\`process.env.${key}\`, so setting it changes nothing in the build`,
    )
  }
}

console.log(
  failures === 0
    ? '\nEvery documented NEXT_PUBLIC_* var is statically read, and no file reads env by computed key.'
    : `\n${failures} failure(s) — see FAIL lines above.`,
)
process.exit(failures === 0 ? 0 : 1)
