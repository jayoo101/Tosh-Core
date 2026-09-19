#!/usr/bin/env node
/**
 * checkQuoteAsset.mjs — does the app approve the token the factory actually pulls?
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ONE QUESTION. `NEXT_PUBLIC_QUOTE_ASSET` tells the frontend which token to read
 * balances on, which allowance to grant, and which address to put in `currency0`
 * of every `PoolKey` it encodes. The factory, the hook implementation and the
 * treasury each hold the answer as an immutable with no setter. This asks whether
 * the two agree.
 *
 * WHY IT NEEDS ASKING. A mismatch has no symptom at the point of the mistake. The
 * balance read succeeds — every ERC-20 answers `balanceOf` — so the panel shows a
 * plausible figure. The approve succeeds, because approving a token you will never
 * spend is a valid transaction. The button enables. Then `deposit` reverts inside
 * `transferFrom` on a token the user was never asked about, and the revert names
 * the factory rather than the misconfiguration. Nothing between the env var and
 * that revert can tell the difference, which is why this is a guard and not a
 * runtime check.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not fall back to a default when the
 * env var is missing, because `contracts.ts` refuses to boot without it and this
 * guard exists to check that decision rather than to paper over it. It also does
 * not accept a factory that has no `quoteAsset()`: a factory predating the
 * quote-asset migration is a real finding, and the correct output is to say so.
 *
 * WHY `check:quote` AND NOT PART OF `npm run guards`. The `guard:*` scripts are
 * offline and run in CI on every push; the `check:*` ones reach the network and are
 * run against a deployment deliberately. This belongs in the second group, and not
 * only because it makes RPC calls: what it reports is the state of a DEPLOYMENT, so
 * a red result here is a fact about the chain rather than a defect in the tree, and
 * putting it on the push path would block merges on something no commit can fix.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXIT CODES
 *   0  the app, the factory, the hook implementation and the treasury agree
 *   1  they disagree, or the token is not an 8-decimal ERC-20
 *   2  the check could not run (no RPC, unreachable chain)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, getAddress } from 'viem'
import { CheckFailed, installFailureExit } from './lib/checkExit.mjs'

installFailureExit()

/**
 * Report, then stop. `CheckFailed` carries the exit code and nothing else —
 * `installFailureExit` deliberately does not print its message, so a guard that
 * only throws exits non-zero with an empty console and reads as a crash.
 *
 * @param {string} message what was found
 * @param {number} [code]  1 = found a problem, 2 = could not run
 */
function fail(message, code = 1) {
  console.log(`\nFAIL  ${message}`)
  throw new CheckFailed(message, code)
}

/**
 * Exit 2, kept separate from `fail` at the call site rather than as an argument.
 *
 * "The check could not run" and "the check found a problem" are different answers
 * and a caller that cannot tell them apart will treat an unreachable RPC as
 * evidence of a misconfigured deployment.
 */
function failCouldNotRun(message) {
  console.log(`\nSKIP  ${message}`)
  throw new CheckFailed(message, 2)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.resolve(HERE, '..')
const REPO = path.resolve(FRONTEND, '..')

/** Minimal dotenv: `KEY=value`, no interpolation, no export syntax. */
function parseDotenv(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return out
}

/*
 * `.env.local` before `.env.production`, matching Next's own precedence for a
 * local dev run. The process environment beats both, so a CI job that exports a
 * value still wins — otherwise this guard would check a developer's file rather
 * than the deployment under test.
 */
const fileEnv = {
  ...parseDotenv(path.join(FRONTEND, '.env.production')),
  ...parseDotenv(path.join(FRONTEND, '.env.local')),
}
const env = key => process.env[key] || fileEnv[key]

const factoryAddress = env('NEXT_PUBLIC_FACTORY_ADDRESS')
const declared = env('NEXT_PUBLIC_QUOTE_ASSET')
const chainId = Number(env('NEXT_PUBLIC_CHAIN_ID') ?? 97)

if (!declared) {
  fail(
    'NEXT_PUBLIC_QUOTE_ASSET is not set. It has no default in source on purpose: a ' +
    'default would let the app approve one token while the factory pulls another.',
  )
}
if (!factoryAddress) {
  fail('NEXT_PUBLIC_FACTORY_ADDRESS is not set, so there is nothing to reconcile against.')
}

/*
 * RPC, in the order that puts capability first. The root `.env` names the keyed
 * endpoints; the public dataseed is a last resort and is enough for this check,
 * which makes four `eth_call`s and reads no logs.
 */
const rootEnv = parseDotenv(path.join(REPO, '.env'))
const rpc =
  process.env.QUOTE_CHECK_RPC
  || (chainId === 97 ? rootEnv.BSC_TESTNET_RPC : rootEnv.BSC_RPC)
  || rootEnv.MONITOR_RPC
  || (chainId === 97
    ? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
    : 'https://bsc-dataseed1.bnbchain.org')

// viem, not ethers: this package ships viem and has no ethers dependency, and a
// guard that needs an install step is a guard that stops being run.
const client = createPublicClient({ transport: http(rpc) })

const fn = (name, outputs) => ({
  type: 'function', name, stateMutability: 'view', inputs: [], outputs,
})
const QUOTE_ASSET_FN = fn('quoteAsset', [{ type: 'address' }])
const FACTORY_ABI = [
  QUOTE_ASSET_FN,
  fn('hookImplementation', [{ type: 'address' }]),
  fn('ladderTreasury', [{ type: 'address' }]),
]
const ERC20_ABI = [
  fn('decimals', [{ type: 'uint8' }]),
  fn('symbol', [{ type: 'string' }]),
]

const read = (address, abi, functionName) =>
  client.readContract({ address: getAddress(address), abi, functionName })

let failures = 0
const report = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (detail) console.log(`        ${detail}`)
  if (!ok) failures++
}

