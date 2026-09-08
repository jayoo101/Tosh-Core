#!/usr/bin/env node
/*
 * checkTestTable.mjs
 * ──────────────────
 * SECURITY_AUDIT.md §4's per-file test table is documentation, not a control —
 * the CI floor already reads forge's "(N total tests)". That is why this table
 * was allowed to sit 28 low and never sum to its own header (§0.4, §5.10).
 *
 * A number next to a filename that a reader treats as coverage is still worth
 * being true. This derives the table from `forge test --list` and fails when
 * either the rows or the two headline figures (passing / including-skipped)
 * disagree with the suite.
 *
 * Exit codes:  0 clean · 1 table drifted · 2 could not run
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = path.resolve(import.meta.dirname, '..')
const DOC = path.join(REPO, 'docs', 'SECURITY_AUDIT.md')

const text = fs.readFileSync(DOC, 'utf8')
const section = text.split(/^## 4\. Test coverage\s*$/m)[1]
if (!section) {
  console.error('✗ SECURITY_AUDIT.md has no "## 4. Test coverage" heading.')
  process.exit(2)
}
const body = section.split(/^## /m)[0]

const headerPass = Number(body.match(/`forge test` — \*\*(\d+) passing\*\*/)?.[1])
const headerFork = Number(body.match(/A further \*\*(\d+) fork tests\*\*/)?.[1])
const headerTotal = Number(body.match(/the gate is (\d+) either way/)?.[1])

if (![headerPass, headerFork, headerTotal].every(Number.isFinite)) {
  console.error('✗ §4 header figures are unparseable (passing / fork tests / gate).')
  process.exit(2)
}

const table = new Map()
for (const line of body.split(/\r?\n/)) {
  const m = line.match(/^\|\s*`?(test\/[A-Za-z0-9_.]+\.t\.sol)`?\s*\|\s*(\d+)\s*\|/)
  if (m) table.set(m[1], Number(m[2]))
}
if (table.size === 0) {
  console.error('✗ §4 table has no parseable `test/*.t.sol` rows.')
  process.exit(2)
}

const listed = spawnSync('forge', ['test', '--list'], {
  cwd: REPO,
  encoding: 'utf8',
  timeout: 180_000,
})
if (listed.status !== 0) {
  console.error('✗ `forge test --list` failed, so the table cannot be checked.')
  console.error(listed.stderr || listed.stdout)
  process.exit(2)
}

// `forge test --list` is a tree, not `file:contract:test()`:
//
//   test/Foo.t.sol
//     FooTest
//       test_bar
//       invariant_baz
//
// Files are unindented, contracts are two spaces, cases are four. Counting
// only `test_*` would drop every `invariant_*` and under-count the one file
// this table exists to watch.
const live = new Map()
let currentFile = null
for (const line of listed.stdout.split(/\r?\n/)) {
  if (/^test\/[A-Za-z0-9_.]+\.t\.sol$/.test(line)) {
    currentFile = line
    continue
  }
  if (currentFile && /^ {4}\S/.test(line)) {
    live.set(currentFile, (live.get(currentFile) ?? 0) + 1)
  }
}

const problems = []
const tableSum = [...table.values()].reduce((a, b) => a + b, 0)
const liveSum = [...live.values()].reduce((a, b) => a + b, 0)

if (tableSum !== headerTotal) {
  problems.push(
    `§4 rows sum to ${tableSum} but the header's gate figure is ${headerTotal}.`)
}
if (headerPass + headerFork !== headerTotal) {
  problems.push(
    `§4 header arithmetic: ${headerPass} passing + ${headerFork} fork ≠ ${headerTotal} gate.`)
}

for (const [file, n] of [...table].sort()) {
  const got = live.get(file)
  if (got === undefined) {
    problems.push(`${file} is in the table (${n}) but \`forge test --list\` does not see it.`)
  } else if (got !== n) {
    problems.push(`${file}: table says ${n}, forge lists ${got}.`)
  }
}
for (const [file, n] of [...live].sort()) {
  if (!table.has(file)) {
    problems.push(`${file} has ${n} tests and no §4 row.`)
  }
}

const forkFiles = [...table.keys()].filter(f => /Fork/i.test(f))
const forkCount = forkFiles.reduce((a, f) => a + (live.get(f) ?? table.get(f)), 0)
if (forkCount !== headerFork) {
  problems.push(
    `§4 says ${headerFork} fork tests; the Fork file(s) list ${forkCount}.`)
}
if (liveSum - forkCount !== headerPass) {
  problems.push(
    `§4 says ${headerPass} passing; forge lists ${liveSum - forkCount} non-fork tests.`)
}

if (problems.length) {
  console.error('✗ SECURITY_AUDIT.md §4 disagrees with `forge test --list`:\n')
  for (const p of problems) console.error(`  · ${p}`)
  console.error(
    '\n  Recount from `forge test --list` and edit the table, not the other way'
    + '\n  round. The CI floor already tracks the total; this guard is what keeps'
    + '\n  the per-file numbers from rotting beside it.')
  process.exit(1)
}

console.log(
  `✓ §4 matches the suite: ${table.size} files, ${headerPass} passing + ${headerFork} fork = ${headerTotal}`)
