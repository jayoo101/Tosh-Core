/**
 * The PM-E2 watcher: turns `monitoring/alerts.json` into an actual monitor.
 *
 * `docs/ONCHAIN_MONITORING.md` §7 says the config is provider-neutral because
 * no two vendors agree on a format, and names the two capabilities an importer
 * must check for. Both turned out to be available on the chain's own RPC —
 * `monitoring/probeRpc.mjs` measures them — which makes a vendor optional
 * rather than load-bearing. This is the direct implementation.
 *
 * ── Run-once, by design ─────────────────────────────────────────────────────
 *
 * One pass, resumable from a state file, then exit. No daemon. That makes the
 * scheduler someone else's problem (cron, a systemd timer, a loop in a shell)
 * and, more usefully, makes the whole thing testable: the same command a
 * scheduler runs is the command a human runs to see what it would say.
 *
 * The state file carries three things that cannot be recomputed from a single
 * reading:
 *
 *   lastBlock     where the previous pass stopped, so no window is skipped and
 *                 none is scanned twice.
 *   hooks         hook addresses harvested from LaunchCreated. §2.1 method 2.
 *                 Kept even though method 1 works here, because STATE-01 and
 *                 STATE-07 need to *call* each hook, and a topic filter cannot
 *                 tell you what to call.
 *   armedSince    STATE-06 is a claim about a 24h window, not about a reading
 *                 (§7). Without memory it fires on every healthy cycle.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * No paging. Findings go to stdout as JSON lines, and a delivery sink is a
 * later decision (PM-E2 done-list). Printing them is not a placeholder for
 * alerting — it is the part that has to be right first, because a pager wired
 * to a monitor that mis-detects is worse than no pager.
 *
 * Usage:
 *   node monitoring/watch.mjs                 one pass against the configured chain
 *   node monitoring/watch.mjs --since 5000    rescan the last N blocks, ignore state
 *   node monitoring/watch.mjs --dry           scan and report, do not persist state
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRpc } from './rpc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = JSON.parse(readFileSync(join(HERE, 'alerts.json'), 'utf8'))

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const RPC = opt('--rpc', process.env.MONITOR_RPC
  || process.env.ROBINHOOD_TESTNET_RPC
  || 'https://rpc.testnet.chain.robinhood.com')
const STATE_PATH = opt('--state', join(HERE, '.watch-state.json'))
const SINCE = opt('--since', null)
const DRY = flag('--dry')

const FACTORY = (process.env.MONITOR_FACTORY || process.env.NEXT_PUBLIC_FACTORY_ADDRESS || '').toLowerCase()
const TREASURY = (process.env.MONITOR_TREASURY || process.env.NEXT_PUBLIC_TREASURY_ADDRESS || '').toLowerCase()
const EXPECTED_OWNER = (process.env.MONITOR_EXPECTED_OWNER || '').toLowerCase()
const EXPECTED_SIGNER = (process.env.MONITOR_EXPECTED_POG_SIGNER || '').toLowerCase()
// Empty unless an automated keeper exists. See STATE-05 below for why this is
// not the PoG signer.
const KEEPER_ADDRESS = (process.env.MONITOR_KEEPER_ADDRESS || '').toLowerCase()
const GAS_FLOOR_WEI = BigInt(process.env.MONITOR_GAS_FLOOR_WEI || 50_000_000_000_000_000n) // 0.05 ETH

if (!FACTORY || !TREASURY) {
  console.error('Set MONITOR_FACTORY and MONITOR_TREASURY (or the NEXT_PUBLIC_ equivalents).')
  process.exit(2)
}

// ── RPC ──────────────────────────────────────────────────────────────────────
//
// Pacing and retry live in rpc.mjs, not here. The 46630 rehearsal could not
// have caught the mainnet limiter: that node accepted a tight loop, this one
// 429s on the seventh identical eth_getLogs. See the header of rpc.mjs for
// the measurement (250 ms / 4 retries / JSON-RPC body error, 2026-09-08).

const rpc = createRpc(RPC)

const hex = n => '0x' + BigInt(n).toString(16)
const asAddress = word => '0x' + String(word).slice(-40).toLowerCase()

/**
 * Selectors are derived from their signature, never typed in. A wrong constant
 * here surfaces as `execution reverted`, which is indistinguishable from the
 * function having been removed -- a state check that cries wolf about exactly
 * the thing it exists to watch.
 */
