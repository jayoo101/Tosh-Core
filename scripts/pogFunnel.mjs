#!/usr/bin/env node
/**
 * How many wallets actually cleared the Proof-of-Gas floor.
 *
 * WHY THIS SCRIPT EXISTS
 *
 * Nothing in production aggregates scan outcomes. `/api/pog-scan` computes
 * `eligible` on every scan and hands it to the browser, and the only server-side
 * trace is one Upstash key per address that expires after 48 hours
 * (`scanJobStore.ts`). There is no counter, no analytics event and no Supabase
 * row, so the question "what fraction of people who tried were allowed in" has
 * no stored answer — which is an uncomfortable gap for the one number that
 * decides whether the raise has a funnel or a wall.
 *
 * What IS durable is the on-chain end: `ToshFactory.registerPoG` emits
 * `PoGRegistered(address,uint256)` for every wallet that cleared the floor and
 * put its quota on chain. That is a permanent, complete census of everyone who
 * got through, and it needs no credentials to read.
 *
 * WHAT THIS CAN AND CANNOT TELL YOU
 *
 * It counts the numerator of the funnel, not the denominator. A wallet that
 * scanned, came back below the floor and left is invisible here — so this
 * measures "how many passed", and pairing it with scan attempts (the Upstash
 * rate-limit counters) is what turns it into a rate. Read the two together.
 *
 * Usage:
 *   MM_RPC_URL=https://… node scripts/pogFunnel.mjs
 *   MM_RPC_URL=https://… node scripts/pogFunnel.mjs --factory=0x… --from=123000000
 */

import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'

const FACTORY = process.env.POG_FACTORY || '0x20dE906A96FfB89BE6fd6267A0876A68017792F7'

/**
 * Endpoints to try, in order, with `MM_RPC_URL` first when it is set.
 *
 * A list rather than a constant because the public BSC endpoints fail in ways a
 * single URL cannot survive: `bsc-dataseed.bnbchain.org` answers `cast` happily
 * while resetting Node's TLS connection outright, and the others rate-limit or
 * drop `eth_getLogs` under any sustained scan. A log census walks millions of
 * blocks, so "mostly up" is not good enough — the scan either completes or the
 * numbers it prints are quietly short.
 */
const RPCS = [
  process.env.MM_RPC_URL,
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc.drpc.org',
  'https://binance.llamarpc.com',
].filter(Boolean)

/** `PoGRegistered(address indexed user, uint256 quota)` — ToshFactory.sol:590 */
const TOPIC0 = ethers.id('PoGRegistered(address,uint256)')

/** Quota is denominated in the quote asset, which carries 8 decimals. */
const QUOTE_DECIMALS = 8

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.slice(2).split('=')
    return [k, v ?? true]
  }),
)

const factory = ethers.getAddress(args.factory || FACTORY)

/**
 * The first endpoint that can answer a trivial request.
 *
 * `staticNetwork` matters here: without it ethers opens with a network-detection
 * round trip, and on a host that resets TLS that failure surfaces as "failed to
 * detect network" rather than as the connection error it is — which sends you
 * looking at the chain id instead of at the socket.
 */
async function firstLiveProvider() {
  const failures = []
  for (const url of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true })
      await p.getBlockNumber()
      return { provider: p, url }
    } catch (e) {
      failures.push(`${url}: ${e.shortMessage || e.message}`)
    }
  }
  throw new Error(`no usable RPC:\n    ${failures.join('\n    ')}`)
}

const { provider, url: rpcUrl } = await firstLiveProvider()

/**
 * The block the factory was deployed in, from Foundry's broadcast record.
 *
 * ⚠ DO NOT REPLACE THIS WITH A BISECTION ON `getCode`. That was the first
 *   version and it produced a confidently wrong answer: the public BSC
 *   endpoints are not archive nodes, so `getCode` at any historical height
 *   comes back empty or errors, and a bisection that treats "no code" as "too
 *   early" walks every probe toward the chain head. It converged 94 blocks
 *   below head — 247,000 blocks AFTER the real deployment — scanned that sliver,
 *   found nothing, and reported "nobody has registered a quota", which is a
 *   sentence that would have sent someone to rewrite a working gate.
 *
 * The broadcast JSON is the deployment's own record of itself, written by the
 * script that did the deploying, and it needs no archive access to read.
 */
