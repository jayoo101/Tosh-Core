/**
 * gasHistory.test.ts ? offline guards for the Proof-of-Gas scan.
 *
 * Every upstream response is faked, so this runs in CI without touching the five
 * public explorers the real scan reads (`gasHistory.live.test.ts` does that,
 * opt-in). The fixtures reproduce the exact response shapes measured on
 * 2026-09-05, including the two that caused real defects: v1 returning
 * transactions in BOTH directions, and `startblock` being inclusive so a
 * boundary block appears in two consecutive windows.
 *
 * What each test is defending is stated on the test, because most of these
 * properties are ones where a broken implementation still returns a plausible
 * number ? and a plausible wrong number here is an allocation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { scanGasHistory, GasScanUnavailable, GAS_SCAN_CHAINS } from './gasHistory'
import {
  POG_GAS_FLOOR_WEI, POG_GAS_CAP_WEI, MAX_ALLOC_ETH_WEI, DEFAULT_GAS_TO_ETH_RATE,
  computeMaxAllocFromWei, isPogEligible, assertPogBandCoherent,
} from './pogQuota'

const USER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'

const GWEI = 1_000_000_000n

// ??? Fixtures ????????????????????????????????????????????????????????????????

/** One v2 item. `fee.value` is what the sender paid. */
function v2Item(from: string, feeWei: bigint) {
  return {
    from: { hash: from },
    fee: { value: feeWei.toString() },
    gas_used: '21000',
    gas_price: (feeWei / 21000n || 1n).toString(),
  }
}

/** A v2 page. `more: true` produces `next_page_params`, which is what tells the
 *  scanner the address is a heavy sender and v1 is needed. */
function v2Page(items: object[], more = false) {
  return {
    items,
    next_page_params: more ? { block_number: 1, index: 1 } : null,
  }
}

/** One v1 row. Note v1 has no fee total ? the scanner must multiply. */
function v1Row(from: string, gasUsed: bigint, gasPrice: bigint, block: number, hash: string) {
  return {
    hash,
    from,
    gasUsed: gasUsed.toString(),
    gasPrice: gasPrice.toString(),
    blockNumber: String(block),
  }
}

function v1Response(rows: object[]) {
  return { status: '1', message: 'OK', result: rows }
}

interface Route {
  match: (url: string) => boolean
  body: () => unknown
  status?: number
  /** Rate-limit headers, which decide whether a 429 is worth retrying. */
  headers?: Record<string, string>
}

let routes: Route[] = []
let requestLog: string[] = []

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input)
    requestLog.push(url)
    const route = routes.find(r => r.match(url))
    if (!route) throw new Error(`no fixture for ${url}`)
    const status = route.status ?? 200
    const headers = new Headers(route.headers ?? {})
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'x',
      headers,
      json: async () => route.body(),
    } as unknown as Response
  }))
}

/** Default: every chain answers "this address sent nothing", in one v2 page. */
function silentEverywhere() {
  routes = [{ match: u => u.includes('/api/v2/'), body: () => v2Page([]) }]
}

function isV2(url: string) { return url.includes('/api/v2/addresses/') }
function isV1(url: string) { return url.includes('action=txlist') }
/** Since the migration to the PRO API all five chains share one host and differ
 *  only in the first path segment (`api.blockscout.com/{chainId}/...`), so "which
 *  chain is this request for" is read from the path rather than the hostname. */
function chainIdOf(url: string) { return Number(new URL(url).pathname.split('/')[1]) }
function isChain(url: string, name: string) {
  return chainIdOf(url) === GAS_SCAN_CHAINS.find(c => c.chain === name)!.chainId
}

beforeEach(() => {
  requestLog = []
  installFetch()
  silentEverywhere()
})
afterEach(() => { vi.unstubAllGlobals() })

// ??? The band ????????????????????????????????????????????????????????????????