const selectorCache = new Map()
function selector(signature) {
  if (!selectorCache.has(signature)) {
    selectorCache.set(signature, execFileSync('cast', ['sig', signature], { encoding: 'utf8' }).trim())
  }
  return selectorCache.get(signature)
}

async function call(to, signature, suffix = '') {
  return rpc('eth_call', [{ to, data: selector(signature) + suffix }, 'latest'])
}

const word = n => BigInt(n).toString(16).padStart(64, '0')

/**
 * V4 encodes a hook's permissions in the low 14 bits of its address, and
 * `HookMiner.isValidHookAddress` tests `bits & REQUIRED_FLAGS == REQUIRED_FLAGS`
 * -- the required bits must be SET, while the rest are whatever CREATE2 mining
 * happened to produce. Testing `(bits & 0x3FFF) == 0x20CC` instead rejects
 * every real hook: the live one on 46630 ends 0xffdf, whose low 14 bits are
 * 0x3fdf, and which carries all of 0x20CC.
 */
const REQUIRED_HOOK_FLAGS = 0x20ccn
const isHookAddress = addr => (BigInt(addr) & REQUIRED_HOOK_FLAGS) === REQUIRED_HOOK_FLAGS

// ── State ────────────────────────────────────────────────────────────────────

/**
 * A state file that will not parse must not be confused with a state file that
 * is not there, and must not be confused with a P0.
 *
 * Bare `JSON.parse` here threw a stack trace and exited 1 — the same code a
 * paging finding uses — so a truncated or BOM-prefixed file arrives at the
 * scheduler looking exactly like a live incident, while the pass in fact
 * scanned nothing. Exit 2 is already this script's "you configured me wrong",
 * and that is what this is.
 *
 * The BOM is stripped rather than rejected because it is the likeliest form of
 * corruption here and the least meaningful: `Set-Content -Encoding utf8` on
 * Windows PowerShell writes one by default, this repository already runs a
 * CI guard for exactly that class of damage, and it is how the first draft of
 * this file's own test harness broke.
 */
let state = { lastBlock: null, hooks: [], armedSince: null, lastPiggybackBlock: null, lastRun: null }
if (existsSync(STATE_PATH)) {
  const raw = readFileSync(STATE_PATH, 'utf8').replace(/^\uFEFF/, '')
  try {
    state = JSON.parse(raw)
  } catch (err) {
    console.error(`State file ${STATE_PATH} is not valid JSON: ${err.message}`)
    console.error('Refusing to continue. Resuming from a checkpoint that cannot be read would')
    console.error('mean rescanning MAX_SPAN and re-reporting old events as new. Delete the file')
    console.error('to start cold on purpose, or restore it from the state branch.')
    process.exit(2)
  }
}

const findings = []
const record = (id, severity, page, message, extra = {}) =>
  findings.push({ id, severity, page, message, ...extra })

/**
 * A finding says something happened on chain. A gap says a check ran but could
 * not actually check, which is a different claim and must not be filed as the
 * first — §6's noise budget is spent by exactly this kind of every-cycle
 * repetition, and the P0 alerts are what get muted along with it. Gaps print
 * once in the summary instead.
 */
const gaps = []
const gap = (id, message) => gaps.push(`${id}: ${message}`)

// ── Scan window ──────────────────────────────────────────────────────────────

const head = Number(await rpc('eth_blockNumber'))
const chainId = Number(await rpc('eth_chainId'))

/**
 * A checkpoint is only meaningful on the chain that produced it, and nothing in
 * the file said which chain that was.
 *
 * This is the C1 cutover, and it fails silently in the worst direction. Point
 * MONITOR_RPC at mainnet while the state still holds a testnet checkpoint and
 * `from` becomes `lastBlock + 1` — a testnet height, far ABOVE the mainnet head.
 * The `from > head` branch below then reports "no new blocks" and exits 0. Not
 * an error, not a gap, not a finding: a green run, every cycle, monitoring
 * nothing, on the day the contracts holding real money go live. Testnet is at
 * ~112.7M blocks and mainnet at ~54.2M, so the gap is around 58 million blocks
 * and would not close on its own within the life of the protocol.
 *
 * So the chain id is part of the checkpoint now, and a change discards it
 * rather than reinterpreting it. Discarding costs one noisy pass: without a
 * lastBlock the scan falls back to the most recent MAX_SPAN, and events in that
 * window are re-reported as new. That is the right trade — a duplicate alert is
 * read and dismissed in seconds, and a silent monitor is not read at all.
 */
