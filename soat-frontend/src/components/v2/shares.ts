import type { V2Quote } from '@/lib/v2/config'

/** Above this many shares a count is harder to read than an amount. */
const MAX_SHARES = 100n

export interface AgentShares {
  /** One share in quote wei: the launch's `minBuy`. */
  size: bigint
  /** Shares one Agent ID may buy: `perAgentCap / minBuy`. */
  count: bigint
}

/**
 * A BNB launch whose Agent ID allowance is a whole number of `minBuy` sells
 * in shares (0.01 BNB × 10). The contract has no such unit; it only sees the
 * amount, so this is a reading of the two parameters, not a rule of its own.
 */
export function agentShares(quote: V2Quote, minBuy?: bigint, cap?: bigint): AgentShares | null {
  if (!quote.native || !minBuy || !cap || cap % minBuy !== 0n) return null
  const count = cap / minBuy
  return count <= MAX_SHARES ? { size: minBuy, count } : null
}

/** Whole shares left in `remaining`, rounding a part-share up so it can still be bought. */
export function sharesLeft(s: AgentShares, remaining: bigint): bigint {
  return (remaining + s.size - 1n) / s.size
}
