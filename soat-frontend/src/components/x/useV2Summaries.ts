'use client'

import { useMemo } from 'react'
import type { Address } from 'viem'
import { useReadContracts } from 'wagmi'

import type { DirectoryProject } from '@/components/directory/useDirectoryProjects'
import { TARGET_CHAIN_ID } from '@/lib/chain'
import { V2_HOOK_ABI, V2_LENS_ABI } from '@/lib/v2/abis'
import { V2_ENABLED, V2_LENS, isV2Factory } from '@/lib/v2/config'

export interface GenesisSummary {
  hardCap: bigint
  perAgentCap: bigint
  basePrice: bigint
  currentPrice: bigint
  sold: bigint
  raised: bigint
  genesisDeadline: bigint
  soldOutAt: bigint
  launched: boolean
}

export interface ShelfSummary { tierIndex: bigint; tierPrice: bigint; spotPrice: bigint }

const key = (a: string) => a.toLowerCase()

/**
 * One `genesisState` per v2 project in the list, keyed by hook. A project the
 * lens did not answer for is not in the map: the cards fall back to what the
 * directory already read.
 */
export function useV2Summaries(projects: readonly DirectoryProject[]): Map<string, GenesisSummary> {
  const hooks = useMemo(() => projects.filter(p => isV2Factory(p.factory)).map(p => p.hook), [projects])
  const { data } = useReadContracts({
    contracts: hooks.map(hook => ({
      address: V2_LENS!, abi: V2_LENS_ABI, functionName: 'genesisState' as const, args: [hook] as const, chainId: TARGET_CHAIN_ID,
    })),
    query: { enabled: V2_ENABLED && hooks.length > 0, refetchInterval: 20_000 },
  })
  return useMemo(() => {
    const out = new Map<string, GenesisSummary>()
    data?.forEach((r, i) => {
      if (r.status === 'success') out.set(key(hooks[i]), r.result as GenesisSummary)
    })
    return out
  }, [data, hooks])
}

/** The live shelf of every launched v2 project in the list, keyed by hook. */
export function useShelfSummaries(projects: readonly DirectoryProject[]): Map<string, ShelfSummary> {
  const hooks = useMemo(
    () => projects.filter(p => p.launched && isV2Factory(p.factory)).map(p => p.hook as Address),
    [projects],
  )
  const { data } = useReadContracts({
    contracts: hooks.map(hook => ({ address: hook, abi: V2_HOOK_ABI, functionName: 'tierStatus' as const, chainId: TARGET_CHAIN_ID })),
    query: { enabled: V2_ENABLED && hooks.length > 0, refetchInterval: 20_000 },
  })
  return useMemo(() => {
    const out = new Map<string, ShelfSummary>()
    data?.forEach((r, i) => {
      if (r.status !== 'success') return
      const [tierIndex, tierPrice, , spotPrice] = r.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean]
      out.set(key(hooks[i]), { tierIndex, tierPrice, spotPrice })
    })
    return out
  }, [data, hooks])
}

export function summaryOf<T>(map: Map<string, T>, hook: string): T | undefined {
  return map.get(key(hook))
}