/* Two tests, because the first one cannot see the file that is already on disk.
 * Existing state predates the `chainId` field, so a mismatch is unrecognisable
 * on the very run where it matters most — the first one after the cutover. The
 * second test needs no field: a checkpoint AHEAD of the head is impossible on
 * the chain that produced it, so it is evidence of the same fault by itself.
 * It also catches a chain rolled back beneath us, which is the other way this
 * arithmetic silently inverts. */
const staleChain = state.chainId != null && state.chainId !== chainId
const impossible = state.lastBlock != null && state.lastBlock > head

if (staleChain || impossible) {
  record('WATCHER-03', 'P1', true,
    (staleChain
      ? `State file was written against chain ${state.chainId}, but this endpoint is chain ${chainId}.`
      : `State file's checkpoint (${state.lastBlock.toLocaleString()}) is AHEAD of chain ` +
        `${chainId}'s head (${head.toLocaleString()}), which cannot happen on the chain that ` +
        `wrote it — so it was written against a different chain, or this one rolled back.`) +
    ` The checkpoint has been discarded, along with the harvested hooks and the STATE-06 ` +
    `window. This pass rescans recent history, so expect duplicates of anything already ` +
    `seen. If this is the mainnet cutover, that is correct: close this once the first pass ` +
    `lands and check that the next run resumes normally.`)
  state.lastBlock = null
  state.hooks = []
  state.armedSince = null
  state.lastPiggybackBlock = null
  delete state.treasuryBalance
}
state.chainId = chainId

// A window wider than the node will answer gets split. 1,000,000 blocks was
// accepted on the 46630 testnet node and, re-measured 2026-09-08 against
// https://rpc.mainnet.chain.robinhood.com, on mainnet too — address-scoped and
// address-less. Window width is not the constraint that moved; request *rate*
// is. Staying under 1M still keeps one pass to one call per topic after a long
// outage; the 250 ms floor in rpc.mjs is what stops the limiter eating those
// calls. A hardcoded sleep with no provenance is the thing someone deletes
// later, which is why the numbers live next to the measurement, not here.
const MAX_SPAN = Number(process.env.MONITOR_MAX_SPAN || 900_000)

let from
if (SINCE) from = Math.max(0, head - Number(SINCE))
else if (state.lastBlock != null) from = state.lastBlock + 1
else from = Math.max(0, head - MAX_SPAN)

if (from > head) {
  console.error(JSON.stringify({ level: 'info', message: 'no new blocks', head, from }))
  process.exit(0)
}
if (head - from > MAX_SPAN) {
  record('WATCHER-01', 'P2', false,
    `Behind by ${(head - from).toLocaleString()} blocks, more than one pass can scan. ` +
    `Scanning the most recent ${MAX_SPAN.toLocaleString()} and skipping the rest — ` +
    `run with --since to sweep the gap deliberately.`)
  from = head - MAX_SPAN
}

// ── 1. Events ────────────────────────────────────────────────────────────────

const addressFor = { ToshFactory: FACTORY, ToshLadderTreasury: TREASURY }

// Grouped so one getLogs serves every alert sharing a scope. The address-less
// group is the one §2.1 requires and the one a fixed-address monitor cannot
// express: hooks are CREATE2'd per project and unknowable in advance.
const anyAddress = CONFIG.alerts.filter(a => a.scope === 'any-address')
const scoped = CONFIG.alerts.filter(a => a.scope !== 'any-address')

const byTopic = new Map()
for (const a of [...anyAddress, ...scoped]) {
  if (!byTopic.has(a.topic0)) byTopic.set(a.topic0, [])
  byTopic.get(a.topic0).push(a)
}

const LAUNCH_CREATED = CONFIG.alerts.find(a => a.event.startsWith('LaunchCreated'))

