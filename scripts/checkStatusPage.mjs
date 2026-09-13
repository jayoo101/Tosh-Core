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
 * `factoryDeployments.ts` was corrected in the playbook by hand and
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
import { installFailureExit } from './lib/checkExit.mjs'

installFailureExit()

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PAGE_URL  = 'https://jayoo101.github.io/tosh-status/'
const GUIDE_URL = 'https://github.com/jayoo101/tosh-status/blob/main/MANUAL_INTERACTION.md'
const PAUSED_SELECTOR = '0x5c975abb' // keccak("paused()")[0:4]

const drift = []
const unreachable = []

/** Which chain the deployed page currently names, and the factory it reads.
 *  Filled by check 5, consumed by check 6. */
let STATUS_PAGE_CHAIN = null
let STATUS_PAGE_FACTORY = null

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

  // ── 5. The page's four chain fields name ONE chain ────────────────────────
  //
  // The page reads paused() over `rpc` from `factory`, and sends users to
  // `explorer` under the label `name`. A half-finished cutover — new factory,
  // old RPC — produces a page that queries an address that does not exist on
  // the chain it asked, which reads as "could not reach the RPC" rather than
  // as a misconfiguration, and points users at an explorer where their money
  // is not. Unanimity is cheap to check and the disagreement is invisible.
  const active = html.match(/^const CHAIN = \{([\s\S]*?)\n\}/m)
  if (!active) {
    drift.push(
      'could not find the active `const CHAIN = { … }` block. The page still '
      + 'has to name a chain somewhere; this guard can no longer tell which.')
  } else {
    const field = k => active[1].match(new RegExp(`${k}:\\s*'([^']*)'`))?.[1] ?? ''
    const chain = { name: field('name'), rpc: field('rpc'), explorer: field('explorer') }
    // Each field votes testnet or mainnet by its own text. Testnet is
    // matched first so a string that somehow names both still votes
    // testnet — a half-finished cutover that still carries a rehearsal
    // marker is the cheaper mistake to catch.
    //
    // `robinhoodchain.blockscout.com` is special-cased because it is the
    // canonical mainnet explorer and contains neither `mainnet` nor `4663`.
    // The vanity alias `explorer.mainnet.chain.robinhood.com` would have
    // voted mainnet on the substring, and was rejected: a GET of
    // `/address/<factory>` against it returns 200 and lands on the
    // explorer's front page — the path is dropped. Address links on the
    // status page would then send users to the homepage of the right
    // chain, looking like a working explorer while showing them nothing
    // about the contract. The hostname is therefore recognised, rather
    // than the URL being swapped for the one that happens to match.
    const vote = s => (/testnet|46630/i.test(s) ? 'testnet' : /mainnet|4663\b|robinhoodchain\.blockscout\.com/.test(s) ? 'mainnet' : '?')
    const votes = Object.fromEntries(Object.entries(chain).map(([k, v]) => [k, vote(v)]))
    const distinct = [...new Set(Object.values(votes))]
    if (distinct.length !== 1 || distinct[0] === '?') {
      drift.push(
        'the page\'s chain fields do not agree on one chain: '
        + Object.entries(votes).map(([k, v]) => `${k}=${v}`).join(' ')
        + '. It reads paused() from the factory over `rpc` and sends users to '
        + '`explorer`; if those are different chains the page is confidently '
        + 'wrong rather than visibly broken.')
    }
    STATUS_PAGE_CHAIN = distinct.length === 1 ? distinct[0] : '?'
    STATUS_PAGE_FACTORY = field('factory').toLowerCase()
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

// ── 6. Once mainnet exists, the page must be pointing at it ─────────────────
//
// Inactive until PM-C1, and it turns itself on. This is the gap the 2026-09-04
// drill (§8.2) surfaced: the page hardcodes its own chain in another
// repository, and PM-C7 — "frontend pointed at the 4663 factory" — says
// nothing about it. Repoint the frontend, forget the page, and the page goes
// on reading a *testnet* contract's paused() and presenting it as production
// truth. Nothing looks wrong: the banner and the chain agree, so even the
// page's own disagreement warning stays quiet. It would be reporting the
// health of a contract nobody is using.
//
// `broadcast/<script>/4663/` is where PM-C1 records the mainnet run, so its
// appearance is exactly the moment the page becomes wrong. No new constant to
// maintain, and no way to satisfy this by editing a comment.
const MAINNET_ID = '4663'
const broadcastRoot = path.join(REPO_ROOT, 'broadcast')
const mainnetDeployed = fs.existsSync(broadcastRoot)
  && fs.readdirSync(broadcastRoot).some(script =>
    fs.existsSync(path.join(broadcastRoot, script, MAINNET_ID)))

// The factory the latest mainnet broadcast actually created, or null if the
// artefact cannot be read. `CREATE` rather than `CALL`, because the later
// entries are `setFactory` and the two `transferOwnership` calls and carry the
// same address in a field that means something else.
function deployedFactory() {
  if (!fs.existsSync(broadcastRoot)) return null
  for (const script of fs.readdirSync(broadcastRoot)) {
    const runLatest = path.join(broadcastRoot, script, MAINNET_ID, 'run-latest.json')
    if (!fs.existsSync(runLatest)) continue
    try {
      const run = JSON.parse(fs.readFileSync(runLatest, 'utf8'))
      const create = (run.transactions ?? []).find(t =>
        t.contractName === 'ToshFactory' && t.transactionType === 'CREATE')
      if (create?.contractAddress) return create.contractAddress.toLowerCase()
    } catch { /* unreadable artefact is not drift; check 6 still votes on the chain */ }
  }
  return null
}

if (mainnetDeployed && STATUS_PAGE_CHAIN && STATUS_PAGE_CHAIN !== 'mainnet') {
  drift.push(
    `broadcast/*/${MAINNET_ID}/ exists, so the mainnet factory is deployed, but `
    + `the status page still names the ${STATUS_PAGE_CHAIN} chain `
    + `(factory ${STATUS_PAGE_FACTORY}). It is reporting the paused() state of a `
    + 'contract that is not the one holding user funds, and it will look '
    + 'perfectly healthy while doing so. Swap the two CHAIN blocks in the '
    + 'status page repository — PM-C7 covers the frontend and has never '
    + 'covered this page.')
}

// ── 6b. …and at the mainnet factory that is current, not a retired one ───────
//
// Check 6 votes testnet-or-mainnet on four text fields, which is why it passed
// for four days while the page read paused() off `0xBa9d2E86…`: that address is
// a perfectly good mainnet factory, it is simply not the one holding funds any
// more. The 2026-09-12 redeploy retired it — the 8%/2% referral split is
// `immutable`, so changing it meant new bytecode — and nothing noticed until
// somebody read the page's source by hand.
//
// A redeploy is not exotic. Any immutable this platform ever wants to change
// forces one, so "which mainnet factory" needs to be checked and not just
// "which chain". The comparison costs nothing new to maintain: the page already
// hands us `STATUS_PAGE_FACTORY`, and `run-latest.json` is overwritten by the
// broadcast itself, so the expected value updates without anyone editing it.
//
// Failure here is the worst-looking kind of healthy. The page's own
// disagreement warning stays quiet, `paused()` returns a real answer from a real
// contract, and it is the answer to a question nobody asked — so pausing the
// live factory during an incident leaves this page saying `operational`.
const currentFactory = deployedFactory()
if (mainnetDeployed && STATUS_PAGE_CHAIN === 'mainnet' && currentFactory
    && STATUS_PAGE_FACTORY && STATUS_PAGE_FACTORY !== currentFactory) {
  drift.push(
    `the status page names mainnet, but reads paused() from ${STATUS_PAGE_FACTORY} `
    + `while the latest mainnet broadcast created ${currentFactory}. Both are real `
    + 'mainnet factories, so check 6 is satisfied and the page looks healthy — it '
    + 'is reporting on a contract nobody uses. Pausing the live factory during an '
    + 'incident would leave this page saying operational, which is the one thing '
    + 'it exists to prevent. Update `factory` in the status page repository\'s '
    + 'CHAIN block.')
}

// ── 7. The signing page signs the message we verify against ─────────────────
//
// PM-D4 collects a proof-of-control signature from each prospective Safe owner
// through /sign/, and `verifySignerCandidates.mjs` recovers an address from it
// using the message carried in safe-owners.json. Those two strings live in two
// different repositories, and if they ever diverge every signature fails — with
// the *misleading* diagnostic, because a signature over different bytes recovers
// a valid-looking but unrelated address. The script would then report that the
// signature recovers to some other address than the one claimed, i.e. it would
// accuse three honest signers of sending the wrong address.
//
// Compared byte for byte, with none of check 2's normalization: whitespace is
// not cosmetic here, it is part of what was hashed.
const SIGN_URL = 'https://jayoo101.github.io/tosh-status/sign/'
const OWNERS_TEMPLATE = path.join(REPO_ROOT, 'safe-owners.example.json')

try {
  const signHtml = await get(SIGN_URL)
  const onPage = signHtml.match(/^const MESSAGE = '([^']*)'/m)?.[1]

  // Resolved the same way `verifySignerCandidates.mjs` resolves it, because a
  // guard that only understands one of the two accepted shapes reports drift
  // when the template switches shape — a false alarm about a real invariant,
  // which is the kind that gets a check deleted.
  const template = JSON.parse(fs.readFileSync(OWNERS_TEMPLATE, 'utf8'))
  const candidates = new Set(
    (template.signers ?? []).map(s => s.message ?? template.message).filter(Boolean))
  if (template.message) candidates.add(template.message)
  const expected = candidates.size === 1 ? [...candidates][0] : null

  if (candidates.size > 1) {
    drift.push(
      `${path.basename(OWNERS_TEMPLATE)} carries ${candidates.size} different messages, `
      + 'so it cannot say which one the signing page should hold. The template is '
      + 'what three people are asked to sign from; it has to name one statement.')
  }

  if (!onPage) {
    drift.push(
      `${SIGN_URL} has no \`const MESSAGE = '…'\` line, so there is nothing to `
      + 'compare against safe-owners.example.json. Either the page stopped '
      + 'hardcoding the message — which would mean it takes one from the URL, '
      + 'the phishing shape its own header rules out — or it was restructured '
      + 'and this check needs rewriting rather than deleting.')
  } else if (expected && onPage !== expected) {
    drift.push(
      `the signing page and safe-owners.example.json disagree about the message.\n`
      + `      page:     ${JSON.stringify(onPage)}\n`
      + `      template: ${JSON.stringify(expected)}\n`
      + '    Signatures collected through the page would fail verification, and '
      + 'they would fail by recovering an unrelated address — so the report '
      + 'would blame the signers for sending a wrong address rather than name '
      + 'this mismatch.')
  }
} catch (err) {
  if (/HTTP 4\d\d/.test(err.message)) {
    drift.push(
      `${SIGN_URL} returns ${err.message}. PM-D4 hands that URL to prospective `
      + 'signers as the one-click way to prove control of their address; '
      + 'without it they are back to three sets of instructions.')
  } else {
    unreachable.push(`${SIGN_URL} — ${err.message}`)
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

if (drift.length) process.exitCode = 1
else if (unreachable.length) process.exitCode = 2
else {
console.log(
  '[checkStatusPage] OK — page is up, its paused copy matches Step 4 verbatim, '
  + 'it still reads paused() from the chain, and the guide §6b links resolves.')
console.log(
  `[checkStatusPage] chain: page names ${STATUS_PAGE_CHAIN}, mainnet deploy `
  + `${mainnetDeployed ? 'RECORDED' : 'not yet recorded'} — cutover check `
  + `${mainnetDeployed ? 'active' : 'inactive, will activate at PM-C1'}.`)
}
