#!/usr/bin/env node
/*
 * preflightMainnet.mjs
 * ────────────────────
 * The last gate before PM-C1, run against the file the deploy will actually
 * source rather than against values passed on a command line.
 *
 * ── Why this exists, given the two checks that already do ────────────────────
 *
 * `DeployMainnet.s.sol` asserts the chain id and that the four privileged roles
 * are non-zero and distinct. `verifyOwnerSafe.mjs` verifies a Safe deeply —
 * 2-of-3, owners as agreed, SafeL2 and indexed, and that it accepts plain BNB.
 * Both are good and neither closes the gap this one does.
 *
 * The gap is a paste. `verifyOwnerSafe.mjs` takes the Safe on argv and ends by
 * printing "Safe to set BOTH of these in .env.production". Nothing then checks
 * that they were set, or set to that. And `DeployMainnet.s.sol` will accept any
 * two non-zero, distinct, mutually different addresses — including a personal
 * EOA, which is the failure a personal-EOA treasury would be: named in as many
 * words: "the deploy script asserts only that it is non-zero and differs from
 * the deployer and the PoG signer, so a personal EOA passes and is then
 * permanent."
 *
 * `PLATFORM_TREASURY` takes 0.30 % of the BNB input of every buy on every pool,
 * forever, and is immutable — baked into the factory AND into the hook
 * implementation's `platformFeeRecipient`. Changing it is a factory redeploy and
 * a migration of every pool. So the one check that matters most is the one
 * neither existing gate performs: **does that address have code at all.**
 *
 * ── Ordering ─────────────────────────────────────────────────────────────────
 *
 * Checks are ordered by how permanent their failure is, not by how cheap they
 * are to run. Anything recoverable by a second owner transaction comes after
 * everything that is not recoverable at all.
 *
 * ── Exit codes ───────────────────────────────────────────────────────────────
 *
 *   0  every check passed — clear for C1
 *   1  at least one check FAILED — do not broadcast
 *   2  could not run (no .env.production, unreachable RPC). NOT a pass; a
 *      guard that cannot run must not be mistaken for one that found nothing.
 *
 * Usage:  node scripts/preflightMainnet.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ethers } from 'ethers'

import { loadRoleEnv, reportRoleEnv } from './loadRoleEnv.mjs'

const REPO = path.resolve(import.meta.dirname, '..')

/**
 * The endpoint is chosen by the chain being deployed to.
 *
 * ⚠ THIS WAS `process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com'`
 *   for the whole of the BSC port, which made the only pre-broadcast guard in
 *   the repository unable to reach the chain it guards. Every check below needs
 *   the provider, so the failure was total: `cannotRun` on the chain-id
 *   comparison, exit 2, and a fix line that named a variable nothing reads.
 *
 *   What makes that worth more than a rename: check 5 cross-checks
 *   `INFINITY_CL_POOL_MANAGER` against `contracts.ts` for chain 56, and both
 *   `.env.example` and `.env.production.example` shipped that name carrying
 *   Uniswap V4's PoolManager address on Robinhood Chain — renamed during the
 *   port, never revalued. So the guard that catches the template was the guard
 *   that could not run. A wrong manager hashes every `PoolKey` to a pool the
 *   factory never opened.
 *
 * Named per chain rather than one `TARGET_RPC`, because these are the same names
 * the frontend's `serverRpc.ts` and the CI fork suite already read, and a
 * chain-named variable cannot answer for a chain it does not name.
 */
function resolveRpc(chainId) {
  if (chainId === 56n) {
    return process.env.BSC_RPC || 'https://bsc-dataseed1.bnbchain.org'
  }
  if (chainId === 97n) {
    return process.env.BSC_TESTNET_RPC || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
  }
  return process.env.TARGET_RPC || null
}

/** Mirrored in `soat-frontend/src/lib/contracts.ts`, parsed rather than retyped. */
const CONTRACTS_TS = path.join(REPO, 'soat-frontend', 'src', 'lib', 'contracts.ts')

const ADDRESS_ROLES = [
  'TARGET_CHAIN_ID',
  'INFINITY_CL_POOL_MANAGER',
  // `DeployMainnet.s.sol` requires this non-zero and neither template declares
  // it, so a deploy from a filled-in template reverts at broadcast. Checking it
  // here turns that into an exit 2 before any gas is spent — and check 5b below
  // does more than presence, since the manager names its own Vault on chain.
  'INFINITY_VAULT',
  'POG_SIGNER_ADDRESS',
  'PLATFORM_TREASURY',
  'PROD_OWNER_SAFE',
  // Same argument as INFINITY_VAULT, and it arrived the same way: the BEM move
  // made `QUOTE_ASSET` a required `vm.envAddress` in DeployMainnet.s.sol while
  // neither env template declared it, so a deploy from a filled-in template
  // reverted at broadcast. Check 5c does more than presence — a wrong token here
  // is not a revert but a factory permanently denominated in something else.
  'QUOTE_ASSET',
]

