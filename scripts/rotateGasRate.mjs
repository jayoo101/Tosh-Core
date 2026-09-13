/*
 * rotateGasRate.mjs — turn the PoG exchange-rate dial when the owner is a Safe.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS RATHER THAN A BUTTON
 *
 * `POST /api/admin/config` authorises a rotation by asking whether a signature
 * authorises `ToshFactory.owner()`. That owner is a 2-of-3 Gnosis Safe, and the
 * admin console cannot produce such a signature — not because the console is
 * wrong, but because `soat-frontend/src/app/providers.tsx` registers `injected()`
 * and nothing else. Every wallet reachable from the browser is therefore an
 * extension EOA, and an extension EOA is not the owner. The panel says so and
 * points here; see `ExchangeRatePanel`.
 *
 * A Safe signs a message off chain by having its owners sign the EIP-712
 * `SafeMessage` wrapper, concatenated in ascending owner-address order. That is
 * the same mechanism `drillQ1.mjs` exercised for `SafeTx`, and the `normalize`
 * and `pack` helpers below are the same ones, for the same reasons — a `v` of
 * 0/1 is read by `checkSignatures` as a contract-signature marker rather than a
 * recovery id, and a mis-ordered concatenation fails as a bare GS02x.
 *
 * WHAT MAKES THIS SAFE TO PUT IN FRONT OF THREE PEOPLE
 *
 * Two cross-checks, both free and both before anybody is interrupted:
 *
 *   • `request` computes the hash to be signed locally AND asks the Safe for its
 *     own answer via `getMessageHash`, and refuses to continue if they differ.
 *     A hash that ethers computes correctly and the contract disagrees with is
 *     invisible until the signatures are already collected and rejected.
 *
 *   • `verify` packs the collected signatures and static-calls the Safe's own
 *     `isValidSignature`. That is the exact question the server will ask over
 *     RPC, so a pass here means `submit` cannot 403 for signature reasons. It
 *     costs no gas and changes nothing.
 *
 * The signers spend nothing and risk nothing: an EIP-712 signature is off chain
 * and free, and this one is bound to the Safe's own address and chainId, to a
 * single rate, and to a nonce the server will refuse to see twice.
 *
 * Usage:
 *   node scripts/rotateGasRate.mjs request --rate 0.12 [--ttl 21600]
 *   node scripts/rotateGasRate.mjs verify  [scripts/.rate-signatures.json]
 *   node scripts/rotateGasRate.mjs submit
 *
 * Configuration, by env var or flag:
 *   ROTATE_RPC_URL   --rpc      an RPC for the chain the factory is on
 *   ROTATE_FACTORY   --factory  the ToshFactory address
 *   ROTATE_API_URL   --api      base URL of the deployed frontend
 */

import { ethers } from 'ethers'
import fs from 'node:fs'
import path from 'node:path'
import { CheckFailed, installFailureExit } from './lib/checkExit.mjs'

installFailureExit()

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const REQUEST_FILE = 'scripts/.rate-request.json'
const SIGNATURES_FILE = 'scripts/.rate-signatures.json'

/** ERC-1271's answer for the bytes32 overload. Anything else is a refusal. */
const EIP1271_MAGIC = '0x1626ba7e'

/**
 * Report a finding, then stop.
 *
 * `CheckFailed` is documented in `lib/checkExit.mjs` as a finding that has
 * ALREADY been reported — the handler deliberately prints nothing for it, so
 * that a script which has laid out its diagnosis does not then dump a stack on
 * top of it. Throwing one with the diagnosis as its message and nothing else
 * therefore exits with the right code and says nothing at all, which is how the
 * first version of this file behaved.
 */
function fail(message) {
  console.log(`\nFAIL  ${message}`)
  throw new CheckFailed(message)
}

const FACTORY_ABI = ['function owner() view returns (address)']

/* `getMessageHash` and `isValidSignature` live on the CompatibilityFallbackHandler
 * and are reached through the Safe's fallback, so they are called on the Safe's
 * own address. */
const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function getMessageHash(bytes message) view returns (bytes32)',
  'function isValidSignature(bytes32 dataHash, bytes signature) view returns (bytes4)',
]

// ─── Argument and environment plumbing ───────────────────────────────────────

const argv = process.argv.slice(2)
const cmd = argv[0]