describe('the eligibility band', () => {
  it('is self-consistent: cap x rate lands exactly on the allocation ceiling', () => {
    // The guard that stops the three copies of this decision from drifting ?
    // this file's cap, MAX_ALLOC_ETH_WEI, and ToshFactory.maxPogAllocationLimit.
    expect(() => assertPogBandCoherent()).not.toThrow()
    expect(computeMaxAllocFromWei(POG_GAS_CAP_WEI, DEFAULT_GAS_TO_ETH_RATE))
      .toBe(MAX_ALLOC_ETH_WEI)
  })

  it('holds the numbers that were actually chosen', () => {
    expect(POG_GAS_FLOOR_WEI).toBe(50_000_000_000_000_000n)  // 0.05 ETH
    expect(POG_GAS_CAP_WEI).toBe(1_000_000_000_000_000_000n) // 1 ETH
    expect(DEFAULT_GAS_TO_ETH_RATE).toBe(0.1)                // 10 %
  })

  it('refuses anything below the floor, including one wei below', () => {
    expect(isPogEligible(POG_GAS_FLOOR_WEI - 1n)).toBe(false)
    expect(computeMaxAllocFromWei(POG_GAS_FLOOR_WEI - 1n, DEFAULT_GAS_TO_ETH_RATE)).toBe(0n)
    // and admits exactly at the floor
    expect(isPogEligible(POG_GAS_FLOOR_WEI)).toBe(true)
    expect(computeMaxAllocFromWei(POG_GAS_FLOOR_WEI, DEFAULT_GAS_TO_ETH_RATE))
      .toBe(5_000_000_000_000_000n) // 0.005 ETH
  })

  it('never exceeds the ceiling however large the history', () => {
    for (const gas of [POG_GAS_CAP_WEI, POG_GAS_CAP_WEI * 25n, 10n ** 24n]) {
      expect(computeMaxAllocFromWei(gas, DEFAULT_GAS_TO_ETH_RATE)).toBe(MAX_ALLOC_ETH_WEI)
    }
  })

  it('does the arithmetic in integers, so a wei-scale input is not rounded away', () => {
    // A float path (`Number(wei)/1e18` then `* rate * 1e18`) loses the low digits
    // of a figure this size. Two inputs one wei apart must not collapse together,
    // because the API route and scripts/pogSigner.ts must agree exactly.
    const a = 123_456_789_012_345_678n
    const b = a + 10n
    expect(computeMaxAllocFromWei(a, 0.1)).toBe(12_345_678_901_234_567n)
    expect(computeMaxAllocFromWei(b, 0.1)).toBe(12_345_678_901_234_568n)
    expect(computeMaxAllocFromWei(a, 0.1)).not.toBe(computeMaxAllocFromWei(b, 0.1))
  })

  it('treats a broken rate as zero rather than as a free allocation', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(computeMaxAllocFromWei(POG_GAS_CAP_WEI, bad)).toBe(0n)
    }
  })
})

// ??? The property the whole feature rests on ?????????????????????????????????