/**
 * The deployer, by address if it is offered and by key only if it is not.
 *
 * `PRIVATE_KEY` was the sole way this script knew the deployer, and it wanted
 * exactly one thing from it: `new ethers.Wallet(pk).address`. So a pre-broadcast
 * *check* — a script whose entire job is to read state and refuse — was loading
 * the mainnet deploy key into process memory to compute a public value, and it
 * was the reason `PRIVATE_KEY` had to stay in plaintext in `.env.production`
 * after the deploy it was needed for. `checkSecretStore.mjs` inventories that
 * name at tier `absent` and reports it on every run; this script was what made
 * the finding unactionable, since removing the key broke the preflight.
 *
 * `DEPLOYER_ADDRESS` is preferred, and when both are present they are compared
 * rather than one silently winning: `forge script --private-key` broadcasts from
 * the KEY, so an address that disagrees would have this script check one wallet
 * and the broadcast sign from another — and check 6 prints a fund-this-address
 * instruction, which is the same money-instruction hazard check 0b exists for.
 */
const DEPLOYER_VARS = ['DEPLOYER_ADDRESS', 'PRIVATE_KEY']

const ROLES = [...DEPLOYER_VARS, ...ADDRESS_ROLES]

const failures = []
const notes = []

function fail(what, why, fix) {
  failures.push({ what, why, fix })
  console.log(`  FAIL  ${what}`)
}
function pass(what, detail = '') {
  console.log(`  ok    ${what}${detail ? '   ' + detail : ''}`)
}
function cannotRun(why) {
  console.error(`\n[preflight] CANNOT RUN — ${why}`)
  console.error('[preflight] exit 2. This is not a pass. Fix the above and re-run.')
  process.exit(2)
}

// ── 0. The file the deploy sources ───────────────────────────────────────────
//
// `.env.production` is gitignored and does not exist until deploy day, which is
// exactly why it is unverified.
//
// This comment used to continue: "the example file carries `0xREPLACE_ME_*` and
// `loadRoleEnv` skips those, so a half-filled file reads as a set of missing
// vars rather than as wrong ones." Half true, and the false half mattered.
// `loadRoleEnv` does skip REPLACE_ME — and then falls back to `.env`, so the
// var is not missing, it is testnet. Check 0b below is what actually makes the
// sentence true.
const ENV_PROD = path.join(REPO, '.env.production')
if (!fs.existsSync(ENV_PROD)) {
  cannotRun(
    '.env.production does not exist.\n'
    + '            Copy .env.production.example to .env.production and fill it.\n'
    + '            Reading .env instead would be worse than not running: it holds\n'
    + '            testnet roles where PLATFORM_TREASURY and POG_SIGNER_ADDRESS are\n'
    + '            both the deployer, so this would report three real failures about\n'
    + '            a file that is not the one being deployed.',
  )
}

console.log('[preflight] PM-C1 pre-broadcast checks, ordered by permanence\n')
console.log('roles, and where each came from:')
const roleEnv = loadRoleEnv(ROLES)

// Which of the two names the deployer arrived under, so that the gates below can
// speak about the one in use rather than about both.
const deployerVar = process.env.DEPLOYER_ADDRESS ? 'DEPLOYER_ADDRESS'
  : process.env.PRIVATE_KEY ? 'PRIVATE_KEY'
    : null

const missingRoles = ADDRESS_ROLES.filter(k => !process.env[k])
if (!deployerVar) missingRoles.push('DEPLOYER_ADDRESS (or PRIVATE_KEY)')

// Reported over the resolved set rather than over ROLES, which holds both
// deployer names. `reportRoleEnv` renders anything missing as "the checks that
// depend on those are SKIPPED, not passed" — true of an absent role, and a lie
// about an absent `PRIVATE_KEY` once `DEPLOYER_ADDRESS` has answered for the
// deployer. Nothing is skipped in that case, and the whole point of the change is
// that the key's absence is the state to aim at, not a degraded one.
reportRoleEnv(
  [deployerVar ?? 'DEPLOYER_ADDRESS', ...ADDRESS_ROLES],
  { source: roleEnv.source, missing: missingRoles },
)

if (missingRoles.length) {
  cannotRun(
    `${missingRoles.length} role var(s) still unset or left as a REPLACE_ME placeholder: `
    + `${missingRoles.join(', ')}.\n`
    + '            Every check below depends on these, so none of them ran.\n'
    + '            DEPLOYER_ADDRESS is the deployer EOA as an address. Set that in\n'
    + '            preference to PRIVATE_KEY: nothing here needs to sign, and a key\n'
    + '            that is not in the file cannot leak from it.',
  )
}

