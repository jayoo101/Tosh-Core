#!/usr/bin/env node
//
// The §8 summary table of PRE_MAINNET_CHECKLIST.md, recounted from the gate
// tables it summarises.
//
// This exists because that table drifted within hours of a hand recount that
// said, in the line directly above it, "against the rows above, not against
// memory". Closing PM-D2 as not-applicable moved it out of every column the
// table had, so it stayed counted under Open and the total read thirteen when
// twelve items were open. Nothing downstream could notice: the prose beneath
// the table was correct, the row itself was correct, and only the arithmetic
// between them was wrong.
//
// A summary that is maintained by hand alongside the thing it summarises is
// only ever as accurate as someone's memory of updating both. So this derives
// one from the other and fails on disagreement.
//
// Checks:
//   1. Per-gate and total counts match the gate-table rows.
//   2. Every item that is not ✅ appears in the "Still open" section, so an
//      item cannot regress or be retired without the reader's list mentioning
//      it.
//   3. No ✅ item still has a row in "Still open".

import fs from 'node:fs'
import path from 'node:path'

const DOC = path.join('docs', 'PRE_MAINNET_CHECKLIST.md')
const SPLIT = '## 8. Current state at a glance'

const GLYPHS = { '✅': 'done', '🟡': 'partial', '❌': 'open', '⏸': 'gated', '⬜': 'na' }
const COLUMNS = ['open', 'partial', 'gated', 'na', 'done'] // §8 column order

const text = fs.readFileSync(DOC, 'utf8')
const at = text.indexOf(SPLIT)
if (at === -1) {
  console.error(`✗ ${DOC}: cannot find "${SPLIT}" — the section was renamed, and`)
  console.error('  this guard silently checks nothing once it cannot find it.')
  process.exit(1)
}

// Everything before §8 is the gate tables; §8 onwards is the summary and the
// reader-facing "Still open" list. Splitting on the heading keeps the two
// occurrences of each ID apart without relying on which came first.
const gateHalf = text.slice(0, at).split(/\r?\n/)
const summaryHalf = text.slice(at)

// ── 1. Recount the gate tables ────────────────────────────────────────────
const status = new Map()
for (const line of gateHalf) {
  const id = line.match(/^\|\s*\*\*(PM-[A-F]\d+)\*\*/)?.[1]
  if (!id || status.has(id)) continue
  const glyph = line.match(/(✅|🟡|❌|⏸|⬜)/)?.[1]
  if (!glyph) {
    console.error(`✗ ${id} has no status glyph in its gate row, so it cannot be counted.`)
    process.exit(1)
  }
  status.set(id, GLYPHS[glyph])
}

const blank = () => ({ open: 0, partial: 0, gated: 0, na: 0, done: 0 })
const counted = {}
for (const [id, s] of status) (counted[id[3]] ??= blank())[s]++

// ── 2. Read what §8 claims ────────────────────────────────────────────────
const claimed = {}
let claimedTotal = null
for (const line of summaryHalf.split(/\r?\n/)) {
  // "| A — Audit | 3 | 1 | 0 | 0 | 1 |" and the bolded Total row.
  const row = line.match(/^\|\s*(?:\*\*)?([A-F]|Total)\b[^|]*\|(.+)\|\s*$/)
  if (!row) continue
  const nums = row[2].split('|').map(c => Number(c.replace(/\*/g, '').trim()))
  if (nums.length !== COLUMNS.length || nums.some(Number.isNaN)) continue
  const tally = blank()
  COLUMNS.forEach((k, i) => { tally[k] = nums[i] })
  if (row[1] === 'Total') claimedTotal = tally
  else claimed[row[1]] = tally
}

const problems = []

if (!claimedTotal) {
  problems.push(
    'the §8 table has no parseable Total row. Either its columns changed or it '
    + `no longer has ${COLUMNS.length} numeric columns (${COLUMNS.join(', ')}).`)
}

for (const gate of Object.keys(counted).sort()) {
  const got = counted[gate]
  const want = claimed[gate]
  if (!want) {
    problems.push(`gate ${gate} has rows in the checklist but no line in the §8 table.`)
    continue
  }
  for (const k of COLUMNS) {
    if (got[k] !== want[k]) {
      problems.push(
        `gate ${gate}, column "${k}": the §8 table says ${want[k]}, the rows say ${got[k]}.`)
    }
  }
}

const total = blank()
for (const g of Object.values(counted)) for (const k of COLUMNS) total[k] += g[k]
if (claimedTotal) {
  for (const k of COLUMNS) {
    if (total[k] !== claimedTotal[k]) {
      problems.push(
        `Total, column "${k}": the §8 table says ${claimedTotal[k]}, the rows say ${total[k]}.`)
    }
  }
}