describe('what counts as gas the claimant paid', () => {
  it('ignores transactions the address received', async () => {
    // This is the difference between measuring what someone PAID and measuring
    // what happened to arrive at their address. Getting it wrong would credit
    // people for airdrops and hand every exchange deposit address a huge score.
    // It is also the exact reason `gas_usage_count` is unused.
    routes = [{
      match: isV2,
      body: () => v2Page([
        v2Item(OTHER, 5n * 10n ** 16n), // inbound, must not count
        v2Item(OTHER, 5n * 10n ** 16n),
        v2Item(USER, 1n * 10n ** 15n),  // the only one that is theirs
      ]),
    }]

    const h = await scanGasHistory(USER)
    expect(h.totalWei).toBe(5n * 10n ** 15n) // 0.001 on each of 5 chains
    expect(h.chains[0].sentTxs).toBe(1)
    expect(isPogEligible(h.totalWei)).toBe(false)
  })

  it('ignores inbound rows on the v1 path too, where the server does not filter', async () => {
    // v1 accepts `filter=from` and silently ignores it ? verified against a real
    // instance. So the from-side check has to be ours, on every row.
    routes = [
      { match: isV2, body: () => v2Page([v2Item(USER, 10n ** 15n)], true) }, // force v1
      {
        match: isV1,
        body: () => v1Response([
          v1Row(OTHER, 21_000n, 100n * GWEI, 10, '0xa'), // inbound
          v1Row(USER,  21_000n, 100n * GWEI, 11, '0xb'), // 0.0021 ETH
        ]),
      },
    ]

    const h = await scanGasHistory(USER)
    const perChain = 21_000n * 100n * GWEI
    expect(h.chains[0].weiSpent).toBe(perChain)
    expect(h.chains[0].sentTxs).toBe(1)
  })

  it('does not count a boundary block twice when windowing past the 10k wall', async () => {
    // `startblock` is INCLUSIVE ? verified: window 2 began on the block window 1
    // ended on. Without the hash de-dup those transactions are counted twice,
    // and double-counting is the one error direction that awards too much.
    const full = Array.from({ length: 10_000 }, (_, i) =>
      v1Row(USER, 21_000n, 1n * GWEI, i < 9_999 ? i + 1 : 9_999, `0x${i.toString(16)}`))
    // Two txs share the final block 9999: index 9998 and 9999.
    const boundaryHashes = ['0x270e', '0x270f']

    let window = 0
    routes = [
      { match: isV2, body: () => v2Page([v2Item(USER, 10n ** 15n)], true) },
      {
        match: isV1,
        body: () => {
          window++
          if (window % 2 === 1) return v1Response(full)
          // Window 2 repeats the boundary block, then stops (short page).
          return v1Response(boundaryHashes.map(h =>
            v1Row(USER, 21_000n, 1n * GWEI, 9_999, h)).slice(0, 2))
        },
      },
    ]

    const h = await scanGasHistory(USER)
    // 10,000 unique txs per chain, not 10,002.
    expect(h.chains[0].sentTxs).toBe(10_000)
    expect(h.chains[0].weiSpent).toBe(10_000n * 21_000n * GWEI)
  })
})

// ??? Cost control ????????????????????????????????????????????????????????????

describe('cost and early exit', () => {
  it('answers a spam-heavy address with one request per chain', async () => {
    // The burn address regression: v1 cannot filter by direction, so an address
    // with huge INBOUND volume used to fill all four windows with rows it never
    // sent ? 140 s, and then flagged `truncated` about a certain zero. The v2
    // probe is what makes this one cheap call.
    routes = [{ match: isV2, body: () => v2Page([v2Item(OTHER, 10n ** 17n)]) }]

    const h = await scanGasHistory(USER)
    expect(h.totalWei).toBe(0n)
    expect(h.truncated).toBe(false)
    expect(requestLog).toHaveLength(GAS_SCAN_CHAINS.length)
    expect(requestLog.every(isV2)).toBe(true)
  })

  it('stops touching later chains once the cap is reached', async () => {
    // Ethereum alone puts this wallet over the cap, so the remaining four
    // chains cannot change the answer and must not be read.
    routes = [
      {
        match: u => isV2(u) && isChain(u, 'Ethereum'),
        body: () => v2Page([v2Item(USER, POG_GAS_CAP_WEI * 2n)]),
      },
      { match: isV2, body: () => v2Page([]) },
    ]

    const h = await scanGasHistory(USER)
    expect(h.totalWei).toBeGreaterThanOrEqual(POG_GAS_CAP_WEI)
    expect(computeMaxAllocFromWei(h.totalWei, DEFAULT_GAS_TO_ETH_RATE)).toBe(MAX_ALLOC_ETH_WEI)
    expect(requestLog).toHaveLength(1)

    // Skipped chains are still reported, so the breakdown never implies an
    // absence it did not actually check.
    expect(h.chains).toHaveLength(5)
    expect(h.chains.filter(c => c.skipped)).toHaveLength(4)
    expect(h.chains.filter(c => c.skipped).every(c => c.weiSpent === 0n)).toBe(true)
  })

  it('uses v1 only for an address that proved it has a long send history', async () => {
    let v1Calls = 0
    routes = [
      {
        // Ethereum has a second page; the others do not.
        match: u => isV2(u) && isChain(u, 'Ethereum'),
        body: () => v2Page([v2Item(USER, 10n ** 15n)], true),
      },
      { match: isV2, body: () => v2Page([v2Item(USER, 10n ** 15n)]) },
      {
        match: isV1,
        body: () => { v1Calls++; return v1Response([v1Row(USER, 21_000n, 1n * GWEI, 1, '0xa')]) },
      },
    ]

    await scanGasHistory(USER)
    // Exactly one chain fell through to v1.
    expect(v1Calls).toBe(1)
    expect(requestLog.filter(isV1)).toHaveLength(1)
    expect(requestLog.filter(u => isV1(u) && isChain(u, 'Ethereum'))).toHaveLength(1)
  })
})

