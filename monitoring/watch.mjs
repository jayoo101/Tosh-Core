/**
 * The PM-E2 watcher: turns `monitoring/alerts.json` into an actual monitor.
 *
 * The config is provider-neutral because no two vendors agree on a format.
 * The two capabilities an importer must check for both turned out to be
 * available on the chain's own RPC — `monitoring/probeRpc.mjs` measures them —
 * which makes a vendor optional rather than load-bearing. This is the direct
 * implementation.
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
import { buildLogQueries, matchLog } from './logQueries.mjs'
import { retiredChain } from '../scripts/lib/retiredChains.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = JSON.parse(readFileSync(join(HERE, 'alerts.json'), 'utf8'))

const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

/* The default is BSC testnet, not Robinhood testnet, and not mainnet.
 *
 * It used to be `https://rpc.testnet.chain.robinhood.com` — chain 46630, which
 * the protocol has left and which is still answering. WATCHER-07's own comment
 * names that default as the way "forgetting one variable" reaches the wrong
 * chain, so leaving it pointed at a retired-but-live endpoint made the fallback
 * the exact fault the check exists to catch.
 *
 * Testnet rather than mainnet on purpose: an unset variable should land
 * somewhere a mistaken pass is cheap. Defaulting to 56 would make a forgotten
 * variable produce confident-looking findings about the chain that holds money.
 */