const served = await client.getChainId().catch(err => {
  failCouldNotRun(
    `could not reach ${rpc}: ${err.shortMessage ?? err.message}. Set QUOTE_CHECK_RPC to ` +
    'a working endpoint for this chain.',
  )
})
if (served !== chainId) {
  failCouldNotRun(
    `the RPC serves chain ${served} but NEXT_PUBLIC_CHAIN_ID says ${chainId}. ` +
    'Reconciling an address against the wrong chain would be worse than not checking.',
  )
}

console.log(`\nchain ${chainId} · factory ${factoryAddress}`)
console.log(`declared quote asset: ${declared}\n`)

let onChainQuote
try {
  onChainQuote = await read(factoryAddress, FACTORY_ABI, 'quoteAsset')
} catch {
  /*
   * A revert here is not an RPC fault and is not ambiguous: `quoteAsset()` is a
   * public immutable, so it answers on any factory that has one. A revert means
   * this deployment predates the quote asset entirely — its `deposit` is payable
   * and takes two arguments where the current one takes three, and its
   * `mintBondingCurve` takes one where the current one takes two. The frontend
   * cannot talk to it at all, and naming the redeploy is the useful output.
   */
  fail(
    `the factory at ${factoryAddress} has no quoteAsset(): the call reverts. This is a ` +
    'deployment from before the protocol was denominated in a quote asset, so its money ' +
    'paths have different signatures and this frontend cannot drive it. Chain ' +
    `${chainId} needs redeploying before NEXT_PUBLIC_QUOTE_ASSET can be correct.`,
  )
}

report(
  onChainQuote.toLowerCase() === declared.toLowerCase(),
  'factory.quoteAsset() == NEXT_PUBLIC_QUOTE_ASSET',
  onChainQuote.toLowerCase() === declared.toLowerCase()
    ? undefined
    : `factory pulls ${onChainQuote}, app would approve ${declared}`,
)

/*
 * The other two holders. They are wired in the same construction call as the
 * factory, so disagreement should be impossible — which is exactly why it is worth
 * a read: an "impossible" mismatch here means the deploy script was changed to wire
 * them separately, and that is a change nothing else would catch.
 */
for (const [label, getterName] of [
  ['hook implementation', 'hookImplementation'],
  ['ladder treasury', 'ladderTreasury'],
]) {
  try {
    const holder = await read(factoryAddress, FACTORY_ABI, getterName)
    const theirs = await read(holder, [QUOTE_ASSET_FN], 'quoteAsset')
    report(
      theirs.toLowerCase() === onChainQuote.toLowerCase(),
      `${label} settles the same token`,
      theirs.toLowerCase() === onChainQuote.toLowerCase()
        ? `${holder}`
        : `${holder} holds ${theirs}, factory holds ${onChainQuote}`,
    )
  } catch (err) {
    report(false, `${label} could not be read`, err.shortMessage ?? err.message)
  }
}

/*
 * Eight decimals is a protocol invariant, not a property of one token: the hook's
 * constructor asserts it and refuses to deploy against anything else. Checked here
 * because the frontend mirrors the number as a constant, and a mirror that drifts
 * misreads every amount by whatever the gap is.
 */
try {
  const decimals = Number(await read(onChainQuote, ERC20_ABI, 'decimals'))
  const symbol = await read(onChainQuote, ERC20_ABI, 'symbol').catch(() => '?')
  report(decimals === 8, 'quote asset has 8 decimals', `${symbol} · decimals ${decimals}`)

  const declaredSymbol = env('NEXT_PUBLIC_QUOTE_SYMBOL')
  if (declaredSymbol && declaredSymbol !== symbol) {
    // Not a failure. The label is deliberately env-driven so a testnet stand-in is
    // not called BEM, and a ticker that differs from the token's own is often the
    // honest choice rather than a mistake. Worth printing, not worth blocking.
    console.log(
      `  note  display symbol is "${declaredSymbol}" while the token reports "${symbol}" — ` +
      'deliberate if this chain runs a stand-in token, a typo otherwise',
    )
  }
} catch (err) {
  report(false, 'quote asset is not a readable ERC-20', err.shortMessage ?? err.message)
}

if (failures > 0) {
  fail(
    `${failures} mismatch(es). The app would authorise a token the protocol does not pull, ` +
    'which fails at deposit time rather than at approve time.',
  )
}

console.log('\nThe app, the factory, the hook implementation and the treasury agree.')
