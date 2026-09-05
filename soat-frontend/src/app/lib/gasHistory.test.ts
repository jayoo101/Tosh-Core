/**
 * gasHistory.test.ts — offline guards for the Proof-of-Gas scan.
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
 * number — and a plausible wrong number here is an allocation.
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

/** One v1 row. Note v1 has no fee total — the scanner must multiply. */
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

interface Route { match: (url: string) => boolean; body: () => unknown; status?: number }

let routes: Route[] = []
let requestLog: string[] = []

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input)
    requestLog.push(url)
    const route = routes.find(r => r.match(url))
    if (!route) throw new Error(`no fixture for ${url}`)
    const status = route.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'x',
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
function hostOf(url: string) { return new URL(url).host }
function chainHost(name: string) {
  return new URL(GAS_SCAN_CHAINS.find(c => c.chain === name)!.host).host
}

beforeEach(() => {
  requestLog = []
  installFetch()
  silentEverywhere()
})
afterEach(() => { vi.unstubAllGlobals() })

// ─── The band ────────────────────────────────────────────────────────────────

describe('the eligibility band', () => {
  it('is self-consistent: cap x rate lands exactly on the allocation ceiling', () => {
    // The guard that stops the three copies of this decision from drifting —
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

// ─── The property the whole feature rests on ─────────────────────────────────

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
    // v1 accepts `filter=from` and silently ignores it — verified against a real
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
    // `startblock` is INCLUSIVE — verified: window 2 began on the block window 1
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
          return v1Response(boundaryHashes.map((h, i) =>
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

// ─── Cost control ────────────────────────────────────────────────────────────

describe('cost and early exit', () => {
  it('answers a spam-heavy address with one request per chain', async () => {
    // The burn address regression: v1 cannot filter by direction, so an address
    // with huge INBOUND volume used to fill all four windows with rows it never
    // sent — 140 s, and then flagged `truncated` about a certain zero. The v2
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
        match: u => isV2(u) && hostOf(u) === chainHost('Ethereum'),
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
        match: u => isV2(u) && hostOf(u) === chainHost('Ethereum'),
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
    expect(requestLog.filter(u => isV1(u) && hostOf(u) === chainHost('Ethereum'))).toHaveLength(1)
  })
})

// ─── Failure direction ───────────────────────────────────────────────────────

describe('failure direction', () => {
  it('fails the whole scan when a chain cannot be read, rather than scoring it zero', async () => {
    // A partial sum is indistinguishable from a smaller wallet, and the
    // difference is money. So one unreachable chain has to take the scan down.
    routes = [
      {
        match: u => hostOf(u) === chainHost('Optimism'),
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

  it('reports truncation instead of pretending a bounded total is complete', async () => {
    // A history longer than the budget yields a lower bound. That is allowed —
    // it can only under-award — but it must be visible, because the caller
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

  it('rejects a malformed address before spending a single request', async () => {
    await expect(scanGasHistory('nonsense')).rejects.toThrow(GasScanUnavailable)
    await expect(scanGasHistory('0x1234')).rejects.toThrow(GasScanUnavailable)
    expect(requestLog).toHaveLength(0)
  })
})

// ─── Upstream contract ───────────────────────────────────────────────────────

describe('assumptions about the upstream API', () => {
  it('asks v2 for the from-side only', async () => {
    await scanGasHistory(USER)
    expect(requestLog.every(u => u.includes('filter=from'))).toBe(true)
  })

  it('sends a browser User-Agent only to the host that demands one', async () => {
    // Robinhood Chain's Blockscout is behind Cloudflare and 403s a default Node
    // fetch. That is a dependency on someone else's configuration, so it is
    // asserted rather than assumed.
    await scanGasHistory(USER)
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    const robinhood = calls.find(([u]) => hostOf(String(u)) === chainHost('Robinhood'))!
    const ethereum = calls.find(([u]) => hostOf(String(u)) === chainHost('Ethereum'))!
    const uaOf = (c: [string, RequestInit]) =>
      (c[1].headers as Record<string, string>)['User-Agent']
    expect(uaOf(robinhood)).toMatch(/Mozilla/)
    expect(uaOf(ethereum)).toBeUndefined()
  })

  it('prefers v2 fee.value over the gas product, since only the former holds L1 data fees', async () => {
    // On OP-stack, `gas_used * gas_price` omits the L1 data fee — measured at
    // 70.83 % of the true fee on a 2022 Optimism transaction. Where v2 gives a
    // total, that total wins.
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