const RPC = opt('--rpc', process.env.MONITOR_RPC
  || process.env.BSC_TESTNET_RPC
  || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545')
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
 * ⚠ THIS FILTER WOULD HAVE BLINDED THE WATCHER on PancakeSwap Infinity, and it
 *   is the reason to state the history rather than just delete it.
 *
 *   It used to read `(bits & 0x20CC) == 0x20CC`. Uniswap V4 encoded a hook's
 *   permissions in the low 14 bits of its address, so every legitimate hook
 *   carried that mask and anything without it could not have been one of ours.
 *   Infinity asks the hook for `getHooksRegistrationBitmap()` instead, the
 *   factory stopped mining for address bits, and a hook's address is now
 *   whatever CREATE2 produced — which satisfies a five-bit mask about one time
 *   in 32.
 *
 *   Left in place, the harvest below would have dropped roughly 31 of every 32
 *   real launches, and `state.hooks.filter` would have deleted the ones already
 *   being polled. The watcher would have reported a clean pass over almost
 *   nothing, which is the failure mode WATCHER-04 exists to catch and this
 *   would have slipped underneath it: queries succeeded, there was just nothing
 *   left to query.
 *
 *   Nothing replaces it. The address was never the authority — `LaunchCreated`
 *   comes from the factory whose address this watcher is configured with, and a
 *   forged event would need control of that factory, at which point a mask on
 *   the hook address protects nothing. `asAddress` still bounds the shape.
 */
const isHookAddress = addr => /^0x[0-9a-f]{40}$/i.test(addr) && BigInt(addr) !== 0n

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
/* WATCHER-07 — the endpoint is not the chain this catalogue is about.
 *
 * `alerts.json` has carried `"chainId": 4663` since it was written, and nothing
 * read it. The only chain test was the one below, which compares the endpoint
 * against the CHECKPOINT — so it needs a previous pass to have happened on the
 * right chain, and says nothing on a cold start. Cold starts are not exotic
 * here: the state branch may not exist, and WATCHER-03 and -06 both discard the
 * checkpoint by design.
 *
 * Reaching the wrong chain takes no more than forgetting one variable. RPC
 * defaults to the TESTNET endpoint (see the `--rpc` default above), and a pass
 * against 46630 with mainnet addresses is quiet rather than loud: the log filters
 * are address-scoped so they return empty, and `owner()`/`paused()` on addresses
 * with no code fail as non-paging "check failed" P1s. Empty logs plus successful
 * queries does not trip WATCHER-04 either, because the queries did succeed. So
 * the catalogue states which chain it is about and this compares the two.
 *
 * It records rather than exiting 2. Exit 2 means "could not even start" and the
 * workflow skips `report.mjs` on it, so the loudest possible misconfiguration
 * would reach a red Actions run and no pager — and at ~6.5 passes a day nobody
 * is watching the Actions tab. Paging is the point.
 */
if (CONFIG.chainId != null && CONFIG.chainId !== chainId) {
  record('WATCHER-07', 'P1', true,
    `alerts.json declares chain ${CONFIG.chainId} and this endpoint is chain ${chainId}. Every ` +
    `alert and address in the catalogue is about the other chain, so nothing below is a ` +
    `statement about ${CONFIG.chainId}. Set MONITOR_RPC — unset, it defaults to the testnet ` +
    `endpoint, and this pass would otherwise have looked quiet rather than wrong.`,
    { catalogueChainId: CONFIG.chainId, endpointChainId: chainId })
}

/* WATCHER-08 — the catalogue is about a chain the protocol has left.
 *
 * WATCHER-07 above compares two numbers and pages when they disagree. It cannot
 * see the case where they AGREE and are both wrong, which is the state this
 * monitor was actually in from the 2026-09-08 cutover until 2026-09-18:
 * `alerts.json` said 4663, `MONITOR_RPC` pointed at 4663, the addresses were the
 * 4663 pair, and every pass reported success. Roughly a thousand green passes
 * about a chain that settles nothing, while `97` — the standing deployment — had
 * nothing watching it at all.
 *
 * Nothing detected it because every consistency check in here was satisfied. The
 * endpoint matched the catalogue, the checkpoint matched the endpoint, the log
 * queries returned real events, and `owner()` answered with the address the
 * config expected. A monitor cannot notice that it is pointed at the wrong
 * chain by cross-checking its own configuration, so this compares the
 * configuration against an external list instead.
 *
 * P1 and paging rather than exit 2, for the reason WATCHER-07 gives: exit 2
 * means "could not start", the workflow skips `report.mjs` on it, and the
 * loudest misconfiguration available would then produce a red Actions run that
 * nobody reads at ~6.5 passes a day. `refuseIfRetired()` is the right shape for
 * the drill scripts and the wrong shape here — hence `retiredChain()`, which
 * only answers the question.
 *
 * This fires on the catalogue rather than on the endpoint on purpose. Repointing
 * `MONITOR_RPC` at a live chain while leaving the addresses on the retired one
 * is a downgrade, not a fix: WATCHER-07 would start paging and the addresses
 * would still be wrong. The catalogue is the thing that has to move.
 */
const retiredTarget = retiredChain(CONFIG.chainId ?? chainId)
if (retiredTarget) {
  record('WATCHER-08', 'P1', true,
    `alerts.json targets chain ${CONFIG.chainId ?? chainId}, ${retiredTarget.name} — a chain this ` +
    `protocol has left. ${retiredTarget.left} Every address, topic and threshold below is about ` +
    `that deployment, so a green pass here is not evidence about the standing one. This is the ` +
    `one fault in this file that consistency cannot catch: the endpoint, the checkpoint and the ` +
    `addresses all agree with each other and all describe the wrong chain. Move the catalogue ` +
    `first (chainId plus the addresses block), then MONITOR_RPC and the MONITOR_* repository ` +
    `variables to match.`,
    { catalogueChainId: CONFIG.chainId ?? chainId, retired: retiredTarget.name })
}

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
/* WATCHER-06 — the checkpoint was written while watching a DIFFERENT factory.
 *
 * WATCHER-03 above asks "same chain?" and stops there, because until 2026-09-12
 * there had only ever been one factory on 4663 and "which one" was not a
 * question. The redeploy that day made it one, and nothing asked it: the
 * variables kept naming the retired pair for four days while every pass went
 * green. A retired factory is not a broken endpoint — it is a real contract that
 * answers `owner()` with the Safe and `paused()` with false and emits nothing,
 * because nothing uses it. So the monitor looked healthy in exactly the way a
 * monitor watching nothing looks healthy. Same shape as `checkStatusPage.mjs`
 * check 6b, same missing distinction: not testnet-vs-mainnet, but WHICH mainnet
 * deployment.
 *
 * The reset is wider than WATCHER-03's on purpose. `hooks` was harvested from
 * the old factory's launches and `treasuryBalance` is the old treasury's, so
 * both are about contracts this pass is no longer watching. `lastBlock` goes too:
 * those blocks were scanned, but scanned with the old addresses in the filters,
 * so the new pair's events inside them were never looked for. Dropping it falls
 * back to `head - MAX_SPAN`, which reaches a redeploy up to MAX_SPAN blocks old
 * and NOT one older than that — said here rather than assumed, because the fix
 * for an older one is a manual `--since`, not another pass.
 *
 * Detected here, where the previous values are still readable, and REPORTED
 * below once MAX_SPAN exists — the message has to name the window it is about to
 * rescan, and a finding that cannot say how far back it reached is not much of
 * one.
 */
const prevFactory = state.factory ?? null
const prevTreasury = state.treasury ?? null
const watchedPairChanged =
  (prevFactory != null && prevFactory !== FACTORY) ||
  (prevTreasury != null && prevTreasury !== TREASURY)

state.chainId = chainId
state.factory = FACTORY
state.treasury = TREASURY

/* WATCHER-05 — how long it had been since a pass ran at all.
 *
 * `state.lastRun` has been written on every pass since this file existed and
 * read by nothing, which made the one failure mode the host actually has
 * invisible from inside: the schedule is best-effort and stops when GitHub
 * decides, and the thing that would announce that is the thing that stopped.
 * Nothing here can make a pass happen. What it can do is make the gap a
 * finding once a pass does happen, so a responder reading a P0 knows whether
 * it was detected in minutes or in hours, and so a schedule that has died
 * announces itself on its first pass back instead of never.
 *
 * The threshold is deliberately far above the cadence the cron asks for.
 * Measured 2026-09-13 over 193.5 h of the 15-minute cron: 52 passes against an
 * expected 774, and consecutive passes 2.1 h apart at the closest and 7.2 h at
 * the widest. A threshold at the requested 15 minutes would therefore fire on
 * every single pass — §6's noise budget spent in full on a condition nobody can
 * act on, taking the P0s with it. 8 h is above the widest gap observed, so this
 * fires when the schedule has stopped rather than when it is merely as bad as
 * usual.
 *
 * 8 h was right only while GitHub's scheduler was the only host. That stopped
 * being the case on 2026-09-14, when `repository_dispatch` (see watch.yml and
 * /api/watch-ping) started arriving: three consecutive gaps of 15.3, 14.7 and
 * 15.1 min against a requested 15 — a cadence the cron never held once across
 * the 193.5 h above. Leaving the threshold at 8 h with a pinger that good
 * inverts the problem, because a pinger that dies then goes unreported for a
 * third of a day, which is most of what the second trigger was for.
 * `MONITOR_MAX_RUN_GAP_MIN` is therefore set to 60 in repository variables:
 * three missed pings before it speaks, detection within the hour instead of a
 * third of a day, and enough headroom for the queueing delay a dispatch still
 * inherits from Actions. Raise it if the platform gets worse. Tighten it
 * toward 45 once the pinger has a week behind it rather than an hour — the
 * sample it is set from is four passes long.
 *
 * `lastRunEvent` is what made that measurement possible at all. Without it the
 * gap is the only record of the schedule, and the gap cannot say WHICH host
 * closed it — so "the pinger is working" and "the cron happened to fire" are
 * the same observation.
 *
 * P1 and paging: a monitor that has not run for a third of a day is an outage of
 * the monitor, which is the same claim WATCHER-03 and -04 page for. It cannot
 * storm — one pass brings the gap back under the threshold, so an outage of any
 * length produces one page.
 */
const RUN_GAP_LIMIT_MIN = Number(process.env.MONITOR_MAX_RUN_GAP_MIN || 480)
// Set by Actions on every run; 'local' when a human runs the command.
const RUN_EVENT = process.env.GITHUB_EVENT_NAME || 'local'
const prevRunEvent = state.lastRunEvent || null
const prevRun = state.lastRun ? Date.parse(state.lastRun) : NaN
const runGapMin = Number.isFinite(prevRun) ? (Date.now() - prevRun) / 60_000 : null
if (runGapMin != null && runGapMin > RUN_GAP_LIMIT_MIN) {
  record('WATCHER-05', 'P1', true,
    `${(runGapMin / 60).toFixed(1)} h since the previous pass (${state.lastRun}), over the ` +
    `${(RUN_GAP_LIMIT_MIN / 60).toFixed(1)} h limit. Nothing in that window was watched until ` +
    `now, so anything this pass reports may have been true for up to that long — read every ` +
    `finding below as "first seen now", not "happened now". The previous pass was started by ` +
    `${prevRunEvent || 'an unrecorded trigger'} and this one by ${RUN_EVENT}; if neither is ` +
    `repository_dispatch then no host outside GitHub's scheduler is running this, which is the ` +
    `gap that made the window this wide.`,
    {
      gapMinutes: Math.round(runGapMin),
      limitMinutes: RUN_GAP_LIMIT_MIN,
      event: RUN_EVENT,
      previousEvent: prevRunEvent || undefined,
    })
}

// A window wider than the node will answer gets split. 1,000,000 blocks was
// accepted on the 46630 testnet node and, re-measured 2026-09-08 against
// https://rpc.mainnet.chain.robinhood.com, on mainnet too — address-scoped and
// address-less. Window width is not the constraint that moved; request *rate*
// is. Staying under 1M still keeps one pass to one call per topic after a long
// outage; the 250 ms floor in rpc.mjs is what stops the limiter eating those
// calls. A hardcoded sleep with no provenance is the thing someone deletes
// later, which is why the numbers live next to the measurement, not here.
const MAX_SPAN = Number(process.env.MONITOR_MAX_SPAN || 900_000)

// The other half of WATCHER-06; see the comment above `watchedPairChanged`.
if (watchedPairChanged) {
  record('WATCHER-06', 'P1', true,
    `The checkpoint was written while watching factory ${prevFactory} / treasury ` +
    `${prevTreasury}, and this pass watches ${FACTORY} / ${TREASURY}. Every pass between ` +
    `those two configurations reported on the old pair, so its greenness said nothing about ` +
    `the new one. The checkpoint, the harvested hooks and the treasury-balance baseline have ` +
    `been discarded; this pass rescans the most recent ${MAX_SPAN.toLocaleString()} blocks, ` +
    `so expect duplicates. If the redeploy is older than that window, run the workflow ` +
    `manually with a larger 'since' — no later pass will reach back on its own.`,
    { previousFactory: prevFactory, previousTreasury: prevTreasury })
  state.lastBlock = null
  state.hooks = []
  state.armedSince = null
  state.lastPiggybackBlock = null
  delete state.treasuryBalance
}

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

// One getLogs per address (and one address-less query for hook events).
// Per-topic0 queries walked the public endpoint into its 429 ceiling; OR-ing
// topic0s under an address filter is what the node already accepts as a
// single wide window. See monitoring/logQueries.mjs.
const logQueries = buildLogQueries(CONFIG.alerts, addressFor)
const LAUNCH_CREATED = CONFIG.alerts.find(a => a.event.startsWith('LaunchCreated'))

let logsSeen = 0
let logQueriesAttempted = 0
let logQueriesSucceeded = 0
for (const query of logQueries) {
  const filter = {
    fromBlock: hex(from),
    toBlock: hex(head),
    topics: query.topics,
  }
  if (query.address) filter.address = query.address

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
     *   - If the skipped query's alerts include any P0, this pages. An
     *     unchecked P0 is an outage of the monitor, not a gap to print.
     *   - P1/P2-only queries that fail still record WATCHER-02, still do
     *     not page. A PARAM-02 miss every cycle would spend the budget
     *     that exists to keep the P0s unmuted.
     *   - A pass that completed zero log queries is WATCHER-04 below,
     *     which always pages: zero logs after a total skip is a blind
     *     monitor, not a quiet chain. One finding, not one per topic, so
     *     a fully wedged endpoint does not also storm the issue tracker.
     */
    const blindsP0 = query.alerts.some(a => a.severity === 'P0')
    record('WATCHER-02', 'P1', blindsP0,
      `eth_getLogs failed for ${query.address || 'any-address'} ` +
      `(${query.alerts.map(a => a.id).join(', ')}): ${err.message}. ` +
      `These alerts were NOT checked this pass.`,
      { alerts: query.alerts.map(a => a.id) })
    continue
  }
  logQueriesSucceeded++
  logsSeen += logs.length

  for (const log of logs) {
    const owner = matchLog(query, log, addressFor)
    if (!owner) continue

    record(owner.id, owner.severity, owner.page === true,
      `${owner.event.split('(')[0]} at ${log.address}`,
      {
        block: Number(log.blockNumber),
        tx: log.transactionHash,
        playbook: owner.playbook || undefined,
        correlate: /^(GOV-|SWITCH-0[12])/.test(owner.id) || undefined,
      })

    if (LAUNCH_CREATED && String(owner.topic0).toLowerCase() === String(LAUNCH_CREATED.topic0).toLowerCase()) {
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
      `factory.owner() is ${owner}, expected ${EXPECTED_OWNER}`, { playbook: 'ownership: confirm the move against the Safe transaction history, and pause the factory if it was not authorised' })
  }
  if (pending !== '0x' + '0'.repeat(40)) {
    record('STATE-03', sev('STATE-03'), true,
      `factory.pendingOwner() is ${pending} — a transfer is mid-flight and can still be abandoned`,
      { playbook: 'ownership: confirm the move against the Safe transaction history, and pause the factory if it was not authorised' })
  }
  /* Paging, not a gap, since 2026-09-13. A gap prints in the summary of a run
   * that is otherwise green, and this workflow's own comment says nobody opens
   * one of those. Deleting this variable therefore turned off the check on the
   * single worst thing that can happen to this protocol — ownership moving away
   * from the Safe — and the only trace was a line in a log nobody reads.
   *
   * The precedent is the sweep that added this: two MONITOR_* variables went
   * STALE and four days of green passes said nothing.
   * A MONITOR_* variable going ABSENT is the same failure with a wider blast
   * radius, because a stale expectation still compares against something.
   *
   * It cannot storm: the variable is either set or it is not, so this is one
   * page until someone sets it, and it names the value to set it to. */
  if (!EXPECTED_OWNER) {
    record('STATE-03', 'P1', true,
      `MONITOR_EXPECTED_OWNER is unset, so factory.owner() is compared against nothing and ` +
      `STATE-03 cannot detect ownership moving away from the Safe — the P0 this check exists ` +
      `for. The chain currently answers ${owner}; if that is correct, set the variable to it. ` +
      `Until then this pass is not evidence that ownership is intact.`,
      { playbook: 'ownership: confirm the move against the Safe transaction history, and pause the factory if it was not authorised', observedOwner: owner })
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
  // Same change as STATE-03's, for the same reason. A rotated-away PoG signer is
  // how forged attestations get minted, so "compared against nothing" is not a
  // note in a summary.
  if (!EXPECTED_SIGNER) {
    record('STATE-04', 'P1', true,
      `MONITOR_EXPECTED_POG_SIGNER is unset, so factory.pogSigner() is compared against nothing ` +
      `and STATE-04 cannot detect the signer being rotated to an attacker's key. The chain ` +
      `currently answers ${signer}; if that is correct, set the variable to it.`,
      { observedSigner: signer })
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
  //
  // The comment above named both causes and the code could not tell them apart,
  // because the stored balance did not record WHICH contract it was read from.
  // Correcting MONITOR_TREASURY was therefore enough to fire this: measured
  // 2026-09-13 against the real state file, the retired treasury's recorded
  // 0.021017 ETH compared against the live one's 0.000000 produced
  // "balance fell ... with NO buyback event in this window" — a P0 drain alarm,
  // the loudest thing in the catalogue, caused by a variable edit. WATCHER-06
  // clears the baseline when it sees the pair change, but it cannot see a change
  // that predates the field, which is exactly the state the CI checkpoint was in
  // on the day the variables were corrected. So the baseline carries its subject
  // now: a reading from a different treasury is not a lower reading, it is a
  // reading of something else, and the only safe thing to do with it is to
  // re-baseline silently rather than to page.
  const baselineIsOfThisTreasury =
    state.treasuryBalance != null && state.treasuryBalanceOf === TREASURY
  if (state.treasuryBalance != null && !baselineIsOfThisTreasury) {
    gap('STATE-02', `balance baseline was read from ${state.treasuryBalanceOf ?? 'an unrecorded address'}, `
      + `not ${TREASURY} — re-baselining this pass instead of comparing across contracts`)
  }
  if (baselineIsOfThisTreasury) {
    const before = BigInt(state.treasuryBalance)
    if (treasuryBalance < before) {
      const spent = findings.some(f => /Buyback|Piggyback/.test(f.message))
      record('STATE-02', sev('STATE-02'), true,
        `ladderTreasury balance fell from ${(Number(before) / 1e18).toFixed(6)} to ` +
        `${(Number(treasuryBalance) / 1e18).toFixed(6)} ETH` +
        (spent ? ' — a buyback in this window explains it, confirm the amounts match'
               : ' with NO buyback event in this window'),
        { playbook: 'treasury: correlate the fall against buyback events in the same window before assuming a leak', correlate: true })
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

      /* PoolKey on Infinity is SIX members and `hooks` is the THIRD, not the last:
       *   (currency0, currency1, hooks, poolManager, fee, parameters)
       *
       * This read was `slice(4 * 64, 5 * 64)` with a comment describing Uniswap
       * V4's five-member key ending in `hooks`. Word 4 of the Infinity key is
       * `fee`, so the "hook address" it produced was the fee tier: 3000, i.e.
       * 0x0000000000000000000000000000000000000bb8. That address has no code,
       * `twapSqrtPriceX96()` on it fails, and the catch below reports the token as
       * having NO anti-sandwich bound. So STATE-07 — the only automated check on
       * a rule the contract deliberately does not enforce — could not detect the
       * condition it exists for, and paged a confident wrong answer about every
       * listed token on every pass instead. Found by running a pass against 97
       * rather than by reading, because both the code and its comment were
       * internally consistent; the comment described V4 and so did the offset.
       *
       * Same root cause as the 0x20CC mask above: an Infinity layout change that
       * leaves working-looking V4 code behind. That one was caught here and this
       * one was not, thirty lines apart.
       */
      const hook = asAddress(key.slice(2).slice(2 * 64, 3 * 64))

      /* Cross-checked against the factory's own token→hook mapping, which is a
       * different storage slot reached by a different call.
       *
       * A raw offset into an abi-encoded struct cannot notice that the struct
       * moved under it — that is precisely how the bug above survived the port —
       * so the offset is no longer the only thing asserting what this address is.
       * A mismatch is also a real finding on its own terms: `_poolKeyOf` is what
       * the buyback actually trades against, so it disagreeing with the token's
       * registered hook means the buyback venue is not the token's own pool.
       */
      const registered = asAddress(await call(FACTORY, 'tokenToHook(address)', word(BigInt(token))))
      if (hook !== registered) {
        record('STATE-07', sev('STATE-07'), pages('STATE-07'),
          `Ladder token ${token}: the pool key the treasury will buy through names hook ${hook}, ` +
          `but the factory registers this token's hook as ${registered}. Either the buyback venue ` +
          `is not this token's own pool, or this decode is reading the wrong word of PoolKey — ` +
          `check the second before acting on the first, because a PoolKey layout change presents ` +
          `exactly like this and has done once already.`,
          { playbook: 'STATE-07: removeLadderToken, wait for the TWAP to mature, then re-add' })
        continue
      }

      let twap
      try {
        twap = BigInt(await call(hook, 'twapSqrtPriceX96()'))
      } catch (err) {
        record('STATE-07', sev('STATE-07'), pages('STATE-07'),
          `Ladder token ${token}: twapSqrtPriceX96() on hook ${hook} did not answer ` +
          `(${err.message}). _buybackSqrtFloor catches that and falls back to UNBOUNDED, which ` +
          `is the same absent bound as a zero reading — treat this exactly like the zero case, ` +
          `and additionally ask why the hook stopped answering.`,
          { playbook: 'STATE-07: removeLadderToken, wait for the TWAP to mature, then re-add' })
        continue
      }
      if (twap === 0n) {
        record('STATE-07', sev('STATE-07'), pages('STATE-07'),
          `Ladder token ${token} has twapSqrtPriceX96() == 0 on hook ${hook}: the buyback's ` +
          `anti-sandwich bound is ABSENT, not loose. Remove it from the ladder until the TWAP matures.`,
          { playbook: 'STATE-07: removeLadderToken, wait for the TWAP to mature, then re-add' })
      }
    } catch (err) {
      // Could not even resolve this entry to a hook. Name the index, because the
      // whole point of this rewrite is that a skipped token is never silent.
      record('STATE-07', sev('STATE-07'), pages('STATE-07'),
        `Ladder token at index ${i} of ${count} could not be checked (${err.message}), so ` +
        `whether its buyback bound exists is UNKNOWN. Every other index was still checked.`,
        { playbook: 'STATE-07: removeLadderToken, wait for the TWAP to mature, then re-add' })
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
    if (!refundable) continue

    /* `canRefund()` is true only after the 7-day launch window lapses unused.
     * An abandoned launch that raised nothing is still refundable then, but
     * nobody is owed an announcement. Read the deposited quantity instead of
     * inferring depositors from the refund gate. */
    const deposited = BigInt(await call(hook, 'totalNativeDeposited()'))
    if (deposited === 0n) {
      gap('STATE-01', `${hook} is refundable but raised nothing, so no depositor is owed an announcement`)
      continue
    }

    record('STATE-01', sev('STATE-01'), pages('STATE-01'),
      `Hook ${hook} reports canRefund() == true with ${deposited} wei deposited. Depositors are ` +
      `owed the news that their exit is open; nothing on chain announces this.`,
      { playbook: 'tosh-status/MANUAL_INTERACTION.md §4' })
  } catch (err) {
    record('STATE-01', 'P2', false,
      `canRefund() / totalNativeDeposited() failed on ${hook}: ${err.message}`)
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
// Which trigger delivered this pass. Written even on a blind pass: the question
// "is anything other than the cron running this" is about the schedule, not
// about whether the scan could read the chain.
state.lastRunEvent = RUN_EVENT
// Written as a pair, always. A balance without the address it was read from is
// what let a variable edit look like a drain; the two must not be able to drift.
if (treasuryBalance != null) {
  state.treasuryBalance = treasuryBalance.toString()
  state.treasuryBalanceOf = TREASURY
}
if (!DRY) writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))

const ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 }
findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity])

