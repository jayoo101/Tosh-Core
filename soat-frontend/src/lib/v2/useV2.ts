'use client'

import { useQuery } from '@tanstack/react-query'
import { zeroAddress, type Address } from 'viem'
import { usePublicClient, useReadContract, useReadContracts } from 'wagmi'

import { TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_BIDBOOK_ABI, V2_HOOK_ABI, V2_LENS_ABI } from './abis'
import { V3_FACTORY_EXTRA_ABI, V3_LENS_EXTRA_ABI } from './abisV3'
import { V31_FACTORY_ABI, V31_LENS_ABI } from './abisV31'
import { IS_V3, V2_BIDBOOK, V2_ENABLED, V2_FROM_BLOCK, V2_LENS, V31_ENABLED, V31_FACTORY, V31_LENS } from './config'
import type { LiveBid } from './bidMath'

const LOG_CHUNK = 5_000n
/** ~15 min of BSC blocks: past the index's 10-minute staleness limit, inside one log query. */
const RECENT_TAIL = 2_000n

/** `true` when a v2 factory registered `hook`. Ask BidBook, not the hook: a
 *  spoofed contract can return our factory from `factory()` and harvest an
 *  approve. `factoryOf` reads `registeredHooks`, which only `createLaunch` writes. */
export function useIsV2Hook(hook: Address | undefined): boolean | undefined {
  const v31 = useIsV31Hook(hook)
  const { data, isError } = useReadContract({
    address: V2_BIDBOOK,
    abi: V2_BIDBOOK_ABI,
    functionName: 'factoryOf',
    args: hook ? [hook] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: V2_ENABLED && hook !== undefined && V2_BIDBOOK !== undefined, staleTime: Infinity },
  })
  if (v31) return true
  if (!V2_ENABLED || isError) return v31 === undefined ? undefined : false
  if (data === undefined) return undefined
  return data !== zeroAddress || (v31 === undefined ? undefined : false)
}

/** `true` when the v3.1 factory registered `hook`, read off the factory for
 *  the reason above. The live BidBook predates it and cannot name it. */
export function useIsV31Hook(hook: Address | undefined): boolean | undefined {
  const { data, isError } = useReadContract({
    address: V31_FACTORY,
    abi: V31_FACTORY_ABI,
    functionName: 'registeredHooks',
    args: hook ? [hook] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: V31_ENABLED && hook !== undefined, staleTime: Infinity },
  })
  if (!V31_ENABLED || isError) return false
  return data
}

/** The lens that reads `hook`: v3.1's for its hooks, else the stack's. */
function useLensOf(hook: Address | undefined): { lens: Address | undefined; v31: boolean | undefined } {
  const v31 = useIsV31Hook(hook)
  return { lens: v31 ? V31_LENS : v31 === false ? V2_LENS : undefined, v31 }
}

/** The address `quoteGenesis` and `accountState` go to for `hook`. Both encode alike on every lens. */
export function useGenesisLens(hook: Address | undefined): Address | undefined {
  return useLensOf(hook).lens
}

/** The factory that registered `hook`, from BidBook for the same reason as above. */
function useHookFactory(hook: Address | undefined): Address | undefined {
  const { data } = useReadContract({
    address: V2_BIDBOOK,
    abi: V2_BIDBOOK_ABI,
    functionName: 'factoryOf',
    args: hook ? [hook] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: IS_V3 && V2_ENABLED && hook !== undefined, staleTime: Infinity },
  })
  return data && data !== zeroAddress ? data : undefined
}

/** v3 only: what `account`'s Agent ID may still spend on `hook`'s shelves. 0 without an ID. */
export function useShelfRemaining(hook: Address | undefined, account: Address | undefined) {
  const factory = useHookFactory(hook)
  return useReadContract({
    address: factory,
    abi: V3_FACTORY_EXTRA_ABI,
    functionName: 'shelfRemaining',
    args: hook && account ? [hook, account] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: IS_V3 && factory !== undefined && account !== undefined, refetchInterval: 15_000 },
  })
}

/** Cost of minting `amount` shelf tokens: on the hook in v2, on the lens in v3. */
export function useShelfQuote(hook: Address, amount: bigint) {
  const v2 = useReadContract({
    address: hook, abi: V2_HOOK_ABI, functionName: 'quoteMint', args: [amount], chainId: TARGET_CHAIN_ID,
    query: { enabled: !IS_V3 && amount > 0n },
  })
  const v3 = useReadContract({
    address: V2_LENS, abi: V3_LENS_EXTRA_ABI, functionName: 'quoteMint', args: [hook, amount], chainId: TARGET_CHAIN_ID,
    query: { enabled: IS_V3 && V2_LENS !== undefined && amount > 0n },
  })
  return IS_V3 ? v3 : v2
}