let logsSeen = 0
let logQueriesAttempted = 0
let logQueriesSucceeded = 0
for (const [topic0, alerts] of byTopic) {
  const wantsAnyAddress = alerts.some(a => a.scope === 'any-address')
  const addresses = wantsAnyAddress
    ? [null]
    : [...new Set(alerts.map(a => addressFor[a.contract]).filter(Boolean))]

  for (const address of addresses) {
    const filter = { fromBlock: hex(from), toBlock: hex(head), topics: [topic0] }
    if (address) filter.address = address

    let logs
    logQueriesAttempted++
    try {
      logs = await rpc('eth_getLogs', [filter])
    } catch (err) {
      /* WATCHER-02 used to be page: false for every failed getLogs.
       *
       * That is the same failure shape WATCHER-03 was written to stop: a
       * monitor that scanned nothing, reported a finding that does not page,
       * and left the job green. The 2026-09-08 mainnet cutover (workflow run
       * 34196807435) did exactly this. Every eth_getLogs 429'd, each landing
       * as a non-paging WATCHER-02; the one paging finding was WATCHER-03,
       * the expected cutover notice; report.mjs filed that one issue and the
       * Actions run went green. Independently, the same window contained
       * seven logs mapping to GOV-01/02/03/06/07 — all P0. Nobody was told.
       *
       * The rule, chosen against §6's noise budget rather than as "page on
       * any RPC hiccup":
       *
       *   - Retry is what absorbs a transient 429. That lives in rpc.mjs.
       *     This branch is after those retries are exhausted.
       *   - If the skipped topic's alerts include any P0, this pages. An
       *     unchecked P0 is an outage of the monitor, not a gap to print.
       *   - P1/P2-only topics that fail still record WATCHER-02, still do
       *     not page. A PARAM-02 miss every cycle would spend the budget
       *     that exists to keep the P0s unmuted.
       *   - A pass that completed zero log queries is WATCHER-04 below,
       *     which always pages: zero logs after a total skip is a blind
       *     monitor, not a quiet chain. One finding, not one per topic, so
       *     a fully wedged endpoint does not also storm the issue tracker.
       */
      const affected = address
        ? alerts.filter(a => a.scope === 'any-address' || addressFor[a.contract] === address)
        : alerts
      const blindsP0 = affected.some(a => a.severity === 'P0')
      record('WATCHER-02', 'P1', blindsP0,
        `eth_getLogs failed for topic ${topic0}: ${err.message}. These alerts were NOT checked this pass.`,
        { alerts: affected.map(a => a.id) })
      continue
    }
    logQueriesSucceeded++
    logsSeen += logs.length

    for (const log of logs) {
      // An address-less filter matches any contract that shares the signature.
      // For hook events that is the point; for the rest it would be noise, so
      // scoped alerts only accept their own contract.
      const owner = alerts.find(a =>
        a.scope === 'any-address' || addressFor[a.contract] === log.address.toLowerCase())
      if (!owner) continue

      record(owner.id, owner.severity, owner.page === true,
        `${owner.event.split('(')[0]} at ${log.address}`,
        {
          block: Number(log.blockNumber),
          tx: log.transactionHash,
          playbook: owner.playbook || undefined,
          correlate: /^(GOV-|SWITCH-0[12])/.test(owner.id) || undefined,
        })

      if (LAUNCH_CREATED && topic0 === LAUNCH_CREATED.topic0) {
        // LaunchCreated(uint256 indexed launchId, address indexed token,
        //               address indexed hook, address creator, string, string)
        //
        // All three of launchId, token and hook are indexed, so they are in
        // topics[1..3] and the data holds `creator` followed by string offsets.
        // Reading the hook out of the data instead yields the deployer address
        // and two ABI offsets, which is what the first draft did: the harvest
        // silently produced nothing and STATE-01 had no hooks to poll.
        const hook = asAddress(log.topics[3])
        if (isHookAddress(hook) && !state.hooks.includes(hook)) state.hooks.push(hook)
      }
    }
  }
}

state.hooks = state.hooks.filter(isHookAddress)

/* WATCHER-04 — a pass that completed zero log queries is a blind monitor.
 *
 * WATCHER-02 pages per skipped P0 topic, which is the right grain when some
 * queries succeed: those alerts were checked, these were not. When none
 * succeed, listing one WATCHER-02 per topic would storm the issue tracker
 * with the same outage (§6: the firehose that gets muted, taking the P0s
 * with it). One paging finding for the whole pass is the same claim
 * WATCHER-03 makes about a stale checkpoint: the monitor did not watch.
 *
 * The workflow's `::error::` is wired to this id as well as to exit 2.
 * Run 34196807435 did not trip that annotation because the watcher still
 * produced findings and exited 1 (WATCHER-03 paged). Exit 2 is "could not
 * even start"; this is "started, scanned nothing". Both are a blind
 * monitor. Neither is a quiet chain.
 *
 * Transient 429s never reach here — rpc.mjs retries them. This fires after
 * those retries are exhausted, so it is not the noise budget talking.
 */
