/**
 * Guard: the chain a build targets and the contract addresses it carries must
 * belong to the same chain.
 *
 * PM-C7 shipped a production deployment that was half cut over. The operator
 * set `NEXT_PUBLIC_FACTORY_ADDRESS` and `NEXT_PUBLIC_TREASURY_ADDRESS` to the
 * canonical mainnet contracts and left `NEXT_PUBLIC_CHAIN_ID` at 46630, so the
 * live site pointed a testnet wallet connection at addresses that exist only on
 * 4663. On 46630 the mainnet factory has no code at all: every read returned
 * empty, the directory rendered nothing, and a `createLaunch` with ETH attached
 * would have gone to a codeless address and been swallowed.
 *
 * Nothing in the repository could have caught it:
 *
 *   - `contracts.ts` validates the factory address is not in the precompile
 *     range, which is a check that the value is SHAPED like an address. It does
 *     not ask which chain it lives on, and the address is not chain-keyed —
 *     it is read straight out of the environment, independently of the id.
 *   - `checkPublicEnv.mjs` proves each variable is statically READ by the
 *     build. Both of these were read correctly. It says nothing about values.
 *   - `chain.ts` throws on an id it does not know. 46630 is one it knows.
 *   - `next build` has no opinion, and the values are gone by runtime anyway:
 *     `NEXT_PUBLIC_*` is inlined at build time, which is also why setting the
 *     variable in the Vercel panel and not redeploying changes nothing.
 *
 * The mistake was found by hand, reading address literals out of a minified
 * chunk. That is not a control, hence this file.
 *
 * TWO MODES, because the failure did not live in a file
 * ─────────────────────────────────────────────────────
 * The local dotenv files were correct and `.env.production.example` already
 * said `NEXT_PUBLIC_CHAIN_ID=4663`. The wrong value existed only in a hosting
 * panel and only in the artifact it produced. A guard that reads dotenv would
 * have reported green through the whole incident.
 *
 *   STATIC (default, hermetic, safe for CI)
 *     Checks the dotenv files present in this directory. Cheap, and it catches
 *     the mistake before it ships — but see above for what it cannot see.
 *
 *   LIVE (`--url https://…`, needs network)
 *     Reads what a deployment actually serves. This is the arm that proves a
 *     cutover, and the only one that would have failed on PM-C7.
 *
 * COHERENCE, NOT "MUST BE MAINNET"
 * ────────────────────────────────
 * The invariant is that the id and the addresses agree, not that they are any
 * particular chain. A developer's `.env.local` holding 46630 with the two 46630
 * contracts is correct and must pass, or the guard gets disabled within a week.
 *
 * Deliberately asymmetric about addresses it does not recognise:
 *
 *   - A known deployment on a DIFFERENT chain than declared is a hard failure.
 *     There is no reading of that which is intended.
 *   - An address absent from `broadcast/` is reported and not failed. A fresh
 *     deployment whose broadcast log is not committed yet is a normal state,
 *     and failing it would make the guard lie about a situation it cannot
 *     actually assess.
 *
 * Any inability to extract the values in live mode is a FAILURE, never a pass.
 * A guard whose parser silently finds nothing reports green on a build it never
 * looked at, which is the shape of bug this repository keeps paying for.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename, dirname, relative } from 'node:path'
import { installFailureExit } from './lib/checkExit.mjs'

// Registered before the first await, which is what makes it useful: the live
// arm's `fetch` calls are not individually guarded, so a DNS failure or a reset
// connection escapes module evaluation with sockets still open — and Node's own
// fatal path calls `exit` from there, which is the crash described in
// `lib/checkExit.mjs`. This turns that into `exit 1` with a printed stack.
installFailureExit()

const BROADCAST = join('..', 'broadcast')
const TRACKED = new Set(['ToshFactory', 'ToshLadderTreasury'])

/** Env keys that name a contract, mapped to the artifact that should be there. */
const ADDRESS_KEYS = {
  NEXT_PUBLIC_FACTORY_ADDRESS: 'ToshFactory',
  NEXT_PUBLIC_TREASURY_ADDRESS: 'ToshLadderTreasury',
  NEXT_PUBLIC_LADDER_TREASURY: 'ToshLadderTreasury',
}