function flag(name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

function required(flagName, ...envNames) {
  const fromFlag = flag(flagName)
  if (fromFlag) return fromFlag
  for (const name of envNames) if (process.env[name]) return process.env[name]
  fail(`missing ${flagName}: pass --${flagName} or set ${envNames.join(' / ')}`)
}

function rpcUrl() {
  return required('rpc', 'ROTATE_RPC_URL', 'NEXT_PUBLIC_RPC_URL', 'ROBINHOOD_RPC')
}

function factoryAddress() {
  return ethers.getAddress(
    required('factory', 'ROTATE_FACTORY', 'NEXT_PUBLIC_FACTORY_ADDRESS'),
  )
}

function apiUrl() {
  return required('api', 'ROTATE_API_URL', 'ADMIN_API_URL').replace(/\/+$/, '')
}

// ─── The canonical message, read from the one place that defines it ──────────

/**
 * Parse `ADMIN_CONFIG_MESSAGE_TEMPLATE` out of the TypeScript module.
 *
 * A fourth hand copy of this template is exactly the failure that module was
 * created to end — the format already existed in three places, each with a
 * comment claiming it was kept in sync by hand, and nothing comparing them. A
 * mismatch here would produce signatures the server rejects as unauthorised,
 * sending an operator to inspect the Safe while the fault is a space.
 *
 * Parsing source is not elegant. It is, however, checkable: if the module is
 * reformatted past what this reads, the script fails loudly and immediately
 * rather than signing the wrong bytes. Same tactic as `checkBlockscoutKey.mjs`
 * reading `gasHistory.ts`.
 */
function canonicalTemplate() {
  const file = path.join(REPO_ROOT, 'soat-frontend/src/lib/adminConfigMessage.ts')
  if (!fs.existsSync(file)) {
    fail(`cannot find the canonical message module at ${file}`)
  }
  const src = fs.readFileSync(file, 'utf8')
  const assignment = src.match(
    /ADMIN_CONFIG_MESSAGE_TEMPLATE\s*=\s*([\s\S]*?)(?:\n\n|\nexport|\n\/\*\*)/,
  )
  if (!assignment) {
    fail(
      'could not find ADMIN_CONFIG_MESSAGE_TEMPLATE in adminConfigMessage.ts — ' +
      'if it was renamed or reformatted, update this parser rather than ' +
      'reimplementing the template here',
    )
  }
  const parts = [...assignment[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1])
  if (parts.length === 0) fail('template literal parse produced nothing')
  const template = parts.join('').replace(/\\n/g, '\n')
  for (const token of ['{rate}', '{nonce}', '{expiresAt}']) {
    if (!template.includes(token)) {
      fail(`parsed template is missing ${token}: ${JSON.stringify(template)}`)
    }
  }
  return template
}

function buildMessage(rate, nonce, expiresAt) {
  return canonicalTemplate()
    .replace('{rate}', String(rate))
    .replace('{nonce}', String(nonce))
    .replace('{expiresAt}', String(expiresAt))
}

// ─── Safe message hashing ────────────────────────────────────────────────────

/**
 * The EIP-712 `SafeMessage` the owners sign.
 *
 * The inner value is `abi.encode(bytes32)` of the EIP-191 hash of our text, not
 * the text itself. That indirection is not ours: the fallback handler's
 * `isValidSignature(bytes32 _dataHash, ...)` wraps `abi.encode(_dataHash)`, and
 * `_dataHash` is what viem's `verifyMessage` passes — the EIP-191 hash. Getting
 * this wrong produces a well-formed signature over the wrong thing, which is why
 * `request` checks it against the contract instead of trusting this comment.
 */
function safeMessageTypedData(safeAddr, chainId, text) {
  const inner = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32'],
    [ethers.hashMessage(text)],
  )
  return {
    domain: { chainId: Number(chainId), verifyingContract: safeAddr },
    types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
    message: { message: inner },
    inner,
  }
}

