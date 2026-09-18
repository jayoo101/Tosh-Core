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
 * Re-measured 2026-09-15, because that model stopped predicting the failures.
 * Five of ten consecutive CI passes were refused every `eth_getLogs` — all
 * three, on the first attempt, through four retries — while `eth_call` answered
 * normally in the same passes. Repeating the watcher's exact three grouped
 * queries from a laptop: 36/36 accepted, 0 refused, at 250, 1000, 2000 and
 * 4000 ms spacing alike.
 *
 * So the limiter is not counting our requests, and the pacing below cannot fix
 * this: it is metered per source IP and weighted by method, a GitHub runner
 * shares its range with every other runner, and the expensive method is the
 * first to be refused when a neighbour has spent the allowance. Tuning
 * `MONITOR_RPC_MIN_INTERVAL_MS` upward is the intuitive response and it is
 * wasted work — the knob is deliberately not plumbed into `watch.yml` for that
 * reason. The fix is a keyed endpoint, which is metered per key; Robinhood's own
 * docs call the public one unsuitable for production.
 *
 * A keyed FREE tier is not the fix, and this is the part worth writing down
 * because every provider's marketing implies otherwise. A pass needs
 * `eth_getLogs` over the ~8,700 blocks it spans, and the free tiers cap that
 * range rather than the rate. Measured 2026-09-15 against chain 4663:
 *
 *   QuickNode Discover  5 blocks   ("limited to a 5 range", code -32615)
 *   Alchemy Free        10 blocks  (their own docs, Robinhood Mainnet row)
 *   dRPC Free           refused 8,700 3/3, while reporting a 10,000 limit
 *
 * Note the last one: the message names a threshold the endpoint does not apply.
 * Chunking around a 10-block cap is not a way out either — 870 requests per
 * group per pass, ~2,600 a pass, ~250,000 a day, which no free allowance covers.
 * The public endpoint is the only one with NO range cap, which is why it worked
 * for as long as it did and why the failure, when it came, looked like nothing
 * about ranges.
 *
 * `MONITOR_RPC` is therefore a paid keyed endpoint (dRPC Growth, from
 * 2026-09-15): same three queries, 3/3 accepted, 81 logs on the first. That
 * makes the watcher depend on a prepaid balance for the first time — see
 * `docs/DEVELOPMENT.md` under "Watcher RPC" for what happens when it runs out.
 *
 * ── BSC testnet 97, measured 2026-09-18 ────────────────────────────────────
 *
 * The monitor moved to chain 97 on 2026-09-18 (see WATCHER-08 in watch.mjs for
 * why that was ten days late). The endpoint question did NOT travel with it, and
 * the answer on BSC is worse than on 4663.
 *
 * Against `https://data-seed-prebsc-1-s1.bnbchain.org:8545`:
 *
 *   - `eth_getLogs` is refused UNCONDITIONALLY: `-32005 limit exceeded`, 6 of 6
 *     identical one-block requests at 2,000 ms spacing.
 *   - a one-block window is refused exactly like a 200-block one, so this is
 *     neither the rate limit of 4663 nor the range cap of the free keyed tiers.
 *     The method is simply not served here.
 *
 * That distinction matters because it rules out both known workarounds. Pacing
 * cannot help a method that is never served, and chunking cannot help when the
 * smallest possible chunk is refused. The 24 log-based alerts in `alerts.json`
 * cannot run on this endpoint at any interval or window size. `eth_call` is
 * served normally, so the STATE-* checks and the `owner()`/`pogSigner()` reads
 * do work — the monitor is partially functional here rather than blind, and
 * WATCHER-02 and -04 say which half is missing on every pass.
 *
 * RESOLVED the same day. `MONITOR_RPC` was repointed at a keyed chain-97
 * endpoint and the next pass reported 12 logs in 3/3 getLogs, one hook harvested
 * from LaunchCreated, and no WATCHER-02 or -04 at all. The log-based half of the
 * catalogue is watched again.
 *
 * One thing that fix needed, and it is the more useful half of this note: the
 * workflow had been changed to prefer `BSC_TESTNET_RPC` over `MONITOR_RPC`,
 * which was correct while MONITOR_RPC held a 4663 key and became the thing
 * holding the monitor half-blind the moment it did not. `||` takes the first
 * non-empty value, BSC_TESTNET_RPC was still the dataseed, and the first pass
 * after the repoint reported 0/3 getLogs exactly as before — a precedence
 * written for one state of the secrets, silently wrong in the next. See the
 * MONITOR_RPC block in .github/workflows/watch.yml.
 *
 * Note also what the first working pass did: 900,000 blocks of chain-97 history
 * had never been scanned, so it filed three P0s — GOV-02, GOV-03 and GOV-06 —
 * all in block 131,563,800, all from the known deployer, two of them the
 * constructor's OwnershipTransferred(0 -> deployer) on contract creation and one
 * the deploy's own setFactory. That is the cold-start rescan behaving correctly,
 * not a governance incident, and it is what "correlate before acting" in the
 * GOV-* playbooks is for.
 *
 * What follows still earns its place. It is what makes a *single* caller behave,
 * and the 2026-09-08 incident it was written for was a real one.
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
