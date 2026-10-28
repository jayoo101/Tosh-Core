// ─────────────────────────────────────────────────────────────────────────────
// Tosh Protocol — chain-level bindings shared across the app.
//
// The v2 contract addresses and ABIs live in `@/lib/v2/config` and
// `@/lib/v2/abis`; this module holds what is not specific to one contract:
// the settlement chain, the ERC-20 surface, and a few protocol constants the
// UI computes with.
// ─────────────────────────────────────────────────────────────────────────────

import { erc20Abi } from 'viem'
import { IS_TESTNET, NATIVE_SYMBOL } from '@/lib/chain'

export type { QuoteConfig } from '@/lib/quoteAssets'

export {
  TARGET_CHAIN_ID,
  MAINNET_CHAIN_LABEL,
  ACTIVE_CHAIN_LABEL,
  IS_TESTNET,
  CHAIN_BYLINE,
  CHAIN_STATUS_BADGE,
  CHAIN_POSITIONING,
  testnetExplorerTx,
  testnetExplorerAddress,
  targetChain,
} from '@/lib/chain'

export const ERC20_ABI = erc20Abi

/** Both v2 quote assets (WBNB and BSC USDT) carry 18 decimals. */
export const QUOTE_DECIMALS = 18

/**
 * The denomination as a sentence, for page metadata and link previews.
 *
 * Derived rather than typed into `app/layout.tsx` so it follows the chain: on
 * a testnet the quote assets are mocks and the preview must not claim
 * otherwise.
 */
export const QUOTE_POSITIONING = IS_TESTNET
  ? `Raises are denominated in test ${NATIVE_SYMBOL} or a mock USDT.`
  : `Raises are denominated in ${NATIVE_SYMBOL} or USDT.`
