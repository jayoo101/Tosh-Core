#!/usr/bin/env node
/*
 * verifyOwnerSafe.mjs
 * ───────────────────
 * Step three of PM-D4: check the Safe you just created is the Safe you meant,
 * and that it satisfies every precondition `DeployMainnet.s.sol` will assert —
 * now, rather than at the moment of the mainnet broadcast.
 *
 * That timing is the point. The deploy script's `requireDistinctRoles` reverts
 * on a role collision, which is the correct behaviour and a terrible time to
 * learn about it: C1 is a single broadcast that deploys the factory, the hook
 * implementation and the treasury and stages both ownership transfers. Finding
 * out there that PLATFORM_TREASURY equals the PoG signer means unpicking a
 * half-done launch under time pressure.
 *
 * The last check is the one that cannot be undone later. Per the decision to
 * let the owner Safe also be PLATFORM_TREASURY, this address will receive
 * 0.30 % of the ETH input of every buy on every pool, forever, and it is
 * IMMUTABLE — baked into both the factory and the hook implementation's
 * `platformFeeRecipient`. Rotating it is a factory redeploy and a migration of
 * every pool. It is also paid on a path that is not fault-isolated: v4-core's
 * `CurrencyLibrary.transfer` bubbles a failed native send up as
 * `NativeTransferFailed`, so a recipient that reverts on receive does not lose
 * one fee — it bricks every buy on every pool.
 *
 * Usage:  node scripts/verifyOwnerSafe.mjs <safe-address> [safe-owners.json]
 */

import fs from 'node:fs'
import { ethers } from 'ethers'
import { loadRoleEnv, reportRoleEnv } from './loadRoleEnv.mjs'

const MAINNET_ID = 4663n
const RPC = process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com'
const TX_SERVICE = 'https://api.safe.global/tx-service/robinhood/api/v1'

// keccak256("fallback_manager.handler.address")
const FALLBACK_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'

const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function nonce() view returns (uint256)',
]

const safeAddr = process.argv[2]
const file = process.argv[3] || 'safe-owners.json'
if (!safeAddr || !ethers.isAddress(safeAddr)) {
  console.error('usage: node scripts/verifyOwnerSafe.mjs <safe-address> [safe-owners.json]')
  process.exit(1)
}

const ROLES = ['PRIVATE_KEY', 'POG_SIGNER_ADDRESS']
const roleEnv = loadRoleEnv(ROLES)
console.log('roles being checked against:')
reportRoleEnv(ROLES, roleEnv)

const provider = new ethers.JsonRpcProvider(RPC)
const net = await provider.getNetwork()
const problems = []
const unknowns = []
const notes = roleEnv.missing.map(k =>
  `${k} was unset, so the collision check against that role did not run. `
  + 'DeployMainnet.s.sol asserts it at C1 regardless.')

/** Sender cannot pay for gas * price + value. That is a property of `from`,
 *  never of the recipient — which is the whole reason this helper exists. */
function isSenderFundsError(err) {
  if (ethers.isError(err, 'INSUFFICIENT_FUNDS')) return true
  const rpc = err?.info?.error
  const msg = String(rpc?.message || '')
  return Number(rpc?.code) === -32000
    && /insufficient funds/i.test(msg)
    && !/revert/i.test(msg)
}

function isRecipientRevert(err) {
  return ethers.isError(err, 'CALL_EXCEPTION')
}

function isOverrideUnsupported(err) {
  const msg = [err?.shortMessage, err?.message, err?.info?.error?.message]
    .filter(Boolean).join(' ')
  return /invalid arguments|too many arguments|optional args|not (supported|available)|unknown method/i.test(msg)
    && !/execution reverted|insufficient funds/i.test(msg)
}

/** 100 ETH — enough for 1 wei plus intrinsic gas at any price this chain has shown. */
const SYNTHETIC_BALANCE = '0x56bc75e2d63100000'

