// ToshX v2 on-chain coordinates.
//
// v2 is OPTIONAL in a build: with NEXT_PUBLIC_V2_BIDBOOK unset the v2 surfaces
// render a "not deployed" notice instead.
// All values come from `script/DeployV2.s.sol` (deployments/v2-<chain>.json).
//
//   NEXT_PUBLIC_V2_BIDBOOK        ToshBidBook (shared by both stacks)
//   NEXT_PUBLIC_V2_LENS           ToshHookLens
//   NEXT_PUBLIC_V2_FACTORY_BNB    ToshFactory quoted in WBNB
//   NEXT_PUBLIC_V2_FACTORY_USDT   ToshFactory quoted in USDT
//   NEXT_PUBLIC_V2_WBNB           WBNB on this chain
//   NEXT_PUBLIC_V2_USDT           USDT on this chain
//   NEXT_PUBLIC_V2_FROM_BLOCK     deploy block, where log scans start
import type { Address } from 'viem'
import { NATIVE_SYMBOL } from '@/lib/chain'

const HEX = /^0x[0-9a-fA-F]{40}$/

function addr(raw: string | undefined): Address | undefined {
  const v = raw?.trim()
  if (!v) return undefined
  if (!HEX.test(v)) throw new Error(`v2 config: "${v}" is not a 20-byte hex address`)
  return v as Address
}

export const V2_BIDBOOK = addr(process.env.NEXT_PUBLIC_V2_BIDBOOK)
export const V2_LENS = addr(process.env.NEXT_PUBLIC_V2_LENS)
export const V2_FACTORY_BNB = addr(process.env.NEXT_PUBLIC_V2_FACTORY_BNB)
export const V2_FACTORY_USDT = addr(process.env.NEXT_PUBLIC_V2_FACTORY_USDT)
export const V2_WBNB = addr(process.env.NEXT_PUBLIC_V2_WBNB)
export const V2_USDT = addr(process.env.NEXT_PUBLIC_V2_USDT)
export const V2_FROM_BLOCK = BigInt(process.env.NEXT_PUBLIC_V2_FROM_BLOCK?.trim() || '0')

export const V2_ENABLED = V2_BIDBOOK !== undefined && V2_LENS !== undefined

export const V2_FACTORIES: readonly Address[] = [V2_FACTORY_BNB, V2_FACTORY_USDT].filter(
  (a): a is Address => a !== undefined,
)

export function isV2Factory(a: string | null | undefined): boolean {
  if (!a) return false
  const l = a.toLowerCase()
  return V2_FACTORIES.some(f => f.toLowerCase() === l)
}

export interface V2Quote {
  asset: Address
  symbol: string
  decimals: number
  native: boolean
}

/** Display data for a hook's quote asset. Both v2 quote assets have 18 decimals. */
export function v2Quote(asset: string, acceptsNative: boolean): V2Quote {
  const isUsdt = V2_USDT !== undefined && asset.toLowerCase() === V2_USDT.toLowerCase()
  return {
    asset: asset as Address,
    symbol: acceptsNative ? NATIVE_SYMBOL : isUsdt ? 'USDT' : 'QUOTE',
    decimals: 18,
    native: acceptsNative,
  }
}

/** A v2 factory's quote in the `QuoteConfig` shape the directory cards format with. */
export function v2QuoteConfig(factory: string): { asset: Address; decimals: number; symbol: string; wrapsNative: boolean } {
  const native = V2_FACTORY_BNB !== undefined && factory.toLowerCase() === V2_FACTORY_BNB.toLowerCase()
  const asset = (native ? V2_WBNB : V2_USDT) ?? ('0x0000000000000000000000000000000000000000' as Address)
  return { asset, decimals: 18, symbol: native ? NATIVE_SYMBOL : 'USDT', wrapsNative: native }
}

/** Mirrors of contract constants the UI computes with. */
export const V2 = {
  FEE_BPS: 100n,
  FILL_FLOOR_BPS: 9000n,
  BPS: 10_000n,
  MIN_FILL_QTY: 10n ** 18n,
  ONE: 10n ** 18n,
  ADMIN_LAUNCH_WINDOW_S: 48 * 3600,
  SALE_SUPPLY: 5_600_000n * 10n ** 18n,
  GENESIS_SUPPLY: 8_400_000n * 10n ** 18n,
  FUND_BPS: 2000n,
} as const