// ── 3. "Still open" must name everything that is not done ─────────────────
//
// Rows may cover several items at once — "**PM-A1, A2, A3**" is one row for
// three audit items, and the trailing entries drop the "PM-" prefix. So the ID
// cell is expanded rather than string-matched, and an item may also be
// satisfied by being named in a row's prose, which is how PM-A4 is currently
// carried ("A4's remaining two boxes wait on A1").
// Anchored to the HEADING, which is `**Still open**` alone on its own line.
//
// This used to be `indexOf('**Still open**')`, and the first occurrence in §8
// is not the heading — it is the paragraph above it explaining what the list is
// for ("...compares the status glyph in **Still open** against the gate row").
// So the searched region began several hundred words early and swallowed the
// surrounding prose, and the fallback below, which accepts an item named
// anywhere in that region, could be satisfied by a sentence that merely
// mentioned the item rather than by a row listing it. PM-F9 was added with no
// row and the guard passed, because the paragraph introducing it said "PM-F9".
//
// That is the same defect as both High findings in §5.10 of the audit dossier:
// a check that reads the right thing at the wrong scope, and therefore asserts
// something weaker than its name claims. Caught here by the mutation that
// deletes a row and expects a failure.
const heading = summaryHalf.match(/^\*\*Still open\*\*\s*$/m)
if (!heading) {
  console.error(`✗ ${DOC}: no "**Still open**" heading on a line of its own.`)
  console.error('  Without it this guard cannot tell the list from the prose')
  console.error('  about the list, and checks membership against neither.')
  process.exit(1)
}
const stillOpen = summaryHalf.slice(heading.index)

// Only the table rows, joined, so the prose fallback below searches the list
// and not the commentary around it. The blockquote notes under the table talk
// about items at length — "**PM-C2 is the one people skip**" — and against the
// whole section that sentence was enough to satisfy membership for an item
// whose row had been deleted. The fallback is meant to cover an item carried
// inside ANOTHER item's row, which is how PM-A4 rides along on PM-A1's, not an
// item merely discussed nearby.
const rowLines = []

const rowIds = new Set()
for (const line of stillOpen.split(/\r?\n/)) {
  const row = line.match(/^\|\s*\*\*([^|*]+)\*\*\s*\|\s*(✅|🟡|❌|⏸|⬜)?\s*\|/)
  if (!row) continue
  rowLines.push(line)
  let gate = null
  for (const part of row[1].split(',').map(s => s.trim())) {
    const m = part.match(/^(?:PM-)?([A-F])?(\d+)$/)
    if (!m) continue
    gate = m[1] ?? gate // "A2" after "PM-A1" inherits the A
    if (!gate) continue
    const id = `PM-${gate}${m[2]}`
    rowIds.add(id)

    // The status is written twice: once in the gate row, once here. Two
    // copies of the same fact, maintained by hand, is the drift this guard
    // exists for — so they are compared rather than trusted.
    const here = row[2] && GLYPHS[row[2]]
    if (here && status.has(id) && status.get(id) !== here) {
      problems.push(
        `${id} is "${status.get(id)}" in its gate row but "${here}" in `
        + '"Still open". The gate row is the source of truth.')
    }
  }
}

for (const [id, s] of status) {
  if (s !== 'done' && !rowIds.has(id)) {
    // Fall back to prose. Bare "A4" is accepted because that is how the
    // document writes it; scoped to this section so it cannot be satisfied by
    // an unrelated mention elsewhere in the file.
    const bare = id.slice(3)
    if (!new RegExp(`\\b(?:${id}|${bare})\\b`).test(rowLines.join('\n'))) {
      problems.push(
        `${id} is not ✅ but is absent from "Still open", which is the list a `
        + 'reader treats as the remaining work.')
    }
  }
  if (s === 'done' && rowIds.has(id)) {
    problems.push(`${id} is ✅ but still has a row in "Still open".`)
  }
}

if (problems.length) {
  console.error(`✗ ${DOC} §8 disagrees with its own rows:\n`)
  for (const p of problems) console.error(`  · ${p}`)
  console.error(
    '\n  Recount from the gate tables and edit the §8 table, not the other way'
    + '\n  round: the per-item rows are the source of truth.')
  process.exit(1)
}

const shape = COLUMNS.map(k => `${k}=${total[k]}`).join(' ')
console.log(`✓ §8 matches the rows: ${status.size} items, ${shape}`)
