'use client'

import { useQuery } from '@tanstack/react-query'
import { zeroAddress, type Address } from 'viem'
import { usePublicClient, useReadContract, useReadContracts } from 'wagmi'

import { TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_BIDBOOK_ABI, V2_LENS_ABI } from './abis'
import { V2_BIDBOOK, V2_ENABLED, V2_FROM_BLOCK, V2_LENS } from './config'
import type { LiveBid } from './bidMath'

const LOG_CHUNK = 5_000n

/** `true` when a v2 factory registered `hook`. Ask BidBook, not the hook: a
 *  spoofed contract can return our factory from `factory()` and harvest an
 *  approve. `factoryOf` reads `registeredHooks`, which only `createLaunch` writes. */
export function useIsV2Hook(hook: Address | undefined): boolean | undefined {
  const { data, isError } = useReadContract({
    address: V2_BIDBOOK,
    abi: V2_BIDBOOK_ABI,
    functionName: 'factoryOf',
    args: hook ? [hook] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: V2_ENABLED && hook !== undefined && V2_BIDBOOK !== undefined, staleTime: Infinity },
  })
  if (!V2_ENABLED || isError) return false
  if (data === undefined) return undefined
  return data !== zeroAddress
}

export function useGenesisState(hook: Address | undefined) {
  return useReadContract({
    address: V2_LENS,
    abi: V2_LENS_ABI,
    functionName: 'genesisState',
    args: hook ? [hook] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: V2_ENABLED && hook !== undefined, refetchInterval: 8_000 },
  })
}

export function useAccountState(hook: Address | undefined, account: Address | undefined) {
  return useReadContract({
    address: V2_LENS,
    abi: V2_LENS_ABI,
    functionName: 'accountState',
    args: hook && account ? [hook, account] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: V2_ENABLED && hook !== undefined && account !== undefined, refetchInterval: 15_000 },
  })
}

/** Bid ids ever placed on `hook`: the indexer first, a direct log scan if it is down. */
function useBidIds(hook: Address | undefined, bidder?: Address) {
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID })
  return useQuery({
    queryKey: ['v2-bid-ids', hook, bidder],
    enabled: V2_ENABLED && (hook !== undefined || bidder !== undefined) && client !== undefined,
    refetchInterval: 10_000,
    queryFn: async (): Promise<bigint[]> => {
      const qs = new URLSearchParams()
      if (hook) qs.set('hook', hook)
      if (bidder) qs.set('bidder', bidder)
      try {
        const r = await fetch(`/api/v2/bids?${qs}`, { cache: 'no-store' })
        if (r.ok) {
          const j = (await r.json()) as { bids: { bid_id: string }[] }
          return j.bids.map(b => BigInt(b.bid_id))
        }
      } catch {
        // fall through to the chain
      }
      const latest = await client!.getBlockNumber()
      const start = V2_FROM_BLOCK > 0n ? V2_FROM_BLOCK : latest > 50_000n ? latest - 50_000n : 0n
      const ids: bigint[] = []
      for (let from = start; from <= latest; from += LOG_CHUNK) {
        const to = from + LOG_CHUNK - 1n > latest ? latest : from + LOG_CHUNK - 1n
        const logs = await client!.getContractEvents({
          address: V2_BIDBOOK!,
          abi: V2_BIDBOOK_ABI,
          eventName: 'BidPlaced',
          args: { ...(hook ? { hook } : {}), ...(bidder ? { bidder } : {}) },
          fromBlock: from,
          toBlock: to,
        })
        for (const l of logs) if (l.args.bidId !== undefined) ids.push(l.args.bidId)
      }
      return ids
    },
  })
}

/** Live state of every bid on `hook` (or by `bidder`), read from the contract. */
export function useBids(hook: Address | undefined, bidder?: Address) {
  const ids = useBidIds(hook, bidder)
  const list = ids.data ?? []
  const reads = useReadContracts({
    contracts: list.map(id => ({
      address: V2_BIDBOOK!,
      abi: V2_BIDBOOK_ABI,
      functionName: 'bids' as const,
      args: [id] as const,
      chainId: TARGET_CHAIN_ID,
    })),
    query: { enabled: V2_ENABLED && list.length > 0, refetchInterval: 10_000 },
  })
  const bids: (LiveBid & { hook: Address; quoteAsset: Address })[] = []
  reads.data?.forEach((r, i) => {
    if (r.status !== 'success') return
    const [bidderAddr, bidHook, , quoteAsset, price, qty, filled, escrow] = r.result as readonly [
      Address, Address, Address, Address, bigint, bigint, bigint, bigint,
    ]
    bids.push({ id: list[i], bidder: bidderAddr, hook: bidHook, quoteAsset, price, qty, filled, escrow })
  })
  return {
    bids,
    open: bids.filter(b => b.escrow > 0n && b.qty > b.filled),
    isLoading: ids.isLoading || reads.isLoading,
    refetch: () => { void ids.refetch(); void reads.refetch() },
  }
}
