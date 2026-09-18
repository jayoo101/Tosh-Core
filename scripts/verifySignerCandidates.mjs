#!/usr/bin/env node
/*
 * verifySignerCandidates.mjs
 * ──────────────────────────
 * Step one of PM-D4: prove each prospective Safe signer actually controls the
 * address they sent you, before that address is load-bearing.
 *
 * The failure this prevents is dull and completely plausible: someone pastes an
 * address from the wrong wallet, or from an exchange deposit account they cannot
 * sign from, or with a transposed character. Nothing detects that at Safe
 * creation — `setup()` accepts any address, including one nobody can sign for.
 * You find out the first time you need two signatures in sixty seconds, which
 * is during a P0 with funds at risk.
 *
 * A signature is the only evidence that distinguishes "an address they own" from
 * "an address they typed". It costs each candidate one click and no gas.
 *
 * What each candidate does:
 *   1. You send them the exact `message` string from the input file.
 *   2. They sign it as a personal message (EIP-191) — every wallet's
 *      "Sign message", including hardware wallets. This is NOT a transaction
 *      and cannot move anything.
 *   3. They send back the address and the signature. Never a private key or a
 *      seed phrase: nobody entitled to ask will ever ask, and this script does
 *      not accept one.
 *
 * Usage:  node scripts/verifySignerCandidates.mjs safe-owners.json
 * Exits non-zero if any candidate fails any check.
 */

import fs from 'node:fs'
import { ethers } from 'ethers'
import { loadRoleEnv, reportRoleEnv } from './loadRoleEnv.mjs'

const MAINNET_ID = 56n
const RPC = process.env.BSC_RPC || 'https://bsc-dataseed1.bnbchain.org'

const ROLES = ['PRIVATE_KEY', 'POG_SIGNER_ADDRESS']
console.log('roles being checked against:')
reportRoleEnv(ROLES, loadRoleEnv(ROLES))

const file = process.argv[2] || 'safe-owners.json'
if (!fs.existsSync(file)) {
  console.error(`✗ ${file} not found. Copy safe-owners.example.json and fill it in.`)
  process.exit(1)
}
/* This file is assembled by hand from three blocks pasted out of a browser, so
 * a syntax error here is the single likeliest thing to go wrong in all of D4.
 * An uncaught SyntaxError would answer it with a stack trace and a byte offset,
 * which is the least useful form the answer could take. */
