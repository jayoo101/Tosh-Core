import type { Address } from 'viem'

/** What a quote asset is, as far as the screen is concerned. */
export interface QuoteConfig {
  readonly asset: Address
  readonly decimals: number
  /** Ticker on screen. WBNB reads as BNB: that is what the user pays with. */
  readonly symbol: string
  /** The asset is the chain's wrapped native coin, so a raise accepts BNB directly. */
  readonly wrapsNative: boolean
}

/** Canonical WETH9-style wrapper surface. */
export const WRAPPED_NATIVE_ABI = [
  { type: 'function', name: 'deposit',  stateMutability: 'payable',    inputs: [], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'wad', type: 'uint256' }], outputs: [] },
] as const
