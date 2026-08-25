#!/usr/bin/env node
/**
 * ONE-SHOT CODEMOD: hue-named token aliases -> semantic token names.
 *
 * Every mapping below is value-identical (see the alias block in globals.css),
 * so this rewrite is pixel-identical by construction. It is mechanical on
 * purpose: `node scripts/checkTokens.mjs` proves the result afterwards, which
 * is the only reason a 359-site rename is safe to do in one pass.
 *
 * THE TRAP THIS AVOIDS
 *   `tosh-raised` is BOTH a colour token (`bg-tosh-raised`) and a real CSS
 *   component class (`.tosh-raised`, an inset well). A blind find-and-replace
 *   would rewrite the component class too and silently delete the well on every
 *   input in the app. So the pattern requires a colour-utility prefix and
 *   rewrites only the token segment, never a bare class name.
 *
 * Delete this file once it has been run and committed.
 *
 * Usage: node scripts/migrateTokens.mjs [--dry]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, extname, dirname } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src')
const DRY = process.argv.includes('--dry')

/** Longest-first is load-bearing: `tosh-line-strong` must win over `tosh-line`. */
const MAP = [
  ['tosh-line-strong', 'border-strong'],
  ['tosh-fluo-dim',    'brand-muted'],
  ['tosh-rust-dim',    'danger-dim'],
  ['tosh-amber-dim',   'warning-dim'],
  ['tosh-curve-dim',   'info-dim'],
  ['tosh-admin-dim',   'admin-dim'],
  ['tosh-ink-dim',     'text-secondary'],
  ['tosh-canvas',      'bg-base'],
  ['tosh-surface',     'surface-card'],
  ['tosh-raised',      'surface-elevated'],
  ['tosh-overlay',     'surface-elevated'],
  ['tosh-line',        'border-subtle'],
  ['tosh-ink',         'text-primary'],
  ['tosh-mute',        'text-tertiary'],
  ['tosh-faint',       'text-quiet'],
  ['tosh-fluo',        'brand'],
  ['tosh-rust',        'danger'],
  ['tosh-amber',       'warning'],
  ['tosh-curve',       'info'],
  ['tosh-admin',       'admin'],
]

const UTILS = [
  'bg', 'text', 'border', 'ring', 'divide', 'outline', 'fill', 'stroke',
  'from', 'to', 'via', 'shadow', 'accent', 'caret', 'decoration',
]

const ALIASES = MAP.map(([from]) => from).join('|')

/**
 * `<util>-<alias>` with an optional side suffix (`border-t-tosh-line`). The
 * lookahead stops the match at a class boundary so `/30` opacity modifiers and
 * adjacent classes survive untouched.
 */
const RE = new RegExp(
  String.raw`\b((?:${UTILS.join('|')})-(?:(?:t|b|l|r|x|y|tl|tr|bl|br)-)?)(${ALIASES})(?=[\s"'\`}\])!:/]|$)`,
  'g',
)

const LOOKUP = new Map(MAP)
const FILE_EXT = new Set(['.ts', '.tsx'])

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (FILE_EXT.has(extname(p))) yield p
  }
}

let files = 0
let hits = 0

for (const file of walk(SRC)) {
  const before = readFileSync(file, 'utf8')
  let n = 0
  const after = before.replace(RE, (_m, prefix, alias) => {
    n++
    return prefix + LOOKUP.get(alias)
  })
  if (n === 0) continue
  files++
  hits += n
  console.log(`  ${String(n).padStart(4)}  ${relative(ROOT, file).replace(/\\/g, '/')}`)
  if (!DRY) writeFileSync(file, after, 'utf8')
}

console.log(`\n[migrate] ${DRY ? 'would rewrite' : 'rewrote'} ${hits} reference(s) in ${files} file(s).`)
console.log('[migrate] now run: node scripts/checkTokens.mjs')