if (logQueriesAttempted > 0 && logQueriesSucceeded === 0) {
  record('WATCHER-04', 'P1', true,
    `Every eth_getLogs query failed this pass (${logQueriesAttempted} attempted, 0 succeeded). ` +
    `Zero logs is not a quiet chain — the monitor was blind. The checkpoint has not been ` +
    `advanced, so the next pass retries this window rather than skipping it.`)
}

// ── 2. State checks ──────────────────────────────────────────────────────────

const spec = Object.fromEntries(CONFIG.stateChecks.map(s => [s.id, s]))
const sev = id => spec[id]?.severity || 'P2'
const pages = id => ['P0', 'P1'].includes(sev(id))

// STATE-03 — ownership, the fact where finding out late is unacceptable.
try {
  const owner = asAddress(await call(FACTORY, 'owner()'))
  const pending = asAddress(await call(FACTORY, 'pendingOwner()'))
  if (EXPECTED_OWNER && owner !== EXPECTED_OWNER) {
    record('STATE-03', sev('STATE-03'), true,
      `factory.owner() is ${owner}, expected ${EXPECTED_OWNER}`, { playbook: 'docs/INCIDENT_RESPONSE.md §5' })
  }
  if (pending !== '0x' + '0'.repeat(40)) {
    record('STATE-03', sev('STATE-03'), true,
      `factory.pendingOwner() is ${pending} — a transfer is mid-flight and can still be abandoned`,
      { playbook: 'docs/INCIDENT_RESPONSE.md §5' })
  }
  if (!EXPECTED_OWNER) {
    gap('STATE-03', `MONITOR_EXPECTED_OWNER unset — owner is ${owner}, compared against nothing`)
  }
} catch (err) {
  record('STATE-03', 'P1', false, `ownership check failed: ${err.message}`)
}

// STATE-04 — the PoG signer, same reasoning as STATE-03 applied to GOV-04.
try {
  const signer = asAddress(await call(FACTORY, 'pogSigner()'))
  if (EXPECTED_SIGNER && signer !== EXPECTED_SIGNER) {
    record('STATE-04', sev('STATE-04'), pages('STATE-04'),
      `factory.pogSigner() is ${signer}, expected ${EXPECTED_SIGNER}`)
  }
  if (!EXPECTED_SIGNER) {
    gap('STATE-04', `MONITOR_EXPECTED_POG_SIGNER unset — signer is ${signer}, compared against nothing`)
  }
} catch (err) {
  record('STATE-04', 'P1', false, `PoG signer check failed: ${err.message}`)
}

/**
 * STATE-05 — a gas floor, for a wallet that does not exist yet.
 *
 * This deliberately does NOT watch the PoG signer. That signer never sends a
 * transaction: `registerPoG` is external and keys off `msg.sender`, so the
 * depositor pays, and both consumers of the key sign without a chain
 * connection -- `privateKeyToAccount().signMessage()` in the API route, and an
 * `ethers.Wallet(pk)` with no provider in `scripts/pogSigner.ts`, which cannot
 * broadcast even in principle. A signer holding nothing signs perfectly well,
 * and a key that guards a balance is worth more to steal than one that does
 * not.
 *
 * The check survives because its shape fits a case that has not arrived.
 * `pokeBuyback()` is permissionless and STATE-06's remedy is a human calling
 * it; automate that and the protocol acquires its first wallet that really
 * does need gas, one that would fail silently on running dry.
 */
if (KEEPER_ADDRESS) {
  try {
    const bal = BigInt(await rpc('eth_getBalance', [KEEPER_ADDRESS, 'latest']))
    if (bal < GAS_FLOOR_WEI) {
      record('STATE-05', sev('STATE-05'), pages('STATE-05'),
        `Keeper ${KEEPER_ADDRESS} holds ${(Number(bal) / 1e18).toFixed(4)} ETH, below the ` +
        `${(Number(GAS_FLOOR_WEI) / 1e18).toFixed(4)} ETH floor — it stops transacting when it empties, ` +
        `and nothing else announces that`)
    }
  } catch (err) {
    record('STATE-05', 'P1', false, `keeper balance check failed: ${err.message}`)
  }
}