let failures = 0
const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`) }
const note = (msg) => console.log(`      ${msg}`)

// ── The address → chain index, read off Foundry's own logs ──────────────────
// `broadcast/<script>/<chainId>/run-latest.json`, with dry-runs one level
// deeper. Dry-run addresses are included: they were never mined, but they are
// still an honest statement that THIS address belongs to THAT chain, which is
// the only claim this index makes.
function buildIndex() {
  const byAddress = new Map()
  const byChain = new Map()

  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (name !== 'run-latest.json') continue

      const parts = p.split(/[\\/]/)
      const dry = parts.includes('dry-run')
      const chainId = Number(basename(dry ? dirname(dirname(p)) : dirname(p)))
      if (!Number.isFinite(chainId)) continue

      let log
      try { log = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }

      for (const tx of log.transactions ?? []) {
        if (!tx.contractName || !TRACKED.has(tx.contractName) || !tx.contractAddress) continue
        const addr = tx.contractAddress.toLowerCase()
        if (!byAddress.has(addr)) {
          byAddress.set(addr, { chainId, name: tx.contractName, dry })
        }
        // First-wins would be wrong here. `byChain` is what the failure
        // message tells an operator to use instead, and directory order put
        // the 46630 dry-run ahead of the real one — so the guard's own advice
        // named two addresses that were never mined. A mined deployment
        // outranks a simulated one for the same contract on the same chain.
        if (!byChain.has(chainId)) byChain.set(chainId, new Map())
        const held = byChain.get(chainId).get(tx.contractName)
        if (!held || (held.dry && !dry)) {
          byChain.get(chainId).set(tx.contractName, { addr, dry })
        }
      }
    }
  }

  if (!existsSync(BROADCAST)) {
    fail(`${BROADCAST} does not exist — this guard cannot attribute any address to any chain`)
    return { byAddress, byChain }
  }
  walk(BROADCAST)

  if (byAddress.size === 0) {
    fail(`no ToshFactory / ToshLadderTreasury address found under ${BROADCAST} — the parser or the logs are wrong`)
  }
  return { byAddress, byChain }
}

const { byAddress, byChain } = buildIndex()

console.log(`Address index: ${byAddress.size} deployment(s) across chain(s) ${[...byChain.keys()].sort((a, b) => a - b).join(', ')}\n`)

/**
 * The shared verdict. Takes a declared chain id and the addresses a build
 * carries, and reports every disagreement.
 */
function assertCoherent(label, chainId, addresses) {
  let bad = 0

  if (!Number.isFinite(chainId)) {
    fail(`${label}: could not determine the target chain id`)
    return
  }

  const expected = byChain.get(chainId)
  console.log(`  chain id        ${chainId}${expected ? '' : '   (no deployment recorded for this chain)'}`)

  for (const [key, addr] of Object.entries(addresses)) {
    const want = ADDRESS_KEYS[key]
    const known = byAddress.get(addr.toLowerCase())

    if (!known) {
      console.log(`  ${key.padEnd(30)} ${addr}   unknown to broadcast/ — not asserted`)
      continue
    }
    if (known.chainId !== chainId) {
      bad++
      fail(
        `${label}: ${key} is ${addr}, which broadcast/ records as the ` +
        `${known.name} on chain ${known.chainId}${known.dry ? ' (dry-run)' : ''} — ` +
        `but this build targets chain ${chainId}.\n` +
        `        On chain ${chainId} that address is ` +
        (expected?.get(want)
          ? `not the ${want}; the recorded one is ${expected.get(want).addr}` +
            `${expected.get(want).dry ? ' (dry-run only — never mined, so treat it as unverified)' : ''}.`
          : 'not a recorded deployment at all.'),
      )
      continue
    }
    if (known.name !== want) {
      bad++
      fail(`${label}: ${key} is ${addr}, which is the ${known.name}, not the ${want}`)
      continue
    }
    console.log(`  ${key.padEnd(30)} ${addr}   ok  (${known.name} on ${known.chainId})`)
  }

  if (bad === 0) console.log(`  → coherent\n`)
  else console.log('')
}

// ── Static mode ─────────────────────────────────────────────────────────────
function parseDotenv(text) {
  const out = {}
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) continue
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

function checkStatic(files) {
  for (const file of files) {
    console.log(`${file}`)
    const env = parseDotenv(readFileSync(file, 'utf8'))

    const raw = env.NEXT_PUBLIC_CHAIN_ID
    if (raw === undefined) {
      // The default lives in `chain.ts` (46630) and applies here too, so an
      // absent id is a real configuration, not a gap.
      console.log('  chain id        (unset — chain.ts defaults to 46630)')
    }
    const chainId = raw === undefined ? 46630 : Number(raw)

    const addresses = {}
    for (const key of Object.keys(ADDRESS_KEYS)) {
      const v = env[key]
      if (v && /^0x[0-9a-fA-F]{40}$/.test(v)) addresses[key] = v
    }

    if (Object.keys(addresses).length === 0) {
      console.log('  no contract address set — nothing to cross-check\n')
      continue
    }
    assertCoherent(relative('.', file), chainId, addresses)
  }
}

/**
 * The ambient environment, which is how the builds that matter are actually
 * configured. Neither CI nor Vercel uses a dotenv file: CI sets job-level `env:`
 * and Vercel injects panel values, so a guard that reads only `.env*` is blind
 * to both. Run as a build step this is the arm that would have failed PM-C7
 * before it deployed, instead of after.
 *
 * CI's own values pass, and should: the factory there is deliberately
 * `0x1111…1111` rather than a real deployment, so it is unrecognised and not
 * asserted. What it would catch is a real address paired with the wrong id.
 */
function checkAmbient() {
  const addresses = {}
  for (const key of Object.keys(ADDRESS_KEYS)) {
    const v = process.env[key]
    if (v && /^0x[0-9a-fA-F]{40}$/.test(v.trim())) addresses[key] = v.trim()
  }
  if (Object.keys(addresses).length === 0) return false

  console.log('process.env (ambient)')
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID
  if (raw === undefined) console.log('  chain id        (unset — chain.ts defaults to 46630)')
  assertCoherent('process.env', raw === undefined ? 46630 : Number(raw), addresses)
  return true
}

// ── Live mode ───────────────────────────────────────────────────────────────
const KNOWN_IDS = new Set([...byChain.keys(), 31337])

async function checkLive(base) {
  const origin = base.replace(/\/+$/, '')
  console.log(`${origin}`)

  const html = await (await fetch(origin + '/')).text()

  // `CHAIN_STATUS_BADGE` is build-time copy derived from the same id, so it is
  // an independent witness. Used to corroborate the number scraped below, not
  // to replace it: two agreeing extractions make a silent wrong answer far
  // less likely than either alone.
  const badge =
    /MAINNET\s*[·\u00b7]/.test(html) ? 'mainnet'
    : /TESTNET\s*[·\u00b7]/.test(html) ? 'testnet'
    : /DEVNET\s*[·\u00b7]/.test(html) ? 'devnet'
    : undefined

  const chunks = [...new Set(
    [...html.matchAll(/(?:src="|")(\/_next\/static\/[^"]+\.js)/g)].map((m) => m[1]),
  )]
  if (chunks.length === 0) {
    fail(`${origin}: no /_next/static/*.js referenced by the document — cannot inspect this build`)
    return
  }

  let js = ''
  for (const c of chunks) {
    const r = await fetch(origin + c)
    if (r.ok) js += await r.text()
  }
  console.log(`  scanned         ${chunks.length} chunk(s), ${js.length} bytes; badge says ${badge ?? 'nothing recognisable'}`)

  // `parseChainId()` compiles to `Number("<value>")` because Next.js inlines
  // the variable as a string literal. Intersected with the ids this build
  // could plausibly target so an unrelated `Number("…")` cannot be mistaken
  // for the answer.
  const candidates = [...new Set(
    [...js.matchAll(/Number\(\s*"(\d{2,7})"\s*\)/g)].map((m) => Number(m[1])),
  )].filter((n) => KNOWN_IDS.has(n))

  if (candidates.length !== 1) {
    fail(
      `${origin}: could not read NEXT_PUBLIC_CHAIN_ID out of the bundle ` +
      `(${candidates.length === 0 ? 'no candidate' : 'ambiguous: ' + candidates.join(', ')}). ` +
      `The minifier's output shape probably changed — fix this parser rather than trusting the build.`,
    )
    return
  }
  const chainId = candidates[0]

  if (badge === undefined) {
    fail(`${origin}: no chain badge in the served HTML — the second witness is missing, so the id above is unconfirmed`)
  } else {
    const expected = chainId === 4663 ? 'mainnet' : chainId === 31337 ? 'devnet' : 'testnet'
    if (badge !== expected) {
      fail(
        `${origin}: the bundle targets chain ${chainId} (reads as ${expected}) but the page badge says ${badge}. ` +
        `Two derivations of one value disagree — one of them, or this parser, is wrong.`,
      )
    }
  }

  // Every tracked deployment address that physically appears in the shipped
  // JavaScript, whatever the minifier did to the code around it.
  const addresses = {}
  for (const [addr, meta] of byAddress) {
    const i = js.toLowerCase().indexOf(addr)
    if (i === -1) continue
    const key = Object.keys(ADDRESS_KEYS).find((k) => ADDRESS_KEYS[k] === meta.name)
    if (key && !addresses[key]) addresses[key] = addr
  }

  if (Object.keys(addresses).length === 0) {
    fail(`${origin}: not one known factory or treasury address appears in the bundle — this build carries contracts nobody recorded, or the scan is broken`)
    return
  }
  assertCoherent(origin, chainId, addresses)
}

// ── Entry ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const urlArg = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : process.env.DEPLOYMENT_URL
const envArg = argv.includes('--env') ? argv[argv.indexOf('--env') + 1] : undefined

if (urlArg) {
  await checkLive(urlArg)
} else if (envArg) {
  // Explicit file. Exists so the verdict can be exercised against a known-good
  // and a known-bad configuration without editing the real dotenv files — a
  // guard nobody can test is a guard nobody can trust.
  if (!existsSync(envArg)) {
    fail(`${envArg} does not exist`)
  } else {
    checkStatic([envArg])
  }
} else {
  const dotenvs = readdirSync('.')
    .filter((f) => f.startsWith('.env') && !f.endsWith('.example'))
    .map((f) => join('.', f))

  const sawAmbient = checkAmbient()
  if (dotenvs.length > 0) checkStatic(dotenvs)

  if (dotenvs.length === 0 && !sawAmbient) {
    console.log('Neither a dotenv file nor an ambient address to check.')
  }
  note('Static arms only. They read configuration; they cannot read a built artifact.')
  note('Verify the deployment too:  node scripts/checkDeployedChain.mjs --url https://…')
}

console.log(
  failures === 0
    ? '\nTarget chain and contract addresses agree.'
    : `\n${failures} failure(s) — see FAIL lines above.`,
)

// `exitCode` and a natural drain, NOT `process.exit()`. This was the last
// `check:*` script still exiting explicitly after a `fetch`, and it still
// reproduced the crash the other four were converted to avoid: run the live arm
// against a host that fails the check and Node aborted inside libuv with
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, ending at
// 0xC0000409 with the FAIL line scrolled off behind a C assertion. The
// diagnostic this file exists to deliver was the thing the exit destroyed. See
// `lib/checkExit.mjs` for the mechanism and the measurement.
//
// Setting it is enough: `fail()` here only increments a counter, so unlike its
// four siblings this script has no mid-flight stop to model, and there is
// nothing left to run once the summary above has printed.
process.exitCode = failures === 0 ? 0 : 1
