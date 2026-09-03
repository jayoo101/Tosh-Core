/**
 * Groups a Slither JSON report by impact, confidence and detector, so a run
 * can be compared against the triage recorded in `docs/SECURITY_AUDIT.md` §5.6
 * rather than re-read from the top.
 *
 * Reading 70 findings linearly is how a real one gets filed behind the
 * seventeenth `timestamp` note. The counts per detector are the useful shape:
 * they make a NEW finding visible as a number that moved, which is the only
 * thing worth a human's attention on a re-run.
 *
 *   slither . --filter-paths "lib/|test/|script/" --json slither.json
 *   node scripts/slitherTriage.mjs
 *
 * `--full` also prints High and Medium descriptions; the default is the
 * summary table alone.
 */

import { readFileSync } from 'node:fs'

const REPORT = process.argv.find((a) => a.endsWith('.json')) ?? 'slither.json'
const FULL = process.argv.includes('--full')

let report
try {
  report = JSON.parse(readFileSync(REPORT, 'utf8'))
} catch {
  console.error(
    `Cannot read ${REPORT}. Generate it with:\n` +
    '  slither . --filter-paths "lib/|test/|script/" --json slither.json',
  )
  process.exit(1)
}

const results = report.results?.detectors ?? []

const byKey = new Map()
for (const r of results) {
  const key = `${r.impact}\t${r.confidence}\t${r.check}`
  if (!byKey.has(key)) byKey.set(key, [])
  byKey.get(key).push(r)
}

const RANK = { High: 0, Medium: 1, Low: 2, Informational: 3, Optimization: 4 }
const sorted = [...byKey.entries()].sort((a, b) => {
  const [ia, , ca] = a[0].split('\t')
  const [ib, , cb] = b[0].split('\t')
  return (RANK[ia] ?? 9) - (RANK[ib] ?? 9) || ca.localeCompare(cb)
})

console.log(`${REPORT}: ${results.length} finding(s)\n`)
for (const [key, group] of sorted) {
  const [impact, confidence, check] = key.split('\t')
  console.log(`  [${impact}/${confidence}] ${check}  x${group.length}`)
}

if (!FULL) {
  console.log('\nRe-run with --full for High and Medium descriptions.')
  process.exit(0)
}

console.log('\n──────── High and Medium impact, in full ────────\n')
for (const [key, group] of sorted) {
  const [impact, confidence, check] = key.split('\t')
  if (impact !== 'High' && impact !== 'Medium') continue
  for (const r of group) {
    console.log(`[${impact}/${confidence}] ${check}`)
    console.log(r.description.trim())
    console.log('---')
  }
}
