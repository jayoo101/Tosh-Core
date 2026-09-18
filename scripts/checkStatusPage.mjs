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
 * The paused wording has to be identical in both places, and used to say so in
 * prose to whoever edited either one. Prose does not hold, and this file has now
 * been on both sides of that lesson: the incident document holding the canonical
 * wording was deleted on 2026-09-13 and check 2 silently degraded to "the page
 * has a paused block", which nothing could fail. The wording is pinned in this
 * file now.
 * The same class of drift already happened once inside this repository, where
 * `docs/` claimed 25 alerts against a config holding 24 for as long as nobody
 * counted, and once across documents, where a dead path to
 * `factoryDeployments.ts` was corrected in the playbook by hand and
 * left live in the user-facing guide for months.
 *
 * Four things are checked:
 *   1. The page is reachable at all. It is a production dependency of the P0
 *      playbook, and "it was up when I last looked by hand" is not a property.
 *   2. Its `paused` copy is word-for-word `EXPECTED_PAUSED_COPY` below. A
 *      responder and a user read the page under time pressure; wording nobody
 *      approved is not detectable by looking at it.
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

/** The approved paused announcement, pinned here so a change to it has to be a
 *  deliberate edit to this file rather than a quiet edit to the page.
 *
 *  This used to be compared against Step 4 of an incident-response document.
 *  That document was removed from the repo on 2026-09-13, and the comparison
 *  went with it: the check kept extracting the page's copy and then only
 *  asserted it was non-empty, while the success line still announced that it
 *  "matches Step 4 verbatim". Any page with a parseable `paused:` block passed.
 *  That is the same presence-without-use failure the chain-read check below
 *  describes in its own comment, arrived at by deletion instead of by design.
 *
 *  Pinning the text here rather than re-deriving it from the page is the whole
 *  point — a guard that reads its expectation from the thing it is guarding
 *  cannot fail. Three claims matter and are why this is worth pinning at all:
 *  that deposits remain refundable, that a security report is being
 *  investigated, and the 30-minute update commitment. */
const EXPECTED_PAUSED_COPY = 'Tosh Protocol is currently paused while we investigate a security '
  + 'report. Existing deposits remain refundable. We will update this page '
  + 'within 30 minutes.'

/** Chains this protocol has left. Named explicitly so that anything still
 *  pointing at one produces the reason rather than a shrug — `?` on its own
 *  reads as "unparseable", which is the wrong thing to go fix.
 *
 *  Module scope because checks 5 and 7 both need it, and they need the SAME
 *  list. Check 5 asks whether the status page names a departed chain; check 7
 *  asks whether the message three people are asked to sign does. A copy that
 *  drifted would leave one of those two blind, and the blind one would be
 *  green. */
const DEPARTED = /robinhood|blockscout|\b4663\b|\b46630\b/i

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

