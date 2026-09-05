#!/usr/bin/env node
/*
 * checkDocLineRefs.mjs
 * ────────────────────
 * The docs cite source locations as `path/to/File.sol:120-134`. Ninety of those
 * exist. They are the one kind of citation that rots without anybody touching
 * it: adding a natspec block two hundred lines above pushes every number below
 * it down, and nothing in the toolchain notices.
 *
 * When this was first run, **22 of the 23 mechanically checkable citations were
 * wrong**, and all in the same direction — cited lines far *above* the real ones,
 * the signature of numbers written against a much shorter version of the
 * contracts and never regenerated. `PRD-v5.0.md:874` claimed
 * `ToshLaunchpadHook.sol:127` for the five functions carrying `nonReentrant`;
 * they live at 1183–1421. An auditor following that lands in a comment about
 * price.
 *
 * ── What is checkable, and what is not ───────────────────────────────────────
 *
 * Whether a line number is *meaningful* is not decidable. What is decidable:
 *
 *  1. the cited file exists;
 *  2. the citation does not run past the end of it;
 *  3. **and the useful one** — when the prose on that same line names a function
 *     in backticks, and that function exists in the cited file, the cited range
 *     must overlap that function's body.
 *
 * Rule 3 is what caught all 22. It is deliberately narrow: it only fires when
 * the document itself has named something checkable, so it cannot invent a
 * complaint about a citation whose prose it does not understand. Citations with
 * no named function are counted and reported, not failed — that number is the
 * honest measure of what this guard does *not* cover.
 *
 * Companion to `checkDocSymbols.mjs`, which verifies that backticked identifiers
 * exist *somewhere*. This one verifies that the place a document points to is
 * where the thing actually is.
 *
 * Exit codes:  0 clean · 1 stale citations found · 2 could not run
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const DOCS = path.join(REPO, 'docs')

/**
 * Function name -> body span, by brace matching from the signature.
 *
 * The span starts at the `function` keyword rather than at its natspec: a
 * citation pointing at the doc comment above a function is pointing at the
 * function, and treating those as misses would make rule 3 fire on citations
 * that are perfectly serviceable. The span therefore also absorbs the natspec
 * that precedes it, back to the previous closing brace.
 */
function spans(absFile) {
  const lines = readFileSync(absFile, 'utf8').split(/\r?\n/)
  const map = new Map()

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*function\s+(\w+)\s*\(/)
    if (!m) continue

    // Walk back over the contiguous natspec / comment block above.
    let start = i
    while (start > 0 && /^\s*(\/\/|\/\*|\*|\*\/)/.test(lines[start - 1])) start--

    // Brace-match forward from the signature to find the real end.
    let depth = 0, seen = false, end = i, bodyless = false
    for (let j = i; j < lines.length; j++) {
      const code = lines[j].replace(/\/\/[^\n]*/g, '')
      for (const ch of code) {
        if (ch === '{') { depth++; seen = true }
        else if (ch === '}') depth--
      }
      if (seen && depth <= 0) { end = j; break }
      // An interface declaration ends at the semicolon with no body.
      if (!seen && /;\s*$/.test(code)) { end = j; bodyless = true; break }
      end = j
    }

    // Interface declarations are skipped entirely. They are not where anything
    // happens, and treating them as definitions made this guard reject a correct
    // citation: `PRD-v5.0.md:965` points at `addLadderToken`, and the nearest
    // name beside it was `tokenToHook` — matched against a one-line echo of that
    // getter in an interface rather than the implementation it names.
    if (bodyless) continue

    // Keep the first definition of a name; overloads would otherwise replace it.
    if (!map.has(m[1])) map.set(m[1], { start: start + 1, end: end + 1 })
  }

  return { map, lineCount: lines.length }
}

const cache = new Map()
function sourceInfo(rel) {
  if (!cache.has(rel)) {
    const abs = path.join(REPO, rel)
    cache.set(rel, existsSync(abs) ? spans(abs) : null)
  }
  return cache.get(rel)
}

const CITE = /((?:src|test|script|scripts|monitoring|soat-frontend\/src)\/[A-Za-z0-9_/.-]+\.(?:sol|ts|tsx|mjs|js)):(\d+)(?:[-–](\d+))?/g

if (!existsSync(DOCS)) {
  console.error('[doc-line-refs] CANNOT RUN — docs/ not found')
  process.exit(2)
}

const problems = []
let checked = 0
let semanticallyChecked = 0
let unverifiable = 0

/**
 * One document line. Split out from the loop so the self-test below can run the
 * real logic over a synthetic line instead of a second, weaker copy of it.
 */
