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
  POG_GAS_FLOOR_WEI, POG_GAS_CAP_WEI, MAX_ALLOC_ETH_WEI,
  DEFAULT_GAS_TO_ETH_RATE, computeMaxAllocFromWei, isPogEligible,
} from './pogQuota'

const eth = (w: bigint) => (Number(w) / 1e18).toFixed(8)

const HEAVY = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const OURS = '0x14791697260E4c9A71f18484C9f997B308e59325'
const EMPTY = '0x000000000000000000000000000000000000dEaD'

function report(label: string, h: Awaited<ReturnType<typeof scanGasHistory>>) {
  const alloc = computeMaxAllocFromWei(h.totalWei, DEFAULT_GAS_TO_ETH_RATE)
  console.log(`\n--- ${label} ---`)
  for (const c of h.chains) {
    console.log(`  ${c.chain.padEnd(10)} ${eth(c.weiSpent).padStart(12)} ETH  sent=${String(c.sentTxs).padStart(5)}`
      + `${c.skipped ? ' [skipped: capped]' : ''}${c.stoppedAtCap && !c.skipped ? ' [hit cap]' : ''}`
      + `${c.truncated ? ' [TRUNCATED]' : ''}${c.execFeeOnly ? ' [exec-fee only]' : ''}`)
  }
  console.log(`  total=${eth(h.totalWei)} ETH  eligible=${isPogEligible(h.totalWei)}`
    + `  alloc=${eth(alloc)} ETH  truncated=${h.truncated}`)
}

describe.runIf(process.env.POG_LIVE_SCAN === '1')('live gas scan', () => {
  it('chain table is coherent', () => {
    expect(GAS_SCAN_CHAINS).toHaveLength(5)
    expect(POG_GAS_CAP_WEI).toBe(10n ** 18n)
    expect(POG_GAS_FLOOR_WEI).toBe(5n * 10n ** 16n)
    // the band's whole point: cap * rate lands exactly on the ceiling
    expect(computeMaxAllocFromWei(POG_GAS_CAP_WEI, DEFAULT_GAS_TO_ETH_RATE)).toBe(MAX_ALLOC_ETH_WEI)
  })

  it('heavy wallet: completes, and stops at the cap', async () => {
    const h = await scanGasHistory(HEAVY)
    report('heavy', h)
    // v2 could not return one page for this wallet inside 15s; v1 must finish.
    expect(h.totalWei).toBeGreaterThanOrEqual(POG_GAS_CAP_WEI)
    expect(computeMaxAllocFromWei(h.totalWei, DEFAULT_GAS_TO_ETH_RATE)).toBe(MAX_ALLOC_ETH_WEI)
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
    expect(isPogEligible(h.totalWei)).toBe(true)
    expect(h.truncated).toBe(false)
  }, 180_000)

  it('empty wallet: zero, not an error, and below the floor', async () => {
    const h = await scanGasHistory(EMPTY)
    report('empty', h)
    expect(h.totalWei).toBe(0n)
    expect(isPogEligible(h.totalWei)).toBe(false)
    expect(computeMaxAllocFromWei(h.totalWei, DEFAULT_GAS_TO_ETH_RATE)).toBe(0n)
    expect(h.chains).toHaveLength(5)
  }, 180_000)
})
