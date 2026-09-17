/**
 * Live-network verification of the scanner, against the five real chains.
 *
 * OPT-IN ONLY:  POG_LIVE_SCAN=1 npx vitest run src/app/lib/gasHistory.live.test.ts
 *
 * `npm test` runs the whole suite in CI, and a test that reaches five free
 * public explorers would make every build depend on their uptime and spend their
 * goodwill on every push — so this is gated off by default rather than deleted.
 * The offline suite in `gasHistory.test.ts` is what actually guards the logic;
 * this exists to check the logic against reality, which a mock cannot do, and to
 * be re-run by hand whenever Blockscout's response shape is in doubt.
 *
 * The assertions encode measurements taken 2026-09-05, including one that is
 * cross-checked against a completely different endpoint: our deployer's
 * Ethereum total, `0.11395591` ETH, was independently produced by v2's
 * `fee.value` over 29 pages and by v1's `gasUsed * gasPrice` in one request.
 */
import { describe, it, expect } from 'vitest'
import { scanGasHistory, GAS_SCAN_CHAINS } from './gasHistory'
import {
  DEFAULT_POG_BAND, DEFAULT_GAS_TO_ALLOC_RATE,
  computeMaxAllocFromWei, isPogEligible, pogCapWei,
} from './pogQuota'

/** The seeded band. A live scan has nowhere to read a rotated one from, and
 *  pointing it at the shared store would make an offline check depend on
 *  Upstash. */
const BAND = DEFAULT_POG_BAND
const POG_GAS_FLOOR_WEI = BAND.floorWei
const POG_GAS_CAP_WEI = pogCapWei(BAND)
const MAX_ALLOC_ETH_WEI = BAND.maxAllocWei

const eth = (w: bigint) => (Number(w) / 1e18).toFixed(8)

const HEAVY = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const OURS = '0x14791697260E4c9A71f18484C9f997B308e59325'
const EMPTY = '0x000000000000000000000000000000000000dEaD'

function report(label: string, h: Awaited<ReturnType<typeof scanGasHistory>>) {
  const alloc = computeMaxAllocFromWei(h.totalWei, BAND)
  console.log(`\n--- ${label} ---`)
  for (const c of h.chains) {
    console.log(`  ${c.chain.padEnd(10)} ${eth(c.weiSpent).padStart(12)} ETH  sent=${String(c.sentTxs).padStart(5)}`
      + `${c.skipped ? ' [skipped: capped]' : ''}${c.stoppedAtCap && !c.skipped ? ' [hit cap]' : ''}`
      + `${c.unavailable ? ' [UNREADABLE: counted as zero]' : ''}`
      + `${c.truncated && !c.unavailable ? ' [TRUNCATED]' : ''}`
      + `${c.execFeeOnly ? ' [exec-fee only]' : ''}`)
  }
  console.log(`  total=${eth(h.totalWei)} ETH  eligible=${isPogEligible(h.totalWei, BAND)}`
    + `  alloc=${eth(alloc)} ETH  truncated=${h.truncated}`)
}

describe.runIf(process.env.POG_LIVE_SCAN === '1')('live gas scan', () => {
  it('chain table is coherent', () => {
    expect(GAS_SCAN_CHAINS).toHaveLength(5)
    expect(POG_GAS_CAP_WEI).toBe(10n ** 18n)
    expect(POG_GAS_FLOOR_WEI).toBe(25n * 10n ** 15n)
    expect(DEFAULT_GAS_TO_ALLOC_RATE).toBe(1.75)
    // the band's whole point: cap * rate lands exactly on the ceiling
    expect(computeMaxAllocFromWei(POG_GAS_CAP_WEI, BAND)).toBe(MAX_ALLOC_ETH_WEI)
  })

  it('heavy wallet: completes, and stops at the cap', async () => {
    const h = await scanGasHistory(HEAVY, POG_GAS_CAP_WEI)
    report('heavy', h)
    // v2 could not return one page for this wallet inside 15s; v1 must finish.
    expect(h.totalWei).toBeGreaterThanOrEqual(POG_GAS_CAP_WEI)
    expect(computeMaxAllocFromWei(h.totalWei, BAND)).toBe(MAX_ALLOC_ETH_WEI)
    // reaching the cap on Ethereum must skip the later chains entirely
    expect(h.chains.some(c => c.skipped)).toBe(true)
  }, 180_000)

  it('our deployer: matches the figure v2 produced independently', async () => {
    const h = await scanGasHistory(OURS)
    report('deployer', h)
    // v2 enumerated this wallet at 0.113956 ETH over 29 pages / 34s.
    // v1 must agree to the wei.
    const ethereum = h.chains.find(c => c.chain === 'Ethereum')!
    expect(eth(ethereum.weiSpent)).toBe('0.11395591')
    expect(isPogEligible(h.totalWei, BAND)).toBe(true)

    // Not `expect(h.truncated).toBe(false)`, which is what this said and which
    // re-coupled the assertion to 4663's uptime — the exact dependency the
    // per-chain failure policy exists to remove. An optional chain being
    // unreadable legitimately sets `truncated`, and on 2026-09-05 that chain's
    // indexer was answering 1 request in 12. What must stay false is truncation
    // from a REQUEST BUDGET running out, which is a claim about our own paging.
    expect(h.chains.filter(c => c.truncated && !c.unavailable)).toEqual([])
  }, 180_000)

  it('empty wallet: zero, not an error, and below the floor', async () => {
    const h = await scanGasHistory(EMPTY)
    report('empty', h)
    expect(h.totalWei).toBe(0n)
    expect(isPogEligible(h.totalWei, BAND)).toBe(false)
    expect(computeMaxAllocFromWei(h.totalWei, BAND)).toBe(0n)
    expect(h.chains).toHaveLength(5)
  }, 180_000)
})
