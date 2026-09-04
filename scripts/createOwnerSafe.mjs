#!/usr/bin/env node
/*
 * createOwnerSafe.mjs
 * ───────────────────
 * Step two of PM-D4: create the real 2-of-3 Safe on Robinhood mainnet (4663).
 *
 * This Safe is not optional scaffolding and it is not only about C2. It is a
 * REQUIRED INPUT to the mainnet deploy: `script/DeployMainnet.s.sol` reads
 * `PROD_OWNER_SAFE` with `vm.envAddress` (no default), asserts it is not the
 * deployer, and then calls `transferOwnership` to it for both the factory and
 * the ladder treasury in the same broadcast. Without this address C1 cannot
 * run at all — which is the good news, because it means creating the Safe now
 * takes it off the critical path instead of parking it behind the audit.
 *
 * Everything here mirrors what §8.2 already rehearsed twice on 46630, with the
 * chain guard inverted: `drillSafe.mjs` refuses to run anywhere BUT testnet,
 * because it uses publicly known mnemonic keys. This one refuses to run
 * anywhere but mainnet, and refuses to use those keys at all.
 *
 * Usage:  node scripts/createOwnerSafe.mjs safe-owners.json --confirm
 * Requires: PRIVATE_KEY (pays gas only — the deployer does NOT become an owner)
 */

import fs from 'node:fs'
import { ethers } from 'ethers'
import { loadRoleEnv, reportRoleEnv } from './loadRoleEnv.mjs'

const MAINNET_ID = 4663n
const RPC = process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com'

// Canonical Safe 1.4.1 deployments. Verified present on BOTH 4663 and 46630
// before the §8.2 rehearsals; re-verified on chain below rather than trusted,
// because a missing singleton here produces a proxy that accepts ownership and
// can never act.
const PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67'
const SAFE_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
const FALLBACK = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99'

const PF_ABI = [
  'function createProxyWithNonce(address _singleton,bytes initializer,uint256 saltNonce) returns (address proxy)',
]
const SETUP_ABI = ['function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)']
const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function nonce() view returns (uint256)',
]

const file = process.argv[2] || 'safe-owners.json'
const confirmed = process.argv.includes('--confirm')

const die = (...lines) => { for (const l of lines) console.error(l); process.exit(1) }

if (!fs.existsSync(file)) die(`✗ ${file} not found.`)
const input = JSON.parse(fs.readFileSync(file, 'utf8'))

const ROLES = ['PRIVATE_KEY', 'POG_SIGNER_ADDRESS']
console.log('roles being checked against:')
reportRoleEnv(ROLES, loadRoleEnv(ROLES))

const provider = new ethers.JsonRpcProvider(RPC)
const net = await provider.getNetwork()

// ── Rail 1: this is a mainnet-only script ─────────────────────────────────────
if (net.chainId !== MAINNET_ID) {
  die(`✗ connected to chain ${net.chainId}, refusing: this script only runs on ${MAINNET_ID}.`,
    '  For rehearsal on 46630 use scripts/drillSafe.mjs, which is built for it and',
    '  carries the opposite guard. Mixing the two is how a Safe whose owners are',
    "  Foundry's public test mnemonic ends up owning the real factory.")
}

if (!process.env.PRIVATE_KEY) die('✗ PRIVATE_KEY unset — needed to pay gas (not to own anything).')
const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider)

// ── Rail 2: the owner set ─────────────────────────────────────────────────────
if (!Array.isArray(input.signers) || input.signers.length !== 3) {
  die(`✗ expected exactly 3 signers, found ${input.signers?.length ?? 0}.`)
}