// ??? Failure direction ???????????????????????????????????????????????????????

describe('failure direction', () => {
  it('fails the whole scan when a chain cannot be read, rather than scoring it zero', async () => {
    // A partial sum is indistinguishable from a smaller wallet, and the
    // difference is money. So one unreachable chain has to take the scan down.
    routes = [
      {
        match: u => isChain(u, 'Optimism'),
        body: () => ({}),
        status: 500,
      },
      { match: isV2, body: () => v2Page([v2Item(USER, 10n ** 15n)]) },
    ]

    await expect(scanGasHistory(USER)).rejects.toThrow(GasScanUnavailable)
    await expect(scanGasHistory(USER)).rejects.toThrow(/Optimism/)
  })

  it('retries a 5xx before giving up', async () => {
    let attempts = 0
    routes = [{
      match: isV2,
      get status() { return ++attempts <= 2 ? 503 : 200 },
      body: () => v2Page([v2Item(USER, 10n ** 15n)]),
    } as Route]

    const h = await scanGasHistory(USER)
    expect(attempts).toBeGreaterThan(2)
    expect(h.totalWei).toBeGreaterThan(0n)
  })

  it('does not retry a 4xx, which is a request we built wrong', async () => {
    routes = [{ match: isV2, body: () => ({}), status: 404 }]
    await expect(scanGasHistory(USER)).rejects.toThrow(GasScanUnavailable)
    // One attempt per chain, no retry storm.
    expect(requestLog).toHaveLength(1)
  })

  it('stops knocking when a 429 says the budget refills in forty minutes', async () => {
    // Measured against the real hosts on 2026-09-05: unkeyed Arbitrum and Base
    // answer `x-ratelimit-limit: 10` with a reset near 2,370,000 ms and refuse
    // the tenth request. The retry loop backed off 400/800/1200 ms against that,
    // which spent three more of a budget that had none left and could not
    // recover inside the request ? three extra refusals aimed at a host that had
    // just asked us to stop.
    routes = [{
      match: isV2,
      body: () => ({ message: 'Too many requests.' }),
      status: 429,
      headers: { 'x-ratelimit-limit': '10', 'x-ratelimit-reset': '2370000' },
    }]

    await expect(scanGasHistory(USER)).rejects.toThrow(GasScanUnavailable)
    expect(requestLog).toHaveLength(1)
  })

  it('says which knob fixes a rate limit, in the error a human will read', async () => {
    routes = [{
      match: isV2,
      body: () => ({}),
      status: 429,
      headers: { 'x-ratelimit-limit': '10', 'x-ratelimit-reset': '2370000' },
    }]
    // Used to point at BLOCKSCOUT_API_KEY. Now that the key is mandatory rather
    // than an upgrade, a long reset means the tier is what ran out, so that is
    // what the message has to name for it to be actionable.
    await expect(scanGasHistory(USER)).rejects.toThrow(/dev\.blockscout\.com/)
  })

  it('names the missing key on a 402 instead of blaming the chain', async () => {
    // Unkeyed, api.blockscout.com answers 402 for every chain. Surfaced as
    // "could not read Ethereum" that sends whoever is on call to investigate
    // Ethereum, when the fault is an unset environment variable.
    routes = [{
      match: isV2,
      body: () => ({ error: 'Proceed with API key or make a X402 payment to continue' }),
      status: 402,
    }]
    await expect(scanGasHistory(USER)).rejects.toThrow(/BLOCKSCOUT_API_KEY is missing/)
    // Not retried: no number of attempts produces a key.
    expect(requestLog).toHaveLength(1)
  })

  it('names a rejected key on a 401, and does not retry that either', async () => {
    routes = [{ match: isV2, body: () => ({ error: 'Unauthorized' }), status: 401 }]
    await expect(scanGasHistory(USER)).rejects.toThrow(/BLOCKSCOUT_API_KEY was rejected/)
    expect(requestLog).toHaveLength(1)
  })

  it('still retries a 429 whose window is about to turn over anyway', async () => {
    // The distinction the fix rests on. A limit resetting in under a second is
    // worth waiting out; treating every 429 as fatal would throw away scans that
    // one backoff would have completed.
    let attempts = 0
    routes = [{
      match: isV2,
      get status() { return ++attempts <= 1 ? 429 : 200 },
      body: () => v2Page([v2Item(USER, 10n ** 15n)]),
      headers: { 'x-ratelimit-limit': '180', 'x-ratelimit-reset': '900' },
    } as Route]

    const h = await scanGasHistory(USER)
    expect(attempts).toBeGreaterThan(1)
    expect(h.totalWei).toBeGreaterThan(0n)
  })

  it('retries a 429 from a host that does not say when it resets', async () => {
    // No header means no evidence, and the old behaviour is the safe default:
    // back off and try, rather than fail a scan on a guess.
    let attempts = 0
    routes = [{
      match: isV2,
      get status() { return ++attempts <= 1 ? 429 : 200 },
      body: () => v2Page([v2Item(USER, 10n ** 15n)]),
    } as Route]

    const h = await scanGasHistory(USER)
    expect(attempts).toBeGreaterThan(1)
    expect(h.totalWei).toBeGreaterThan(0n)
  })

  it('reports truncation instead of pretending a bounded total is complete', async () => {
    // A history longer than the budget yields a lower bound. That is allowed ?
    // it can only under-award ? but it must be visible, because the caller
    // shows the figure to the user.
    const full = Array.from({ length: 10_000 }, (_, i) =>
      v1Row(USER, 1n, 1n, i + 1, `0x${i.toString(16)}`))
    routes = [
      { match: isV2, body: () => v2Page([v2Item(USER, 1n)], true) },
      { match: isV1, body: () => v1Response(full) },
    ]

    const h = await scanGasHistory(USER)
    expect(h.truncated).toBe(true)
    expect(h.chains.some(c => c.truncated)).toBe(true)
  })

  it('survives an unreadable OPTIONAL chain, as a flagged lower bound', async () => {
    // The asymmetry this encodes: an unreadable Ethereum can hide 24 ETH, while a
    // busy Robinhood account's fifty latest transactions measured 0.00403 ETH --
    // 8 % of the eligibility floor. Measured 2026-09-05, the 4663 leg answered
    // 1 request in 12 while Ethereum answered 12 in 12 on the same key, and its
    // own instance was down at the same moment, so this is the chain's indexer
    // rather than an access path. While it was fatal, its uptime was the uptime of
    // every genesis allocation.
    routes = [
      { match: u => isChain(u, 'Robinhood'), body: () => ({}), status: 503 },
      { match: isV2, body: () => v2Page([v2Item(USER, 10n ** 16n)]) },
    ]

    const h = await scanGasHistory(USER)

    // Four chains counted, the fifth reported rather than fatal.
    expect(h.totalWei).toBe(4n * 10n ** 16n)
    const rh = h.chains.find(c => c.chain === 'Robinhood')!
    expect(rh.unavailable).toBe(true)
    expect(rh.weiSpent).toBe(0n)
    // Not `skipped`: that means the cap was reached and looking was pointless,
    // which would imply the total is complete.
    expect(rh.skipped).toBe(false)
    // The total is a lower bound and has to say so.
    expect(rh.truncated).toBe(true)
    expect(h.truncated).toBe(true)
  })

  it('still fails the whole scan when a REQUIRED chain cannot be read', async () => {
    // The other half of the policy, and the half that protects the money. Every
    // required chain is tested rather than one representative, because the flag is
    // per-row and a single typo in the table would silently make a major chain
    // optional -- which is precisely the mistake that cannot be allowed to be
    // silent. One scan per chain, because each 503 costs the full retry backoff.
    for (const required of GAS_SCAN_CHAINS.filter(c => c.required)) {
      requestLog = []
      routes = [
        { match: u => isChain(u, required.chain), body: () => ({}), status: 503 },
        { match: isV2, body: () => v2Page([v2Item(USER, 10n ** 16n)]) },
      ]
      const err = await scanGasHistory(USER).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(GasScanUnavailable)
      expect((err as GasScanUnavailable).chain).toBe(required.chain)
    }
  }, 60_000)

  it('treats an unparseable response on the optional chain as unreadable, not as zero', async () => {
    // Where the boundary actually is, which is not where it looks. `getJson`
    // normalises every failure it sees -- timeouts, 5xx, a body that will not
    // parse -- into `GasScanUnavailable`, so a shape change on the optional chain
    // arrives as "could not read" and is flagged as a lower bound rather than
    // reported as a confident zero. That is the right outcome; the point of the
    // test is that it is the outcome, since "unparseable" is the plausible way for
    // this to happen in production and it must not read as "this wallet spent
    // nothing here".
    //
    // The `instanceof GasScanUnavailable` guard in `scanGasHistory` therefore
    // defends against a defect inside this module rather than anything a response
    // can trigger. It is kept because that is the case where turning an exception
    // into a zero would turn a bug into an allocation.
    routes = [
      {
        match: u => isChain(u, 'Robinhood'),
        body: () => { throw new TypeError('shape changed under us') },
      },
      { match: isV2, body: () => v2Page([v2Item(USER, 10n ** 16n)]) },
    ]

    const h = await scanGasHistory(USER)
    const rh = h.chains.find(c => c.chain === 'Robinhood')!
    expect(rh.unavailable).toBe(true)
    expect(rh.sentTxs).toBe(0)
    expect(h.truncated).toBe(true)
  }, 30_000)

  it('marks exactly one chain optional, and it is the one that was argued for', async () => {
    // A guard on the table itself. The exception is justified by a specific
    // measurement about one specific chain, so it must not spread by copy-paste.
    const optional = GAS_SCAN_CHAINS.filter(c => !c.required)
    expect(optional.map(c => c.chain)).toEqual(['Robinhood'])
    expect(optional.map(c => c.chainId)).toEqual([4663])
  })

  it('reports a cap-skipped chain as complete, not as a lower bound', async () => {
    // The distinction `unavailable` exists to preserve. Reaching the cap means
    // more reading cannot change the answer, so the total is final -- if that set
    // `truncated`, every heavy wallet would be told its figure was uncertain.
    routes = [
      {
        match: u => isV2(u) && isChain(u, 'Ethereum'),
        body: () => v2Page([v2Item(USER, POG_GAS_CAP_WEI * 2n)]),
      },
      { match: isV2, body: () => v2Page([]) },
    ]

    const h = await scanGasHistory(USER)
    expect(h.truncated).toBe(false)
    expect(h.chains.filter(c => c.skipped).every(c => c.unavailable === false)).toBe(true)
  })

  it('rejects a malformed address before spending a single request', async () => {
    await expect(scanGasHistory('nonsense')).rejects.toThrow(GasScanUnavailable)
    await expect(scanGasHistory('0x1234')).rejects.toThrow(GasScanUnavailable)
    expect(requestLog).toHaveLength(0)
  })
})

