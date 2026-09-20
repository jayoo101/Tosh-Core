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
import { retiredChain } from './lib/retiredChains.mjs'

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
//
// A SECOND pass reads the timestamped `run-<epoch>.json` siblings, purely to
// recognise our own SUPERSEDED deployments. They stay out of `byAddress` and
// `byChain`, which must keep meaning "the current pair", and go into their own
// map instead.
//
// That pass exists because of a real misdiagnosis. Indexing only run-latest
// meant the guard could not tell "an address we have never seen" from "the
// address we deployed last week", and toshx.xyz was serving a build two
// redeploys behind. It failed — correctly — but said the build "carries
// contracts nobody recorded, or the scan is broken", which sends you to audit
// the parser. The true cause was that NEXT_PUBLIC_* is inlined at build time,
// so changing it in the host's dashboard does nothing until a rebuild. That is
// the single most likely reason this guard ever fires in live mode, and it was
// the one reading the message ruled out.
function buildIndex() {
  const byAddress = new Map()
  const byChain = new Map()
  const superseded = new Map()

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
        // Mined outranks simulated here too, and for a sharper reason than in
        // `byChain`: a dry run and the broadcast that follows it start from the
        // SAME nonce, so a dry run that deploys one fewer contract shifts every
        // address by one slot. The two logs then claim the same address for
        // DIFFERENT contracts. That is not hypothetical — on 97 the 2026-09-20
        // dry run put ToshFactory at 0x5BBcA0…, the broadcast put
        // ToshLadderTreasury there, directory order gave the dry run first-wins,
        // and this guard failed a correct `.env.local` with "is the ToshFactory,
        // not the ToshLadderTreasury". A guard that reports a good config as a
        // finding is worse than no guard: the next operator's cheapest reading
        // is that the guard is broken, and here that reading would be right.
        const claim = byAddress.get(addr)
        if (!claim || (claim.dry && !dry)) {
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

  // Second pass: the archive. Anything here that `walk` did not already claim
  // is a deployment we replaced.
  const walkHistory = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { walkHistory(p); continue }
      if (!/^run-\d+\.json$/.test(name)) continue

      const parts = p.split(/[\\/]/)
      const dry = parts.includes('dry-run')
      const chainId = Number(basename(dry ? dirname(dirname(p)) : dirname(p)))
      if (!Number.isFinite(chainId)) continue

      const when = Number(name.slice(4, -5))

      let log
      try { log = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }

      for (const tx of log.transactions ?? []) {
        if (!tx.contractName || !TRACKED.has(tx.contractName) || !tx.contractAddress) continue
        const addr = tx.contractAddress.toLowerCase()
        if (byAddress.has(addr)) continue
        const held = superseded.get(addr)
        if (!held || when > held.when) {
          superseded.set(addr, { chainId, name: tx.contractName, dry, when })
        }
      }
    }
  }

  if (!existsSync(BROADCAST)) {
    fail(`${BROADCAST} does not exist — this guard cannot attribute any address to any chain`)
    return { byAddress, byChain, superseded }
  }
  walk(BROADCAST)
  walkHistory(BROADCAST)

  if (byAddress.size === 0) {
    fail(`no ToshFactory / ToshLadderTreasury address found under ${BROADCAST} — the parser or the logs are wrong`)
  }
  return { byAddress, byChain, superseded }
}

const { byAddress, byChain, superseded } = buildIndex()

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
      // The default lives in `chain.ts` (31337) and applies here too, so an
      // absent id is a real configuration, not a gap.
      console.log('  chain id        (unset — chain.ts defaults to 31337)')
    }
    const chainId = raw === undefined ? 31337 : Number(raw)

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
  if (raw === undefined) console.log('  chain id        (unset — chain.ts defaults to 31337)')
  assertCoherent('process.env', raw === undefined ? 31337 : Number(raw), addresses)
  return true
}

// ── Live mode ───────────────────────────────────────────────────────────────
const KNOWN_IDS = new Set([...byChain.keys(), 31337])