// ── 0b. Every role must have come from .env.production, not from .env ────────
//
// Closing a hole this script's own header claimed was already closed. That
// header says a half-filled file "reads as a set of missing vars rather than as
// wrong ones", and it is not so: `loadRoleEnv` reads .env.production FIRST and
// then falls back to .env for anything still unset, which is correct for the
// PM-D4 scripts it was written for and wrong here. So a .env.production with
// PRIVATE_KEY and POG_SIGNER_ADDRESS still on REPLACE_ME does not stop this
// script — it silently substitutes the TESTNET deployer for both and then
// reports, in the imperative, two failures about a file nobody is deploying.
//
// The reason that is worth an explicit gate rather than a note: the remediation
// text is a money instruction. Check 6 prints "Fund 0x73db078f… with at least
// N BNB", and 0x73db078f… is the testnet deployer that §4.1 forbids reusing on
// mainnet. An operator following this script on deploy day would send real BNB
// to a wallet that must never sign a mainnet transaction.
//
// Note also that the existing protection lived only in the `!existsSync` branch
// above — it lapsed the moment the file was created, which is the very thing
// that branch tells you to do.
const strayed = [...ADDRESS_ROLES, deployerVar]
  .filter(k => roleEnv.source[k] !== '.env.production')
if (strayed.length) {
  cannotRun(
    `${strayed.length} role var(s) did not come from .env.production: `
    + `${strayed.map(k => `${k} (${roleEnv.source[k]})`).join(', ')}.\n`
    + '            This script checks the file the deploy sources. A role resolved\n'
    + '            from .env is a TESTNET value, and every check below would then\n'
    + '            describe the wrong wallet — including the funding check, whose\n'
    + '            fix line names an address to send real BNB to.\n'
    + '            Fill these in .env.production itself and re-run.',
  )
}

// Everything below needs the chain. The endpoint is chosen by the chain the
// file asks for, so a `.env.production` naming 56 cannot be checked against 97
// by an endpoint left over from the rehearsal.
const targetChainId = BigInt(process.env.TARGET_CHAIN_ID)
const RPC = resolveRpc(targetChainId)
if (!RPC) {
  cannotRun(
    `TARGET_CHAIN_ID is ${targetChainId}, which this script has no endpoint for.\n`
    + '            56 reads BSC_RPC, 97 reads BSC_TESTNET_RPC, and both fall back to\n'
    + '            a public endpoint. For anything else, set TARGET_RPC.',
  )
}

const provider = new ethers.JsonRpcProvider(RPC)
let net
try {
  net = await provider.getNetwork()
} catch (err) {
  cannotRun(`could not reach ${RPC} (${err.message}).`)
}

if (net.chainId !== targetChainId) {
  cannotRun(
    `TARGET_CHAIN_ID is ${targetChainId} but ${RPC} reports chain ${net.chainId}.\n`
    + `            Set ${targetChainId === 56n ? 'BSC_RPC' : targetChainId === 97n ? 'BSC_TESTNET_RPC' : 'TARGET_RPC'} `
    + 'to an endpoint for the chain you are deploying to.\n'
    + '            DeployMainnet.s.sol asserts this too, but at broadcast time.',
  )
}

const deployer = deployerVar === 'DEPLOYER_ADDRESS'
  ? ethers.getAddress(process.env.DEPLOYER_ADDRESS)
  : new ethers.Wallet(process.env.PRIVATE_KEY).address

// Both names present is allowed, disagreeing is not. The broadcast signs from the
// key, so this script would otherwise report on a wallet that never signs.
if (process.env.DEPLOYER_ADDRESS && process.env.PRIVATE_KEY) {
  const fromKey = new ethers.Wallet(process.env.PRIVATE_KEY).address
  if (fromKey !== deployer) {
    cannotRun(
      `DEPLOYER_ADDRESS is ${deployer} but PRIVATE_KEY derives ${fromKey}.\n`
      + '            forge script --private-key signs from the KEY, so every check\n'
      + '            below would describe a wallet that does not broadcast — and\n'
      + '            check 6 names an address to send real BNB to.\n'
      + '            Delete whichever is stale. Prefer keeping DEPLOYER_ADDRESS.',
    )
  }
}
const platformTreasury = ethers.getAddress(process.env.PLATFORM_TREASURY)
const prodOwnerSafe = ethers.getAddress(process.env.PROD_OWNER_SAFE)
const pogSigner = ethers.getAddress(process.env.POG_SIGNER_ADDRESS)
const poolManager = ethers.getAddress(process.env.INFINITY_CL_POOL_MANAGER)

console.log(`chain ${net.chainId} via ${RPC}`)
console.log(`deployer ${deployer}\n`)

const codeOf = async (addr) => await provider.getCode(addr)