/** Bring v into the 27/28 range Safe expects for an ECDSA signature. */
function normalize(sigHex) {
  const s = String(sigHex).trim()
  // Plain `Error`, not `CheckFailed`: every call site is inside a `catch` that
  // prints the message against the offending entry and carries on to the next
  // one. A finding here is about one signature, not about the run.
  if (!/^0x[0-9a-fA-F]{130}$/.test(s)) throw new Error(`not a 65-byte signature: ${s.slice(0, 20)}…`)
  let v = parseInt(s.slice(130), 16)
  if (v === 0 || v === 1) v += 27
  if (v !== 27 && v !== 28) throw new Error(`unexpected v=${v}`)
  return s.slice(0, 130) + v.toString(16).padStart(2, '0')
}

/** Safe wants signatures concatenated in ascending owner-address order. */
function pack(list) {
  return '0x' + [...list]
    .sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
    .map(s => s.signature.slice(2))
    .join('')
}

function readJson(file) {
  if (!fs.existsSync(file)) fail(`${file} not found`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * Resolve the Safe to sign for, normally by asking the factory who owns it.
 *
 * `--safe` overrides that read. It is not a convenience: it makes the hash
 * derivation below checkable against a Safe that does not own the factory yet,
 * which is the one moment an operator can afford to discover that this script's
 * idea of a `SafeMessage` disagrees with the deployed fallback handler. Without
 * it, the first test of that derivation is also the first time three people are
 * waiting on it.
 */
async function connect() {
  const provider = new ethers.JsonRpcProvider(rpcUrl())
  const net = await provider.getNetwork()

  const override = flag('safe')
  if (override) {
    const safeAddr = ethers.getAddress(override)
    if ((await provider.getCode(safeAddr)) === '0x') {
      fail(`--safe ${safeAddr} has no code on chain ${net.chainId}`)
    }
    return {
      provider, chainId: net.chainId, owner: safeAddr,
      safe: new ethers.Contract(safeAddr, SAFE_ABI, provider),
    }
  }

  const factory = new ethers.Contract(factoryAddress(), FACTORY_ABI, provider)
  const owner = ethers.getAddress(await factory.owner())
  if ((await provider.getCode(owner)) === '0x') {
    fail(
      `owner ${owner} is an EOA, not a Safe — this script is for the contract-owner ` +
      'case. An EOA owner can rotate the rate from the admin console directly. ' +
      'Pass --safe <address> to dry-run the hashing against a Safe anyway.',
    )
  }
  return { provider, chainId: net.chainId, owner, safe: new ethers.Contract(owner, SAFE_ABI, provider) }
}

/**
 * Confirm the Safe exposes the ERC-1271 entry point, before anyone signs.
 *
 * A revert here is the pass. What must NOT happen is the call decoding to
 * nothing, which is how ethers reports "this address has no such function" — and
 * is what a Safe without the CompatibilityFallbackHandler would do. That
 * distinction is the whole content of this check, so it is made explicitly
 * rather than by treating every failure as fine.
 */
async function probeErc1271(safe, dataHash) {
  try {
    const answer = await safe.isValidSignature(dataHash, '0x')
    // Succeeding means the hash is already in `signedMessages`. Harmless, and
    // impossible for a fresh nonce, so say so rather than silently continuing.
    console.log(`  note          the Safe already has this hash approved (${answer})`)
    return
  } catch (err) {
    const code = err.code ?? ''
    const text = `${err.reason ?? ''} ${err.shortMessage ?? ''} ${err.message ?? ''}`
    if (code === 'BAD_DATA' || /could not decode|no data present/i.test(text)) {
      fail(
        'this Safe did not answer isValidSignature(bytes32,bytes) — it is probably ' +
        'missing the CompatibilityFallbackHandler. The server verifies through that ' +
        'exact overload, so signatures collected against this Safe could never be ' +
        `checked. Raw error: ${err.shortMessage ?? err.message}`,
      )
    }
    const reason = err.reason ?? err.shortMessage ?? 'reverted'
    console.log(`  erc-1271      reachable  ✓ (${reason})`)
  }
}

async function request() {
  const rateArg = flag('rate')
  if (!rateArg) fail('pass --rate <number>, the new ETH quota per 1 ETH of gas')
  const rate = Number(rateArg)
  if (!Number.isFinite(rate) || rate <= 0) fail(`--rate must be positive, got ${rateArg}`)

  // Default six hours. The server allows up to 24 for a contract owner; the
  // shorter default is a nudge to keep a signed instruction from lingering, not
  // a limit — raise it with --ttl if the signers are in awkward timezones.
  const ttl = Number(flag('ttl') ?? 6 * 60 * 60)
  if (!Number.isInteger(ttl) || ttl <= 0) fail(`--ttl must be a positive integer of seconds`)

  const { chainId, owner, safe } = await connect()
  const [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()])

  const nonce = Date.now()
  const expiresAt = Math.floor(Date.now() / 1000) + ttl
  const text = buildMessage(rate, nonce, expiresAt)
  const td = safeMessageTypedData(owner, chainId, text)

  const local = ethers.TypedDataEncoder.hash(td.domain, td.types, td.message)
  // Held against the Safe's own answer, exactly as drillQ1 does for SafeTx. A
  // mismatch here is the failure that wastes a signer's time and stays invisible
  // until the assembled signature is rejected.
  const onChain = await safe.getMessageHash(td.inner)
  if (local.toLowerCase() !== onChain.toLowerCase()) {
    fail(
      `SafeMessage hash mismatch — local ${local}, Safe ${onChain}. Do not collect ` +
      'signatures against either until this is understood; the Safe version may ' +
      'wrap messages differently than assumed.',
    )
  }

  // Third read-only check: does this Safe actually answer the question the
  // server will ask? `verifyMessage` calls the bytes32 overload of
  // `isValidSignature`, which lives on the CompatibilityFallbackHandler — a Safe
  // set up without that handler, or with an older one exposing only the `bytes`
  // overload, would take every signature we collect and then be unable to be
  // asked about them. Probed with an empty signature, which Safe answers by
  // consulting `signedMessages` and reverting `Hash not approved`; that revert is
  // the confirmation, because reaching it means the entry point exists.
  await probeErc1271(safe, ethers.hashMessage(text))

  const out = {
    generatedAt: new Date().toISOString(),
    chainId: Number(chainId),
    // Absent in a `--safe` dry run, where there is deliberately no factory in
    // the picture yet. Recorded rather than required so the artefact still says
    // what it was produced against.
    factory: flag('safe')
      ? null
      : factoryAddress(),
    safe: owner,
    threshold: Number(threshold),
    owners: owners.map(ethers.getAddress),
    rate,
    nonce,
    expiresAt,
    message: text,
    safeMessageHash: local,
    eip712: { domain: td.domain, types: td.types, message: td.message },
  }
  fs.writeFileSync(path.join(REPO_ROOT, REQUEST_FILE), JSON.stringify(out, null, 2) + '\n')

  console.log(`\n  safe          ${owner}  (${threshold}-of-${owners.length})`)
  console.log(`  rate          ${rate}`)
  console.log(`  nonce         ${nonce}`)
  console.log(`  expires       ${new Date(expiresAt * 1000).toISOString()}  (${ttl}s)`)
  console.log(`  hash to sign  ${local}  ✓ matches the Safe's own getMessageHash`)
  console.log(`\n  message:\n${text.split('\n').map(l => '    ' + l).join('\n')}`)
  console.log(`\n  wrote ${REQUEST_FILE}`)
  console.log(`\n  Ask ${Number(threshold)} of these owners to sign the EIP-712 payload in that file:`)
  for (const o of out.owners) console.log(`    ${o}`)
  console.log(`\n  Collect their replies into ${SIGNATURES_FILE} as`)
  console.log('    { "signatures": [ { "address": "0x…", "signature": "0x…" } ] }')
  console.log(`  then: node scripts/rotateGasRate.mjs verify`)
}

async function verify(file) {
  const req = readJson(path.join(REPO_ROOT, REQUEST_FILE))
  const collected = readJson(path.isAbsolute(file) ? file : path.join(REPO_ROOT, file))
  const entries = collected.signatures || collected
  const known = new Map(req.owners.map(a => [a.toLowerCase(), a]))

  const accepted = []
  let bad = 0
  for (const entry of entries) {
    let sig
    try { sig = normalize(entry.signature) } catch (e) { console.log(`  ✗ ${e.message}`); bad++; continue }
    let who
    try {
      who = ethers.recoverAddress(req.safeMessageHash, sig)
    } catch (e) { console.log(`  ✗ unrecoverable signature — ${e.message}`); bad++; continue }
    if (!known.has(who.toLowerCase())) {
      console.log(`  ✗ signed by ${who}, who is not an owner of this Safe`)
      bad++; continue
    }
    if (accepted.some(a => a.address.toLowerCase() === who.toLowerCase())) {
      console.log(`  ! duplicate signature from ${who}, ignored`)
      continue
    }
    accepted.push({ address: ethers.getAddress(who), signature: sig })
    console.log(`  ✓ signed by ${ethers.getAddress(who)}`)
  }

  console.log(`\n  ${accepted.length}/${req.threshold} required signatures`)
  if (bad) console.log(`  ${bad} rejected`)
  if (accepted.length < req.threshold) {
    fail(`not yet executable — still needs ${req.threshold - accepted.length}`)
  }

  const packed = pack(accepted)

  // The decisive check. This is the same question `verifyMessage` will ask from
  // the server, put to the same contract, so a magic value here means `submit`
  // cannot fail for signature reasons — and a refusal here costs nobody a
  // second round trip.
  const { safe } = await connect()
  const answer = await safe.isValidSignature(ethers.hashMessage(req.message), packed)
  if (answer.toLowerCase() !== EIP1271_MAGIC) {
    fail(
      `the Safe refused the assembled signature (isValidSignature returned ${answer}). ` +
      'Do not submit; re-collect.',
    )
  }
  console.log(`  ✓ the Safe validates the assembled signature (${answer})`)

  fs.writeFileSync(
    path.join(REPO_ROOT, REQUEST_FILE),
    JSON.stringify({ ...req, packedSignature: packed }, null, 2) + '\n',
  )
  console.log(`\n  wrote the packed signature into ${REQUEST_FILE}`)
  console.log('  then: node scripts/rotateGasRate.mjs submit')
}

async function submit() {
  const req = readJson(path.join(REPO_ROOT, REQUEST_FILE))
  if (!req.packedSignature) fail('no packed signature — run `verify` first')

  const now = Math.floor(Date.now() / 1000)
  if (req.expiresAt <= now) {
    fail(
      `this instruction expired ${now - req.expiresAt}s ago — start again with ` +
      '`request`, optionally with a longer --ttl',
    )
  }

  const url = `${apiUrl()}/api/admin/config`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      newRate: req.rate,
      nonce: String(req.nonce),
      expiresAt: req.expiresAt,
      signature: req.packedSignature,
    }),
  })
  const body = await res.json().catch(() => ({}))

  console.log(`\n  POST ${url}`)
  console.log(`  ${res.status} ${res.statusText}`)
  console.log(`  ${JSON.stringify(body, null, 2).split('\n').join('\n  ')}`)

  if (!res.ok) fail(`rotation refused (HTTP ${res.status})`)

  console.log(`\n  ✓ rate is now ${body.globalGasToSatoRate} (was ${body.previous})`)
  console.log('  Confirm from a second instance:')
  console.log(`    curl -s ${apiUrl()}/api/admin/config`)
  console.log('  `lastSeenNonce` should now be this request\'s nonce, and `nonceStore`')
  console.log('  should read `redis` — on `memory` the rotation is instance-local.')
}

