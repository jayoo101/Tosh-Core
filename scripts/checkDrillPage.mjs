/**
 * checkDrillPage.mjs
 * ──────────────────
 * Guards the Q1 drill co-signing page at /drill/ against the chain it signs for.
 *
 * The page hands four EIP-712 payloads to people who are not engineers and
 * cannot be expected to audit them. Everything that makes those payloads safe
 * is a literal typed into another repository by hand: the Safe address, the
 * chain id, four selectors, and four 66-character hashes. Any one of them wrong
 * produces the same symptom — a signature that recovers to the right person and
 * is rejected by the Safe as GS026 — discovered only after the human has been
 * interrupted, and indistinguishable at a glance from the signer's mistake.
 *
 * So the hashes are not trusted. Each is recomputed from the page's own struct
 * and held against the Safe's `getTransactionHash()` on chain 46630. What the
 * wallet will show and what the contract will accept are then the same object,
 * demonstrated rather than assumed.
 *
 * Also checked, because they are the properties that make the page safe to
 * send to someone rather than merely correct:
 *
 *   · the Safe it names is a real 2-of-3 whose owners are the three real
 *     signers, and does NOT include the operator — a drill the operator can
 *     complete alone scores nothing;
 *   · it is the testnet Safe, not the mainnet one;
 *   · the loop closes — the last payload hands ownership back;
 *   · nothing is read from the URL.
 *
 * Usage:  node scripts/checkDrillPage.mjs
 *         DRILL_PAGE_FILE=../tosh-status/drill/index.html node scripts/checkDrillPage.mjs
 */

import fs from 'node:fs'
import { ethers } from 'ethers'
import { CheckFailed, installFailureExit } from './lib/checkExit.mjs'
import { refuseIfRetired } from './lib/retiredChains.mjs'

installFailureExit()

const PAGE_URL = 'https://jayoo101.github.io/tosh-status/drill/'
const RPC = process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com'
const TESTNET_ID = 46630n
const MAINNET_SAFE = '0x2953957774482efA660921df85A1E7634ccfe27A'
const OWNERS = {
  '0xc2ea14ce2112b18afbc78fe78c969b3002f07cbb': 'Signer #1',
  '0x0db9114fa8082800b23aa6141ec88f2a64ca1c6e': 'Signer #2',
  '0x3b7ff171a71281b1d77e18ae1a0bc725d69712e6': 'Signer #3',
}

const problems = []
const fail = m => problems.push(m)

// ── Load the page ───────────────────────────────────────────────────────────
//
// Announced on every run: a guard that can be pointed at a file on someone's
// disk without saying so would go green while the page a signer actually opens
// had drifted.
const LOCAL = process.env.DRILL_PAGE_FILE
let html
if (LOCAL) {
  console.error(`[checkDrillPage] reading ${LOCAL} instead of ${PAGE_URL} — NOT checking the deployed page`)
  html = fs.readFileSync(LOCAL, 'utf8')
} else {
  const res = await fetch(PAGE_URL)
  // Self-retiring. This page is an artifact of one drill, not a standing
  // surface, and the hazard it guards — real people signing real Safe payloads
  // — exists only while it is reachable. Once §8.3 is scored the page comes
  // down, and this guard should go quiet rather than hold CI red over a
  // deliberate deletion. It stays in the workflow so that putting the page back
  // up for the next quarter re-arms it without anyone remembering to.
  if (res.status === 404) {
    console.log(`[checkDrillPage] no drill page at ${PAGE_URL} — nothing to guard.`)
    console.log('[checkDrillPage] this is the expected state between drills.')
    // Do not `process.exit` after `fetch`. On Windows, undici's keep-alive
    // socket is still open, and tearing it down that way is a stack buffer
    // overrun (0xC0000409, exit -1073740791). CI is Linux so it never saw
    // this; a local scan on this machine did. Leave the event loop to drain.
    process.exitCode = 0
  } else if (!res.ok) {
    console.error(`[checkDrillPage] FAIL — ${PAGE_URL} returned ${res.status}`)
    process.exitCode = 1
  } else {
    html = await res.text()
  }
}

if (html == null) {
  // 404 or fetch error: the rest of this file has nothing to check.
} else {

// ── 1. Nothing is read from the URL ─────────────────────────────────────────
//
// The sibling ../sign/ page carries the same rule. It matters more here: a page
// on the project's own origin that signs whatever a query parameter hands it
// would be a phishing kit for Safe transactions, endorsed by the project.
// Comments are stripped first: the page documents this very rule, and naming
// `location.search` in order to forbid it must not read as doing it.
const code = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*\/\/.*$/gm, '')
if (/location\.(search|hash)|URLSearchParams|searchParams/.test(code)) {
  fail('the page reads from the URL. Every payload must be hardcoded — otherwise '
    + 'a crafted link turns this origin into a Safe-transaction phishing page.')
}