export function useGenesisState(hook: Address | undefined) {
  const { v31 } = useLensOf(hook)
  const base = useReadContract({
    address: V2_LENS,
    abi: V2_LENS_ABI,
    functionName: 'genesisState',
    args: hook ? [hook] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: V2_ENABLED && hook !== undefined && v31 === false, refetchInterval: 8_000 },
  })
  const next = useReadContract({
    address: V31_LENS,
    abi: V31_LENS_ABI,
    functionName: 'genesisState',
    args: hook ? [hook] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: hook !== undefined && v31 === true, refetchInterval: 8_000 },
  })
  if (!v31) return { data: base.data, refetch: base.refetch }
  return { data: next.data && { ...next.data, acceptsNative: false }, refetch: next.refetch }
}

export function useAccountState(hook: Address | undefined, account: Address | undefined) {
  const { lens } = useLensOf(hook)
  return useReadContract({
    address: lens,
    abi: V2_LENS_ABI,
    functionName: 'accountState',
    args: hook && account ? [hook, account] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: V2_ENABLED && lens !== undefined && hook !== undefined && account !== undefined, refetchInterval: 15_000 },
  })
}

/** v3.1 only: the L2 curve of `hook`, with any idle burn that is due counted as burned. */
export function useL2State(hook: Address | undefined) {
  return useReadContract({
    address: V31_LENS,
    abi: V31_LENS_ABI,
    functionName: 'l2State',
    args: hook ? [hook] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: V31_ENABLED && hook !== undefined, refetchInterval: 8_000 },
  })
}

/** v3.1 only: what `account` may still pay on `hook`'s L2, and its vesting lock. */
export function useL2Account(hook: Address | undefined, account: Address | undefined) {
  return useReadContract({
    address: V31_LENS,
    abi: V31_LENS_ABI,
    functionName: 'l2Account',
    args: hook && account ? [hook, account] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: V31_ENABLED && hook !== undefined && account !== undefined, refetchInterval: 15_000 },
  })
}

/** v3.1 only: what `mintL2(pay, 0)` would lock and charge now. */
export function useL2Quote(hook: Address | undefined, pay: bigint) {
  return useReadContract({
    address: V31_LENS,
    abi: V31_LENS_ABI,
    functionName: 'quoteL2',
    args: hook ? [hook, pay] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: V31_ENABLED && hook !== undefined && pay > 0n, refetchInterval: 8_000 },
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
      const scan = (fromBlock: bigint, toBlock: bigint) => client!.getContractEvents({
        address: V2_BIDBOOK!,
        abi: V2_BIDBOOK_ABI,
        eventName: 'BidPlaced',
        args: { ...(hook ? { hook } : {}), ...(bidder ? { bidder } : {}) },
        fromBlock,
        toBlock,
      })
      try {
        const r = await fetch(`/api/v2/bids?${qs}`, { cache: 'no-store' })
        if (r.ok) {
          const j = (await r.json()) as { bids: { bid_id: string }[] }
          const ids = j.bids.map(b => BigInt(b.bid_id))
          // The index may trail the chain by up to its staleness limit, so a
          // bid placed a moment ago is not in it yet. Read the tail directly.
          try {
            const latest = await client!.getBlockNumber()
            const seen = new Set(ids)
            for (const l of await scan(latest > RECENT_TAIL ? latest - RECENT_TAIL : 0n, latest)) {
              if (l.args.bidId !== undefined && !seen.has(l.args.bidId)) { seen.add(l.args.bidId); ids.push(l.args.bidId) }
            }
          } catch { /* the index answer stands; the next poll retries the tail */ }
          return ids
        }
      } catch {
        // fall through to the chain
      }
      const latest = await client!.getBlockNumber()
      const start = V2_FROM_BLOCK > 0n ? V2_FROM_BLOCK : latest > 50_000n ? latest - 50_000n : 0n
      const ids: bigint[] = []
      for (let from = start; from <= latest; from += LOG_CHUNK) {
        const to = from + LOG_CHUNK - 1n > latest ? latest : from + LOG_CHUNK - 1n
        for (const l of await scan(from, to)) if (l.args.bidId !== undefined) ids.push(l.args.bidId)
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
