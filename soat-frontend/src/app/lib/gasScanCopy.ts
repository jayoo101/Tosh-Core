/**
 * The chain names the PoG scanner reads, for UI copy only.
 *
 * Source of truth for WHAT is scanned is `GAS_SCAN_CHAINS` in gasHistory.ts.
 * This list is pinned to that table by `covers exactly the five chains…` in
 * gasHistory.test.ts, so a rename in one place and not the other fails the
 * suite rather than shipping a dialog that names the wrong chains.
 *
 * Kept in its own file so client components can print the list without pulling
 * the scanner (Blockscout fetch, retries, the v1/v2 probe) into the bundle.
 *
 * ⚠ ROBINHOOD IS STILL HERE, and that is current behaviour rather than a missed
 *   rename. The scanner still reads 4663; it does not yet read BSC 56, because
 *   Blockscout does not cover that chain and the Etherscan v2 transport is
 *   waiting on a key. A dialog that omitted Robinhood while the scanner still
 *   queried it, or that named BSC while the scanner does not, would be the
 *   lying copy this module exists to stop.
 */
export const GAS_SCAN_CHAIN_NAMES = [
  'Ethereum',
  'Arbitrum',
  'Optimism',
  'Base',
  'Robinhood',
] as const

/** "Ethereum, Arbitrum, Optimism, Base and Robinhood" */
export function formatGasScanChainList(
  names: readonly string[] = GAS_SCAN_CHAIN_NAMES,
): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