// STATE-02 and STATE-06 — the treasury's balance, read two different ways.
let treasuryBalance = null
try {
  treasuryBalance = BigInt(await rpc('eth_getBalance', [TREASURY, 'latest']))

  // STATE-02: a drop with no buyback to explain it means either a withdrawal
  // path exists or we are watching the wrong contract.
  if (state.treasuryBalance != null) {
    const before = BigInt(state.treasuryBalance)
    if (treasuryBalance < before) {
      const spent = findings.some(f => /Buyback|Piggyback/.test(f.message))
      record('STATE-02', sev('STATE-02'), true,
        `ladderTreasury balance fell from ${(Number(before) / 1e18).toFixed(6)} to ` +
        `${(Number(treasuryBalance) / 1e18).toFixed(6)} ETH` +
        (spent ? ' — a buyback in this window explains it, confirm the amounts match'
               : ' with NO buyback event in this window'),
        { playbook: 'docs/INCIDENT_RESPONSE.md §2', correlate: true })
    }
  }

  // STATE-06: armed and idle. The gas-gated skip emits nothing by design, so
  // balance-plus-silence is the only available signal (§2.3).
  // STATE-06 is the one check whose firing path cannot be reached by waiting:
  // it needs the reservoir above TRIGGER_STEP for 24h, which on a quiet testnet
  // never happens. An override makes that path testable, and announces itself
  // as a gap every run so it can never be the reason production went quiet.
  let trigger = BigInt(await call(TREASURY, 'TRIGGER_STEP()'))
  if (process.env.MONITOR_TRIGGER_STEP_WEI) {
    const override = BigInt(process.env.MONITOR_TRIGGER_STEP_WEI)
    gap('STATE-06', `TRIGGER_STEP overridden to ${override} wei (chain says ${trigger}) — testing only`)
    trigger = override
  }
  const piggybacked = findings.some(f => /Piggyback/.test(f.message))
  if (piggybacked) {
    state.armedSince = null
    state.lastPiggybackBlock = head
  } else if (treasuryBalance >= trigger) {
    const now = Math.floor(Date.now() / 1000)
    if (state.armedSince == null) state.armedSince = now
    const armedFor = now - state.armedSince
    if (armedFor >= 24 * 3600) {
      record('STATE-06', sev('STATE-06'), pages('STATE-06'),
        `Reservoir has held >= TRIGGER_STEP for ${(armedFor / 3600).toFixed(1)} h with no ` +
        `PiggybackExecuted. Call pokeBuyback() — permissionless, no Safe transaction needed.`)
    }
  } else {
    state.armedSince = null
  }
} catch (err) {
  record('STATE-02', 'P1', false, `treasury balance check failed: ${err.message}`)
}