// ── 1. PLATFORM_TREASURY has code ────────────────────────────────────────────
//
// The single irreversible field on this list, and the one nothing else checks.
console.log('1. irreversible — PLATFORM_TREASURY (immutable, on every buy, forever)')
const treasuryCode = await codeOf(platformTreasury)
if (treasuryCode === '0x') {
  fail(
    'PLATFORM_TREASURY has no code — it is an EOA',
    'This address is immutable once the factory is deployed: it is baked into the '
    + 'factory and into the hook implementation as platformFeeRecipient, and it takes '
    + '0.30 % of the BNB input of every buy on every pool, forever. An EOA here is not '
    + 'a configuration to revisit later, it is permanent. PM-C9 decided this is the '
    + '2-of-3 owner Safe. DeployMainnet.s.sol does NOT check this and will accept it.',
    'Set PLATFORM_TREASURY to the owner Safe in .env.production.',
  )
} else {
  pass('PLATFORM_TREASURY is a contract', `${(treasuryCode.length - 2) / 2} bytes`)
}

// ── 2. PROD_OWNER_SAFE has code ──────────────────────────────────────────────
console.log('\n2. near-irreversible — PROD_OWNER_SAFE (holds every kill switch)')
const ownerCode = await codeOf(prodOwnerSafe)
if (ownerCode === '0x') {
  fail(
    'PROD_OWNER_SAFE has no code — it is an EOA',
    'Ownership is recoverable in principle, but a timelock on treasury curation was '
    + 'declined specifically because the owner is a 2/N Safe. A single-EOA owner lapses '
    + 'that decision and a timelock must be added immediately.',
    'Set PROD_OWNER_SAFE to the 2-of-3 Safe in .env.production.',
  )
} else {
  pass('PROD_OWNER_SAFE is a contract', `${(ownerCode.length - 2) / 2} bytes`)
}

// ── 3. The PM-C9 decision: both roles are the same Safe ──────────────────────
if (platformTreasury === prodOwnerSafe) {
  pass('PLATFORM_TREASURY == PROD_OWNER_SAFE', 'as PM-C9 decided')
} else {
  notes.push(
    'PLATFORM_TREASURY and PROD_OWNER_SAFE are different addresses. PM-C9 decided they '
    + 'are the same 2-of-3 Safe. This is not fatal and may be deliberate, but if it is '
    + 'not, one of the two is a paste error — and the treasury one is permanent. Note '
    + 'that verifyOwnerSafe.mjs below only inspects PROD_OWNER_SAFE, so a distinct '
    + 'treasury Safe is NOT deeply verified by this run.',
  )
  console.log('  note  the two roles differ — see the notes at the end')
}

// ── 4. POG_SIGNER_ADDRESS must NOT have code ─────────────────────────────────
//
// The inverse of checks 1 and 2, and a silent failure rather than a loud one.
console.log('\n3. silent-until-launch — POG_SIGNER_ADDRESS must be an EOA')
const signerCode = await codeOf(pogSigner)
if (signerCode !== '0x') {
  fail(
    'POG_SIGNER_ADDRESS is a contract',
    'registerPoG authenticates with hash.recover(signature), which can only ever yield '
    + 'an EOA. A contract address here can never match, so every registration reverts '
    + 'InvalidSignature — after launch, on every user, with a factory that looks '
    + 'perfectly healthy. setPogSigner can fix it, but only once someone works out why '
    + 'nobody can register.',
    'Set POG_SIGNER_ADDRESS to the EOA whose private key is in Vercel Production.',
  )
} else {
  pass('POG_SIGNER_ADDRESS is an EOA')
}

// ── 5. requireDistinctRoles, before the broadcast rather than during it ──────
console.log('\n4. would revert mid-broadcast — role separation')
const distinct = [
  [pogSigner !== deployer, 'POG_SIGNER_ADDRESS != deployer'],
  [prodOwnerSafe !== deployer, 'PROD_OWNER_SAFE != deployer'],
  [platformTreasury !== deployer, 'PLATFORM_TREASURY != deployer'],
  [platformTreasury !== pogSigner, 'PLATFORM_TREASURY != POG_SIGNER_ADDRESS'],
]
for (const [ok, label] of distinct) {
  if (ok) pass(label)
  else {
    fail(
      label.replace(' != ', ' equals '),
      'DeployMainnet.s.sol:requireDistinctRoles reverts on this. C1 is a single broadcast '
      + 'that deploys the factory, the hook implementation and the treasury and stages '
      + 'both ownership transfers, so hitting it there means unpicking a half-done launch.',
      'Fix the collision in .env.production before broadcasting.',
    )
  }
}