const owners = []
for (const s of input.signers) {
  if (!ethers.isAddress(s.address)) die(`✗ "${s.address}" (${s.name}) is not an address.`)
  const addr = ethers.getAddress(s.address)

  // Re-verify the signature here rather than trusting that step one was run.
  // The whole point of that step is that an unsignable owner is invisible until
  // it matters, so the check belongs at the write, not only upstream of it.
  if (!input.message || !s.signature) {
    die(`✗ ${s.name} has no signature in ${file}.`,
      '  Run: node scripts/verifySignerCandidates.mjs ' + file,
      '  An owner who cannot sign looks identical to one who can until the first',
      '  time you need two signatures inside sixty seconds.')
  }
  let recovered
  try {
    recovered = ethers.getAddress(ethers.verifyMessage(input.message, s.signature))
  } catch (err) {
    die(`✗ ${s.name}: signature unparseable (${err.message}).`)
  }
  if (recovered !== addr) {
    die(`✗ ${s.name}: signature recovers to ${recovered}, not ${addr}.`,
      '  Resolve this before writing anything on chain. Once this Safe owns the',
      '  factory, replacing an owner is itself a 2-of-3 Safe transaction — so an',
      '  owner nobody can sign for makes the threshold effectively 2-of-2.')
  }

  if (owners.includes(addr)) die(`✗ ${addr} appears twice — three owners must be three keys.`)
  if (addr === deployer.address) {
    die(`✗ ${s.name} is the deployer EOA.`,
      '  Its key is plaintext in .env and PM-D1 replaces it at C1. An owner whose',
      '  key sits in a file is not a third of a 2-of-3.')
  }
  if (process.env.POG_SIGNER_ADDRESS
      && ethers.isAddress(process.env.POG_SIGNER_ADDRESS)
      && addr === ethers.getAddress(process.env.POG_SIGNER_ADDRESS)) {
    die(`✗ ${s.name} is the PoG signer, whose key is online by design.`)
  }
  if ((await provider.getCode(addr)) !== '0x') {
    die(`✗ ${addr} (${s.name}) has code — Safe owners must be EOAs here.`)
  }
  owners.push(addr)
}

// ── Rail 3: the Safe contracts are actually there ─────────────────────────────
for (const [name, addr] of [['SafeProxyFactory', PROXY_FACTORY], ['SafeL2', SAFE_L2], ['FallbackHandler', FALLBACK]]) {
  const code = await provider.getCode(addr)
  if (code === '0x') {
    die(`✗ ${name} has no code at ${addr} on chain ${net.chainId}.`,
      '  Do not improvise around this. Stop and re-check the canonical addresses.')
  }
  console.log(`  ✓ ${name.padEnd(16)} ${addr}  (${(code.length - 2) / 2} bytes)`)
}

const bal = await provider.getBalance(deployer.address)
console.log(`\n  gas payer       ${deployer.address}  ${ethers.formatEther(bal)} ETH`)
console.log(`  owners (2-of-3)`)
input.signers.forEach((s, i) => console.log(`    ${i + 1}. ${owners[i]}  ${s.name || ''}`))
console.log('\n  NOTE: SafeL2, not the plain singleton — chain 4663 is `l2: true` in Safe\'s')
console.log('  own config, and the plain singleton yields a Safe that works on chain but')
console.log('  is invisible to the transaction service and to app.safe.global, i.e. it')
console.log('  holds ownership while nobody can drive it from the UI the playbook assumes.')

if (!confirmed) {
  console.log('\n  Dry run. Nothing was written. Re-run with --confirm to create it.')
  process.exit(0)
}

// ── Create ────────────────────────────────────────────────────────────────────
const initializer = new ethers.Interface(SETUP_ABI).encodeFunctionData('setup', [
  owners, 2, ethers.ZeroAddress, '0x', FALLBACK, ethers.ZeroAddress, 0, ethers.ZeroAddress,
])
const pf = new ethers.Contract(PROXY_FACTORY, PF_ABI, deployer)

console.log('\n  creating…')
const tx = await pf.createProxyWithNonce(SAFE_L2, initializer, BigInt(Date.now()))
const rcpt = await tx.wait()

// The proxy address comes out of the ProxyCreation event rather than being
// guessed: createProxyWithNonce is CREATE2, and re-deriving the salt here would
// be a second implementation of something the receipt already states.
const created = rcpt.logs
  .map(l => { try { return ethers.getAddress('0x' + l.data.slice(26, 66)) } catch { return null } })
  .find(a => a && a !== ethers.ZeroAddress)
const safeAddr = created ?? rcpt.logs[0]?.address

console.log(`  tx              ${rcpt.hash}`)
console.log(`  gas used        ${rcpt.gasUsed}`)
console.log(`  SAFE            ${safeAddr}`)

const safe = new ethers.Contract(safeAddr, SAFE_ABI, provider)
console.log(`\n  read back: threshold ${await safe.getThreshold()} of ${(await safe.getOwners()).length},`
  + ` version ${await safe.VERSION()}, nonce ${await safe.nonce()}`)

console.log('\n  Put these in .env.production — the same address for both, per the decision')
console.log('  to let the owner Safe also be the platform treasury:\n')
console.log(`    PROD_OWNER_SAFE=${safeAddr}`)
console.log(`    PLATFORM_TREASURY=${safeAddr}`)
console.log('\n  Then: node scripts/verifyOwnerSafe.mjs ' + safeAddr + ' ' + file)