async function estimatePlainEth(to, from) {
  const tx = { to, value: 1n, from }
  try {
    return { gas: await provider.estimateGas(tx) }
  } catch (err) {
    if (!isSenderFundsError(err)) {
      return isRecipientRevert(err) ? { reject: err } : { indeterminate: err }
    }
    try {
      const gasHex = await provider.send('eth_estimateGas', [
        { from, to, value: '0x1' },
        'latest',
        { [from.toLowerCase()]: { balance: SYNTHETIC_BALANCE } },
      ])
      return { gas: BigInt(gasHex), synthetic: true }
    } catch (overrideErr) {
      if (isRecipientRevert(overrideErr) && !isOverrideUnsupported(overrideErr)) {
        return { reject: overrideErr }
      }
      return { indeterminate: err, overrideErr }
    }
  }
}

if (net.chainId !== MAINNET_ID) {
  console.error(`✗ connected to chain ${net.chainId}, expected ${MAINNET_ID}.`)
  process.exit(1)
}

const safe = new ethers.Contract(ethers.getAddress(safeAddr), SAFE_ABI, provider)

// ── 1. It exists and is a Safe ────────────────────────────────────────────────
if ((await provider.getCode(safeAddr)) === '0x') {
  console.error(`✗ no code at ${safeAddr} on chain ${net.chainId}.`)
  process.exit(1)
}

const owners = (await safe.getOwners()).map(a => ethers.getAddress(a))
const threshold = await safe.getThreshold()
const version = await safe.VERSION()
const nonce = await safe.nonce()

console.log(`safe        ${ethers.getAddress(safeAddr)}`)
console.log(`version     ${version}`)
console.log(`threshold   ${threshold} of ${owners.length}`)
console.log(`nonce       ${nonce}`)
owners.forEach((o, i) => console.log(`  owner ${i + 1}   ${o}`))

// ── 2. Threshold and owner count ──────────────────────────────────────────────
if (owners.length !== 3 || threshold !== 2n) {
  problems.push(`this is ${threshold}-of-${owners.length}, not 2-of-3. §1.1 settled on `
    + '2-of-3: a lower threshold voids PRD §11 D2, and 2-of-2 means one unreachable '
    + 'signer freezes the brake, which is the failure the brake exists to prevent.')
}

// ── 3. Owners match what was agreed ───────────────────────────────────────────
if (fs.existsSync(file)) {
  const input = JSON.parse(fs.readFileSync(file, 'utf8'))
  const expected = (input.signers || [])
    .filter(s => ethers.isAddress(s.address))
    .map(s => ethers.getAddress(s.address))
  const missing = expected.filter(e => !owners.includes(e))
  const extra = owners.filter(o => !expected.includes(o))
  if (missing.length) problems.push(`agreed owners absent from the Safe: ${missing.join(', ')}.`)
  if (extra.length) {
    problems.push(`the Safe has owners nobody agreed to: ${extra.join(', ')}. Treat this `
      + 'as a compromised setup, not a typo — an unexpected owner is one signature '
      + 'toward a 2-of-3 quorum.')
  }
  if (!missing.length && !extra.length) console.log('\n  ✓ owner set matches ' + file + ' exactly')
} else {
  notes.push(`${file} not found, so the owner set was not cross-checked against what `
    + 'was agreed — only against itself.')
}

// ── 4. Fallback handler ───────────────────────────────────────────────────────
const handler = ethers.getAddress('0x' + (await provider.getStorage(safeAddr, FALLBACK_SLOT)).slice(26))
console.log(`  fallback  ${handler}`)
if (handler === ethers.ZeroAddress) {
  problems.push('no fallback handler set. Without CompatibilityFallbackHandler the Safe '
    + 'cannot answer the EIP-1271 and message-hash queries that tooling and the '
    + 'transaction service rely on.')
}