// ── 6. INFINITY_CL_POOL_MANAGER: has code, and agrees with the frontend's copy ────────
//
// contracts.ts hardcodes CL_POOL_MANAGER per chain and says why it is
// deliberately not env-bound: a wrong one hashes every PoolKey to a pool that
// was never initialised. That makes it two independent declarations of one
// address with nothing comparing them — the same shape as the mirrored-constant
// drift that checkContractConstants.ts exists for, but across the deploy env
// boundary.
console.log('\n5. silent mis-derivation — INFINITY_CL_POOL_MANAGER')
const pmCode = await codeOf(poolManager)
if (pmCode === '0x') {
  fail(
    'INFINITY_CL_POOL_MANAGER has no code on this chain',
    'Every pool this factory opens is keyed on this address. A wrong or stale value '
    + 'produces a factory whose createLaunch reverts, or worse, whose PoolKeys hash '
    + 'to a manager that does not exist.',
    'Set INFINITY_CL_POOL_MANAGER to the PancakeSwap Infinity CLPoolManager on this chain.',
  )
} else {
  pass('INFINITY_CL_POOL_MANAGER is a contract', `${(pmCode.length - 2) / 2} bytes`)

  let mirrored = null
  try {
    const src = fs.readFileSync(CONTRACTS_TS, 'utf8')
    const block = src.match(/export const CL_POOL_MANAGER[\s\S]*?infinityAddress\(\{([\s\S]*?)\}\)/)
    mirrored = block?.[1].match(/\[BSC_ID\]:\s*'(0x[0-9a-fA-F]{40})'/)?.[1]
  } catch {
    notes.push(`could not read ${path.relative(REPO, CONTRACTS_TS)} to cross-check CL_POOL_MANAGER.`)
  }
  if (mirrored && ethers.getAddress(mirrored) !== poolManager) {
    fail(
      'INFINITY_CL_POOL_MANAGER disagrees with the frontend',
      `.env.production says ${poolManager}; contracts.ts names ${ethers.getAddress(mirrored)} for chain 56. `
      + 'The frontend encodes every PoolKey against its own copy, so the two must agree or '
      + 'every deposit hashes to a pool the factory never opened. contracts.ts deliberately '
      + 'does not read this from the environment, which is what makes them two independent '
      + 'declarations with nothing comparing them until now.',
      'Make .env.production and soat-frontend/src/lib/contracts.ts name the same CLPoolManager.',
    )
  } else if (mirrored) {
    pass('matches contracts.ts CL_POOL_MANAGER for chain 56', 'frontend PoolKey derivation agrees')
  }
}

// ── 5b. INFINITY_VAULT, asked of the manager rather than of the operator ─────
//
// The two are not independent: Infinity's CLPoolManager is constructed with its
// Vault and exposes it as `vault()`. So the pair can be checked against the
// chain instead of against a document, and that is the strongest check in this
// file — it is the only one whose reference value comes from the deployment
// being deployed against rather than from something a human typed twice.
//
// It also happens to be the cleanest way to catch a Uniswap V4 PoolManager
// wearing an Infinity variable name, which is exactly what both env templates
// shipped: V4's singleton has no `vault()`, so the call reverts and this fails
// with the reason rather than with a shrug. The same confusion reached the
// rehearsal suite once already, where it survived a `code.length > 0` assertion
// because the wrong address is also a real contract.
console.log('\n5b. structural — INFINITY_VAULT is the Vault this manager settles through')
const vault = ethers.getAddress(process.env.INFINITY_VAULT)
const vaultCode = await codeOf(vault)
if (vaultCode === '0x') {
  fail(
    'INFINITY_VAULT has no code on this chain',
    'The hook, the factory and the treasury all settle through the Vault. DeployMainnet.s.sol '
    + 'requires it non-zero but cannot tell a wrong contract from the right one.',
    'Set INFINITY_VAULT to the PancakeSwap Infinity Vault on this chain.',
  )
} else {
  pass('INFINITY_VAULT is a contract', `${(vaultCode.length - 2) / 2} bytes`)

  let declared = null
  try {
    declared = await new ethers.Contract(
      poolManager, ['function vault() view returns (address)'], provider,
    ).vault()
  } catch (err) {
    fail(
      'INFINITY_CL_POOL_MANAGER does not answer vault()',
      `Called vault() on ${poolManager} and it reverted (${err.shortMessage ?? err.message}). `
      + 'Every Infinity CLPoolManager answers it. A contract at this address that does not is '
      + 'not an Infinity manager — Uniswap V4\'s PoolManager is the near miss to expect, since '
      + 'it settles internally and has no Vault, and both env templates shipped V4\'s Robinhood '
      + 'address under this exact variable name.',
      'Set INFINITY_CL_POOL_MANAGER to the PancakeSwap Infinity CLPoolManager on this chain.',
    )
  }
  if (declared && ethers.getAddress(declared) !== vault) {
    fail(
      'INFINITY_VAULT is not the Vault this manager uses',
      `${poolManager} reports vault() = ${ethers.getAddress(declared)}, but .env.production names `
      + `${vault}. The manager's own answer is authoritative; settling through any other Vault `
      + 'is settling against balances nothing credits.',
      `Set INFINITY_VAULT to ${ethers.getAddress(declared)}.`,
    )
  } else if (declared) {
    pass('the manager names this Vault itself', 'vault() agrees with .env.production')
  }
}