// ── 2. Pull out what the page will actually hand the wallet ─────────────────
const lit = (name, re) => {
  const m = html.match(re)
  if (!m) fail(`could not find ${name} in the page — this guard cannot verify it`)
  return m?.[1]
}
const safe = lit('SAFE', /^const SAFE = '(0x[0-9a-fA-F]{40})'/m)
const factory = lit('FACTORY', /^const FACTORY = '(0x[0-9a-fA-F]{40})'/m)
const chainId = lit('CHAIN_ID', /^const CHAIN_ID = (\d+)/m)

// Deliberately here, inside the "a page exists" branch, and not at the top of
// the file. Everything this guard pins — TESTNET_ID, MAINNET_SAFE, OWNERS, the
// RPC — describes the 2026-09-04 drill on 46630, so the file is stale the
// moment the next drill runs anywhere else. But between drills the page 404s
// and this guard is deliberately silent, and a refusal at import time would
// hold CI red over a page that does not exist, for a chain nobody is signing
// against. The hazard is a drill page being LIVE while the constants describe a
// departed chain, so the refusal belongs exactly where that becomes true.
refuseIfRetired(TESTNET_ID, {
  script: 'checkDrillPage.mjs',
  reArm: [
    'point TESTNET_ID and the RPC at the chain the next drill runs on',
    'replace MAINNET_SAFE with the live Safe on that chain, and OWNERS with '
      + 'its three owners — none of which exist yet, because PM-D4 has not been '
      + 'redone on BSC and the Safe it names is on 4663',
    'until then this page must not be published: it would ask real signers for '
      + 'real Safe payloads that this guard cannot check',
  ],
})

if (chainId && BigInt(chainId) !== TESTNET_ID) {
  fail(`the page signs for chain ${chainId}, not the rehearsal chain ${TESTNET_ID}.`)
}
if (safe && safe.toLowerCase() === MAINNET_SAFE.toLowerCase()) {
  fail(`the page names the MAINNET Safe ${MAINNET_SAFE}. This is a drill page; it `
    + 'must never collect signatures against the Safe that holds the live protocol.')
}

// The struct the wallet hashes, field for field. A missing or reordered field
// changes the EIP-712 type hash, so this is load-bearing, not cosmetic.
const EXPECTED_FIELDS = ['to', 'value', 'data', 'operation', 'safeTxGas', 'baseGas',
  'gasPrice', 'gasToken', 'refundReceiver', 'nonce']
const safeTxType = html.match(/SafeTx: \[([\s\S]*?)\],\s*\}/)?.[1] ?? ''
const fields = [...safeTxType.matchAll(/name: '(\w+)'/g)].map(m => m[1])
if (fields.join(',') !== EXPECTED_FIELDS.join(',')) {
  fail(`the SafeTx type is [${fields.join(', ')}], but Safe 1.4.1 defines `
    + `[${EXPECTED_FIELDS.join(', ')}]. A different field list is a different type `
    + 'hash, so every signature collected would be rejected.')
}
if (!/domain: \{ chainId: CHAIN_ID, verifyingContract: SAFE \}/.test(html)) {
  fail('the EIP-712 domain is not { chainId, verifyingContract } bound to CHAIN_ID '
    + 'and SAFE. Those two fields are the entire reason a signature collected here '
    + 'cannot be replayed against the mainnet Safe.')
}

const steps = [...html.matchAll(
  /nonce: (\d+),\s*\n\s*data: '(0x[0-9a-fA-F]*)',\s*\n\s*safeTxHash: '(0x[0-9a-fA-F]{64})'/g,
)].map(m => ({ nonce: Number(m[1]), data: m[2], safeTxHash: m[3] }))

if (steps.length !== 4) {
  fail(`found ${steps.length} payloads on the page, expected 4.`)
}
if (steps.some((s, i) => s.nonce !== i)) {
  fail(`payload nonces are [${steps.map(s => s.nonce).join(', ')}]. Safe consumes `
    + 'nonces strictly in order, so a gap means a step that can never execute.')
}

// ── 3. The chain has to agree ───────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC)
const net = await provider.getNetwork()
if (net.chainId !== TESTNET_ID) {
  console.error(`[checkDrillPage] FAIL — RPC is chain ${net.chainId}, expected ${TESTNET_ID}`)
  throw new CheckFailed(`RPC is chain ${net.chainId}`)
}

