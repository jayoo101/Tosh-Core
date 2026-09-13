/**
 * Shared JSON-RPC transport for `watch.mjs` and `probeRpc.mjs`.
 *
 * The 46630 testnet node accepted a tight loop of `eth_getLogs`. The 4663
 * public endpoint does not. Measured 2026-09-08 against
 * `https://rpc.mainnet.chain.robinhood.com`:
 *
 *   - identical `eth_getLogs` back-to-back, no delay: requests 1–6 succeed,
 *     request #7 returns a JSON-RPC error `Too Many Requests` (code 429).
 *     The limiter is a JSON-RPC *body* error on HTTP 200, not `res.status`.
 *   - the same loop with 250 ms between calls: 0 failures in 24.
 *   - `Promise.all` of the same calls: fails immediately.
 *   - window width is not the constraint — a 1,000,000-block `eth_getLogs`
 *     is accepted, address-scoped and address-less.
 *
 * So this transport does two things, and deleting either re-opens the 2026-09-08
 * mainnet-cutover incident (workflow run 34196807435): a 900k-block pass that
 * returned 0 logs, recorded non-paging WATCHER-02 for every topic, filed only
 * the expected WATCHER-03 cutover notice, and left the job green while every
 * P0 governance alert in the window went unchecked.
 *
 *   1. Pace. One in-flight request at a time, at least 250 ms since the previous
 *      start. Concurrent callers (the probe used to `Promise.all` two
 *      `eth_getBlockByNumber`s) queue rather than stampede.
 *   2. Retry a rate-limited response with exponential backoff, bounded: four
 *      retries, 500 ms × 2^attempt (500, 1000, 2000, 4000). A genuinely
 *      unavailable endpoint still throws after that bound. Other errors are
 *      not retried — a revert is a revert, not a 429.
 */

const MEASURED_ENDPOINT = 'https://rpc.mainnet.chain.robinhood.com'
const MEASURED_ON = '2026-09-08'

// 250 ms was the interval that produced 0/24 failures on the endpoint above.
const DEFAULT_MIN_INTERVAL_MS = 250
const DEFAULT_MAX_RETRIES = 4
const DEFAULT_BACKOFF_MS = 500

function isRateLimit(error) {
  if (error == null) return false
  if (typeof error === 'object') {
    if (Number(error.code) === 429) return true
    if (/too many requests/i.test(String(error.message || ''))) return true
  }
  return /too many requests/i.test(String(error))
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function createRpc(url, {
  minIntervalMs = Number(process.env.MONITOR_RPC_MIN_INTERVAL_MS) || DEFAULT_MIN_INTERVAL_MS,
  maxRetries = Number(process.env.MONITOR_RPC_MAX_RETRIES ?? DEFAULT_MAX_RETRIES),
  backoffMs = Number(process.env.MONITOR_RPC_BACKOFF_MS) || DEFAULT_BACKOFF_MS,
} = {}) {
  let seq = 0
  let tail = Promise.resolve()
  let lastStartedAt = 0
  // A 429 means 250 ms is no longer enough for the rest of this process.
  // Staying at the measured interval after the limiter has already fired is
  // how a pass burned its remaining retries on the next identical call.
  let intervalMs = minIntervalMs
  const MAX_INTERVAL_MS = 4_000

  async function once(method, params) {
    const wait = intervalMs - (Date.now() - lastStartedAt)
    if (wait > 0) await sleep(wait)
    lastStartedAt = Date.now()

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
    })

    let body
    try {
      body = await res.json()
    } catch {
      // The measured limiter answers HTTP 200 with a JSON-RPC error object.
      // An HTTP 429 with a non-JSON body is the other shape a CDN can throw;
      // treat it the same so a retry still happens.
      if (res.status === 429) {
        const err = new Error(`${method}: Too Many Requests (code 429)`)
        err.rateLimited = true
        throw err
      }
      throw new Error(`${method}: HTTP ${res.status} ${res.statusText || 'non-JSON response'}`)
    }

    if (body.error) {
      const code = body.error.code != null ? ` (code ${body.error.code})` : ''
      const err = new Error(`${method}: ${body.error.message}${code}`)
      err.rpcError = body.error
      err.rateLimited = isRateLimit(body.error) || res.status === 429
      throw err
    }
    return body.result
  }

  async function rpc(method, params = []) {
    const run = tail.then(async () => {
      let lastErr
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await once(method, params)
        } catch (err) {
          lastErr = err
          if (!err.rateLimited || attempt === maxRetries) throw err
          intervalMs = Math.min(Math.max(intervalMs * 2, backoffMs), MAX_INTERVAL_MS)
          await sleep(backoffMs * (2 ** attempt))
        }
      }
      throw lastErr
    })
    // A failed call must not stall the queue: later methods still have to run
    // so a single 429 that exhausted retries cannot freeze the rest of the pass.
    tail = run.then(() => {}, () => {})
    return run
  }

  Object.defineProperty(rpc, 'minIntervalMs', { get: () => intervalMs })
  rpc.maxRetries = maxRetries
  rpc.measuredAgainst = `${MEASURED_ENDPOINT} on ${MEASURED_ON}`
  return rpc
}