// ── 5c. Permanent: the asset the whole protocol is denominated in ────────────
//
// `quoteAsset` is an immutable on the factory, on the hook IMPLEMENTATION and on
// the treasury, with no setter on any of the three. Getting it wrong is not a
// revert and not a migration — it is a factory that prices every raise, fee,
// shelf and buyback in a token nobody meant, and the only remedy is deploying a
// new one and abandoning this.
//
// THE DECIMALS ARE THE LOAD-BEARING PART. The hook's constructor asserts
// `decimals() == 8`, so an 18-decimal token fails the broadcast — loudly, which
// is fine. The dangerous case is a DIFFERENT 8-decimal token: it deploys
// perfectly, and every dial then means something else by a factor nobody
// notices, because 9.28 of the wrong token is still 9.28 on screen.
console.log('\n5c. permanent — QUOTE_ASSET is the token every figure is denominated in')
const quoteAsset = ethers.getAddress(process.env.QUOTE_ASSET)
const quoteCode = await codeOf(quoteAsset)
if (quoteCode === '0x') {
  fail(
    'QUOTE_ASSET has no code on this chain',
    'DeployMainnet.s.sol requires it to hold code, so this would revert at broadcast. More to '
    + 'the point, an address with no token behind it cannot be the asset three immutable fields '
    + 'are about to be set to.',
    'Set QUOTE_ASSET to the quote token on this chain. On 56 that is BEM, '
    + '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a.',
  )
} else {
  pass('QUOTE_ASSET is a contract', `${(quoteCode.length - 2) / 2} bytes`)

  const erc20 = new ethers.Contract(quoteAsset, [
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
  ], provider)

  let decimals = null
  try {
    decimals = Number(await erc20.decimals())
  } catch (err) {
    fail(
      'QUOTE_ASSET does not answer decimals()',
      `Called decimals() on ${quoteAsset} and it reverted (${err.shortMessage ?? err.message}). `
      + 'The hook constructor calls the same function and asserts it returns 8, so this address '
      + 'cannot be deployed against whatever else it is.',
      'Set QUOTE_ASSET to an ERC-20 with 8 decimals.',
    )
  }

  if (decimals !== null && decimals !== 8) {
    fail(
      `QUOTE_ASSET has ${decimals} decimals, not 8`,
      'ToshLaunchpadHook\'s constructor requires exactly 8, so the broadcast would revert. The '
      + 'constant mirrors in soat-frontend and every scaled figure in the test suite assume 8 as '
      + 'well — this is a protocol invariant, not a property of one token.',
      'Set QUOTE_ASSET to the 8-decimal quote token for this chain.',
    )
  } else if (decimals === 8) {
    let label = ''
    try {
      const [symbol, supply] = await Promise.all([erc20.symbol(), erc20.totalSupply()])
      label = `${symbol} · supply ${ethers.formatUnits(supply, 8)}`
    } catch { label = '8 decimals' }
    pass('QUOTE_ASSET is an 8-decimal token', label)

    // Named rather than enforced. A deploy to a chain other than 56 legitimately
    // uses a different token, and on 97 it MUST, since BEM has no deployment
    // there. So this reports the disagreement and leaves the judgement with the
    // operator instead of refusing a rehearsal.
    // `targetChainId`, not `chainId` — which is what this line said until the
    // first run that ever reached it, and it threw a ReferenceError that took
    // the whole preflight down at the last check.
    //
    // Worth recording how it survived being written: every earlier run exited 2
    // at the top because `.env.production` did not exist, so check 5c had never
    // executed once. A guard that cannot run is not a guard that passes, and the
    // day it would first have run is deploy day.
    const BEM_56 = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'
    if (targetChainId === 56n && quoteAsset !== ethers.getAddress(BEM_56)) {
      notes.push(
        `QUOTE_ASSET on chain 56 is ${quoteAsset}, not BEM (${BEM_56}). Every document in this `
        + 'tree says the mainnet quote asset is BEM. If that changed, the docs are now wrong; if '
        + 'it did not, this is the one value you cannot fix after broadcast.',
      )
    }
  }
}

// ── 7. Recoverable, so last: can the deployer pay for the broadcast ──────────
//
// Not a threshold anyone picked. The chain-97 rehearsal broadcast is on disk
// with per-transaction receipts, so the requirement is measured and then priced
// at the live gas price. An arbitrary "at least 0.01 BNB" would have been a
// number with no argument behind it, and on a chain whose gas price moves it
// would be wrong in both directions.
console.log('\n6. recoverable — can the deployer actually pay for C1')
const balance = await provider.getBalance(deployer)

