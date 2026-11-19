'use client'

import { useAccount, useReadContracts } from 'wagmi'
import type { Address } from 'viem'

import { ERC20_ABI, TARGET_CHAIN_ID } from '@/lib/contracts'
import { OURO_MINT_ABI } from '@/lib/ouroboros/abis'
import { MAX_MINT_POOL_BPS, MAX_SHARES, OURO_MINT, OURO_TOKEN, OURO_USDT, PHASES, type Phase } from '@/lib/ouroboros/config'
import { sharesWithin } from '@/lib/ouroboros/ladder'

const ZERO = '0x0000000000000000000000000000000000000000' as Address
const POLL_MS = 8_000

type StateRead =
  | 'phase' | 'l1Start' | 'l1End' | 'l2Start' | 'paused' | 'launched'
  | 'totalL1Shares' | 'l2Minted' | 'totalBurned' | 'poolReserves' | 'poolSeeded'
type UserRead = 'remainingShares' | 'l1SharesOf' | 'l1TokensOf' | 'l1Claimed' | 'vestOf'

export interface OuroState {
  phase: Phase | undefined
  l1Start: number
  l1End: number
  l2Start: number
  paused: boolean
  launched: boolean
  /** The official pair holds liquidity and trades; set by the first call from L2. */
  poolSeeded: boolean
  totalL1Shares: bigint
  l2Minted: bigint
  totalBurned: bigint
  reserveUsdt: bigint
  reserveToken: bigint
  supply: bigint
}

/**
 * Most L2 shares one mint may take under the contract's 10 % pool cap, with
 * 2.5 % headroom: the mint sells held buy tax first, which lowers the reserve
 * the cap is checked against, and mints landing first may lift the cost by up
 * to `L2_MAX_PAY_BPS`.
 */
export function l2PoolCap(state: OuroState): number {
  const budget = (state.reserveUsdt * MAX_MINT_POOL_BPS * 9_750n) / 10_000n / 10_000n
  return sharesWithin(Number(state.l2Minted), budget, MAX_SHARES)
}

export interface OuroUser {
  remaining: number
  l1Shares: bigint
  l1Tokens: bigint
  l1Claimed: boolean
  vestLocked: bigint
  vestClaimable: bigint
  unlockAt: number
  tokenBalance: bigint
  usdtBalance: bigint
}

function v<T>(r: { status: string; result?: unknown } | undefined, fallback: T): T {
  return r?.status === 'success' ? (r.result as T) : fallback
}

/** Protocol-wide reads. */
export function useOuroState() {
  const mint = OURO_MINT ?? ZERO
  const fn = <F extends StateRead>(functionName: F) =>
    ({ address: mint, abi: OURO_MINT_ABI, functionName, chainId: TARGET_CHAIN_ID }) as const
  const q = useReadContracts({
    contracts: [
      fn('phase'), fn('l1Start'), fn('l1End'), fn('l2Start'), fn('paused'), fn('launched'),
      fn('totalL1Shares'), fn('l2Minted'), fn('totalBurned'), fn('poolReserves'),
      fn('poolSeeded'),
      { address: OURO_TOKEN ?? ZERO, abi: ERC20_ABI, functionName: 'totalSupply', chainId: TARGET_CHAIN_ID },
    ],
    query: { enabled: OURO_MINT !== undefined, refetchInterval: POLL_MS },
  })
  const d = q.data
  const reserves = v<readonly [bigint, bigint]>(d?.[9], [0n, 0n])
  const phaseIdx = v<number | undefined>(d?.[0], undefined)
  const state: OuroState = {
    phase: phaseIdx === undefined ? undefined : PHASES[phaseIdx],
    l1Start: Number(v<bigint>(d?.[1], 0n)),
    l1End: Number(v<bigint>(d?.[2], 0n)),
    l2Start: Number(v<bigint>(d?.[3], 0n)),
    paused: v(d?.[4], false),
    launched: v(d?.[5], false),
    totalL1Shares: v(d?.[6], 0n),
    l2Minted: v(d?.[7], 0n),
    totalBurned: v(d?.[8], 0n),
    reserveUsdt: reserves[0],
    reserveToken: reserves[1],
    supply: v(d?.[11], 0n),
    poolSeeded: v(d?.[10], false),
  }
  return { state, refetch: q.refetch, isLoading: q.isLoading }
}

/** Reads for `account`, or for the connected wallet when none is given. */
export function useOuroUser(account?: Address) {
  const { address: connected } = useAccount()
  const address = account ?? connected
  const mint = OURO_MINT ?? ZERO
  const who = address ?? ZERO
  const fn = <F extends UserRead>(functionName: F) =>
    ({ address: mint, abi: OURO_MINT_ABI, functionName, args: [who], chainId: TARGET_CHAIN_ID }) as const
  const q = useReadContracts({
    contracts: [
      fn('remainingShares'), fn('l1SharesOf'), fn('l1TokensOf'), fn('l1Claimed'), fn('vestOf'),
      { address: OURO_TOKEN ?? ZERO, abi: ERC20_ABI, functionName: 'balanceOf', args: [who], chainId: TARGET_CHAIN_ID },
      { address: OURO_USDT ?? ZERO, abi: ERC20_ABI, functionName: 'balanceOf', args: [who], chainId: TARGET_CHAIN_ID },
    ],
    query: { enabled: OURO_MINT !== undefined && address !== undefined, refetchInterval: POLL_MS },
  })
  const d = q.data
  const vest = v<readonly [bigint, bigint, bigint]>(d?.[4], [0n, 0n, 0n])
  const user: OuroUser = {
    remaining: Number(v<bigint>(d?.[0], 0n)),
    l1Shares: v(d?.[1], 0n),
    l1Tokens: v(d?.[2], 0n),
    l1Claimed: v(d?.[3], false),
    vestLocked: vest[0],
    vestClaimable: vest[1],
    unlockAt: Number(vest[2]),
    tokenBalance: v(d?.[5], 0n),
    usdtBalance: v(d?.[6], 0n),
  }
  return { address, user, refetch: q.refetch, remainingError: d?.[0]?.status === 'failure' }
}