// ── 2. The paused copy matches the approved announcement word for word ──────
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
  } else if (pageCopy !== normalize(EXPECTED_PAUSED_COPY)) {
    drift.push(
      'the paused announcement on the page is not the approved wording.\n'
      + `      page:     ${pageCopy}\n`
      + `      expected: ${normalize(EXPECTED_PAUSED_COPY)}\n`
      + '      If the page is right, update EXPECTED_PAUSED_COPY in this guard in '
      + 'the same commit. If the guard is right, the page is telling users '
      + 'something nobody approved during an incident.')
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
    // Hostnames are recognised as well as chain numbers, because the
    // canonical endpoints name neither: `bscscan.com` and
    // `bsc-dataseed1.bnbchain.org` contain no `56`, and the testnet
    // dataseed says `prebsc` rather than `97`. Matching on bare `56`
    // alone would also be reckless — it is two digits that turn up inside
    // addresses and hostnames for reasons that have nothing to do with
    // the chain — hence the word boundaries.
    //
    // Testnet markers are still checked first, so `testnet.bscscan.com`
    // votes testnet despite also matching the mainnet host pattern.
    //
    // ⚠ THE WORDS `mainnet` AND `testnet` ARE NOT ENOUGH ON THEIR OWN, and the
    //   version of this that only looked for them was not wrong until the chain
    //   changed under it. "Robinhood mainnet — 4663" contains `mainnet`, so it
    //   voted mainnet; so would "Base mainnet", or any other. The vote was
    //   answering "is this a production page" when check 6 needs it to answer
    //   "is this OUR production page". Every field has to carry a BSC marker.
    const bscTestnet = /prebsc|testnet\.bscscan|\bbsc[\s-]*testnet\b|\b97\b/i
    const bscMainnet = /bscscan\.com|bsc-dataseed|\bbnb smart chain\b|\bbsc mainnet\b|\b56\b/i

    const stranded = Object.entries(chain).filter(([, v]) => v && DEPARTED.test(v))
    if (stranded.length) {
      drift.push(
        'the page still names a chain this protocol has left: '
        + stranded.map(([k, v]) => `${k}=${v}`).join(' ')
        + '. Those fields describe Robinhood Chain; settlement moved to BNB Smart '
        + 'Chain. Users following the incident playbook to this page are being '
        + 'shown the health of contracts nobody is using, over an RPC for a chain '
        + 'nobody is trading on. Edit the CHAIN block in jayoo101/tosh-status.')
    }

    const vote = s => (bscTestnet.test(s) ? 'testnet' : bscMainnet.test(s) ? 'mainnet' : '?')
    const votes = Object.fromEntries(Object.entries(chain).map(([k, v]) => [k, vote(v)]))
    const distinct = [...new Set(Object.values(votes))]
    if (!stranded.length && (distinct.length !== 1 || distinct[0] === '?')) {
      drift.push(
        'the page\'s chain fields do not agree on one BSC chain: '
        + Object.entries(votes).map(([k, v]) => `${k}=${v}`).join(' ')
        + '. It reads paused() from the factory over `rpc` and sends users to '
        + '`explorer`; if those are different chains the page is confidently '
        + 'wrong rather than visibly broken. A `?` means the field carries no '
        + 'BSC marker at all.')
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
// `broadcast/<script>/56/` is where PM-C1 records the mainnet run, so its
// appearance is exactly the moment the page becomes wrong. No new constant to
// maintain, and no way to satisfy this by editing a comment.
//
// ⚠ THIS SAID 4663, and `broadcast/DeployMainnet.s.sol/4663/` is on disk, so the
//   check was armed and comparing the page against a deployment on a chain the
//   protocol no longer uses. The page passed it — by still naming that chain.
//   Retargeting to 56 disarms it until the BSC deploy, which is correct: there is
//   no mainnet to be pointed at yet.
//
//   That does not make the page right. It is live at the URL the incident
//   playbook sends users to, and it still declares `Robinhood mainnet — 4663`
//   with an RPC, a Blockscout explorer and a factory address on that chain. This
//   guard cannot fix it: the page is in `jayoo101/tosh-status` by design, so
//   that a status page and the thing whose status it reports do not share a
//   deploy pipeline. It has to be edited there, and nothing here will go red
//   about it until chain 56 is deployed.
const MAINNET_ID = '56'
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
//
// ⚠ AGREEMENT WAS THE ONLY THING THIS CHECKED, AND AGREEMENT IS NOT ENOUGH.
//
//   For the whole Infinity port both copies read "…(2-of-3, Robinhood Chain
//   4663). Collected 2026-09-04." — and this check was green throughout,
//   correctly, because they agreed. Two identical copies of a statement about
//   a chain the protocol has left is exactly the state a consistency check
//   cannot see, and the consequence is not cosmetic: anyone signing that text
//   today is accepting a 2-of-3 role on a chain that no longer settles
//   anything. Their signature would still prove control of the key, which is
//   the half that makes this quiet — `verifySignerCandidates.mjs` would report
//   all three as verified and leave the reader believing PM-D4 was done.
//
//   So 7b asks what the message SAYS, not just whether two places say it
//   alike. It shares check 5's `DEPARTED` list rather than carrying its own,
//   because a second copy of that list would go stale in one place and be
//   green in the other.
//
//   7c covers the same failure one level up. `safe-owners.json` — the
//   collected file, gitignored because it names people — carries the message
//   inside each signer block, so it does NOT follow an edit to the template.
//   Fixing the text in the template and on the page therefore makes 7a and 7b
//   pass while three real signatures sit in the tree covering the OLD
//   statement, and nothing compared those two until now. That check only fires
//   for an operator; CI cannot see the file and reports it as not-evaluated
//   rather than as a pass.
const SIGN_URL = 'https://jayoo101.github.io/tosh-status/sign/'
const OWNERS_TEMPLATE = path.join(REPO_ROOT, 'safe-owners.example.json')
const OWNERS_COLLECTED = path.join(REPO_ROOT, 'safe-owners.json')

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
  }

  // ── 7b. The message must not name a chain the protocol has left ───────────
  //
  // Checked on the template rather than the page, and on the page only when
  // they already agree, so that a divergence reports as 7a once instead of as
  // two findings with one cause.
  const stated = expected ?? onPage
  if (stated && DEPARTED.test(stated)) {
    drift.push(
      'the Safe signing message names a chain this protocol has left:\n'
      + `      ${JSON.stringify(stated)}\n`
      + '    Settlement moved to BNB Smart Chain, so this text asks three people '
      + 'to accept a 2-of-3 role over a chain that settles nothing. Agreement '
      + 'between the page and the template does NOT catch this — both said it, '
      + 'identically, for the whole port, and 7a was green the entire time. Fix '
      + 'the string in safe-owners.example.json AND in `const MESSAGE` in '
      + 'jayoo101/tosh-status/sign/index.html on the same day, because 7a fails '
      + 'the moment only one of them moves. Re-date it while you are there: the '
      + 'date is what stops a signature collected for one round being replayed '
      + 'into another.')
  }

  // ── 7c. Signatures already collected must cover the message now in force ──
  if (fs.existsSync(OWNERS_COLLECTED) && expected) {
    try {
      const got = JSON.parse(fs.readFileSync(OWNERS_COLLECTED, 'utf8'))
      const signed = new Set(
        (got.signers ?? []).map(s => s.message ?? got.message).filter(Boolean))
      const stale = [...signed].filter(m => m !== expected)
      if (stale.length) {
        drift.push(
          `safe-owners.json holds ${(got.signers ?? []).length} signature(s) over a `
          + 'message that is no longer the one in force.\n'
          + `      signed:      ${JSON.stringify(stale[0])}\n`
          + `      now in force: ${JSON.stringify(expected)}\n`
          + '    Those signatures are not worthless and should not be deleted — an '
          + 'EIP-191 signature proves control of the key whatever the text said, and '
          + 'that half still holds. What they no longer record is CONSENT to the role '
          + 'as currently stated, which is the half PM-D4 exists to collect. '
          + '`verifySignerCandidates.mjs` reads the message out of this same file, so '
          + 'it will keep reporting all of them as verified: it is answering "did '
          + 'these people sign this text", and the question here is "is this the text '
          + 'we are asking them to sign". Re-collect before creating the Safe.')
      }
    } catch (err) {
      drift.push(
        `safe-owners.json exists but could not be read as JSON (${err.message}). `
        + 'It is the input to all three PM-D4 scripts, so a malformed copy stops '
        + 'the Safe being created rather than creating a wrong one — but it is '
        + 'reported here because the failure would otherwise surface halfway '
        + 'through createOwnerSafe.mjs.')
    }
  }

  // `onPage &&` matters: this used to be the `else` arm of the block above, and
  // splitting 7b/7c between them would otherwise make a page with no MESSAGE
  // line report twice — once for being absent, once for "disagreeing" with the
  // template it could not be compared to.
  if (onPage && expected && onPage !== expected) {
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
  '[checkStatusPage] OK — page is up, its paused copy matches the approved '
  + 'wording verbatim, it still reads paused() from the chain, and the guide '
  + '§6b links resolves.')
console.log(
  `[checkStatusPage] chain: page names ${STATUS_PAGE_CHAIN}, mainnet deploy `
  + `${mainnetDeployed ? 'RECORDED' : 'not yet recorded'} — cutover check `
  + `${mainnetDeployed ? 'active' : 'inactive, will activate at PM-C1'}.`)
}
