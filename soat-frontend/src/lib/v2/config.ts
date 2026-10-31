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
//   NEXT_PUBLIC_V2_LEGACY_FACTORIES_BNB / _USDT
//                                 comma-separated earlier factories of the
//                                 same stack. Their projects stay listed and
//                                 tradable; new launches go to the two above.
//   NEXT_PUBLIC_V2_WBNB           WBNB on this chain
//   NEXT_PUBLIC_V2_USDT           USDT on this chain
//   NEXT_PUBLIC_V2_FROM_BLOCK     deploy block, where log scans start
//   NEXT_PUBLIC_TOSH_STACK        `v3` when the addresses above are a v3
//                                 deployment (script/DeployV3.s.sol); unset or
//                                 `v2` otherwise. One stack is live at a time.
//   NEXT_PUBLIC_V31_FACTORY       ToshFactoryV31 (USDT, script/DeployV31.s.sol).
//                                 Optional: its hooks list and trade beside the
//                                 stack above, with the L2 curve in place of
//                                 the shelf ladder.
//   NEXT_PUBLIC_V31_LENS          ToshHookLensV31; required with the factory.
import { getAddress, type Address } from 'viem'
import { NATIVE_SYMBOL } from '@/lib/chain'

const HEX = /^0x[0-9a-fA-F]{40}$/

/**
 * Re-checksummed from the hex, so a value pasted with its case mangled still
 * works. viem refuses a mixed-case address whose checksum is wrong at call
 * time, and inside a read hook that refusal is a silent, permanent "loading".
 */
function addr(raw: string | undefined): Address | undefined {
  const v = raw?.trim()
  if (!v) return undefined
  if (!HEX.test(v)) throw new Error(`v2 config: "${v}" is not a 20-byte hex address`)
  return getAddress(v.toLowerCase())
}

export const V2_BIDBOOK = addr(process.env.NEXT_PUBLIC_V2_BIDBOOK)
export const V2_LENS = addr(process.env.NEXT_PUBLIC_V2_LENS)
export const V2_FACTORY_BNB = addr(process.env.NEXT_PUBLIC_V2_FACTORY_BNB)
export const V2_FACTORY_USDT = addr(process.env.NEXT_PUBLIC_V2_FACTORY_USDT)
export const V2_WBNB = addr(process.env.NEXT_PUBLIC_V2_WBNB)
export const V2_USDT = addr(process.env.NEXT_PUBLIC_V2_USDT)
export const V2_FROM_BLOCK = BigInt(process.env.NEXT_PUBLIC_V2_FROM_BLOCK?.trim() || '0')

function addrList(raw: string | undefined): Address[] {
  return (raw ?? '').split(',').map(s => addr(s)).filter((a): a is Address => a !== undefined)
}

export const V2_LEGACY_FACTORIES_BNB = addrList(process.env.NEXT_PUBLIC_V2_LEGACY_FACTORIES_BNB)
export const V2_LEGACY_FACTORIES_USDT = addrList(process.env.NEXT_PUBLIC_V2_LEGACY_FACTORIES_USDT)

export const V2_ENABLED = V2_BIDBOOK !== undefined && V2_LENS !== undefined

const V31_FACTORY_RAW = addr(process.env.NEXT_PUBLIC_V31_FACTORY)
export const V31_LENS = addr(process.env.NEXT_PUBLIC_V31_LENS)
/** Unset unless the lens is too, so every v3.1 read has somewhere to go. */
export const V31_FACTORY = V31_LENS !== undefined ? V31_FACTORY_RAW : undefined
export const V31_ENABLED = V2_ENABLED && V31_FACTORY !== undefined

/** Every factory whose projects are listed: the current pair, v3.1, then the legacy ones. */
export const V2_FACTORIES: readonly Address[] = [
  ...new Set(
    [V2_FACTORY_BNB, V2_FACTORY_USDT, V31_ENABLED ? V31_FACTORY : undefined, ...V2_LEGACY_FACTORIES_BNB, ...V2_LEGACY_FACTORIES_USDT].filter(
      (a): a is Address => a !== undefined,
    ),
  ),
]

const has = (list: readonly (Address | undefined)[], a: string) => {
  const l = a.toLowerCase()
  return list.some(f => f !== undefined && f.toLowerCase() === l)
}

export function isV2Factory(a: string | null | undefined): boolean {
  return !!a && has(V2_FACTORIES, a)
}

