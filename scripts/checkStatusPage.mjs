#!/usr/bin/env node
/*
 * checkStatusPage.mjs
 * ───────────────────
 * Guards the public status page against the playbook that sends people to it.
 *
 * The page lives in another repository (`jayoo101/tosh-status`) on purpose —
 * a status page sharing a deploy pipeline with the application is useless in
 * the §0 P0 case that names a malicious frontend bundle. That separation buys
 * availability and costs coupling: nothing in this repository can see the page
 * change, and nothing over there can see this playbook change.
 *
 * Both halves of Step 4 assert that the paused wording is identical in the two
 * places, and say so in prose to whoever edits either one. Prose does not hold.
 * The same class of drift already happened once inside this repository, where
 * `docs/` claimed 25 alerts against a config holding 24 for as long as nobody
 * counted, and once across documents, where a dead path to
 * `factoryDeployments.ts` was corrected in INCIDENT_RESPONSE.md by hand and
 * left live in the user-facing guide for months.
 *
 * Four things are checked:
 *   1. The page is reachable at all. It is a production dependency of the P0
 *      playbook, and "it was up when I last looked by hand" is not a property.
 *   2. Its `paused` copy is word-for-word the blockquote in Step 4. A
 *      responder reads both under time pressure; if they disagree, the one
 *      that is wrong is unknowable at exactly the wrong moment.
 *   3. The manual-interaction guide the page links still resolves. §6b hands
 *      that URL to users mid-outage, and it returned 404 to them for as long
 *      as the guide sat in this private repository.
 *   4. The page still reads `paused()` off the chain. Delete that and the page
 *      degrades from "cannot be wrong about the one fact that matters" to "is
 *      as current as whoever last remembered it", silently and while still
 *      looking fine.
 *
 * Usage:  node scripts/checkStatusPage.mjs
 * Exits 1 on drift, 2 when the network prevented an answer — the two are
 * different findings and are deliberately not collapsed into one code.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLAYBOOK  = path.join(REPO_ROOT, 'docs', 'INCIDENT_RESPONSE.md')

const PAGE_URL  = 'https://jayoo101.github.io/tosh-status/'
const GUIDE_URL = 'https://github.com/jayoo101/tosh-status/blob/main/MANUAL_INTERACTION.md'
const PAUSED_SELECTOR = '0x5c975abb' // keccak("paused()")[0:4]

const drift = []
const unreachable = []

/** Collapse the wording differences that carry no meaning — line wrapping in
 *  markdown, string-concatenation breaks in JS — so the comparison is about
 *  the sentence and not about where each file happened to wrap it. */
const normalize = s => s.replace(/\s+/g, ' ').trim()

/** Retries transient failures, but not 4xx.
 *
 *  The distinction is the point. A blip between CI and GitHub Pages should not
 *  redden a pull request that has nothing to do with either, but a 404 is not
 *  a blip — it means the page or the guide moved, went private, or was
 *  deleted, and retrying a 404 three times only delays the finding. */
