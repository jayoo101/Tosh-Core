/**
 * The chain names the PoG scanner reads, for UI copy only.
 *
 * Source of truth for WHAT is scanned is `GAS_SCAN_CHAINS` in gasHistory.ts.
 * This list is pinned to that table by `covers exactly the six chains…` in
 * gasHistory.test.ts, so a rename in one place and not the other fails the
 * suite rather than shipping a dialog that names the wrong chains.
 *
 * Kept in its own file so client components can print the list without pulling
 * the scanner (the fetch layer, retries, the v1/v2 probe) into the bundle.
 *
 * ⚠ BNB CHAIN IS NOW HERE, and this comment used to explain why it was not.
 *   It said 56 was "waiting on a key" because Blockscout does not cover that
 *   chain at any tier — true then, and the key (Etherscan v2 Lite) was bought on
 *   2026-09-22, so the scanner reads it and this list names it.
 *
 *   Robinhood is still here too, and that remains current behaviour rather than
 *   a missed rename: the scanner still reads 4663. A dialog that omitted
 *   Robinhood while the scanner still queried it, or that named BSC while the
 *   scanner did not, would be the lying copy this module exists to stop — and
 *   for three weeks it was the second of those two, which is why the pin is a
 *   test and not a comment.
 */
export const GAS_SCAN_CHAIN_NAMES = [
  'Ethereum',
  'Arbitrum',
  'Optimism',
  'Base',
  'BNB Chain',
  'Robinhood',
] as const

/** "Ethereum, Arbitrum, Optimism, Base, BNB Chain and Robinhood" */
export function formatGasScanChainList(
  names: readonly string[] = GAS_SCAN_CHAIN_NAMES,
): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