// ── 5. The transaction service can see it ─────────────────────────────────────
//
// A Safe deployed against the plain singleton instead of SafeL2 works perfectly
// on chain and is invisible here, because the L2 variant is what emits the
// events the indexer consumes. That combination is the dangerous one: it owns
// the factory while nobody can drive it from the interface the playbook names.
try {
  const res = await fetch(`${TX_SERVICE}/safes/${ethers.getAddress(safeAddr)}/`)
  if (res.ok) {
    const j = await res.json()
    console.log(`\n  tx service  indexed, version ${j.version}, threshold ${j.threshold}, ${j.owners?.length} owners`)
    if (!String(j.version).includes('L2')) {
      problems.push(`the service reports version "${j.version}" with no L2 marker. Chain `
        + `${MAINNET_ID} is l2:true in Safe's config, so this was likely deployed `
        + 'against the plain singleton and will not stay indexed.')
    }
  } else if (res.status === 404) {
    problems.push('the transaction service does not know this Safe (404). Either it was '
      + 'not deployed with SafeL2, or indexing has not caught up — re-run in a minute '
      + 'before concluding.')
  } else {
    notes.push(`transaction service returned ${res.status}; could not confirm indexing.`)
  }
} catch (err) {
  notes.push(`could not reach the transaction service (${err.message}).`)
}

// ── 6. Role separation, as DeployMainnet will assert it ───────────────────────
const roles = []
if (process.env.PRIVATE_KEY) roles.push(['deployer EOA', new ethers.Wallet(process.env.PRIVATE_KEY).address])
if (process.env.POG_SIGNER_ADDRESS && ethers.isAddress(process.env.POG_SIGNER_ADDRESS)) {
  roles.push(['PoG signer', ethers.getAddress(process.env.POG_SIGNER_ADDRESS)])
}
console.log()
for (const [name, addr] of roles) {
  const asSafe = ethers.getAddress(addr) === ethers.getAddress(safeAddr)
  const asOwner = owners.includes(ethers.getAddress(addr))
  console.log(`  vs ${name.padEnd(12)} ${addr}  ${asSafe ? '✗ IS the Safe' : asOwner ? '✗ is an owner' : '✓ distinct'}`)
  if (asSafe) {
    problems.push(`${name} equals the Safe address. DeployMainnet's requireDistinctRoles `
      + 'reverts on this, and it would revert mid-broadcast.')
  }
  if (asOwner && name === 'deployer EOA') {
    problems.push('the deployer EOA is one of the three owners. Its key is plaintext in '
      + '.env and PM-D1 replaces it at C1, so that owner slot is not worth what the '
      + '2-of-3 implies.')
  }
  if (asOwner && name === 'PoG signer') {
    problems.push('the PoG signer is one of the three owners, and its key is online by design.')
  }
}

