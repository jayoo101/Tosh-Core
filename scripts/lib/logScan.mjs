/**
 * getLogs against free BSC endpoints.
 *
 * WHY THIS IS NOT `withFallback` FROM ./bscProvider.mjs. That helper assumes an
 * endpoint either answers or is down, which holds for `eth_call` and is false for
 * `eth_getLogs`. Probing the public set (scripts/_probeLogs output, Sep 2026)
 * found three distinct behaviours that a single retry loop cannot tell apart:
 *
 *   - most dataseeds answer eth_call and getBlockNumber fine but refuse getLogs
 *     outright, so retrying them is pure latency;
 *   - the two that do serve logs cap the range hard — 2,000 blocks works,
 *     20,000 fails — so the fix for a failure is a SMALLER WINDOW, not another
 *     endpoint;
 *   - ranges fail transiently under load, where another endpoint IS the fix.
 *
 * So this keeps a list of endpoints known to serve logs, splits the span into
 * windows they accept, and — the part that matters for anything drawing a
 * conclusion from the result — RETURNS THE RANGES IT COULD NOT READ instead of
 * quietly returning a short list. A burn total that silently omits a third of
 * the chain is worse than no total at all, because it still looks like an answer.
 */
import { ethers } from 'ethers'

import { BSC_CHAIN_ID } from './bscProvider.mjs'

/** Ordered by how reliably they served a 2,000-block getLogs when probed. */
const LOG_RPCS = [
  process.env.BSC_LOG_RPC,
  process.env.BSC_ARCHIVE_RPC,
  'https://bsc.rpc.blxrbdn.com',
  'https://rpc-bsc.48.club',
].filter(Boolean)

/** The largest window every endpoint in LOG_RPCS accepted. Not a guess. */
export const MAX_LOG_SPAN = 2_000

const provider = (url) =>
  new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 })

export async function logHead() {
  const errors = []
  for (const url of LOG_RPCS) {
    try { return await provider(url).getBlockNumber() } catch (e) { errors.push(`${url}: ${e.shortMessage || e.message}`) }
  }
  throw new Error(`no log endpoint answered getBlockNumber\n  ${errors.join('\n  ')}`)
}

/**
 * Walk `[fromBlock, toBlock]` newest-first, yielding each window's logs as it
 * lands so a caller can stop early once it has seen enough.
 *
 * Newest-first is deliberate: the questions being asked here ("where did this
 * balance come from") are nearly always answered by recent activity, and
 * stopping early turns a 200-window scan into a 15-window one.
 *
 * @yields {{ logs: import('ethers').Log[], from: number, to: number, failed: boolean }}
 */
export async function* scanBack({ address, topics, fromBlock, toBlock, span = MAX_LOG_SPAN }) {
  for (let hi = toBlock; hi >= fromBlock; hi -= span) {
    const lo = Math.max(fromBlock, hi - span + 1)
    let got = null
    for (const url of LOG_RPCS) {
      try { got = await provider(url).getLogs({ address, topics, fromBlock: lo, toBlock: hi }); break } catch { /* next endpoint */ }
    }
    yield got === null
      ? { logs: [], from: lo, to: hi, failed: true }
      : { logs: got, from: lo, to: hi, failed: false }
  }
}
