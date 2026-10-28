/**
 * Event history for the dashboard, from plain `eth_getLogs`, cached on disk.
 *
 * v1 read history from Etherscan. v2 does not, for two reasons: the key this
 * repository holds is not valid for BSC, and every log the dashboard needs
 * comes from a short list of our own addresses, which public endpoints will
 * answer directly. What they will not do is answer the same way: observed on
 * 2026-10-28, `bsc-rpc.publicnode.com` served 50 000-block ranges, the
 * `dataseed` nodes refused every range with `limit exceeded`, `drpc` refused
 * anything on its free plan, and `1rpc` was out of quota. So each request is
 * walked across `candidateRpcs()` and the range halves on refusal.
 *
 * Each address keeps its own cursor. A hook created yesterday has to be read
 * from its own creation block, not from wherever the factories' cursor has got
 * to, or its first buys would never be seen. Its start block comes from the
 * factory's `LaunchCreated` log, which is why the factories are synced first.
 *
 * The cache lives in the OS temp directory rather than the repository: it is
 * a copy of public chain data, and a file that changes on every page load does
 * not belong in `git status`.
 */

import { ethers } from 'ethers'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { candidateRpcs, BSC_CHAIN_ID } from '../lib/bscProvider.mjs'

const CACHE_PATH = join(tmpdir(), `toshx-dashboard-logs-${BSC_CHAIN_ID}.json`)
const CACHE_VERSION = 1
const MAX_SPAN = 20_000
const MIN_SPAN = 500

/** `{ version, cursors: { [address]: lastBlockRead }, logs: [...] }`. */
function loadCache() {
  if (!existsSync(CACHE_PATH)) return { version: CACHE_VERSION, cursors: {}, logs: [] }
  try {
    const c = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    if (c.version === CACHE_VERSION) return c
  } catch { /* a torn write; start over */ }
  return { version: CACHE_VERSION, cursors: {}, logs: [] }
}

const providers = new Map()
function providerFor(url) {
  if (!providers.has(url)) {
    providers.set(url, new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 }))
  }
  return providers.get(url)
}

/** One range, tried on every endpoint before giving up on it. */
async function getLogsAnywhere(filter) {
  const failures = []
  for (const url of candidateRpcs()) {
    try {
      return await providerFor(url).send('eth_getLogs', [filter])
    } catch (e) {
      failures.push(`${url}: ${(e.shortMessage || e.message || '').slice(0, 120)}`)
    }
  }
  const err = new Error(`eth_getLogs refused by every endpoint:\n  ${failures.join('\n  ')}`)
  err.refused = true
  throw err
}

const hex = (n) => '0x' + n.toString(16)

/** Read `addresses` from `from` to `to`, halving the span whenever it is refused. */
async function readRange(addresses, from, to, out) {
  let start = from
  let span = MAX_SPAN
  while (start <= to) {
    const end = Math.min(to, start + span - 1)
    try {
      const logs = await getLogsAnywhere({ address: addresses, fromBlock: hex(start), toBlock: hex(end) })
      for (const l of logs) {
        out.push({
          address: l.address.toLowerCase(),
          topics: l.topics,
          data: l.data,
          block: parseInt(l.blockNumber, 16),
          tx: l.transactionHash,
          index: parseInt(l.logIndex, 16),
        })
      }
      start = end + 1
    } catch (e) {
      if (!e.refused || span <= MIN_SPAN) throw e
      span = Math.max(MIN_SPAN, Math.floor(span / 2))
    }
  }
}

/**
 * Bring every address in `starts` up to `head`.
 *
 * @param {Record<string, number>} starts  address -> first block worth reading
 * @param {number} head
 * @returns {Promise<{ logs: object[], cachePath: string, fetched: number }>}
 */
export async function syncLogs(starts, head) {
  const cache = loadCache()
  const groups = new Map()
  for (const [addr, first] of Object.entries(starts)) {
    const a = addr.toLowerCase()
    const from = Math.max(first, (cache.cursors[a] ?? first - 1) + 1)
    if (from > head) continue
    if (!groups.has(from)) groups.set(from, [])
    groups.get(from).push(a)
  }

  const fresh = []
  for (const [from, addresses] of [...groups.entries()].sort((x, y) => x[0] - y[0])) {
    await readRange(addresses, from, head, fresh)
    for (const a of addresses) cache.cursors[a] = head
  }

  if (fresh.length || groups.size) {
    const seen = new Set(cache.logs.map((l) => `${l.tx}:${l.index}`))
    for (const l of fresh) if (!seen.has(`${l.tx}:${l.index}`)) cache.logs.push(l)
    cache.logs.sort((x, y) => x.block - y.block || x.index - y.index)
    writeFileSync(CACHE_PATH, JSON.stringify(cache))
  }
  return { logs: cache.logs, cachePath: CACHE_PATH, fetched: fresh.length }
}