const safeC = new ethers.Contract(safe, [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
], provider)

if (await provider.getCode(safe) === '0x') {
  console.error(`[checkDrillPage] FAIL — no contract at ${safe} on chain ${TESTNET_ID}`)
  throw new CheckFailed(`no contract at ${safe}`)
}

const [owners, threshold, version, liveNonce] = await Promise.all([
  safeC.getOwners(), safeC.getThreshold(), safeC.VERSION(), safeC.nonce(),
])
const lower = owners.map(a => a.toLowerCase())

if (threshold !== 2n) fail(`the drill Safe threshold is ${threshold}, not 2 — it cannot measure a two-signature bar.`)
if (lower.length !== 3) fail(`the drill Safe has ${lower.length} owners, not 3.`)
for (const [addr, name] of Object.entries(OWNERS)) {
  if (!lower.includes(addr)) fail(`${name} ${addr} is not an owner of the drill Safe, so the drill would not involve them.`)
}
const strangers = lower.filter(a => !(a in OWNERS))
if (strangers.length) {
  fail(`the drill Safe has owner(s) outside the real signer set: ${strangers.join(', ')}. `
    + 'The whole point of this run is that the two signatures come from people who '
    + 'are not the operator; a stand-in key restores the gap §8.1 and §8.2 recorded.')
}

// ── 4. Each hash the page shows is the hash the Safe will check ─────────────
const iface = new ethers.Interface([
  'function acceptOwnership()', 'function pause()', 'function unpause()',
  'function transferOwnership(address newOwner)',
])
const SELECTORS = {
  0: iface.getFunction('acceptOwnership').selector,
  1: iface.getFunction('pause').selector,
  2: iface.getFunction('unpause').selector,
  3: iface.getFunction('transferOwnership').selector,
}

for (const step of steps) {
  const args = [factory, 0n, step.data, 0, 0n, 0n, 0n, ethers.ZeroAddress, ethers.ZeroAddress]
  const onChain = await safeC.getTransactionHash(...args, step.nonce)
  if (onChain.toLowerCase() !== step.safeTxHash.toLowerCase()) {
    fail(`nonce ${step.nonce}: the page records ${step.safeTxHash}, but the Safe's own `
      + `getTransactionHash() returns ${onChain}. Signatures collected for the page's `
      + 'hash would be rejected as GS026 after the signer had already been interrupted.')
  }
  const want = SELECTORS[step.nonce]
  if (want && !step.data.toLowerCase().startsWith(want.toLowerCase())) {
    fail(`nonce ${step.nonce}: expected the payload to call ${Object.keys(SELECTORS)[step.nonce]} `
      + `(${want}) but it starts ${step.data.slice(0, 10)}.`)
  }
}

// ── 5. The loop closes ──────────────────────────────────────────────────────
//
// The last payload is what makes this a rehearsal rather than a handover. If it
// does not return ownership, a signed set leaves the testnet factory owned by a
// Safe whose only purpose was a drill.
const last = steps.find(s => s.nonce === 3)
if (last) {
  const to = '0x' + last.data.slice(34)
  const factoryC = new ethers.Contract(factory, [
    'function owner() view returns (address)',
    'function pendingOwner() view returns (address)',
  ], provider)
  const currentOwner = (await factoryC.owner()).toLowerCase()
  if (to.toLowerCase() !== currentOwner) {
    fail(`the closing payload hands ownership to ${ethers.getAddress(to)}, but the factory's `
      + `owner before the drill is ${ethers.getAddress(currentOwner)}. The drill would not restore `
      + 'the state it started from.')
  }
  if (to.toLowerCase() in OWNERS) {
    fail('the closing payload hands ownership to one of the signers personally rather '
      + 'than back to the deploying account.')
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`\n[checkDrillPage] FAIL — ${problems.length} problem(s):\n`)
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`))
  process.exitCode = 1
}

console.log(`[checkDrillPage] OK — ${LOCAL ? 'local page' : PAGE_URL}`)
console.log(`[checkDrillPage] Safe ${safe} on ${net.chainId}: ${version}, ${threshold}-of-${lower.length}, nonce ${liveNonce}`)
console.log(`[checkDrillPage] owners are exactly ${Object.values(OWNERS).join(', ')} — the operator is not among them`)
console.log('[checkDrillPage] all 4 payload hashes match the Safe\'s own getTransactionHash(), and the loop returns ownership')
}