function deploymentBlockFromBroadcast() {
  const path = new URL('../broadcast/DeployMainnet.s.sol/56/run-latest.json', import.meta.url)
  let record
  try {
    record = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(
      `cannot read the mainnet broadcast record (${e.message}).\n`
      + '    Pass --from=<block> instead. Do not guess: a start block after the\n'
      + '    first registration silently under-counts rather than failing.',
    )
  }

  const creation = record.transactions?.find(
    (t) => t.contractAddress?.toLowerCase() === factory.toLowerCase()
      && t.transactionType === 'CREATE',
  )
  const hash = creation?.hash
  const receipt = hash && record.receipts?.find((r) => r.transactionHash === hash)
  if (receipt?.blockNumber) return Number(BigInt(receipt.blockNumber))

  // The factory is not in this record — a different deployment, or an address
  // passed with --factory. Falling back to the earliest block the record knows
  // about is still sound (it cannot be later than a contract this record
  // deployed) and is loudly reported rather than assumed.
  const earliest = record.receipts
    ?.map((r) => Number(BigInt(r.blockNumber)))
    .sort((a, b) => a - b)[0]
  if (!earliest) throw new Error('broadcast record has no receipts to date the deployment from')
  console.log(`  note      ${factory} is not the factory in the broadcast record;`)
  console.log(`            starting from that deployment's first block instead`)
  return earliest
}

/**
 * Read the log history through Etherscan's v2 API.
 *
 * WHY THIS PATH EXISTS AT ALL
 *
 * Because the JSON-RPC one does not work for this query on any free endpoint.
 * Measured, not assumed — eight public BSC endpoints were probed against this
 * exact filter at 1,000 and 200 block spans and every one refused: publicnode
 * answers `-32602 Archive requests require a personal token`, the dataseed
 * nodes return an error ethers cannot even parse, drpc 400s, blastapi
 * rate-limits. The census reaches back 247,000 blocks to the factory's
 * deployment, and log history that old is a paid feature essentially
 * everywhere.
 *
 * Etherscan's `logs` module serves it, and the key stays on the machine that
 * runs this — which is the point. Nothing here prints or transmits it.
 */
async function scanLogsViaEtherscan(from, to, apiKey) {
  const out = []
  const PAGE = 1000 // Etherscan's per-page ceiling for this module.
  let page = 1
  while (true) {
    const url = 'https://api.etherscan.io/v2/api'
      + `?chainid=56&module=logs&action=getLogs&address=${factory}`
      + `&topic0=${TOPIC0}&fromBlock=${from}&toBlock=${to}`
      + `&page=${page}&offset=${PAGE}&apikey=${apiKey}`

    const res = await fetch(url)
    if (!res.ok) throw new Error(`Etherscan HTTP ${res.status}`)
    const body = await res.json()

    // `status: '0'` is both "nothing found" and "something went wrong", told
    // apart only by the message. Treating the former as an error would report a
    // healthy empty range as a failure; treating the latter as empty would
    // report a broken key as "nobody qualified", which is the worse mistake.
    if (body.status === '0') {
      const msg = String(body.message || body.result || '')
      if (/no records found/i.test(msg)) break
      throw new Error(`Etherscan: ${msg} ${typeof body.result === 'string' ? body.result : ''}`.trim())
    }

    const batch = Array.isArray(body.result) ? body.result : []
    out.push(...batch)
    process.stderr.write(`\r  reading page ${page} … ${out.length} events`)
    if (batch.length < PAGE) break
    page += 1
  }
  process.stderr.write('\r\x1b[K')
  return out
}

/**
 * Pull logs in windows, shrinking on rejection.
 *
 * Public BSC nodes disagree about the largest `eth_getLogs` range they will
 * serve and several answer an over-wide request with a generic error rather
 * than a documented one, so the window adapts instead of assuming. Halving on
 * failure also rescues the case where a range is fine by width but too dense
 * by result count.
 */
async function scanLogs(from, to) {
  const out = []
  let span = 5_000
  let cursor = from
  while (cursor <= to) {
    const end = Math.min(cursor + span - 1, to)
    try {
      const logs = await provider.getLogs({ address: factory, topics: [TOPIC0], fromBlock: cursor, toBlock: end })
      out.push(...logs)
      cursor = end + 1
      // Creep back up so one dense stretch does not slow the whole scan.
      if (span < 5_000) span = Math.min(5_000, span * 2)
    } catch (e) {
      if (span <= 100) throw new Error(`getLogs failed even at 100 blocks near ${cursor}: ${e.message}`)
      span = Math.floor(span / 2)
    }
    process.stderr.write(`\r  scanning ${cursor}/${to} … ${out.length} events`)
  }
  process.stderr.write('\r\x1b[K')
  return out
}