async function get(url, attempts = 3) {
  let last
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (res.status >= 400 && res.status < 500) throw new Error(`HTTP ${res.status}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    } catch (err) {
      last = err
      if (/HTTP 4\d\d/.test(err.message)) throw err
      if (i < attempts) await new Promise(r => setTimeout(r, i * 1500))
    }
  }
  throw last
}

// ── 1. The page is reachable ────────────────────────────────────────────────
//
// STATUS_PAGE_FILE checks a local copy instead of the deployed one, which is
// how you verify a rewording before pushing it and how this guard's own
// failure paths get exercised. It is announced on every run, because a guard
// that can be pointed away from production without saying so is worse than no
// guard: it would go green against a file on someone's disk while the page a
// responder actually opens had drifted.
const LOCAL = process.env.STATUS_PAGE_FILE

let html = null
if (LOCAL) {
  console.error(`[checkStatusPage] reading ${LOCAL} instead of ${PAGE_URL} `
    + '— local override, NOT a check of the deployed page')
  html = fs.readFileSync(LOCAL, 'utf8')
} else {
  try {
    html = await get(PAGE_URL)
  } catch (err) {
    unreachable.push(`${PAGE_URL} — ${err.message}`)
  }
}

// ── 2. The paused copy matches Step 4 word for word ─────────────────────────
if (html) {
  // The page holds it as a concatenation:
  //     paused: 'first part '
  //           + 'second part.',
  // so take everything up to the next key and glue the quoted runs together.
  const block = html.match(/paused:\s*([\s\S]*?),\s*\n\s*resolved:/)
  const pageCopy = block
    ? normalize([...block[1].matchAll(/'([^']*)'/g)].map(m => m[1]).join(''))
    : null

  if (!pageCopy) {
    drift.push(
      'could not find the `paused` copy in the page source. Either the COPY '
      + 'table was restructured or the page is no longer the file this guard '
      + 'was written against — check it by hand before trusting either.')
  }

  const doc = fs.readFileSync(PLAYBOOK, 'utf8')
  // The blockquote under Step 4's status-page item, which is the wording the
  // commander is told to post.
  const quoted = doc.match(/Public status page[\s\S]*?\n((?:\s*>\s*"?[^\n]*\n)+)/)
  const docCopy = quoted
    ? normalize(quoted[1].replace(/^\s*>\s?/gm, '').replace(/"/g, ''))
    : null

  if (!docCopy) {
    drift.push(
      'could not find the paused blockquote under Step 4 in '
      + 'docs/INCIDENT_RESPONSE.md. If that wording moved, this guard stopped '
      + 'guarding it.')
  }

  if (pageCopy && docCopy && pageCopy !== docCopy) {
    drift.push(
      'the paused wording differs between the page and Step 4.\n'
      + `      page:     ${pageCopy}\n`
      + `      playbook: ${docCopy}\n`
      + '      Both files tell their editor to change the other in the same '
      + 'sitting. One of them did not.')
  }

  // ── 4. The page still reads the chain ─────────────────────────────────────
  //
  // Deliberately matched in the `data:` position of the eth_call rather than
  // anywhere in the file. An earlier version of this check asked only whether
  // the page *contained* the selector, and a mutation that repointed the call
  // at 0xdeadbeef sailed through it — the selector was still sitting in the
  // comment one line above, which is presence without use. A guard that a
  // comment can satisfy is checking the documentation, not the behaviour.
  if (!new RegExp(`data:\\s*'${PAUSED_SELECTOR}'`).test(html)) {
    drift.push(
      `the page does not call eth_call with ${PAUSED_SELECTOR}, so it is not `
      + 'reading paused() off the chain. Its strongest property was that the '
      + 'fact that matters cannot go stale; without this it is only as fresh '
      + 'as the last human edit, and it will not look any different.')
  }

  if (!html.includes('MANUAL_INTERACTION.md')) {
    drift.push(
      'the page no longer links MANUAL_INTERACTION.md, which §6b instructs it '
      + 'to offer users during a frontend outage.')
  }
}

// ── 3. The guide §6b hands to users still resolves ──────────────────────────
try {
  await get(GUIDE_URL)
} catch (err) {
  // A 404 here is drift, not a network problem: it means the guide moved or
  // went private again, which is the exact regression that made §6b
  // unexecutable in the first place.
  if (/HTTP 4\d\d/.test(err.message)) {
    drift.push(
      `${GUIDE_URL} returns ${err.message}. §6b tells the status page to hand `
      + 'that URL to users during an outage; unreachable, they are left with '
      + 'an explorer and nothing telling them what to send it.')
  } else {
    unreachable.push(`${GUIDE_URL} — ${err.message}`)
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
if (drift.length) {
  console.error('[checkStatusPage] DRIFT')
  for (const d of drift) console.error('  · ' + d)
}
if (unreachable.length) {
  console.error('[checkStatusPage] could not reach:')
  for (const u of unreachable) console.error('  · ' + u)
  console.error('  This is not a pass. It means the check did not run.')
}

if (drift.length) process.exit(1)
if (unreachable.length) process.exit(2)

console.log(
  '[checkStatusPage] OK — page is up, its paused copy matches Step 4 verbatim, '
  + 'it still reads paused() from the chain, and the guide §6b links resolves.')
