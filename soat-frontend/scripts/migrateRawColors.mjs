#!/usr/bin/env node
/**
 * ONE-SHOT CODEMOD: raw palette shades and bare hex -> semantic tokens.
 *
 * THE THING THAT MAKES THIS NON-TRIVIAL
 *   `zinc-800` is not one colour, it is three decisions. As a background it is
 *   an elevated surface; as a border it is the default hairline; as text it is
 *   nearly invisible. A single find-and-replace table would flatten all three
 *   into whichever one was written first and quietly wreck the depth ladder the
 *   token layer exists to express. So the mapping is keyed on
 *   (utility-role, shade), and a shade with no entry for the role it appears in
 *   is LEFT ALONE and reported, rather than guessed at.
 *
 *   Roles, not utilities: `bg`/`from`/`to`/`via` are surfaces, `border`/`divide`
 *   /`ring`/`outline` are lines, `text`/`fill`/`stroke`/`decoration` are ink.
 *
 * Verified afterwards by `scripts/checkTokens.mjs`, which is the only reason a
 * sweep this wide is safe. Delete this file once run and committed.
 *
 * Usage: node scripts/migrateRawColors.mjs [--dry] [--report]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, extname, dirname } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src')
const DRY = process.argv.includes('--dry')
const REPORT = process.argv.includes('--report')

const SURFACE = 'surface'
const LINE = 'line'
const INK = 'ink'

const ROLE = new Map([
  ['bg', SURFACE], ['from', SURFACE], ['to', SURFACE], ['via', SURFACE],
  ['border', LINE], ['divide', LINE], ['ring', LINE], ['outline', LINE],
  ['text', INK], ['fill', INK], ['stroke', INK], ['decoration', INK],
  ['accent', INK], ['caret', INK],
])

/**
 * (role, source colour) -> token.
 *
 * The neutral ramp is where the role split earns its keep. Everything else is
 * a hue with one obvious semantic home, so those rows are role-agnostic and
 * listed once under `any`.
 */
const NEUTRALS = {
  [SURFACE]: {
    'black': 'bg-base', 'zinc-950': 'bg-base', 'neutral-950': 'bg-base',
    'zinc-900': 'surface-card', 'neutral-900': 'surface-card', 'gray-900': 'surface-card',
    'zinc-800': 'surface-elevated', 'neutral-800': 'surface-elevated', 'gray-800': 'surface-elevated',
    'zinc-700': 'surface-hover', 'neutral-700': 'surface-hover', 'gray-700': 'surface-hover',
    'zinc-600': 'surface-hover',
    'white': 'text-primary',
  },
  [LINE]: {
    'zinc-950': 'border-subtle', 'zinc-900': 'border-subtle',
    'zinc-800': 'border-subtle', 'neutral-800': 'border-subtle', 'gray-800': 'border-subtle',
    'zinc-700': 'border-strong', 'neutral-700': 'border-strong', 'gray-700': 'border-strong',
    'zinc-600': 'border-strong', 'zinc-500': 'border-strong', 'zinc-400': 'border-strong',
    'black': 'bg-base', 'white': 'text-primary',
  },
  [INK]: {
    'white': 'text-primary',
    'zinc-50': 'text-primary', 'zinc-100': 'text-primary', 'zinc-200': 'text-primary',
    'zinc-300': 'text-secondary',
    'zinc-400': 'text-secondary', 'neutral-400': 'text-secondary', 'gray-400': 'text-secondary',
    'zinc-500': 'text-tertiary', 'neutral-500': 'text-tertiary', 'gray-500': 'text-tertiary',
    'zinc-600': 'text-quiet', 'neutral-600': 'text-quiet', 'gray-600': 'text-quiet',
    'zinc-700': 'text-quiet',
    'black': 'bg-base',
  },
}

/**
 * Hues: one semantic home regardless of role. The dark 700-900 shades are
 * folded onto the same tone rather than a `-dim` companion, because in every
 * call site they appear as a tinted border or fill, and the token system
 * expresses that as an opacity modifier off the base (`border-success/30`)
 * rather than as a separate colour.
 */
const HUES = {}
for (const shade of [300, 400, 500, 600, 700, 800, 900]) {
  for (const n of ['emerald', 'green', 'teal', 'lime']) HUES[`${n}-${shade}`] = 'success'
  for (const n of ['red', 'rose', 'pink']) HUES[`${n}-${shade}`] = 'danger'
  for (const n of ['amber', 'yellow', 'orange']) HUES[`${n}-${shade}`] = 'warning'
  for (const n of ['cyan', 'sky', 'blue', 'indigo']) HUES[`${n}-${shade}`] = 'info'
  for (const n of ['purple', 'violet', 'fuchsia']) HUES[`${n}-${shade}`] = 'admin'
}