function analyseLine(doc, idx, line, problems) {
  {
    const cites = [...line.matchAll(CITE)].map(m => ({
      rel: m[1],
      start: Number(m[2]),
      end: m[3] ? Number(m[3]) : Number(m[2]),
      at: m.index,
      raw: `${m[1]}:${m[2]}${m[3] ? '-' + m[3] : ''}`,
    }))
    if (!cites.length) return

    // The docs' established shorthand: after a full citation, further locations
    // in the same file are written as bare backticked numbers —
    // `src/ToshFactory.sol:37`、`657-717`、`740-766`. Those were invisible to the
    // pattern above, so a good part of the 90 citations went unchecked. Attribute
    // each to the nearest preceding full citation's file, and only accept it when
    // nothing but a separator sits between the two, so a backticked quantity
    // elsewhere in the sentence is not mistaken for a line number.
    for (const m of line.matchAll(/`(\d+)(?:[-–](\d+))?`/g)) {
      const prior = cites.filter(c => c.at < m.index).sort((a, b) => b.at - a.at)[0]
      if (!prior) continue
      const between = line.slice(line.indexOf('`', prior.at) + 1, m.index)
      if (!/^[`\s、,，和及]*$/.test(between.replace(/^[^`]*`/, ''))) continue
      cites.push({
        rel: prior.rel,
        start: Number(m[1]),
        end: m[2] ? Number(m[2]) : Number(m[1]),
        at: m.index,
        raw: `${prior.rel}:${m[1]}${m[2] ? '-' + m[2] : ''} (shorthand)`,
      })
    }
    checked += cites.length

    // ── Structural: the citation has to be a place that exists. ──────────────
    for (const c of cites) {
      const src = sourceInfo(c.rel)
      if (!src) {
        problems.push({ doc, docLine: idx + 1, cite: c.raw, why: 'cited file does not exist' })
      } else if (c.end > src.lineCount) {
        problems.push({
          doc, docLine: idx + 1, cite: c.raw,
          why: `runs past the end of the file, which has ${src.lineCount} lines`,
        })
      }
    }

    // ── Semantic: evaluated per NAME, not per citation. ───────────────────────
    //
    // Every function named anywhere on the line must be covered by at least one
    // of the line's citations, in one of the cited files that defines it.
    //
    // Two earlier rules were weaker and a mutation walked through each. Matching
    // only the name nearest a citation cut coverage from 23 checkable citations to
    // 6 of 104 — close to decorative — and four of the cases it stopped checking
    // were real defects found minutes earlier. Accepting a line as soon as *any*
    // one name was covered let a correct `createLaunch` citation mask a `deposit`
    // citation broken by hand, which is precisely the rot this exists to catch.
    //
    // Resolving a name against every cited file that defines it, rather than
    // skipping it as ambiguous, is what makes the strict rule usable: `deposit`
    // exists in both the factory and the hook, and a sentence citing both is
    // satisfied by covering either definition — but not by covering neither.
    const namesOnLine = [...new Set([...line.matchAll(/`([A-Za-z_]\w*)`/g)].map(x => x[1]))]

    for (const name of namesOnLine) {
      const owners = cites
        .map(c => c.rel)
        .filter((rel, i, a) => a.indexOf(rel) === i)
        .filter(rel => sourceInfo(rel)?.map.has(name))
      if (!owners.length) continue

      semanticallyChecked++

      const covered = owners.some(rel => {
        const fn = sourceInfo(rel).map.get(name)
        return cites.some(c => c.rel === rel && c.start <= fn.end && c.end >= fn.start)
      })

      if (!covered) {
        const truth = owners
          .map(rel => `${rel}:${sourceInfo(rel).map.get(name).start}-${sourceInfo(rel).map.get(name).end}`)
          .join(' or ')
        problems.push({
          doc, docLine: idx + 1, cite: cites.map(c => c.raw).join(', '),
          why: `names \`${name}\` but no citation covers it — it is at ${truth}`,
        })
      }
    }

    if (!namesOnLine.some(n => cites.some(c => sourceInfo(c.rel)?.map.has(n)))) {
      unverifiable += cites.length
    }
  }
}

// ── Self-test: does this checker still detect a citation it is certain about? ──
//
// Two mutations of this file survived the harness — deleting the exit code and
// skipping the semantic loop — because nothing here was checking the checker.
// That is the failure §5.14 and §5.15 of SECURITY_AUDIT.md each ran into from a
// different direction: a verification tool that cannot fail loudly is
// indistinguishable from the thing it was built to detect.
//
// So before reading a single real document, run the real logic over a line whose
// verdict is not in question. `deposit` is defined in ToshFactory.sol and line 1
// is not where it lives, so exactly one problem must come back. If none does, the
// semantic path is dead and every green result below would be meaningless.
{
  const canary = []
  analyseLine('<self-test>', 0, 'a claim about `deposit` citing `src/ToshFactory.sol:1`', canary)
  if (canary.length !== 1) {
    console.error('[doc-line-refs] CANNOT RUN — the self-test found '
      + `${canary.length} problems in a line built to contain exactly one.`)
    console.error('               The semantic check is not running. Fix this before')
    console.error('               trusting any pass from this script.')
    process.exit(2)
  }
  // The counters must not carry the fixture into the real tally.
  checked = 0
  semanticallyChecked = 0
  unverifiable = 0
}

for (const doc of readdirSync(DOCS).filter(f => f.endsWith('.md'))) {
  const lines = readFileSync(path.join(DOCS, doc), 'utf8').split(/\r?\n/)
  lines.forEach((line, idx) => analyseLine(doc, idx, line, problems))
}

if (problems.length) {
  console.error(`[doc-line-refs] ${problems.length} stale citation(s):\n`)
  for (const p of problems) {
    console.error(`  ${p.doc}:${p.docLine}  cites ${p.cite}`)
    console.error(`      ${p.why}\n`)
  }
  console.error('Fix the numbers, or cite the function by name instead — names are')
  console.error('checked by checkDocSymbols.mjs and do not rot when a file grows.')
  process.exit(1)
}

console.log(`check:doc-line-refs OK — ${checked} citations, ${semanticallyChecked} verified against the `
  + `function named beside them`)
console.log(`  ${unverifiable} name no function this guard knows, so they are counted and not checked; `
  + 'that is the gap, stated rather than hidden.')
