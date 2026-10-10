import type { Address } from 'viem'

/**
 * What a quote asset is, as far as the screen is concerned.
 *
 * A hook is bound for life to the asset its factory was built against, so a site
 * listing more than one factory lists more than one asset: the WBNB factory's
 * launches and the retired BEM factories' launches sit side by side, at 18 and
 * 8 decimals. A single module constant cannot describe both, which is why every
 * project-scoped figure reads this through `useQuote()` instead.
 */
export interface QuoteConfig {
  readonly asset: Address
  readonly decimals: number
  /** Ticker on screen. WBNB reads as BNB: that is what the user pays with. */
  readonly symbol: string
  /**
   * The asset is the chain's wrapped native coin, so a deposit can go through
   * `factory.depositNative` and a pull can be funded by wrapping BNB first.
   */
  readonly wrapsNative: boolean
}

export const WBNB_BSC: Address = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
export const BEM_BSC: Address = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'

const KNOWN: Record<string, Omit<QuoteConfig, 'asset'>> = {
  [WBNB_BSC.toLowerCase()]: { decimals: 18, symbol: 'BNB', wrapsNative: true },
  [BEM_BSC.toLowerCase()]:  { decimals: 8,  symbol: 'BEM', wrapsNative: false },
}

/** The ecosystem the site positions itself in (TapeOut's coin), whatever a raise is paid in. */
export const ECOSYSTEM_SYMBOL = KNOWN[BEM_BSC.toLowerCase()].symbol

/** The table entry for `asset`, or undefined for a token this file does not know. */
export function knownQuote(asset: string | undefined | null): QuoteConfig | undefined {
  if (!asset) return undefined
  const k = KNOWN[asset.toLowerCase()]
  return k ? { asset: asset as Address, ...k } : undefined
}

/**
 * Retired factories on 56 and what they were denominated in. Immutable facts of
 * deployed contracts, so a table rather than a read: the directory can price a
 * card before any hook answers. A factory missing here is assumed to share the
 * current factory's asset, which holds on every chain this site has run on
 * except 56 after the WBNB move.
 */
export const RETIRED_FACTORY_QUOTES: Record<string, Address> = {
  '0x20de906a96ffb89be6fd6267a0876a68017792f7': BEM_BSC,
  '0xbca66f7382aac0c6ee2b833fc2072ca607367f2c': BEM_BSC,
}

/** Canonical WETH9-style wrapper surface. */
export const WRAPPED_NATIVE_ABI = [
  { type: 'function', name: 'deposit',  stateMutability: 'payable',    inputs: [], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'wad', type: 'uint256' }], outputs: [] },
] as const
