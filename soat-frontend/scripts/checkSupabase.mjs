/**
 * Guard: every Supabase query carries a deadline.
 *
 * supabase-js ships no timeout AND retries four times with backoff. Against a
 * host whose TLS handshake was being reset, each attempt failed in ~1.65 s and
 * the call settled after **13.9 s**. That is not a slow query, it is a hang
 * with a stopping condition nobody chose.
 *
 * Three call sites existed and only one had thought about it — `getProject`,
 * which raced a `setTimeout` and so bounded its own wait while leaving the
 * retry chain running behind it. The other two simply paid the full span:
 * `GET /api/projects` answered after fourteen seconds on every request, and
 * `POST /api/projects` could hold the publish step open just as long with the
 * user's launch already mined and their gas already spent.
 *
 * Why a source guard rather than a test: a test can only prove that the call
 * sites which exist today are bounded. The failure here was not a wrong value
 * anywhere — it was a question two of three call sites never asked, and the
 * fourth one added will not ask it either. That is a property of the source
 * text, so this is where it is checkable.
 *
 * Why not a wrapper that cannot be bypassed: `.abortSignal()` has to sit at a
 * specific point in the builder chain (before `.single()`, which returns the
 * terminal builder), so a wrapper would have to re-expose the whole PostgREST
 * surface to stay usable. Naming the requirement is cheaper and the error
 * message can say what to do.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { blankComments } from './lib/blankComments.mjs'

const SRC = 'src'
const EXTS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'])

/** `foo.test.ts` — never bundled, and mocks the client outright. */
const isTest = (name) => /\.test\.[cm]?[jt]sx?$/.test(name)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXTS.has(name.slice(name.lastIndexOf('.'))) && !isTest(name)) out.push(p)
  }
  return out
}

/**
 * Spans one Supabase `.from(...)` chain, from `.from(` to the statement's end.
 *
 * The chains here are multi-line and the deadline can sit on any line of one,
 * so a line-by-line scan cannot see it. Depth counting ends the chain at the
 * point the expression does, which keeps a later unbounded query in the same
 * file from being covered by an earlier bounded one.
 *
 * The receiver pattern is any identifier CONTAINING "supabase", not the exact
 * word. It was the exact word until a second client arrived: splitting reads
 * (anon) from writes (service role) introduced `supabaseAdmin.from(...)`, and
 * an anchored match would have skipped the one call site on the write path —
 * the path with no fallback, where a hang holds the publish step open with the
 * user's launch already mined. This guard's own docstring predicted that
 * ("the fourth one added will not ask it either"); it did not predict that the
 * fourth one would be invisible to the guard.
 *
 * The limitation that remains: a client bound to a name with no "supabase" in
 * it is not seen. That is a naming convention doing load-bearing work, which
 * is worth knowing about, but the alternative — matching every `.from(` in the
 * tree — collects `Array.from` and `Buffer.from` and stops being read.
 */
function chains(text) {
  const found = []
  const re = /\b[\w$]*supabase[\w$]*\s*(?:\r?\n\s*)?\.from\s*\(/gi
  let m
  while ((m = re.exec(text)) !== null) {
    let i = m.index + m[0].length
    let depth = 1
    // Walk to the matching paren of `.from(`, then keep going while the
    // expression continues with further `.method(...)` links.
    while (i < text.length && depth > 0) {
      const c = text[i]
      if (c === '(') depth++
      else if (c === ')') depth--
      else if (c === '"' || c === "'" || c === '`') {
        const q = c
        i++
        while (i < text.length) {
          if (text[i] === '\\') { i += 2; continue }
          if (text[i] === q) break
          i++
        }
      }
      i++
    }
    while (i < text.length) {
      const rest = text.slice(i)
      const cont = /^\s*\.\s*[A-Za-z_$][\w$]*\s*\(/.exec(rest)
      if (!cont) break
      i += cont[0].length
      depth = 1
      while (i < text.length && depth > 0) {
        const c = text[i]
        if (c === '(') depth++
        else if (c === ')') depth--
        else if (c === '"' || c === "'" || c === '`') {
          const q = c
          i++
          while (i < text.length) {
            if (text[i] === '\\') { i += 2; continue }
            if (text[i] === q) break
            i++
          }
        }
        i++
      }
    }
    found.push({
      line: text.slice(0, m.index).split('\n').length,
      body: text.slice(m.index, i),
    })
  }
  return found
}

let failures = 0
let checked = 0

for (const file of walk(SRC)) {
  // Comments go first, or the prose in `app/lib/supabase.ts` explaining this
  // very requirement reads as an unbounded query, and a comment sitting
  // between two links breaks the chain walk at that point.
  const text = blankComments(readFileSync(file, 'utf8'))
  if (!text.includes('.from(')) continue
  for (const chain of chains(text)) {
    checked++
    if (chain.body.includes('.abortSignal(')) continue
    failures++
    console.log(
      `FAIL  ${relative('.', file)}:${chain.line} supabase query has no deadline.\n` +
      '        supabase-js has no default timeout and retries 4x with backoff, so\n' +
      '        this call can take ~14 s to fail. Add, before any .single():\n' +
      '          .abortSignal(AbortSignal.timeout(REGISTRY_READ_DEADLINE_MS))\n' +
      '        (or REGISTRY_WRITE_DEADLINE_MS) from app/lib/supabase.ts.',
    )
  }
}

console.log(
  failures === 0
    ? `\nAll ${checked} Supabase quer${checked === 1 ? 'y carries a deadline' : 'ies carry a deadline'}.`
    : `\n${failures} of ${checked} Supabase queries have no deadline.`,
)
process.exit(failures === 0 ? 0 : 1)
