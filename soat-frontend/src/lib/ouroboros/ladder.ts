/**
 * The L2 ladder, mirrored from `OuroborosMint.ladderPrice` so the page can draw
 * the table and preview a cost before any read returns. The contract's
 * `quoteL2` remains what a mint is sent with.
 */
const E = 10n ** 15n // 0.001 USDT

export interface Tier {
  from: number
  to: number
  /** First price in the tier, USDT wei. */
  start: bigint
  /** Price step, USDT wei. 0 for a flat tier. */
  step: bigint
  /** Shares per step. */
  every: number
}

export const TIERS: readonly Tier[] = [
  { from: 1, to: 10_000, start: 1_200n * E, step: 0n, every: 10_000 },
  { from: 10_001, to: 20_000, start: 1_280n * E, step: 80n * E, every: 1_000 },
  { from: 20_001, to: 100_000, start: 2_080n * E, step: 16n * E, every: 1_000 },
  { from: 100_001, to: 1_000_000, start: 3_360n * E, step: 16n * E, every: 10_000 },
  { from: 1_000_001, to: 5_000_000, start: 4_800n * E, step: 20n * E, every: 20_000 },
  { from: 5_000_001, to: 21_000_000, start: 8_800n * E, step: 20n * E, every: 50_000 },
]

export function tierOf(n: number): Tier {
  return TIERS.find(t => n <= t.to) ?? TIERS[TIERS.length - 1]
}

/** Last price in a tier. */
export function tierEnd(t: Tier): bigint {
  if (t.step === 0n) return t.start
  return t.start + t.step * BigInt(Math.floor((t.to - t.from) / t.every))
}

/** Price of L2 share `n` (1-based), USDT wei. */
export function ladderPrice(n: number): bigint {
  const t = tierOf(n)
  if (t.step === 0n) return t.start
  return t.start + t.step * BigInt(Math.floor((n - t.from) / t.every))
}

/** Cost of `shares` shares after `minted` have sold. */
export function ladderCost(minted: number, shares: number): bigint {
  let c = 0n
  for (let i = 1; i <= shares; i++) c += ladderPrice(minted + i)
  return c
}

/** Most shares, up to `limit`, whose cost after `minted` stays within `budget` (the contract's `maxL2Cost`). */
export function sharesWithin(minted: number, budget: bigint, limit: number): number {
  let c = 0n
  for (let i = 1; i <= limit; i++) {
    c += ladderPrice(minted + i)
    if (c > budget) return i - 1
  }
  return limit
}
