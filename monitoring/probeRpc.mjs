/**
 * Capability probe for a monitoring RPC endpoint, and a survey of what the
 * catalogue actually matches on that chain.
 *
 * Two capabilities a monitor needs, and
 * the first is the one a node can refuse: `eth_getLogs` filtered by topic0 with
 * NO address, because hook addresses are unbounded and unknowable ahead of time
 * (§2.1). Providers variously cap the block range, require an address, or
 * truncate the result set silently. Each of those turns hook coverage into a
 * filter that returns nothing and reports success, which is the exact failure
 * shape the whole monitoring spec is written against.
 *
 * Every topic0 here is read from `monitoring/alerts.json` rather than written
 * down. A probe with a hand-copied hash proves only that the hash matches
 * itself: the first draft of this file used a fabricated LaunchCreated topic,
 * matched 1,706 unrelated logs, and looked like a successful result.
 *
 * Addresses follow the same `MONITOR_*` convention as `watch.mjs`. The first
 * mainnet cutover run of this probe ignored that, fell back to hardcoded
 * testnet factory/treasury addresses, and reported `factory.owner() =
 * 0x73db078f…` (the testnet deployer) plus "0 of 24 alerts have matching
 * history" against a mainnet RPC. The chain-mismatch note was the only reason
 * that was caught — it stays, and it is louder now. Hardcoded testnet
 * addresses are never used when the endpoint's chain id does not match
 * `alerts.json`.
 *
 * Transport is `rpc.mjs`, the same paced+retried client the watcher uses.
 * A `Promise.all` of `eth_getBlockByNumber` against
 * `https://rpc.mainnet.chain.robinhood.com` (measured 2026-09-08) threw
 * unhandled `Too Many Requests (code 429)` and crashed the probe. Concurrent
 * callers now queue; rate-limited bodies retry.
 *
 * Run:  node monitoring/probeRpc.mjs [rpcUrl]
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRpc } from './rpc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(HERE, 'alerts.json'), 'utf8'))

// argv[2] wins, then the watcher's MONITOR_RPC, then BSC_TESTNET_RPC, then
// the public chain-97 dataseed. A bare `node monitoring/probeRpc.mjs` must
// land on the chain alerts.json actually names (97), not a retired one.
// The chain-mismatch banner below still fires if those disagree.
const RPC = process.argv[2]
  || process.env.MONITOR_RPC
  || process.env.BSC_TESTNET_RPC
  || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'

const rpc = createRpc(RPC)

const hex = n => '0x' + n.toString(16)

console.log(`\nProbing ${RPC}`)

const chainId = Number(await rpc('eth_chainId'))
const head = Number(await rpc('eth_blockNumber'))
console.log(`  chain ${chainId} · head ${head.toLocaleString()}`)

const chainMatches = chainId === config.chainId
if (!chainMatches) {
  const banner = [
    '',
    '  ********************************************************************************',
    `  WARNING  alerts.json targets chain ${config.chainId}; this endpoint is ${chainId}.`,
    '           Address-scoped results below mean nothing until those match.',
    '           Hardcoded testnet factory/treasury fallbacks are NOT applied on a',
    '           mismatched chain — that is how a MONITOR_RPC pointed at mainnet',
    '           still probed 0x2E690A91… / 0x3Fd38489… and reported the testnet',
    '           deployer as owner.',
    '  ********************************************************************************',
    '',
  ].join('\n')
  console.log(banner)
  console.error(banner)
}

const envFactory = process.env.MONITOR_FACTORY || process.env.NEXT_PUBLIC_FACTORY_ADDRESS || ''
const envTreasury = process.env.MONITOR_TREASURY || process.env.NEXT_PUBLIC_TREASURY_ADDRESS || ''
const catalogFactory = config.addresses?.factory || ''
const catalogTreasury = config.addresses?.ladderTreasury || ''

let FACTORY = envFactory
let TREASURY = envTreasury
if (!FACTORY && chainMatches && catalogFactory) FACTORY = catalogFactory
if (!TREASURY && chainMatches && catalogTreasury) TREASURY = catalogTreasury

// Hardcoded 46630 addresses used to live here as the last-resort default.
// They are why `MONITOR_RPC` pointed at mainnet still probed
// 0x2E690A91… / 0x3Fd38489… and reported the testnet deployer as owner.
// They are not applied on a mismatched chain, and alerts.json is 4663, so
// they are not applied at all. Address-scoped rows skip instead.

if (!FACTORY || !TREASURY) {
  console.log(`  no factory/treasury address: set MONITOR_FACTORY / MONITOR_TREASURY`)
  console.log(`  (or NEXT_PUBLIC_*) — address-scoped rows below will be skipped.\n`)
}

// ── Capability 1: how wide a window will the node answer? ───────────────────

const LAUNCH_CREATED = config.alerts.find(a => a.event.startsWith('LaunchCreated'))
if (!LAUNCH_CREATED) throw new Error('alerts.json no longer carries a LaunchCreated alert')

async function widestSpan(filter) {
  for (const span of [1_000_000, 500_000, 100_000, 50_000, 10_000, 5_000, 1_000, 500, 100]) {
    try {
      const logs = await rpc('eth_getLogs', [{
        fromBlock: hex(Math.max(0, head - span)), toBlock: hex(head), ...filter,
      }])
      return { span, count: logs.length }
    } catch (err) {
      // "too many" used to match Too Many Requests and shrink the window.
      // Window width is not the constraint on mainnet (1,000,000-block
      // getLogs is accepted); rate is. A 429 after rpc.mjs retries is an
      // endpoint problem, not a span problem.
      if (err.rateLimited || /too many requests/i.test(err.message)) {
        return { error: err.message }
      }
      if (/range|limit|too many|exceed|large|result set/i.test(err.message)) continue
      return { error: err.message }
    }
  }
  return { error: 'every span from 1,000,000 down to 100 was refused' }
}

console.log(`\n  Address-less topic0 filter — the §2.1 requirement`)
console.log(`  topic0 ${LAUNCH_CREATED.topic0}  (${LAUNCH_CREATED.id} ${LAUNCH_CREATED.event})`)
const anyAddr = await widestSpan({ topics: [LAUNCH_CREATED.topic0] })
if (anyAddr.error) {
  console.log(`  REFUSED — ${anyAddr.error}`)
  console.log(`  Hook coverage by topic0 alone is unavailable here; §2.1 method 2 becomes mandatory.`)
} else {
  console.log(`  accepted over ${anyAddr.span.toLocaleString()} blocks · ${anyAddr.count} log(s)`)
}

if (FACTORY) {
  const scoped = await widestSpan({ address: FACTORY })
  console.log(`\n  Address-scoped filter on the factory`)
  console.log(`  ${scoped.error ? `REFUSED — ${scoped.error}` : `accepted over ${scoped.span.toLocaleString()} blocks · ${scoped.count} log(s)`}`)
} else {
  console.log(`\n  Address-scoped filter on the factory`)
  console.log(`  skipped — no factory address for this chain`)
}

// Block time sets how far behind a watcher drifts between polls. This is an
// Orbit chain, so a "15 minute" cadence is thousands of blocks, not dozens.
// Sequential on purpose: Promise.all against the mainnet endpoint 429s.
const bNow = await rpc('eth_getBlockByNumber', [hex(head), false])
const bThen = await rpc('eth_getBlockByNumber', [hex(Math.max(0, head - 1000)), false])
const secPerBlock = (Number(bNow.timestamp) - Number(bThen.timestamp)) / 1000
console.log(`\n  Block time ${secPerBlock.toFixed(3)} s · ~${Math.round(60 / (secPerBlock || 1)).toLocaleString()} blocks/min`)
if (!anyAddr.error) {
  console.log(`  One max-span call reaches back ~${((anyAddr.span * secPerBlock) / 3600).toFixed(1)} h`)
}

// ── Survey: what does each alert actually match here? ───────────────────────

const WINDOW = Math.min(anyAddr.span || 100_000, 1_000_000)
const from = Math.max(0, head - WINDOW)
console.log(`\n  Catalogue survey over the last ${WINDOW.toLocaleString()} blocks`)
console.log(`  (a zero is not a failure — most of these should never have fired)\n`)

const addressFor = { ToshFactory: FACTORY, ToshLadderTreasury: TREASURY }
const rows = []
for (const a of config.alerts) {
  const filter = { fromBlock: hex(from), toBlock: hex(head), topics: [a.topic0] }
  if (a.scope !== 'any-address') {
    const addr = addressFor[a.contract]
    if (!addr) { rows.push([a.id, a.severity, '—', `no address known for ${a.contract}`]); continue }
    filter.address = addr
  }
  try {
    const logs = await rpc('eth_getLogs', [filter])
    const where = a.scope === 'any-address' ? 'any' : a.contract.replace('Tosh', '')
    rows.push([a.id, a.severity, String(logs.length), `${where} · ${a.event.split('(')[0]}`])
  } catch (err) {
    rows.push([a.id, a.severity, 'ERR', err.message.slice(0, 48)])
  }
}

for (const [id, sev, n, what] of rows) {
  const mark = n === 'ERR' ? '!' : n === '0' ? ' ' : '*'
  console.log(`  ${mark} ${id.padEnd(10)}${sev.padEnd(4)}${n.padStart(4)}  ${what}`)
}

const fired = rows.filter(r => r[2] !== '0' && r[2] !== 'ERR' && r[2] !== '—')
const errored = rows.filter(r => r[2] === 'ERR')
console.log(`\n  ${fired.length} of ${rows.length} alerts have matching history here; ${errored.length} errored.`)

// ── Capability 2: eth_call, which all seven stateChecks need ────────────────

console.log(`\n  eth_call — the §7 capability providers most often lack`)

// Selectors are derived, not typed. The first draft hardcoded a guess for
// pogSigner() and got `execution reverted`, which reads exactly like "the
// function is gone" -- the same false alarm a state check would raise at 3am.
// The real selector is 0x436fee2b and the function was there all along.
const selector = sig => execFileSync('cast', ['sig', sig], { encoding: 'utf8' }).trim()

if (FACTORY) {
  for (const label of ['owner()', 'pendingOwner()', 'pogSigner()']) {
    try {
      const out = await rpc('eth_call', [{ to: FACTORY, data: selector(label) }, 'latest'])
      const addr = out && out.length >= 66 ? '0x' + out.slice(26, 66) : out
      console.log(`  ${`factory.${label}`.padEnd(26)}${addr}`)
    } catch (err) {
      console.log(`  ${`factory.${label}`.padEnd(26)}ERROR ${err.message.slice(0, 50)}`)
    }
  }
} else {
  console.log(`  factory view calls skipped — no factory address for this chain`)
}
if (TREASURY) {
  const bal = await rpc('eth_getBalance', [TREASURY, 'latest'])
  console.log(`  ${'treasury balance'.padEnd(26)}${(Number(BigInt(bal)) / 1e18).toFixed(6)} ETH`)
} else {
  console.log(`  treasury balance skipped — no treasury address for this chain`)
}
console.log('')