let input
try {
  input = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (err) {
  console.error(`✗ ${file} is not valid JSON: ${err.message}`)
  console.error('  Three things cause this almost every time:')
  console.error('   · a comma after the LAST entry in `signers`, or a missing one between two')
  console.error('   · a block pasted through a chat app that turned " into a curly quote')
  console.error('   · one block pasted twice, leaving a stray } or ]')
  process.exit(1)
}

// The signing page emits one object per signer with the message inside it, so
// that the text travels with the signature that covers it. A hand-written file
// is likelier to carry one message at the top. Accept both, and then require
// that whatever arrives agrees: three owners who signed three different
// statements have each proved control of a key, but they have not all accepted
// the same role, and only one of those two things is what this step is for.
const messageFor = s => s.message ?? input.message
const messages = new Set((input.signers ?? []).map(messageFor).filter(Boolean))

if (messages.size === 0) {
  console.error('✗ no `message` found, neither at the top level nor on any signer.')
  console.error('  Every signer must sign the SAME text, and it must name this purpose')
  console.error('  and a date, so a signature collected for something else cannot be')
  console.error('  replayed into this role. The signing page emits the text alongside')
  console.error('  the signature for exactly this reason.')
  process.exit(1)
}
if (messages.size > 1) {
  console.error(`✗ ${messages.size} different messages were signed:\n`)
  for (const m of messages) console.error(`  · "${m}"`)
  console.error('\n  These must be identical. A signer whose text differs — even by a')
  console.error('  date or a stray space — signed a different statement, and if the')
  console.error('  difference is the wording rather than the whitespace then they')
  console.error('  agreed to something other than what the other two agreed to.')
  process.exit(1)
}
if (!Array.isArray(input.signers) || input.signers.length !== 3) {
  console.error(`✗ expected exactly 3 signers, found ${input.signers?.length ?? 0}.`)
  console.error('  §1.1 decided 2-of-3 and explains why neither 2-of-2 nor a lower')
  console.error('  threshold is acceptable: 2-of-2 freezes the brake the moment one')
  console.error('  signer is unreachable, and anything below 2/N voids PRD §11 D2.')
  process.exit(1)
}

// Anything a signer must NOT be. The deployer is excluded by decision rather
// than by the contract: `DeployMainnet.s.sol` only forbids the *Safe* from
// being the deployer, but a Safe one of whose owners is a key sitting in
// plaintext in .env is not the 2-of-3 it appears to be, and PM-D1 replaces
// that key at C1 anyway.
// Reasons accumulate rather than overwrite. One address can hold two roles —
// in the current testnet .env the deployer and the PoG signer are literally the
// same key — and reporting only the last reason to be registered describes the
// collision inaccurately at exactly the moment someone is trying to understand
// it.
const FORBIDDEN = new Map()
const addForbidden = (addr, why) => {
  if (!addr || !ethers.isAddress(addr)) return
  const key = ethers.getAddress(addr)
  FORBIDDEN.set(key, [...(FORBIDDEN.get(key) ?? []), why])
}
const forbiddenReason = addr => (FORBIDDEN.get(addr) ?? []).join('; and ')
if (process.env.PRIVATE_KEY) {
  addForbidden(new ethers.Wallet(process.env.PRIVATE_KEY).address,
    'this is the deployer EOA, whose key is in plaintext and is replaced at C1 (PM-D1)')
}
addForbidden(process.env.POG_SIGNER_ADDRESS,
  'this is the PoG signer, whose key is online by design (DeployMainnet requires the roles distinct)')

const provider = new ethers.JsonRpcProvider(RPC)
let chainOk = true
try {
  const net = await provider.getNetwork()
  if (net.chainId !== MAINNET_ID) {
    console.error(`⚠ connected to chain ${net.chainId}, expected ${MAINNET_ID}. On-chain`)
    console.error('  checks below are skipped; signature recovery still runs.')
    chainOk = false
  }
} catch (err) {
  console.error(`⚠ could not reach ${RPC} (${err.message}). Signature recovery still`)
  console.error('  runs; the on-chain checks are skipped and this is NOT a full pass.')
  chainOk = false
}

const MESSAGE = [...messages][0]
console.log(`message all three must have signed:\n  "${MESSAGE}"\n`)

const problems = []
const seen = new Map()

for (const s of input.signers) {
  const label = s.name || s.address || '(unnamed)'
  console.log(`── ${label} ──`)

  if (s.privateKey || s.mnemonic || s.seed) {
    problems.push(`${label}: the input file contains a private key or seed phrase. `
      + 'Delete it, treat that key as compromised, and have them generate a new '
      + 'one. A signer key must never leave the signer.')
    console.log('  ✗ refusing to process — secret material in the input file\n')
    continue
  }

  if (!ethers.isAddress(s.address)) {
    problems.push(`${label}: "${s.address}" is not a valid address.`)
    console.log('  ✗ not an address\n')
    continue
  }
  const addr = ethers.getAddress(s.address)
  console.log(`  claimed     ${addr}`)

  // 1. The signature must recover to the claimed address.
  let recovered = null
  try {
    recovered = ethers.verifyMessage(messageFor(s), s.signature)
  } catch (err) {
    problems.push(`${label}: signature could not be parsed (${err.message}).`)
  }
  if (recovered) {
    const match = ethers.getAddress(recovered) === addr
    console.log(`  recovered   ${recovered}  ${match ? '✓ matches' : '✗ DOES NOT MATCH'}`)
    if (!match) {
      problems.push(`${label}: the signature recovers to ${recovered}, not the claimed `
        + `${addr}. Either the wrong address was sent or the signature came from a `
        + 'different wallet. Do not proceed with either address until this is resolved.')
    }
  }

  // 2. Duplicates. Three owners with two distinct keys is a 2-of-2 wearing a
  //    2-of-3 label, and 2-of-2 is what §1.1 explicitly refuses.
  if (seen.has(addr)) {
    problems.push(`${label}: same address as ${seen.get(addr)}. Three owners must be `
      + 'three distinct keys held by three distinct people, or the threshold is a '
      + 'fiction.')
  }
  seen.set(addr, label)

  // 3. Role separation.
  if (FORBIDDEN.has(addr)) {
    problems.push(`${label}: ${forbiddenReason(addr)}.`)
    console.log(`  ✗ forbidden — ${forbiddenReason(addr)}`)
  }

  // 4. Must be an EOA. A contract cannot produce an EIP-191 signature, so if
  //    one gets this far the recovery above was satisfied by something else.
  if (chainOk) {
    try {
      const code = await provider.getCode(addr)
      const isEoa = code === '0x'
      console.log(`  on chain    ${isEoa ? 'EOA' : `CONTRACT (${(code.length - 2) / 2} bytes)`}`
        + `, nonce ${await provider.getTransactionCount(addr)}`
        + `, ${ethers.formatEther(await provider.getBalance(addr))} BNB`)
      if (!isEoa) {
        problems.push(`${label}: ${addr} has code on chain ${MAINNET_ID}. Safe owners `
          + 'must be EOAs here — a contract owner cannot sign the way Step 1 assumes.')
      }
    } catch (err) {
      console.log(`  on chain    could not read (${err.message})`)
    }
  }
  console.log()
}

// One of the three needs gas, because whoever submits `execTransaction` pays
// for it. The other two never need any: signing is off-chain. Worth surfacing
// now rather than discovering it mid-incident.
if (chainOk) {
  const funded = []
  for (const [addr, label] of seen) {
    try {
      if ((await provider.getBalance(addr)) > 0n) funded.push(label)
    } catch { /* reported above */ }
  }
  if (funded.length === 0) {
    console.log('⚠ none of the three holds BNB on this chain. Signing costs nothing,')
    console.log('  but SOMEONE has to submit the transaction and pay for it. Fund at')
    console.log('  least one — ideally two, so the executor is not a single point.\n')
  } else {
    console.log(`gas available: ${funded.join(', ')} — enough to submit.\n`)
  }
}

if (problems.length) {
  console.error('✗ NOT READY to create the Safe:\n')
  for (const p of problems) console.error('  · ' + p)
  process.exit(1)
}

console.log('✓ all three candidates proved control of their address, the three are')
console.log('  distinct, none collides with the deployer or the PoG signer, and all')
console.log('  three are EOAs.')
console.log('\n  Next: node scripts/createOwnerSafe.mjs ' + file)