/** Bare hex, keyed the same way. These are the pre-token palette literals. */
const HEX = {
  [SURFACE]: {
    '#000': 'bg-base', '#000000': 'bg-base',
    '#05050A': 'bg-subtle',
    // Near-black gradient tints, each a bespoke warm/cool cast on the canvas.
    // The token layer has one canvas, so they collapse onto `bg-subtle`.
    '#070A05': 'bg-subtle', '#0D0A07': 'bg-subtle',
    '#0A0A0A': 'surface-card', '#08080B': 'surface-card', '#0A0A10': 'surface-card',
    '#0E0E13': 'surface-elevated', '#12121A': 'surface-elevated', '#14141B': 'surface-elevated',
    '#1A1A24': 'surface-hover', '#1F1F2E': 'surface-hover',
    '#FFF': 'text-primary', '#FFFFFF': 'text-primary',
  },
  [LINE]: {
    '#1F1F2E': 'border-subtle',
    '#2A2A3D': 'border-strong', '#2E2E42': 'border-strong', '#444': 'border-strong',
    '#000': 'bg-base', '#000000': 'bg-base',
  },
  [INK]: {
    '#FFF': 'text-primary', '#FFFFFF': 'text-primary',
    '#CCC': 'text-secondary', '#CCCCCC': 'text-secondary', '#A0A0AE': 'text-secondary',
    '#AAA': 'text-secondary',
    '#888': 'text-tertiary', '#888888': 'text-tertiary', '#6B6B7B': 'text-tertiary',
    '#666': 'text-tertiary',
    '#555': 'text-quiet', '#555555': 'text-quiet', '#4A4A58': 'text-quiet',
    '#444': 'text-quiet', '#3A3A4A': 'text-quiet', '#222': 'text-quiet',
  },
}

const HEX_HUES = {
  // A muted rose used twice in admin/page.tsx, both times to emphasise the
  // DANGEROUS misreading of a setting inside an already-amber warn note
  // ("Zero is not freeze registrations", "Deposits are not paused"). Amber
  // would have erased the emphasis against its own background; danger is what
  // the span actually means.
  '#C88': 'danger',
  '#00FFA3': 'brand', '#00CC82': 'brand-muted', '#5BFFC4': 'brand-hover',
  '#00E58F': 'success',
  '#FF3355': 'danger', '#BB2640': 'danger-dim',
  '#FFB400': 'warning', '#B27F00': 'warning-dim',
  '#22D3EE': 'info', '#0E7490': 'info-dim',
  '#A855F7': 'admin', '#6B21A8': 'admin-dim',
}

function resolve(util, value) {
  const role = ROLE.get(util)
  if (role === undefined) return null

  if (value.startsWith('#')) {
    const up = value.toUpperCase()
    return HEX_HUES[up] ?? HEX[role]?.[up] ?? null
  }
  return HUES[value] ?? NEUTRALS[role]?.[value] ?? null
}

const UTILS = [...ROLE.keys()].join('|')
const SIDES = String.raw`(?:(?:t|b|l|r|x|y|tl|tr|bl|br)-)?`

const PALETTE_RE = new RegExp(
  String.raw`\b((?:${UTILS})-${SIDES})((?:gray|zinc|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|black|white)` +
  String.raw`(?=[\s"'\`}\])!:/]|$)`,
  'g',
)
const HEX_RE = new RegExp(
  String.raw`\b((?:${UTILS})-${SIDES})\[(#[0-9A-Fa-f]{3,8})\]`,
  'g',
)

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
const skipped = new Map()

for (const file of walk(SRC)) {
  const before = readFileSync(file, 'utf8')
  let n = 0

  const rewrite = (re, capture) => (_m, prefix, value) => {
    const util = prefix.replace(/-$/, '').split('-')[0]
    const token = resolve(util, value)
    if (token === null) {
      const key = `${prefix}${capture(value)}`
      skipped.set(key, (skipped.get(key) ?? 0) + 1)
      return _m
    }
    n++
    return prefix + token
  }

  let after = before.replace(PALETTE_RE, rewrite(PALETTE_RE, v => v))
  after = after.replace(HEX_RE, rewrite(HEX_RE, v => `[${v}]`))

  if (n === 0) continue
  files++
  hits += n
  console.log(`  ${String(n).padStart(4)}  ${relative(ROOT, file).replace(/\\/g, '/')}`)
  if (!DRY) writeFileSync(file, after, 'utf8')
}

console.log(`\n[raw] ${DRY ? 'would rewrite' : 'rewrote'} ${hits} colour(s) in ${files} file(s).`)

if (skipped.size > 0) {
  console.log(`\n[raw] ${skipped.size} distinct class(es) left alone (no mapping for that role).`)
  if (REPORT) {
    for (const [cls, n] of [...skipped].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${cls}`)
    }
  } else {
    console.log('      re-run with --report to list them.')
  }
}