// Sum of broadcast/Deploy.s.sol/97/run-latest.json, which deployed the same three
// contracts against the Infinity manager and Vault. A fallback only: the live sum
// below is preferred, and this exists so the check still has a basis if the
// broadcast directory is absent or pruned.
//
// ⚠ THE FALLBACK MUST NEVER UNDERSTATE, because understating is the direction that
//   greenlights an underfunded deployer, and this constant has been wrong in that
//   direction twice.
//
//   First it was 14_580_627, transcribed from the 46630 rehearsal and already
//   stale against its own source (that file sums to 15_143_081). The BSC port then
//   replaced it with 9_550_629, described as "about a third lower" because Infinity
//   reads hook permissions from a bitmap instead of mining an address. That
//   reasoning was sound and the number was not: no broadcast in this tree sums to
//   9_550_629, and the actual 97 deploy — same script, same three contracts, same
//   Infinity manager — sums to 15_236_814. The saving from not mining an address
//   did not materialise. 9_550_629 understated the real cost by 37 %.
//
//   So this is now a re-summed measurement rather than an adjusted estimate. When
//   the contracts change, the live sum below picks it up; if you ever have to
//   update this literal by hand, re-sum a receipt file rather than reasoning about
//   a delta.
const C1_REHEARSED_GAS = 15_236_814n
let requiredGas = C1_REHEARSED_GAS
const REHEARSAL = path.join(REPO, 'broadcast', 'Deploy.s.sol', '97', 'run-latest.json')
try {
  const receipts = JSON.parse(fs.readFileSync(REHEARSAL, 'utf8')).receipts ?? []
  const summed = receipts.reduce((a, r) => a + BigInt(r.gasUsed), 0n)
  if (summed > 0n) requiredGas = summed
} catch {
  notes.push(
    `could not read ${path.relative(REPO, REHEARSAL)}; priced C1 from the recorded `
    + `${C1_REHEARSED_GAS} gas instead of re-summing the rehearsal receipts.`,
  )
}

const feeData = await provider.getFeeData()
const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas
if (!gasPrice) {
  notes.push('the RPC returned no gas price, so affordability was not checked.')
} else {
  const need = requiredGas * gasPrice
  console.log(`        C1 measured at ${requiredGas} gas (rehearsal), priced at `
    + `${ethers.formatUnits(gasPrice, 'gwei')} gwei`)
  console.log(`        needs ~${ethers.formatEther(need)} BNB, deployer holds `
    + `${ethers.formatEther(balance)} BNB`)

  // DeployMainnet does slightly more than the rehearsal it is priced from — it
  // also stages two ownership transfers — and the gas price read here is a
  // single sample. Hence a margin rather than a bare comparison.
  //
  // ⚠ THE MARGIN USED TO BE `need * 2`, AND A RELATIVE MARGIN COLLAPSES EXACTLY
  //   WHEN SPOT IS AT THE FLOOR. BSC validators moved to 0.05 gwei, so 2x of
  //   spot is 0.1 gwei — a margin against a 2x move, on a chain whose ordinary
  //   price was 1 gwei until recently and still reaches it under load. At the
  //   time this was written the deployer held 0.0130 BNB and passed "over 2x"
  //   with 17x of headroom, while needing 0.0151 BNB at 1 gwei: comfortably
  //   green, and short by a fifth if the network got busy before the broadcast.
  //
  //   So the margin is now the greater of 2x spot and a stress price. 1 gwei is
  //   not a guess: it was BSC's network minimum before the 2024-25 reductions,
  //   it is what most wallets still default to, and it is the level congestion
  //   returns to rather than a tail. Pricing against it costs the operator a
  //   few cents of idle BNB and buys the one thing this check exists for, which
  //   is not being half-deployed.
  const STRESS_GAS_PRICE = ethers.parseUnits('1', 'gwei')
  const stressPrice = gasPrice * 2n > STRESS_GAS_PRICE ? gasPrice * 2n : STRESS_GAS_PRICE
  const wantMargin = requiredGas * stressPrice

  if (balance < need) {
    fail(
      `deployer cannot afford C1 — holds ${ethers.formatEther(balance)} BNB, needs ~${ethers.formatEther(need)} BNB`,
      `That is ${(balance * 100n) / need} % of the requirement, short by `
      + `${ethers.formatEther(need - balance)} BNB. C1 is a single broadcast that deploys `
      + 'HookDeployLib, the treasury and the factory and then wires them together; the '
      + 'factory alone was 7.95 M gas in rehearsal. A broadcast that runs out of gas '
      + 'part-way leaves exactly the half-deployed platform this script exists to prevent, '
      + 'with some contracts live and unowned.',
      `Fund ${deployer} with at least ${ethers.formatEther(wantMargin - balance)} BNB more `
      + `(${requiredGas} gas at ${ethers.formatUnits(stressPrice, 'gwei')} gwei, so a gas-price `
      + 'move between this check and the broadcast does not strand it).',
    )
  } else if (balance < wantMargin) {
    notes.push(
      `deployer holds ${ethers.formatEther(balance)} BNB, which covers C1 at the current `
      + `${ethers.formatUnits(gasPrice, 'gwei')} gwei but NOT at ${ethers.formatUnits(stressPrice, 'gwei')} gwei, `
      + `where the same ${requiredGas} gas costs ${ethers.formatEther(wantMargin)} BNB. `
      + `Top up by ${ethers.formatEther(wantMargin - balance)} BNB. The price above is one `
      + 'sample taken at a historic low; BSC ran at 1 gwei until recently and returns there '
      + 'under load, and a broadcast that runs dry part-way leaves the half-deployed platform '
      + 'this script exists to prevent.',
    )
    pass('deployer can afford C1 at spot', 'but not at the stress price — see notes')
  } else {
    pass('deployer can afford C1',
      `${ethers.formatEther(balance)} BNB, covers ${requiredGas} gas at `
      + `${ethers.formatUnits(stressPrice, 'gwei')} gwei`)
  }
}

