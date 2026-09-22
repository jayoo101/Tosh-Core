// Does `docs/AUDIT.md` still describe the baselines it claims to describe?
//
// The two analyser gates each compare a baseline against a fresh run, so they
// catch a finding that appears or disappears. Neither of them reads this
// document, and nothing else did either — so the prose could drift from the
// baselines indefinitely without any check going red.
//
// It had. On 2026-09-22 the header claimed 74 Slither findings against a
// baseline holding 76, and 97 Aderyn findings against a baseline holding 98;
// the Aderyn section described 19 `centralization-risk` instances where the
// baseline had 21, and its own per-detector figures summed to 96 rather than
// the 97 it announced. Every number had been right when it was written. The
// gates stayed green throughout, correctly: they were never looking here.
//
// That matters more than an ordinary stale comment, because this file is
// PUBLISHED — `SiteFooter` links to it as "Security". A reader checking what
// analysis stands behind a protocol holding their quote gets this document and
// nothing else, so a count that disagrees with the artefact it summarises is
// not an internal tidiness problem.
//
//   node scripts/checkAuditDoc.mjs
//
// Exits non-zero on any disagreement. There is no `--update`: the fix is to
// read what moved and write it down, which is the whole point of the record.

import { readFileSync } from 'node:fs'

const read = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch (e) {
    console.error(`FAIL  cannot read ${p}: ${e.message}`)
    process.exit(2)
  }
}

const doc = read('docs/AUDIT.md')
const aderyn = JSON.parse(read('aderyn-baseline.json'))
const slither = JSON.parse(read('slither-baseline.json'))

const problems = []

// ── The header table ──────────────────────────────────────────────────────
//
// Shape: | Current | 76 findings, 1H/29M/27L/19I | 98 findings, 16H/82L |
const header = /\|\s*Current\s*\|\s*(\d+) findings,\s*([0-9HMLI/]+)\s*\|\s*(\d+) findings,\s*([0-9HMLI/]+)\s*\|/.exec(doc)
if (!header) {
  problems.push('the "Current" header row is missing or no longer in the expected shape')
} else {
  const [, sTotal, sBreak, aTotal, aBreak] = header

  if (Number(sTotal) !== slither.total) {
    problems.push(`header says ${sTotal} Slither findings; slither-baseline.json has ${slither.total}`)
  }
  if (Number(aTotal) !== aderyn.total) {
    problems.push(`header says ${aTotal} Aderyn findings; aderyn-baseline.json has ${aderyn.total}`)
  }

  // Impact breakdowns, written as "1H/29M/27L/19I". Compared letter by letter
  // rather than as a string, so a reordering is not reported as a drift.
  const letter = { H: 'High', M: 'Medium', L: 'Low', I: 'Informational' }
  const parse = (s) =>
    Object.fromEntries(
      [...s.matchAll(/(\d+)([HMLI])/g)].map((m) => [letter[m[2]], Number(m[1])])
    )

  for (const [name, claimed, actual] of [
    ['Slither', parse(sBreak), slither.byImpact ?? {}],
    ['Aderyn', parse(aBreak), aderyn.byImpact ?? {}],
  ]) {
    for (const impact of new Set([...Object.keys(claimed), ...Object.keys(actual)])) {
      const c = claimed[impact] ?? 0
      const a = actual[impact] ?? 0
      if (c !== a) problems.push(`header ${name} ${impact}: says ${c}, baseline has ${a}`)
    }
  }
}

// ── The Aderyn disposition record ─────────────────────────────────────────
const body = doc.slice(doc.indexOf('## Aderyn disposition record'))
if (!body) {
  problems.push('the Aderyn disposition record is missing')
} else {
  const announced = /(\d+) detectors, (\d+) instances/.exec(body)
  if (!announced) {
    problems.push('the disposition record no longer announces a detector/instance count')
  } else {
    const detectors = Object.keys(aderyn.byCheck).length
    if (Number(announced[1]) !== detectors) {
      problems.push(`record announces ${announced[1]} detectors; baseline fired ${detectors}`)
    }
    if (Number(announced[2]) !== aderyn.total) {
      problems.push(`record announces ${announced[2]} instances; baseline has ${aderyn.total}`)
    }
  }

  // Per detector. Both shapes the document uses: "**`name`** \u2014 21." for the
  // ones with their own paragraph, "**`name`** (7)" for the grouped style
  // findings. The dash is U+2014; matching a plain hyphen finds nothing.
  const claimed = new Map()
  for (const m of body.matchAll(/\*\*`([a-z0-9-]+)`\*\*\s*(?:\u2014\s*(?:was\s+)?|\()(\d+)/g)) {
    if (!claimed.has(m[1])) claimed.set(m[1], Number(m[2]))
  }

  for (const [check, count] of Object.entries(aderyn.byCheck)) {
    if (!claimed.has(check)) {
      problems.push(`${check} fires ${count} time(s) and the record never names it`)
    } else if (claimed.get(check) !== count) {
      problems.push(`${check}: record says ${claimed.get(check)}, baseline has ${count}`)
    }
  }

  // A detector the document still discusses but which no longer fires is the
  // other half of the contract, and the more misleading direction: it tells a
  // reader something was reviewed that the tool has stopped reporting. Findings
  // recorded as fixed are written "was 3" and are exempt, since describing what
  // was removed is the point of them.
  for (const [check] of claimed) {
    if (check in aderyn.byCheck) continue
    if (new RegExp(`\\*\\*\`${check}\`\\*\\*\\s*\u2014\\s*was\\s`).test(body)) continue
    problems.push(`the record discusses ${check}, which no longer appears in the baseline`)
  }
}

if (problems.length === 0) {
  console.log(
    `OK    docs/AUDIT.md matches both baselines: ` +
      `Slither ${slither.total}, Aderyn ${aderyn.total} across ` +
      `${Object.keys(aderyn.byCheck).length} detectors.`
  )
  process.exitCode = 0
} else {
  console.error('FAIL  docs/AUDIT.md disagrees with the baselines it describes:\n')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('\nThis file is linked publicly from the site footer as "Security".')
  console.error('Update the prose to match, rather than the other way round.')
  process.exitCode = 1
}
