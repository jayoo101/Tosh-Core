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
const GAS_FLOOR_WEI = BigInt(process.env.MONITOR_GAS_FLOOR_WEI || 50_000_000_000_000_000n) // 0.05 ETH

if (!FACTORY || !TREASURY) {
  console.error('Set MONITOR_FACTORY and MONITOR_TREASURY (or the NEXT_PUBLIC_ equivalents).')
  process.exit(2)
}

// ── RPC ──────────────────────────────────────────────────────────────────────

let seq = 0
async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

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

const state = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  : { lastBlock: null, hooks: [], armedSince: null, lastPiggybackBlock: null, lastRun: null }

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

// A window wider than the node will answer gets split. 1M was measured as
// acceptable on this endpoint; staying under it keeps one pass to one call per
// topic even after a long outage.
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
for (const [topic0, alerts] of byTopic) {
  const wantsAnyAddress = alerts.some(a => a.scope === 'any-address')
  const addresses = wantsAnyAddress
    ? [null]
    : [...new Set(alerts.map(a => addressFor[a.contract]).filter(Boolean))]

  for (const address of addresses) {
    const filter = { fromBlock: hex(from), toBlock: hex(head), topics: [topic0] }
    if (address) filter.address = address

    let logs
    try {
      logs = await rpc('eth_getLogs', [filter])
    } catch (err) {
      record('WATCHER-02', 'P1', false,
        `eth_getLogs failed for topic ${topic0}: ${err.message}. These alerts were NOT checked this pass.`,
        { alerts: alerts.map(a => a.id) })
      continue
    }
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

  // STATE-05 — the signer runs dry silently and blocks every new depositor.
  const bal = BigInt(await rpc('eth_getBalance', [signer, 'latest']))
  if (bal < GAS_FLOOR_WEI) {
    record('STATE-05', sev('STATE-05'), pages('STATE-05'),
      `PoG signer ${signer} holds ${(Number(bal) / 1e18).toFixed(4)} ETH, below the ` +
      `${(Number(GAS_FLOOR_WEI) / 1e18).toFixed(4)} ETH floor — /api/sign-allocation fails when it empties`)
  }
} catch (err) {
  record('STATE-04', 'P1', false, `PoG signer check failed: ${err.message}`)
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
try {
  const count = Number(BigInt(await call(TREASURY, 'ladderTokenCount()')))
  for (let i = 0; i < count; i++) {
    const token = asAddress(await call(TREASURY, 'ladderTokens(uint256)', word(i)))
    const key = await call(TREASURY, 'getPoolKey(address)', word(BigInt(token)))
    // PoolKey is (currency0, currency1, fee, tickSpacing, hooks) — hooks last.
    const hook = asAddress(key.slice(2).slice(4 * 64, 5 * 64))
    const twap = BigInt(await call(hook, 'twapSqrtPriceX96()'))
    if (twap === 0n) {
      record('STATE-07', sev('STATE-07'), pages('STATE-07'),
        `Ladder token ${token} has twapSqrtPriceX96() == 0 on hook ${hook}: the buyback's ` +
        `anti-sandwich bound is ABSENT, not loose. Remove it from the ladder until the TWAP matures.`,
        { playbook: 'docs/ONCHAIN_MONITORING.md §4 STATE-07' })
    }
  }
  if (count === 0) gap('STATE-07', 'no ladder tokens listed, so there is nothing to price-bound yet')
} catch (err) {
  record('STATE-07', 'P1', false, `ladder TWAP check failed: ${err.message}`)
}

// STATE-01 — refundable and unannounced. The gap LIFE-01 leaves (§2.2).
for (const hook of state.hooks) {
  try {
    const refundable = BigInt(await call(hook, 'canRefund()')) === 1n
    if (refundable) {
      record('STATE-01', sev('STATE-01'), pages('STATE-01'),
        `Hook ${hook} reports canRefund() == true. Depositors are owed the news that their ` +
        `exit is open; nothing on chain announces this.`,
        { playbook: 'docs/MANUAL_INTERACTION.md §4' })
    }
  } catch (err) {
    record('STATE-01', 'P2', false, `canRefund() failed on ${hook}: ${err.message}`)
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

state.lastBlock = head
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