const latest = await provider.getBlockNumber()
const from = args.from ? Number(args.from) : deploymentBlockFromBroadcast()

const apiKey = process.env.ETHERSCAN_API_KEY

console.log(`\nPoGRegistered census`)
console.log(`  rpc       ${rpcUrl}`)
console.log(`  logs via  ${apiKey ? 'Etherscan v2 (ETHERSCAN_API_KEY is set)' : 'JSON-RPC eth_getLogs — likely to be refused'}`)
console.log(`  factory   ${factory}`)
console.log(`  blocks    ${from} → ${latest}  (${(latest - from).toLocaleString()} blocks)`)

let raw
try {
  raw = apiKey
    ? await scanLogsViaEtherscan(from, latest, apiKey)
    : await scanLogs(from, latest)
} catch (e) {
  console.error(`\n  ✗ could not read the log history: ${e.message}\n`)
  if (!apiKey) {
    console.error('  No free BSC endpoint serves logs this far back. Set a key and retry:')
    console.error('      $env:ETHERSCAN_API_KEY="…"; node scripts/pogFunnel.mjs')
    console.error('  The key is read from the environment and is never printed or sent anywhere else.\n')
  }
  process.exit(1)
}

/**
 * One shape for both sources.
 *
 * Etherscan returns `blockNumber` as a hex string while JSON-RPC returns a
 * number, and a census that sorted or printed those interchangeably would look
 * fine right up until the block column read `0x75a...`.
 */
const logs = raw.map((l) => ({
  topics: l.topics,
  data: l.data,
  blockNumber: typeof l.blockNumber === 'string' ? Number(BigInt(l.blockNumber)) : l.blockNumber,
}))

// `registerPoG` only ever raises a quota, and emits on every call — so the same
// wallet can appear more than once. Collapsing to the highest quota per wallet
// is what makes this a census of people rather than of transactions.
const byWallet = new Map()
for (const log of logs) {
  const user = ethers.getAddress('0x' + log.topics[1].slice(26))
  const quota = BigInt(log.data)
  const prev = byWallet.get(user)
  if (!prev || quota > prev.quota) byWallet.set(user, { quota, block: log.blockNumber })
}

const wallets = [...byWallet.entries()].sort((a, b) => (b[1].quota > a[1].quota ? 1 : -1))
const quotas = wallets.map(([, v]) => v.quota)
const total = quotas.reduce((a, b) => a + b, 0n)
const fmt = (v) => Number(ethers.formatUnits(v, QUOTE_DECIMALS)).toLocaleString('en-US', { maximumFractionDigits: 4 })

console.log(`\n  registrations     ${logs.length}`)
console.log(`  unique wallets    ${wallets.length}   ← everyone who cleared the floor`)

if (wallets.length === 0) {
  console.log(`\n  Nobody has registered a quota. Either the floor is admitting no one,`)
  console.log(`  or the scan is never reaching the signing step.\n`)
  process.exit(0)
}

console.log(`  total quota       ${fmt(total)} quote units`)
console.log(`  median quota      ${fmt(quotas[Math.floor(quotas.length / 2)])}`)
console.log(`  largest           ${fmt(quotas[0])}`)
console.log(`  smallest          ${fmt(quotas[quotas.length - 1])}`)

// The ceiling is a live config value, but the default is 46.4 quote units. A
// wallet sitting exactly there was capped rather than measured, which matters:
// a population bunched at the ceiling and a population spread below it call for
// opposite changes to the floor.
const CEILING = 464n * 10n ** 7n
const atCeiling = quotas.filter(q => q >= CEILING).length
console.log(`  at the ceiling     ${atCeiling} of ${wallets.length}  (${((atCeiling / wallets.length) * 100).toFixed(1)}%)`)

console.log(`\n  Wallets`)
for (const [addr, v] of wallets) {
  console.log(`    ${addr}  ${fmt(v.quota).padStart(12)}  block ${v.block}`)
}

console.log(`\n  This is the numerator. For a qualification RATE, pair it with scan`)
console.log(`  attempts from the Upstash counters (tosh:rl:pog-scan:global:*).\n`)