async function checkLive(base) {
  const origin = base.replace(/\/+$/, '')
  console.log(`${origin}`)

  const res = await fetch(origin + '/')
  const html = await res.text()

  // ── Is this the site, or a wall in front of it? ────────────────────────────
  //
  // Vercel Deployment Protection answers every path on a protected deployment
  // — including `/_next/static/*.js` — with its own SSO login page. That page
  // is itself a Next.js app, so it has real `/_next/static` chunks, they fetch
  // with 200, and they contain no `Number("<chainId>")` for this project. The
  // scan therefore completed, found nothing, and blamed the one suspect it
  // knows about: "the minifier's output shape probably changed — fix this
  // parser". It cost an investigation of a parser that was working perfectly,
  // on a build it had never been shown.
  //
  // Checked on the response rather than by eye, because the giveaway is a
  // header: a protected deployment returns `x-matched-path: /login`, and the
  // body carries Vercel's SSO nonce. Either is conclusive; both are cheap.
  const matched = res.headers.get('x-matched-path') ?? ''
  if (/^\/login/.test(matched) || /_vercel_sso_nonce|vercel\.com\/sso-api/.test(html)) {
    fail(
      `${origin}: served Vercel's authentication page, not the site ` +
      `(x-matched-path: ${matched || 'n/a'}). Deployment Protection is on for ` +
      `this deployment, so every asset behind it — the document and the ` +
      `chunks — is that login page. Nothing here is a statement about the ` +
      `build. Check a production alias, or disable protection for this URL.`,
    )
    return
  }

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

  // Asked before the badge is compared, because a retired chain makes that
  // comparison produce a true statement about a false premise. `expected` maps
  // anything that is not 56 or 31337 to "testnet"; 4663 was Robinhood
  // MAINNET, so a build still on it reads as `expected: testnet` against a
  // badge saying `mainnet`, and the guard concludes "two derivations disagree —
  // one of them, or this parser, is wrong". All three were right. The parser
  // read the id correctly, the badge rendered it correctly, and the disagreement
  // was entirely inside a mainnet/testnet mapping that no longer has a case for
  // that chain. Sending someone to debug the parser is the one outcome that
  // cannot lead to the fix, which is to redeploy off a chain the protocol left.
  const retired = retiredChain(chainId)
  if (retired) {
    fail(
      `${origin}: this build targets chain ${chainId}, ${retired.name} — a chain ` +
      `this protocol has left. ${retired.left} Nothing is wrong with this ` +
      `guard's extraction: the id was read correctly and the badge says ` +
      `${badge ?? 'nothing recognisable'}. The build itself is the finding.`,
    )
    return
  }

  if (badge === undefined) {
    fail(`${origin}: no chain badge in the served HTML — the second witness is missing, so the id above is unconfirmed`)
  } else {
    const expected = chainId === 56 ? 'mainnet' : chainId === 31337 ? 'devnet' : 'testnet'
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
    // Before blaming the scan, check whether this is one of OUR deployments
    // that we replaced. That is the overwhelmingly likely case and it has a
    // different fix, so it gets a different message.
    const stale = []
    for (const [addr, meta] of superseded) {
      if (js.toLowerCase().includes(addr)) stale.push({ addr, ...meta })
    }

    if (stale.length > 0) {
      fail(
        `${origin}: this build is STALE. It carries a deployment we superseded —\n` +
        stale
          .map((s) => `          ${s.name} ${s.addr} (chain ${s.chainId}, deployed ${new Date(s.when).toISOString().slice(0, 10)})`)
          .join('\n') + '\n' +
        `        NEXT_PUBLIC_* is inlined at BUILD time, so setting it on the host\n` +
        `        changes nothing until the site is rebuilt. Trigger a redeploy.\n` +
        `        Current on chain ${chainId}: ` +
        [...(byChain.get(chainId) ?? new Map())].map(([n, v]) => `${n} ${v.addr}`).join(', '),
      )
      return
    }

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
