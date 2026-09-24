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
 *
 *   Chain 56 is named through `MAINNET_CHAIN_LABEL` rather than spelled out, and
 *   that is not style. It is the one scanned chain that is also the settlement
 *   chain, so a literal here could drift from what every other screen calls it;
 *   and `checkChainCopy.mjs` rejects that label outside `chain.ts` with no
 *   exemption, not even for tests.
 *
 *   Which is why this module, and not `gasHistory.ts`, decides what users read.
 *   That table has to stay free of node_modules so `scripts/pogSigner.ts` can
 *   compile it, and `chain.ts` needs viem — so the scan table carries `BSC` as an
 *   internal id and `gasScanChainLabel` below translates it on the way to a
 *   screen. Nothing else in the table needs translating; see the map.
 */
import { MAINNET_CHAIN_LABEL } from '@/lib/chain'
import { fill } from '@/i18n/fill'

export const GAS_SCAN_CHAIN_NAMES = [
  'Ethereum',
  'Arbitrum',
  'Optimism',
  'Base',
  MAINNET_CHAIN_LABEL,
  'Robinhood',
] as const

/**
 * Internal scan-table id → what a screen may show. Only 56 differs, for the
 * reason in the header; every other row is already its own display name, so the
 * id is returned untouched rather than requiring an entry here that could rot.
 *
 * Keyed on `chainId` and not on the id string, because the string is the thing
 * allowed to change: renaming `BSC` in the table must not silently strand the
 * translation and put a bare id on screen.
 */
const DISPLAY_NAME_BY_CHAIN_ID: Readonly<Record<number, string>> = {
  56: MAINNET_CHAIN_LABEL,
}

/** What to print for a scanned chain, given the row the scanner returned. */
export function gasScanChainLabel(chainId: number, scanTableId: string): string {
  return DISPLAY_NAME_BY_CHAIN_ID[chainId] ?? scanTableId
}

/**
 * "Ethereum, Arbitrum, Optimism, Base, BNB Smart Chain and Robinhood".
 *
 * `words` is `{ listSeries, listLast }` from the active dictionary's `gas`
 * surface; this module stays free of React, so the caller passes them in.
 */
export function formatGasScanChainList(
  names: readonly string[] = GAS_SCAN_CHAIN_NAMES,
  words: Pick<ListWords, 'listSeries' | 'listLast'> = ENGLISH_LIST,
): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  const head = names.slice(0, -1).reduce((a, b) => fill(words.listSeries, { a, b }))
  return fill(words.listLast, { a: head, b: names[names.length - 1] })
}

/**
 * "BSC and Robinhood and Base": every name joined by `listEvery`, for the
 * chains a scan could not read. Kept apart from the series form above because
 * that is how this list has always read in English.
 */
export function formatMissingChainList(
  names: readonly string[],
  words: Pick<ListWords, 'listEvery'> = ENGLISH_LIST,
): string {
  if (names.length === 0) return ''
  return names.reduce((a, b) => fill(words.listEvery, { a, b }))
}

interface ListWords { listSeries: string; listLast: string; listEvery: string }

const ENGLISH_LIST: ListWords = {
  listSeries: '{a}, {b}',
  listLast:   '{a} and {b}',
  listEvery:  '{a} and {b}',
}