/**
 * Print the message this script would sign, without touching the network.
 *
 * Exists so the source-parsing above is exercisable on its own. The parser is
 * the one part of this file that can break from an edit to an unrelated
 * TypeScript module, and the alternative to a command that shows its output is
 * discovering the breakage while three people wait.
 */
function template() {
  const rate = Number(flag('rate') ?? 0.1)
  const nonce = flag('nonce') ?? 1700000000000
  const expiresAt = Number(flag('expiresAt') ?? 1700000600)
  const text = buildMessage(rate, nonce, expiresAt)
  console.log(`\n  parsed from soat-frontend/src/lib/adminConfigMessage.ts:\n`)
  console.log(text.split('\n').map(l => '    ' + l).join('\n'))
  console.log(`\n  eip-191 hash  ${ethers.hashMessage(text)}`)
}

const run = async () => {
  switch (cmd) {
    case 'template': return template()
    case 'request': return request()
    case 'verify': return verify(argv[1] && !argv[1].startsWith('--') ? argv[1] : SIGNATURES_FILE)
    case 'submit': return submit()
    default:
      console.log('usage: node scripts/rotateGasRate.mjs <template|request|verify|submit> [options]')
      console.log('  see the header of this file for the full flow')
      if (cmd) fail(`unknown command ${cmd}`)
  }
}

await run()
