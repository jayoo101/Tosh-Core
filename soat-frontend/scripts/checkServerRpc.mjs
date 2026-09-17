/**
 * Guard: nothing may choose an RPC endpoint without saying which chain it is
 * for.
 *
 * Four server modules independently picked their own endpoint, and all four
 * had the same shape:
 *
 *     process.env.BASE_SEPOLIA_RPC
 *       ?? process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC
 *       ?? 'https://sepolia.base.org'
 *
 * paired with `createPublicClient({ chain: targetChain, ... })`. The chain and
 * the transport were chosen by different expressions, so nothing kept them
 * describing the same network. A mainnet build that never set an RPC landed on
 * the hardcoded Sepolia default; a `BASE_SEPOLIA_RPC` left over in the deploy
 * shell did the same, and Next's loader does not override an already-present
 * variable, so `.env.production` lost that race in silence.
 *
 * Why a source guard rather than a test: every one of these reads its value at
 * MODULE LOAD from the ambient environment, so a test can only ever observe the
 * environment the test runner happens to have. The property that matters is
 * about the source text — that no expression can yield an endpoint for a chain
 * other than the one it was asked about — and that is checkable here and
 * nowhere else.
 *
 * What it cost when it was wrong: `POST /api/projects` authenticates a
 * directory listing by reading the launch's receipt and trusting the
 * `LaunchCreated` creator inside it. Read on the wrong chain, a launch minted
 * on free Sepolia authenticates a listing in the mainnet directory — the caller
 * really is that launch's creator and the signature really does verify, so
 * every check downstream passes on a forged row.
 *
 *   A. Chain-named env vars (`BASE_SEPOLIA_RPC`, `LOCAL_RPC`, …) may only be
 *      read in files that scope them to that chain. Two do, and they are named
 *      below; anywhere else the name is a promise the code cannot keep.
 *
 *   B. Hardcoded endpoint literals may only appear in those same files, where
 *      they sit in a chain-id-keyed table. Elsewhere a bare URL is a default
 *      that some other chain will eventually inherit.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { blankComments } from './lib/blankComments.mjs'

const SRC = 'src'
const EXTS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'])

/**
 * The only two places allowed to name a chain's endpoint.
 *
 * `serverRpc.ts` keys everything by chain id, and `providers.tsx` builds the
 * browser transports behind explicit `targetChain.id === …` tests. Adding to
 * this list means taking on that same obligation.
 */
const ALLOWED = new Set([
  join('src', 'app', 'lib', 'serverRpc.ts'),
  join('src', 'app', 'providers.tsx'),
])

/**
 * Env vars whose NAME commits them to one chain.
 *
 * The retired Base names stay on this list. They are no longer read anywhere,
 * which is exactly why they are worth keeping: a variable that has fallen out
 * of the resolver but survives in someone's shell or deploy config is the most
 * likely way this class of bug comes back, and the guard costs nothing to keep
 * pointed at it.
 */
const CHAIN_SCOPED_ENV = [
  'ROBINHOOD_RPC',
  'NEXT_PUBLIC_ROBINHOOD_RPC',
  'ROBINHOOD_TESTNET_RPC',
  'NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC',
  'BASE_SEPOLIA_RPC',
  'NEXT_PUBLIC_BASE_SEPOLIA_RPC',
  'LOCAL_RPC',
  'NEXT_PUBLIC_FOUNDRY_RPC',
]

/** Endpoint literals that belong to exactly one chain. */
const ENDPOINT_LITERALS = [
  'bsc-dataseed1.bnbchain.org',
  'data-seed-prebsc-1-s1.bnbchain.org',
  'sepolia.base.org',
  'mainnet.base.org',
  'eth.llamarpc.com',
  '127.0.0.1:8545',
  'localhost:8545',
]

/** `foo.test.ts` — never bundled, so it cannot ship a wrong endpoint. */
const isTest = (name) => /\.test\.[cm]?[jt]sx?$/.test(name)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    // Tests are excluded because they assert on these very literals: the
    // regression test for this bug has to name the endpoint it expects. A test
    // is not a module that chooses an endpoint — nothing imports it — so the
    // property this guard protects does not apply to it.
    else if (EXTS.has(name.slice(name.lastIndexOf('.'))) && !isTest(name)) out.push(p)
  }
  return out
}

let failures = 0
const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`) }

const files = walk(SRC)
const code = new Map(files.map((f) => [f, blankComments(readFileSync(f, 'utf8'))]))

function scan(label, needles, describe) {
  let hits = 0
  for (const [file, text] of code) {
    const rel = relative('.', file)
    if (ALLOWED.has(rel.split('/').join(sep))) continue
    text.split('\n').forEach((line, i) => {
      for (const needle of needles) {
        if (!line.includes(needle)) continue
        hits++
        fail(`${rel}:${i + 1} ${describe(needle)}\n        ${line.trim()}`)
      }
    })
  }
  if (hits === 0) console.log(`${label} — ok`)
  return hits
}

scan(
  'A. no chain-named RPC env var read outside the chain-scoped resolvers',
  CHAIN_SCOPED_ENV.map((v) => `process.env.${v}`),
  (n) =>
    `reads ${n.replace('process.env.', '')}, which names one chain, outside a ` +
    'chain-scoped resolver — on any other target chain that value is stale ' +
    'configuration, not an override. Use serverRpcUrl()/serverPublicClient().',
)

scan(
  'B. no hardcoded RPC endpoint outside the chain-scoped resolvers',
  ENDPOINT_LITERALS,
  (n) =>
    `hardcodes the endpoint ${n} — a bare default is inherited by whichever ` +
    'chain the build happens to target. Add it to PUBLIC_FALLBACK in ' +
    'app/lib/serverRpc.ts, keyed by chain id.',
)

// The allowlist is only meaningful if the file it points at still exists;
// a rename would otherwise silently turn this guard off.
for (const rel of ALLOWED) {
  try {
    statSync(rel)
  } catch {
    fail(`allowlisted ${rel} does not exist — update ALLOWED in this guard`)
  }
}

console.log(
  failures === 0
    ? '\nEvery RPC endpoint is chosen against an explicit chain id.'
    : `\n${failures} failure(s) — see FAIL lines above.`,
)
process.exit(failures === 0 ? 0 : 1)
