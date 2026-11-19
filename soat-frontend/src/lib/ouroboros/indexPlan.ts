/**
 * Most mint transactions one index pass reads; a busier range ends the pass
 * early at a block boundary, so a pass always fits the route's time budget and
 * the cursor keeps moving through a crowded L1.
 */
export const MAX_MINT_TXS = 400

/** The last block of [from, to] that keeps the pass within `max` mint transactions. */
export function passEnd(mintTxBlocks: { hash: string; block: bigint }[], from: bigint, to: bigint, max = MAX_MINT_TXS): bigint {
  const seen = new Set<string>()
  const sorted = [...mintTxBlocks].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))
  for (const t of sorted) {
    if (seen.has(t.hash)) continue
    seen.add(t.hash)
    // Whole blocks only: the cursor never splits one.
    if (seen.size > max && t.block > from) return t.block - 1n
  }
  return to
}
