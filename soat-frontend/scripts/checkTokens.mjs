#!/usr/bin/env node
/**
 * TOKEN GUARD
 *
 * A Tailwind class name is a string. `bg-surface-crd` (a typo) and
 * `text-tosh-fluo` (a deleted token) both compile, ship, and render as NO
 * STYLE. `tsc` cannot see it, `next build` cannot see it, and the diff looks
 * correct. That makes a design-token rename the one refactor this toolchain
 * cannot verify -- which is why the v5.0 palette migration needed this guard
 * before it needed a single call-site edit.
 *
 * WHAT THIS PROVES
 *   1. Every token-shaped utility class under `src/` resolves to a name that
 *      `globals.css` actually defines in its `@theme` block.
 *   2. How much raw colour (Tailwind palette shades, bare hex) still bypasses
 *      the token layer, per file, so the migration has a burn-down number.
 *   3. How many transitional `tosh-*` aliases remain, so the alias block in
 *      globals.css can be deleted the moment that number reaches zero.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not parse JSX or evaluate template expressions. It greps for
 *   class-shaped substrings, which catches `'border-danger'` assembled inside a
 *   ternary just as well as one written in a literal `className`.
 *
 * ON FALSE POSITIVES
 *   A guard that cries wolf gets ignored, and an ignored guard is worse than no
 *   guard because it looks like coverage. So the check is deliberately lenient
 *   in one direction: the legal-value set is the UNION of every `@theme`
 *   namespace rather than the one namespace a given utility belongs to. That
 *   lets a nonsense-but-harmless `bg-body` through in exchange for never
 *   flagging a legitimate `text-body` (a font-size token) as an undefined
 *   colour. Silent-failure detection is the goal; taxonomy is not.
 *
 * Usage:  node scripts/checkTokens.mjs [--strict]
 *   default   fail only on unresolvable tokens
 *   --strict  also fail on raw palette / hex colour (the migration end state)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative, extname, dirname } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src')
const CSS = join(SRC, 'app', 'globals.css')
const STRICT = process.argv.includes('--strict')

// ---------------------------------------------------------------------------
// 1. Parse the token vocabulary out of the @theme block.
// ---------------------------------------------------------------------------

// Comments are stripped BEFORE looking for the at-rule. This file's own header
// documents the guard and therefore contains the literal string "@theme", so a
// naive indexOf lands in prose and the brace walk then matches nothing.
const css = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const themeStart = css.indexOf('@theme')
if (themeStart === -1) {
  console.error('[tokens] no @theme block in globals.css')
  process.exit(1)
}

// Walk braces so a nested rule cannot terminate the block early.
let depth = 0
let themeEnd = -1
for (let i = css.indexOf('{', themeStart); i < css.length; i++) {
  if (css[i] === '{') depth++
  else if (css[i] === '}') {
    depth--
    if (depth === 0) { themeEnd = i; break }
  }
}
if (themeEnd === -1) {
  console.error('[tokens] unbalanced braces in the @theme block')
  process.exit(1)
}
const theme = css.slice(themeStart, themeEnd)

/** `--<ns>-<name>: ...` -> Set(name), skipping Tailwind's `--text-x--weight`. */
function collect(ns) {
  const out = new Set()
  const re = new RegExp(`^\\s*--${ns}-([a-z0-9-]+)\\s*:`, 'gmi')
  let m
  while ((m = re.exec(theme)) !== null) {
    if (!m[1].includes('--')) out.add(m[1])
  }
  return out
}

const colors  = collect('color')
const spacing = collect('spacing')
const radii   = collect('radius')
const shadows = collect('shadow')
const texts   = collect('text')

if (colors.size === 0) {
  console.error('[tokens] parsed zero colours from @theme -- the parser is wrong, not the code')
  process.exit(1)
}

/** See "ON FALSE POSITIVES" above: one union, not one namespace per utility. */
const DEFINED = new Set([
  ...colors, ...spacing, ...radii, ...shadows, ...texts,
  // Tailwind built-ins that are always legal and are not project tokens.
  'transparent', 'current', 'inherit', 'black', 'white',
])