// ── 7. It accepts plain ETH — the irreversible PLATFORM_TREASURY property ─────
//
// Measured, not assumed. A Safe's receive() emits SafeReceived, which costs far
// more than the 2300-gas stipend a bare `transfer()` would forward: on 46630 a
// plain send to a 1.4.1 Safe used 29,944 gas total, roughly 8,900 of it inside
// the Safe. We are safe only because v4-core sends with `call(gas(), ...)` and
// forwards everything. That is a real dependency on a vendored library, so it
// is worth restating wherever this address is checked.
//
// The probe sender is the deployer EOA when PRIVATE_KEY is set, otherwise
// owners[0]. That is deliberate: shopping for a funded `from` would make this
// pass on whichever machine happened to have a rich owner and leave the next
// caller — whose deployer is empty and whose owners are too — with the same
// misdiagnosis this used to print. An empty sender is not a property of the
// Safe. State-override the sender's balance if the node honours it (Robinhood
// mainnet nitro does, third argument of eth_estimateGas); otherwise report
// indeterminate rather than either a pass or "Do NOT use it as PLATFORM_TREASURY".
const probeFrom = roles[0]?.[1] ?? owners[0]
const probeTo = ethers.getAddress(safeAddr)
const ethProbe = await estimatePlainEth(probeTo, probeFrom)
if (ethProbe.gas != null) {
  const how = ethProbe.synthetic
    ? ` — probe sender ${probeFrom} holds too little to pay for 1 wei; measured with an eth_estimateGas state override`
    : ''
  console.log(`\n  plain ETH   accepted, ~${ethProbe.gas} gas${how}`)
  console.log('              well over the 2300 a bare transfer() would forward.')
  console.log('              v4-core uses call(gas(), …), so this is fine;')
  console.log('              it is fine BECAUSE of that, not by margin.')
  if (ethProbe.synthetic) {
    notes.push(`the ETH-accept probe funded ${probeFrom} synthetically; its on-chain `
      + 'balance could not pay for 1 wei plus gas. The gas figure is the recipient\'s. '
      + 'The empty sender is not a reason to rotate PLATFORM_TREASURY.')
  }
  if (ethProbe.gas > 100000n) {
    problems.push(`receiving ETH costs ${ethProbe.gas} gas, which is high enough to be worth `
      + 'understanding before making this the permanent fee recipient.')
  }
} else if (ethProbe.reject) {
  problems.push('a plain ETH transfer to this address does not even estimate '
    + `(${ethProbe.reject.message}). As PLATFORM_TREASURY it would revert every buy on every pool, `
    + 'and the address is immutable once the factory is deployed. Do NOT use it as '
    + 'PLATFORM_TREASURY.')
} else {
  const err = ethProbe.indeterminate
  const extra = ethProbe.overrideErr
    ? ` State override retry: ${ethProbe.overrideErr.message}.`
    : ''
  if (err && isSenderFundsError(err)) {
    unknowns.push('could not determine whether this address accepts plain ETH: the probe sender '
      + `${probeFrom} cannot fund the estimate (${err.message}).`
      + extra
      + ' This is not a finding that the Safe rejects ETH, and not a reason to rotate '
      + 'PLATFORM_TREASURY. Re-run once the sender can pay for 1 wei plus gas, or against an RPC '
      + 'that honours eth_estimateGas state overrides.')
  } else {
    unknowns.push('could not determine whether this address accepts plain ETH '
      + `(${err?.message ?? 'unknown'}).`
      + extra
      + ' This is not a finding that the Safe rejects ETH, and not a reason to rotate '
      + 'PLATFORM_TREASURY.')
  }
}

// ── Verdict ───────────────────────────────────────────────────────────────────
console.log()
for (const n of notes) console.log('  ⚠ ' + n)
if (problems.length) {
  console.error('\n✗ NOT ready to put in .env.production:\n')
  for (const p of problems) console.error('  · ' + p)
  if (unknowns.length) {
    console.error('\n  also could not determine (not a finding that the Safe is unfit):\n')
    for (const u of unknowns) console.error('  · ' + u)
  }
  process.exit(1)
}
if (unknowns.length) {
  console.error('\n✗ could not finish the check. This is not a pass, and not a finding that the Safe is unfit:\n')
  for (const u of unknowns) console.error('  · ' + u)
  process.exit(2)
}

console.log('✓ 2-of-3, owners as agreed, SafeL2 and indexed, roles distinct, accepts ETH.')
console.log('\n  Safe to set BOTH of these in .env.production:')
console.log(`    PROD_OWNER_SAFE=${ethers.getAddress(safeAddr)}`)
console.log(`    PLATFORM_TREASURY=${ethers.getAddress(safeAddr)}`)
// Both sentences this block used to print went stale on 2026-09-04 and stayed
// that way. It asked you to "fill INCIDENT_RESPONSE.md §1 with all three
// signers" — already done, §1 names Tom, Jack and Joe against their
// signature-proved addresses — and to "re-run the §8.2 Q1 drill … that is the
// third Q1 criterion, and the only one still unmet", which §8.3 closed the same
// day: Joe and Tom signed all four payloads on 46630.
//
// Left alone it would have cost real time. C1_RUNBOOK.md §0 has you run this
// script on deploy day, where it would have sent you to organise a drill that
// is already done while saying nothing about the gap that is actually open.
console.log('\n  Remaining for D4 / E4: a contact channel for each signer.')
console.log('  §1 names them and §8.3 met Q1\'s third criterion on 2026-09-04, so')
console.log('  the drill is done. What is still blank is how you wake two of the')
console.log('  three at 03:00 — §8.2 timed the mechanical path at 5 s against a')
console.log('  60-second budget, so nearly all of that budget is the human hop.')
