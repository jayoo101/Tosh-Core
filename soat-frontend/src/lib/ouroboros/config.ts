// Ouroboros on-chain coordinates, from `script/DeployOuroboros.s.sol`.
//
//   NEXT_PUBLIC_OURO_TOKEN       OuroborosToken
//   NEXT_PUBLIC_OURO_MINT        OuroborosMint
//   NEXT_PUBLIC_OURO_BIDBOOK     OuroborosBidBook
//   NEXT_PUBLIC_OURO_PAIR        the official Pancake V2 TOKEN/USDT pair
//   NEXT_PUBLIC_OURO_USDT        USDT (defaults to BSC USDT on chain 56)
//   NEXT_PUBLIC_OURO_TREASURY    the project Safe, shown on the page
//   NEXT_PUBLIC_OURO_FROM_BLOCK  deploy block, where log scans start
//
// With the mint unset the page renders a "not deployed" notice.
import { getAddress, type Address } from 'viem'
import { BSC_ID, TARGET_CHAIN_ID } from '@/lib/chain'

const HEX = /^0x[0-9a-fA-F]{40}$/

function addr(raw: string | undefined): Address | undefined {
  const v = raw?.trim()
  if (!v) return undefined
  if (!HEX.test(v)) throw new Error(`ouroboros config: "${v}" is not a 20-byte hex address`)
  return getAddress(v.toLowerCase())
}

const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955' as const

export const OURO_TOKEN = addr(process.env.NEXT_PUBLIC_OURO_TOKEN)
export const OURO_MINT = addr(process.env.NEXT_PUBLIC_OURO_MINT)
export const OURO_BIDBOOK = addr(process.env.NEXT_PUBLIC_OURO_BIDBOOK)
export const OURO_PAIR = addr(process.env.NEXT_PUBLIC_OURO_PAIR)
export const OURO_TREASURY = addr(process.env.NEXT_PUBLIC_OURO_TREASURY)
/** The hot wallet that pays partner rebates automatically, topped up by the treasury. */
export const OURO_REF_PAYER = addr(process.env.NEXT_PUBLIC_OURO_REF_PAYER)
export const OURO_USDT: Address | undefined =
  addr(process.env.NEXT_PUBLIC_OURO_USDT) ?? (TARGET_CHAIN_ID === BSC_ID ? BSC_USDT : undefined)
export const OURO_FROM_BLOCK = BigInt(process.env.NEXT_PUBLIC_OURO_FROM_BLOCK?.trim() || '0')

export const OURO_ENABLED =
  OURO_TOKEN !== undefined && OURO_MINT !== undefined && OURO_BIDBOOK !== undefined && OURO_USDT !== undefined

/** Mirrors `OuroborosMint.Phase`. */
export const PHASES = ['Pending', 'L1', 'AwaitLaunch', 'L1_5', 'L2', 'SoldOut', 'Failed'] as const
export type Phase = (typeof PHASES)[number]

export const MAX_SHARES = 30
export const L1_PRICE = 900_000_000_000_000_000n
export const L2_TOTAL_SHARES = 21_000_000n
/** `OuroborosMint.MAX_MINT_POOL_BPS`: one L2 mint costs at most 10 % of the pool's USDT. */
export const MAX_MINT_POOL_BPS = 1_000n
export const VEST_SECONDS = 180