// ??? Upstream contract ???????????????????????????????????????????????????????

describe('the API key, which is what makes the scan deployable at all', () => {
  /**
   * The key is now the difference between working and not working at all, not a
   * higher ceiling: `api.blockscout.com` answers 402 unkeyed, so every chain
   * fails and therefore every scan does. "Is the key actually on the request" is
   * load-bearing, and it is exactly the kind of plumbing that silently does
   * nothing.
   *
   * Historical, and the reason the migration happened: unkeyed, the per-instance
   * Arbitrum and Base hosts granted ten requests per
   * ~40-minute window and 429'd on the eleventh, which capped the whole product at
   * roughly ten wallets an hour. A key is the difference between that and about
   * a thousand a day, so "is the key actually on the request" is load-bearing
   * rather than cosmetic ? and it is exactly the kind of plumbing that silently
   * does nothing.
   *
   * Read at module load, so these re-import rather than restub.
   */
  async function scanWithKey(key: string | undefined) {
    vi.resetModules()
    if (key === undefined) vi.stubEnv('BLOCKSCOUT_API_KEY', undefined as unknown as string)
    else vi.stubEnv('BLOCKSCOUT_API_KEY', key)
    const mod = await import('./gasHistory')
    await mod.scanGasHistory(USER)
    return mod
  }

  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  it('puts the key on every upstream request when one is configured', async () => {
    await scanWithKey('test-key-123')
    expect(requestLog.length).toBeGreaterThan(0)
    expect(requestLog.every(u => u.includes('apikey=test-key-123'))).toBe(true)
  })

  it('sends no apikey parameter at all when none is configured', async () => {
    await scanWithKey(undefined)
    expect(requestLog.length).toBeGreaterThan(0)
    expect(requestLog.some(u => u.includes('apikey'))).toBe(false)
  })

  it('escapes a key rather than splicing it into the query raw', async () => {
    await scanWithKey('a&b=c')
    expect(requestLog.every(u => u.includes('apikey=a%26b%3Dc'))).toBe(true)
  })

  it('refuses to start unkeyed when asked to assert, naming the variable', async () => {
    // The header used to promise this function existed while it did not, so an
    // unkeyed deployment's first symptom was every claimant getting a chain-level
    // failure. A caller that wants to fail at boot now can.
    vi.resetModules()
    vi.stubEnv('BLOCKSCOUT_API_KEY', undefined as unknown as string)
    const mod = await import('./gasHistory')
    expect(() => mod.assertScanKeyPresent()).toThrow(/BLOCKSCOUT_API_KEY/)
    expect(() => mod.assertScanKeyPresent()).toThrow(/check:blockscout/)

    vi.resetModules()
    vi.stubEnv('BLOCKSCOUT_API_KEY', 'k')
    const keyed = await import('./gasHistory')
    expect(() => keyed.assertScanKeyPresent()).not.toThrow()
  })

  it('latches the credit balance the host reports, so the next request can ration', async () => {
    // The daily credit budget, not the per-second rate, is what this tier runs
    // out of: 100k/day at ~20 credits a call. `/api/pog-scan` refuses new scans
    // near the floor, and it can only do that if a scan leaves its last reading
    // behind. Null before anything is observed, which must stay distinct from
    // zero -- an unknown budget read as an exhausted one would refuse everyone on
    // a cold start.
    vi.resetModules()
    vi.stubEnv('BLOCKSCOUT_API_KEY', 'k')
    const mod = await import('./gasHistory')
    expect(mod.lastObservedCredits()).toBeNull()

    routes = [{
      match: isV2,
      body: () => v2Page([]),
      headers: { 'x-credits-remaining': '4321' },
    }]
    await mod.scanGasHistory(USER)
    expect(mod.lastObservedCredits()).toBe(4321)
  })

  it('reads the credit balance off a 429 too, which is the response that matters most', async () => {
    // A budget exhausted for the day arrives as a refusal. If the reading were
    // only taken from successes, the one response that proves we are out would be
    // the one we failed to learn from.
    vi.resetModules()
    vi.stubEnv('BLOCKSCOUT_API_KEY', 'k')
    const mod = await import('./gasHistory')
    routes = [{
      match: isV2,
      body: () => ({}),
      status: 429,
      headers: { 'x-ratelimit-reset': '2370000', 'x-credits-remaining': '0' },
    }]
    // `mod.GasScanUnavailable`, not the one imported at the top of this file:
    // `resetModules` gives a fresh module registry, so the re-imported class is a
    // different identity and `instanceof` against the static import would fail
    // for a reason that has nothing to do with the behaviour under test.
    await expect(mod.scanGasHistory(USER)).rejects.toThrow(mod.GasScanUnavailable)
    expect(mod.lastObservedCredits()).toBe(0)
  })

  it('reports whether a key is present, since the scan ceiling depends on it', async () => {
    const withKey = await scanWithKey('k')
    expect(withKey.scanKeyPresent()).toBe(true)
    const without = await scanWithKey(undefined)
    expect(without.scanKeyPresent()).toBe(false)
  })
})