// STATE-07 — the only automated check on a rule the contract does not enforce.
//
// Two properties of this loop are load-bearing, and neither was true when it was
// written. Both come from the same place: `_buybackSqrtFloor` reaches UNBOUNDED
// by two doors, and only one of them was being watched.
//
//   1. PER-TOKEN ISOLATION. Every read here was on the outer `try`, so one
//      failing call — a reverting hook, or a plain RPC hiccup on token 0 —
//      aborted the whole loop and left every LATER token unchecked. The alert
//      that came out said "check failed", which reads as "the monitor is
//      unwell", not "one or more listed pools may have no price bound right
//      now". A twenty-token ladder could be blinded nineteen-twentieths by one
//      bad call, and nothing in the output would say which tokens were skipped.
//
//   2. A REVERT IS THE SAME HAZARD AS A ZERO. `_buybackSqrtFloor` wraps this
//      exact call in `try/catch` and returns `MIN_SQRT_PRICE + 1` — unbounded —
//      from BOTH the `twapSqrt == 0` branch and the `catch`. So a hook whose
//      `twapSqrtPriceX96()` reverts has no anti-sandwich bound, identically to
//      one reporting 0. That case used to land in the generic error path below
//      as a HARDCODED non-paging record, while the zero case pages at P1. The
//      consequence is the same, so the page is the same.
//
// The generic handler is now reserved for the one failure that really is a
// monitor fault rather than a finding: not being able to read the token list at
// all, in which case nothing downstream was checked and the count is unknown.
try {
  const count = Number(BigInt(await call(TREASURY, 'ladderTokenCount()')))
  for (let i = 0; i < count; i++) {
    try {
      const token = asAddress(await call(TREASURY, 'ladderTokens(uint256)', word(i)))
      const key = await call(TREASURY, 'getPoolKey(address)', word(BigInt(token)))
      // PoolKey is (currency0, currency1, fee, tickSpacing, hooks) — hooks last.
      const hook = asAddress(key.slice(2).slice(4 * 64, 5 * 64))
      let twap
      try {
        twap = BigInt(await call(hook, 'twapSqrtPriceX96()'))
      } catch (err) {
        record('STATE-07', sev('STATE-07'), pages('STATE-07'),
          `Ladder token ${token}: twapSqrtPriceX96() on hook ${hook} did not answer ` +
          `(${err.message}). _buybackSqrtFloor catches that and falls back to UNBOUNDED, which ` +
          `is the same absent bound as a zero reading — treat this exactly like the zero case, ` +
          `and additionally ask why the hook stopped answering.`,
          { playbook: 'docs/ONCHAIN_MONITORING.md §4 STATE-07' })
        continue
      }
      if (twap === 0n) {
        record('STATE-07', sev('STATE-07'), pages('STATE-07'),
          `Ladder token ${token} has twapSqrtPriceX96() == 0 on hook ${hook}: the buyback's ` +
          `anti-sandwich bound is ABSENT, not loose. Remove it from the ladder until the TWAP matures.`,
          { playbook: 'docs/ONCHAIN_MONITORING.md §4 STATE-07' })
      }
    } catch (err) {
      // Could not even resolve this entry to a hook. Name the index, because the
      // whole point of this rewrite is that a skipped token is never silent.
      record('STATE-07', sev('STATE-07'), pages('STATE-07'),
        `Ladder token at index ${i} of ${count} could not be checked (${err.message}), so ` +
        `whether its buyback bound exists is UNKNOWN. Every other index was still checked.`,
        { playbook: 'docs/ONCHAIN_MONITORING.md §4 STATE-07' })
    }
  }
  if (count === 0) gap('STATE-07', 'no ladder tokens listed, so there is nothing to price-bound yet')
} catch (err) {
  record('STATE-07', 'P1', false,
    `ladder token list could not be read (${err.message}), so NO token was checked this pass`)
}

// STATE-01 — refundable and unannounced. The gap LIFE-01 leaves (§2.2).
for (const hook of state.hooks) {
  try {
    const refundable = BigInt(await call(hook, 'canRefund()')) === 1n
    if (refundable) {
      record('STATE-01', sev('STATE-01'), pages('STATE-01'),
        `Hook ${hook} reports canRefund() == true. Depositors are owed the news that their ` +
        `exit is open; nothing on chain announces this.`,
        { playbook: 'tosh-status/MANUAL_INTERACTION.md §4' })
    }
  } catch (err) {
    record('STATE-01', 'P2', false, `canRefund() failed on ${hook}: ${err.message}`)
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

/* A blind or P0-blinding pass must not consume the window. The 2026-09-08
 * cutover pass wrote lastBlock = head after scanning nothing, persisted it,
 * and made the seven P0 governance logs in that 900k-block window
 * unrecoverable from the resume path — `--since` is the only way back, and
 * nobody who saw a green run would think to use it.
 *
 * Duplicate findings on a retry are the same trade WATCHER-03 already
 * accepted: a duplicate is dismissed in seconds, a skipped window is not
 * read at all. P1/P2-only skips still advance: stalling the checkpoint on
 * PARAM-02 would spend the noise budget the other way, by re-firing every
 * healthy event forever. */
const fullyBlind = logQueriesAttempted > 0 && logQueriesSucceeded === 0
const blindedP0 = findings.some(f => f.id === 'WATCHER-02' && f.page)
if (!fullyBlind && !blindedP0) state.lastBlock = head
state.lastRun = new Date().toISOString()
if (treasuryBalance != null) state.treasuryBalance = treasuryBalance.toString()
if (!DRY) writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))

const ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 }
findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity])

for (const f of findings) console.log(JSON.stringify(f))

const paging = findings.filter(f => f.page)
console.error(
  `\n[watch] chain ${chainId} · blocks ${from.toLocaleString()}-${head.toLocaleString()} · ` +
  `${logsSeen} log(s) · ${state.hooks.length} hook(s) known · ` +
  `${findings.length} finding(s), ${paging.length} paging`
)
if (gaps.length > 0) {
  console.error(`        ${gaps.length} check(s) ran without being able to check:`)
  for (const g of gaps) console.error(`          ${g}`)
}
console.error('')

// A paging finding is the exit code a scheduler can act on without parsing.
process.exit(paging.length > 0 ? 1 : 0)