/**
 * THE FAMILY TEST -- how this guard stays quiet.
 *
 * Enumerating everything Tailwind ships is a losing game: the first pass of
 * this script reported 127 "failures", every one of them a built-in
 * (`text-xs`, `border-b`, `rounded-full`, `bg-gradient-to-r`). A guard that
 * noisy is one nobody reads.
 *
 * So the test is inverted. Rather than asking "is this value a legal Tailwind
 * value", which is unanswerable without reimplementing Tailwind, it asks: does
 * this value's FIRST SEGMENT name one of OUR token families? If it does, the
 * author was reaching for a project token and it had better resolve. If it does
 * not, the class belongs to Tailwind and is none of our business.
 *
 *   bg-surface-crd   -> family `surface` is ours, not defined  -> FAIL (typo)
 *   text-tosh-gone   -> family `tosh` is ours, not defined     -> FAIL (deleted)
 *   text-brand       -> family `brand` is ours, defined        -> ok
 *   text-xs          -> family `xs` is not ours                -> ignored
 *   bg-gradient-to-r -> family `gradient` is not ours          -> ignored
 *
 * This is precise about the one thing that fails silently -- a dangling
 * reference into our own namespace -- and mute about everything else.
 */
const FAMILIES = new Set([...DEFINED].map(t => t.split('-')[0]))

// ---------------------------------------------------------------------------
// 2. Walk src/ and check every token-shaped class.
// ---------------------------------------------------------------------------

const FILE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css'])

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (FILE_EXT.has(extname(p))) yield p
  }
}

const UTILS = [
  'bg', 'text', 'border', 'ring', 'divide', 'outline', 'fill', 'stroke',
  'from', 'to', 'via', 'shadow', 'accent', 'caret', 'decoration', 'rounded',
]

/**
 * `<util>-<value>` with an optional `/50` opacity modifier, an optional
 * responsive/state prefix, and an optional side suffix on `border`/`rounded`
 * (`border-t-danger`, `rounded-tl-card`). Bounded by a class delimiter so a
 * hyphenated word inside prose does not match.
 */
const CLASS_RE = new RegExp(
  String.raw`(?:^|[\s"'\`{(\[:])` +
  String.raw`(?:(?:hover|focus|focus-visible|active|disabled|group-hover|peer-focus|sm|md|lg|xl|2xl|dark|first|last|odd|even)::?)*` +
  String.raw`((?:${UTILS.join('|')}))-(?:(?:t|b|l|r|x|y|s|e|tl|tr|bl|br|ss|se|es|ee)-)?` +
  String.raw`([a-z][a-z0-9-]*)(?:\/\d{1,3})?` +
  String.raw`(?=["'\`\s}\])!:]|$)`,
  'g',
)