export function isV31Factory(a: string | null | undefined): boolean {
  return !!a && V31_ENABLED && has([V31_FACTORY], a)
}

/** A listed factory that no longer takes launches. */
export function isLegacyFactory(a: string | null | undefined): boolean {
  return !!a && has([...V2_LEGACY_FACTORIES_BNB, ...V2_LEGACY_FACTORIES_USDT], a)
}

/**
 * Whether `factory`'s hooks gate shelves on spot alone. The v3 factories that
 * were live before the spot gate became legacy when it shipped, so on a v3
 * build only the current pair, and only once a legacy pair is configured,
 * runs the new rule; everything else still reads `min(spot, 30m TWAP)`.
 */
export function hasSpotShelfGate(factory: string | null | undefined): boolean {
  if (!factory || !IS_V3 || V2_LEGACY_FACTORIES_BNB.length + V2_LEGACY_FACTORIES_USDT.length === 0) return false
  return has([V2_FACTORY_BNB, V2_FACTORY_USDT], factory)
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
  const native = has([V2_FACTORY_BNB, ...V2_LEGACY_FACTORIES_BNB], factory)
  const asset = (native ? V2_WBNB : V2_USDT) ?? ('0x0000000000000000000000000000000000000000' as Address)
  return { asset, decimals: 18, symbol: native ? NATIVE_SYMBOL : 'USDT', wrapsNative: native }
}

function stack(raw: string | undefined): 'v2' | 'v3' {
  const v = raw?.trim().toLowerCase()
  if (!v || v === 'v2') return 'v2'
  if (v === 'v3') return 'v3'
  throw new Error(`v2 config: NEXT_PUBLIC_TOSH_STACK must be "v2" or "v3", got "${raw}"`)
}

export const TOSH_STACK = stack(process.env.NEXT_PUBLIC_TOSH_STACK)
export const IS_V3 = TOSH_STACK === 'v3'

/** Supply constants per stack, in token wei. Total supply is 21M on v2 and 2.1B on v3. */
export const STACK_SUPPLY = {
  v2: { SALE_SUPPLY: 5_600_000n * 10n ** 18n, GENESIS_SUPPLY: 8_400_000n * 10n ** 18n, MAX_SUPPLY: 21_000_000n * 10n ** 18n, TIER_COUNT: 4_000 },
  v3: { SALE_SUPPLY: 180_000_000n * 10n ** 18n, GENESIS_SUPPLY: 270_000_000n * 10n ** 18n, MAX_SUPPLY: 2_100_000_000n * 10n ** 18n, TIER_COUNT: 10_000 },
} as const
const SUPPLY = STACK_SUPPLY[TOSH_STACK]

/** Mirrors of contract constants the UI computes with. */
export const V2 = {
  FEE_BPS: 100n,
  FILL_FLOOR_BPS: 9000n,
  BPS: 10_000n,
  MIN_FILL_QTY: 10n ** 18n,
  ONE: 10n ** 18n,
  ADMIN_LAUNCH_WINDOW_S: 48 * 3600,
  SALE_SUPPLY: SUPPLY.SALE_SUPPLY,
  MAX_SUPPLY: SUPPLY.MAX_SUPPLY,
  GENESIS_SUPPLY: SUPPLY.GENESIS_SUPPLY,
  FUND_BPS: 2000n,
  TIER_COUNT: SUPPLY.TIER_COUNT,
} as const

/**
 * v3.1 mirrors, independent of the stack switch. Genesis is v3's curve; the
 * pool and the L2 curve both scale by raised / hard cap.
 */
export const V31 = {
  MAX_SUPPLY: 1_000_000_000n * 10n ** 18n,
  SALE_SUPPLY: 180_000_000n * 10n ** 18n,
  GENESIS_SUPPLY: 270_000_000n * 10n ** 18n,
  L2_SUPPLY: 730_000_000n * 10n ** 18n,
  L2_QUOTA_BPS: 1000n,
  LP_SHARE_BPS: 8000n,
  /** To the TOSH buyback; the project takes the rest of a mint. */
  PLATFORM_TAX_BPS: 100n,
  DECAY_INTERVAL_S: 60,
  /** One step multiplies the price by 0.999. */
  DECAY_PER_STEP: 0.999,
  BURN_INTERVAL_S: 600,
  BURN_PERIODS: 1008n,
  VEST_DURATION_S: 8 * 3600,
} as const