for (const f of findings) console.log(JSON.stringify(f))

const paging = findings.filter(f => f.page)
console.error(
  `\n[watch] chain ${chainId} · blocks ${from.toLocaleString()}-${head.toLocaleString()} · ` +
  `${logsSeen} log(s) in ${logQueriesSucceeded}/${logQueriesAttempted} getLogs · ` +
  `${state.hooks.length} hook(s) known · ` +
  `${findings.length} finding(s), ${paging.length} paging`
)
if (/rpc\.mainnet\.chain\.robinhood\.com/i.test(RPC)) {
  console.error(
    '        MONITOR_RPC is the public 4663 endpoint, which Robinhood documents as\n' +
    '        rate-limited and not for production. Do not try to pace around it: measured\n' +
    '        2026-09-15, a laptop got 36/36 grouped getLogs accepted at 250 ms spacing\n' +
    '        while five of ten passes here were refused on the first one, eth_call\n' +
    '        working throughout. The variable is who asks, not how fast — a GitHub\n' +
    '        runner shares its IP range with every other runner, and no interval buys\n' +
    '        back an allowance a neighbour already spent. A keyed URL is metered per\n' +
    '        key — but not a free one: measured the same day, QuickNode Discover caps\n' +
    '        eth_getLogs at 5 blocks, Alchemy Free at 10, dRPC Free refuses 8,700, and\n' +
    '        a pass spans ~8,700. Only a paid tier does this job. See rpc.mjs.',
  )
}
// Printed on every pass, not only when WATCHER-05 fires. The threshold answers
// "has the schedule stopped"; this line is the only place the cadence the host
// actually delivers gets written down, and it is what a later measurement of it
// will be read against.
console.error(
  runGapMin == null
    ? `        first pass on this checkpoint — no previous run to measure a gap against ` +
      `(started by ${RUN_EVENT})`
    : `        ${(runGapMin / 60).toFixed(1)} h since the previous pass ` +
      `(${prevRunEvent || 'trigger unrecorded'} → ${RUN_EVENT}; ` +
      `WATCHER-05 fires past ${(RUN_GAP_LIMIT_MIN / 60).toFixed(1)} h)`
)
if (gaps.length > 0) {
  console.error(`        ${gaps.length} check(s) ran without being able to check:`)
  for (const g of gaps) console.error(`          ${g}`)
}
console.error('')

// A paging finding is the exit code a scheduler can act on without parsing.
process.exit(paging.length > 0 ? 1 : 0)