describe('assumptions about the upstream API', () => {
  it('asks v2 for the from-side only', async () => {
    await scanGasHistory(USER)
    expect(requestLog.every(u => u.includes('filter=from'))).toBe(true)
  })

  it('reads every chain from the one keyed host, addressed by chain id in the path', async () => {
    // The shape this migration settled on. Asserted because it was established
    // by probing a live key, not taken from the docs -- which describe a
    // `chain_id` query parameter that this deployment does not accept -- so a
    // tidy-up back to the documented form would 404 all five chains at once.
    await scanGasHistory(USER)
    expect(requestLog).toHaveLength(GAS_SCAN_CHAINS.length)
    for (const chain of GAS_SCAN_CHAINS) {
      expect(requestLog.some(u => u.startsWith(`https://api.blockscout.com/${chain.chainId}/api/`)))
        .toBe(true)
    }
  })

  it('spoofs no browser User-Agent, because nothing behind Cloudflare is read any more', async () => {
    // Robinhood Chain's own instance 403s a default Node fetch, so that leg used
    // to depend on impersonating Chrome -- a dependency on someone else's WAF
    // configuration, which by the failure rule would take every claimant's whole
    // scan down with it. The PRO API answers 4663 with no override, verified, so
    // the workaround is gone and this is what keeps it gone.
    await scanGasHistory(USER)
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const [, init] of calls) {
      expect((init.headers as Record<string, string>)['User-Agent']).toBeUndefined()
    }
  })

  it('prefers v2 fee.value over the gas product, since only the former holds L1 data fees', async () => {
    // On OP-stack, `gas_used * gas_price` omits the L1 data fee ? measured at
    // Re-measured on the PRO API over 50 transactions per chain: Optimism
    // under-counts by 2.30 % in aggregate and 49.09 % on its worst single
    // transaction, Base by 0.02 %, while Ethereum, Arbitrum and Robinhood come
    // out exact to the wei. Where v2 gives a total, that total wins.
    routes = [{
      match: isV2,
      body: () => v2Page([{
        from: { hash: USER },
        fee: { value: (10n ** 15n).toString() }, // authoritative
        gas_used: '21000',
        gas_price: '1',                          // product would be 21000 wei
      }]),
    }]

    const h = await scanGasHistory(USER)
    expect(h.chains[0].weiSpent).toBe(10n ** 15n)
  })

  it('falls back to the gas product when an instance omits the fee total', async () => {
    routes = [{
      match: isV2,
      body: () => v2Page([{
        from: { hash: USER },
        gas_used: '21000',
        gas_price: (1n * GWEI).toString(),
      }]),
    }]

    const h = await scanGasHistory(USER)
    expect(h.chains[0].weiSpent).toBe(21_000n * GWEI)
  })

  it('reads `from` whether it arrives as an object or a bare string', async () => {
    routes = [{
      match: isV2,
      body: () => v2Page([
        { from: USER, fee: { value: (10n ** 15n).toString() } },
        { from: { hash: USER.toUpperCase() }, fee: { value: (10n ** 15n).toString() } },
      ]),
    }]

    const h = await scanGasHistory(USER)
    expect(h.chains[0].sentTxs).toBe(2)
  })

  it('treats v1\'s "no transactions found" as zero, not as an error', async () => {
    // v1 signals an empty result as status "0" with a STRING result. Treating
    // that as a failure would fail the scan for every fresh wallet.
    routes = [
      { match: isV2, body: () => v2Page([v2Item(USER, 10n ** 15n)], true) },
      { match: isV1, body: () => ({ status: '0', message: 'No transactions found', result: null }) },
    ]

    const h = await scanGasHistory(USER)
    expect(h.chains[0].weiSpent).toBe(0n)
    expect(h.chains[0].truncated).toBe(false)
  })

  it('covers exactly the five chains that were agreed, and no others', async () => {
    expect(GAS_SCAN_CHAINS.map(c => c.chain))
      .toEqual(['Ethereum', 'Arbitrum', 'Optimism', 'Base', 'Robinhood'])
    expect(GAS_SCAN_CHAINS.map(c => c.chainId)).toEqual([1, 42161, 10, 8453, 4663])
  })
})