// ── 8. Delegate the deep Safe verification to the script that owns it ────────
//
// Deliberately a subprocess against the address THE FILE names, not a
// reimplementation: verifyOwnerSafe.mjs already checks 2-of-3, the agreed owner
// set, the fallback handler, SafeL2 indexing and that plain BNB is accepted.
// Re-running it here is what turns "the Safe we blessed" into "the Safe we are
// about to deploy against".
console.log('\n7. deep Safe verification, delegated to verifyOwnerSafe.mjs')
console.log(`   (against PROD_OWNER_SAFE as written in .env.production: ${prodOwnerSafe})\n`)
const sub = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'verifyOwnerSafe.mjs'), prodOwnerSafe], {
  cwd: REPO,
  encoding: 'utf8',
})
const subOut = (sub.stdout || '') + (sub.stderr || '')
console.log(subOut.split(/\r?\n/).map(l => (l ? '   │ ' + l : '   │')).join('\n'))
if (sub.status === null) {
  notes.push(`verifyOwnerSafe.mjs did not run to completion (${sub.error?.message ?? 'unknown'}).`)
} else if (sub.status === 2) {
  // Exit 2 is "could not determine", not "the Safe is unfit". Flattening it into
  // "rejected" is the same misdiagnosis verifyOwnerSafe.mjs itself was just
  // fixed for: an error on the probe, reported as a property of the recipient.
  const why = 'It exited 2 — a guard that cannot run, not a finding that the Safe is unfit. '
    + 'Its output is printed above.'
  const fix = 'Resolve whatever blocked it (typically an unfunded probe sender on an RPC that '
    + 'will not honour eth_estimateGas state overrides) and re-run. Do not rotate '
    + 'PLATFORM_TREASURY on this basis.'
  if (failures.length) {
    fail(
      'verifyOwnerSafe.mjs could not determine a required property of PROD_OWNER_SAFE',
      why,
      fix,
    )
  } else {
    cannotRun(
      'verifyOwnerSafe.mjs could not determine a required property of PROD_OWNER_SAFE (exit 2).\n'
      + '            A guard that cannot run must not be mistaken for one that found nothing,\n'
      + '            and must not be mistaken for one that found a problem. Output is printed above.',
    )
  }
} else if (sub.status !== 0) {
  fail(
    'verifyOwnerSafe.mjs rejected PROD_OWNER_SAFE',
    'Its findings are printed above. It is the authority on the Safe itself; this script '
    + 'only established that .env.production points at it.',
    'Resolve every point it lists, then re-run this preflight.',
  )
} else {
  pass('verifyOwnerSafe.mjs accepted the Safe named in .env.production')
}

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(74))
for (const n of notes) console.log(`\nnote: ${n}`)

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed. DO NOT BROADCAST C1.\n`)
  for (const f of failures) {
    console.error(`  · ${f.what}`)
    console.error(`      why: ${f.why}`)
    console.error(`      fix: ${f.fix}\n`)
  }
  process.exit(1)
}

console.log('\n✓ clear for C1.')
console.log('  Still not covered by any pre-broadcast check, because they are only')
console.log('  observable afterwards: that the PoG signer KEY in Vercel matches')
console.log('  POG_SIGNER_ADDRESS above (PM-C7), and the status page CHAIN block')
console.log('  (checkStatusPage.mjs, which arms itself once broadcast/*/56/ exists).')