const RAW_PALETTE = /\b(bg|text|border|ring|divide|from|to|via|outline|fill|stroke)-(gray|zinc|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g
const RAW_HEX = /\b(bg|text|border|ring|divide|from|to|via|outline|fill|stroke|shadow)-\[#[0-9A-Fa-f]{3,8}\]/g
const ALIAS = /\b(?:bg|text|border|ring|divide|from|to|via|outline|fill|stroke)-tosh-[a-z-]+\b/g

/**
 * Tailwind's stock type and radius steps, which bypass the semantic scale in
 * `@theme`.
 *
 * Reported, never fatal. The named steps carry `letter-spacing` and
 * `font-weight` alongside the size, so `text-sm` -> `text-readout` is not a
 * pure size swap — it also restyles weight and tracking, and can collide with
 * an explicit `font-black` on the same element depending on which utility the
 * generated stylesheet emits last. Each site needs a human decision, so this
 * exists to keep the remaining count visible rather than to gate the build.
 */
const RAW_SCALE =
  /\b(?:text-(?:xs|sm|base|lg|xl|[2-9]xl)|rounded-(?:sm|md|lg|xl|[23]xl|full))\b/g

const unknown = []
const rawPalette = []
const rawHex = []
let aliasCount = 0
const aliasFiles = new Map()
let rawScaleCount = 0
const rawScaleFiles = new Map()

for (const file of walk(SRC)) {
  if (file === CSS) continue // the definition file is not a call site

  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const src = readFileSync(file, 'utf8')

  for (const m of src.matchAll(CLASS_RE)) {
    const [, util, value] = m
    if (DEFINED.has(value)) continue
    if (!FAMILIES.has(value.split('-')[0])) continue  // Tailwind's, not ours
    if (/-\d{2,3}$/.test(value)) continue              // palette shade, below
    unknown.push({ rel, cls: `${util}-${value}` })
  }

  for (const m of src.matchAll(RAW_PALETTE)) rawPalette.push({ rel, cls: m[0] })
  for (const m of src.matchAll(RAW_HEX)) rawHex.push({ rel, cls: m[0] })

  const aliases = [...src.matchAll(ALIAS)]
  if (aliases.length > 0) {
    aliasCount += aliases.length
    aliasFiles.set(rel, aliases.length)
  }

  const rawScale = [...src.matchAll(RAW_SCALE)]
  if (rawScale.length > 0) {
    rawScaleCount += rawScale.length
    rawScaleFiles.set(rel, rawScale.length)
  }
}

// ---------------------------------------------------------------------------
// 3. Report.
// ---------------------------------------------------------------------------

function group(list) {
  const byFile = new Map()
  for (const { rel, cls } of list) {
    if (!byFile.has(rel)) byFile.set(rel, new Map())
    const m = byFile.get(rel)
    m.set(cls, (m.get(cls) ?? 0) + 1)
  }
  return byFile
}

let failed = false

if (unknown.length > 0) {
  failed = true
  console.error(`\n[tokens] FAIL -- ${unknown.length} class(es) reference a token globals.css does not define.`)
  console.error('         These render as NO STYLE. Nothing else in the toolchain reports them.\n')
  for (const [rel, classes] of group(unknown)) {
    console.error(`  ${rel}`)
    for (const [cls, n] of classes) console.error(`      ${cls}${n > 1 ? `  x${n}` : ''}`)
  }
}

const rawTotal = rawPalette.length + rawHex.length
if (rawTotal > 0) {
  if (STRICT) failed = true
  console.error(`\n[tokens] ${STRICT ? 'FAIL' : 'warn'} -- ${rawTotal} hardcoded colour(s) bypass the token layer ` +
                `(${rawPalette.length} palette, ${rawHex.length} hex):`)
  if (!STRICT) console.error('         Not fatal yet. Run with --strict once the migration lands.')
  for (const [rel, classes] of [...group([...rawPalette, ...rawHex])].sort(
    (a, b) => sum(b[1]) - sum(a[1]),
  )) {
    console.error(`  ${String(sum(classes)).padStart(4)}  ${rel}`)
  }
}

/**
 * Now FATAL, and the alias block's deletion is exactly why.
 *
 * The family test above derives its vocabulary from what `@theme` defines. While
 * the transitional `--color-tosh-*` block existed, `tosh` was a live family, so
 * a dangling `text-tosh-mute` failed the `unknown` check on its own. Deleting
 * that block removed `tosh` from the vocabulary — which also removed those
 * classes from the one check that was catching them, leaving this counter as the
 * only thing that still saw them. A count that nothing enforces is not a guard,
 * and the correct count is now permanently zero.
 */
if (aliasCount > 0) {
  failed = true
  console.error(`\n[tokens] FAIL -- ${aliasCount} reference(s) to the deleted \`tosh-*\` alias layer ` +
                `across ${aliasFiles.size} file(s).`)
  console.error('         globals.css no longer defines these. They render as NO STYLE.\n')
  for (const [rel, n] of [...aliasFiles].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(n).padStart(4)}  ${rel}`)
  }
}

if (rawScaleCount > 0) {
  console.error(`\n[tokens] note -- ${rawScaleCount} stock Tailwind type/radius step(s) across ` +
                `${rawScaleFiles.size} file(s) bypass the semantic scale.`)
  console.error('         Deliberately not fatal: the named steps also set weight and tracking,')
  console.error('         so each swap is a design call, not a rename. See RAW_SCALE above.\n')
  for (const [rel, n] of [...rawScaleFiles].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(n).padStart(4)}  ${rel}`)
  }
}

function sum(map) {
  let t = 0
  for (const n of map.values()) t += n
  return t
}

if (!failed) {
  console.log(
    `[tokens] OK -- ${colors.size} colours, ${radii.size} radii, ${texts.size} text steps, ` +
    `${spacing.size} spacing steps, ${shadows.size} shadows; every reference resolves.`,
  )
}

process.exit(failed ? 1 : 0)
