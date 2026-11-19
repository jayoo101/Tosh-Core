/** Limits on one automatic payout run, in USDT wei. */
export const AUTOPAY_LIMITS = {
  /** Below this a balance waits for a later run. */
  min: 5n * 10n ** 18n,
  /** A run above this waits for a Safe signer's approval. */
  runCap: 1_000n * 10n ** 18n,
  /** So does a run paying any one partner above this. */
  partnerCap: 500n * 10n ** 18n,
}

export interface PayItem { partner: string; amount: bigint }

export type AutopayPlan =
  | { kind: 'idle' }
  | { kind: 'held'; total: bigint; items: PayItem[] }
  | { kind: 'pay'; total: bigint; items: PayItem[]; usesApproval: boolean }

/**
 * What one run pays: every partner owed at least `min`, net of transfers
 * still in flight, unless the run exceeds a cap without an approval covering
 * its total.
 */
export function planPayouts(
  owed: { partner: string; owed: bigint }[],
  inFlight: Map<string, bigint>,
  approvedTotal: bigint | null,
  limits = AUTOPAY_LIMITS,
): AutopayPlan {
  // One item per partner whatever the input repeats: a partner listed twice
  // must not be paid twice.
  const seen = new Set<string>()
  const items = owed
    .filter(o => !seen.has(o.partner.toLowerCase()) && seen.add(o.partner.toLowerCase()))
    .map(o => ({ partner: o.partner, amount: o.owed - (inFlight.get(o.partner) ?? 0n) }))
    .filter(i => i.amount >= limits.min)
  if (items.length === 0) return { kind: 'idle' }
  const total = items.reduce((s, i) => s + i.amount, 0n)
  const over = total > limits.runCap || items.some(i => i.amount > limits.partnerCap)
  if (over && (approvedTotal === null || total > approvedTotal)) return { kind: 'held', total, items }
  return { kind: 'pay', total, items, usesApproval: over }
}
