'use client'

import { useEffect, useMemo, useState } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import { formatUnits, type Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI, ERC20_ABI, LAUNCH_WINDOW_SECONDS,
} from '@/lib/contracts'
import { useNowSec } from '@/components/ui'

export type DirectoryTab = 'live' | 'launching' | 'completed' | 'archived'

export interface DirectoryProject {
  token:           Address
  hook:            Address
  creator:         Address
  createdAt:       bigint
  launched:        boolean
  genesisDeadline: bigint
  totalEth:        bigint
  softCap:         bigint
  symbol:          string
  name:            string
  logoUrl:         string | null
  website:         string | null
  twitter:         string | null
  description:     string | null
  tab:             DirectoryTab
  progress:        number
}

const SCAN_DEPTH = 48

interface RegistryRow {
  name:          string
  symbol:        string
  logo_url:      string | null   // Supabase returns snake_case
  token_address: string | null
  hook_address:  string | null
  website:       string | null
  twitter:       string | null
  description:   string | null
  telegram:      string | null
}

/// Order matters, and an earlier revision had it wrong in both directions.
///
///   • The deadline was tested BEFORE the soft cap, so a raise that succeeded
///     and was waiting on the creator's `launch()` got filed under `archived`
///     and rendered as "[REFUND] ELIGIBLE" — advertising a healthy project as
///     dead and pointing its depositors at a refund the hook would reject.
///   • `launching` fired as soon as the soft cap was touched, while the window
///     was still open.  Nothing is launching then: deposits are still accepted
///     and the creator cannot call `launch()` until the deadline passes.
function bucket(
  launched: boolean,
  totalEth: bigint,
  softCap: bigint,
  genesisDeadline: bigint,
  nowSec: number,
): DirectoryTab {
  if (launched) return 'completed'

  // nowSec === 0 means the clock has not ticked yet; do not call it expired.
  if (nowSec === 0 || Number(genesisDeadline) > nowSec) return 'live'

  const capMet = softCap > 0n && totalEth >= softCap
  if (!capMet) return 'archived'

  // Cap met, but `launch()` only stays open for LAUNCH_WINDOW; past that the
  // hook opens refunds to everyone and the raise really is archived.
  const launchWindowEnd = Number(genesisDeadline) + Number(LAUNCH_WINDOW_SECONDS)
  return nowSec < launchWindowEnd ? 'launching' : 'archived'
}

export function useDirectoryProjects() {
  // One shared store instead of a per-hook interval; `CLOCK_UNSYNCED` (0)
  // carries the same "not known yet" reading the local `useState(0)` did, and
  // `bucketOf` below already treats an unread deadline as live.
  const nowSec = useNowSec()
  const [registry, setRegistry] = useState<Map<string, RegistryRow>>(new Map())

  useEffect(() => {
    let cancelled = false
    fetch('/api/projects', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((payload: unknown) => {
        if (cancelled) return
        const rows: RegistryRow[] = Array.isArray(payload)
          ? (payload as RegistryRow[])
          : ((payload as { data?: RegistryRow[] })?.data ?? [])
        const map = new Map<string, RegistryRow>()
        for (const r of rows) {
          if (r.token_address) map.set(r.token_address.toLowerCase(), r)
        }
        setRegistry(map)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const { data: launchCountRaw, isLoading: countLoading, refetch } = useReadContract({
    address:      FACTORY_ADDRESS,
    abi:          FACTORY_ABI,
    functionName: 'launchCount',
    query:        { refetchInterval: 30_000 },
  })
  const launchCount = launchCountRaw !== undefined ? Number(launchCountRaw as bigint) : 0

  const launchIds = useMemo(() => {
    const start = Math.max(0, launchCount - SCAN_DEPTH)
    return Array.from({ length: launchCount - start }, (_, i) => BigInt(start + i))
  }, [launchCount])

  const launchesQuery = useReadContracts({
    contracts: launchIds.map(id => ({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launches' as const, args: [id] as const,
    })),
    query: { enabled: launchCount > 0 },
  })

  const launches = useMemo(() => {
    if (!launchesQuery.data) return []
    const out: { token: Address; hook: Address; creator: Address; createdAt: bigint }[] = []
    for (const r of launchesQuery.data) {
      if (r.status !== 'success') continue
      const t = r.result as readonly [Address, Address, Address, bigint]
      out.push({ token: t[0], hook: t[1], creator: t[2], createdAt: t[3] })
    }
    return out
  }, [launchesQuery.data])

  const phaseQuery = useReadContracts({
    contracts: launches.flatMap(l => [
      { address: l.hook,  abi: HOOK_ABI,  functionName: 'launched'           as const },
      { address: l.hook,  abi: HOOK_ABI,  functionName: 'genesisDeadline'    as const },
      { address: l.hook,  abi: HOOK_ABI,  functionName: 'totalEthDeposited'  as const },
      { address: l.hook,  abi: HOOK_ABI,  functionName: 'softCap'            as const },
      { address: l.token, abi: ERC20_ABI, functionName: 'symbol'             as const },
      { address: l.token, abi: ERC20_ABI, functionName: 'name'               as const },
    ]),
    query: { enabled: launches.length > 0, refetchInterval: 15_000 },
  })

  const projects: DirectoryProject[] = useMemo(() => {
    if (!phaseQuery.data) return []
    const out: DirectoryProject[] = []
    for (let i = 0; i < launches.length; i++) {
      const off = i * 6
      const d = phaseQuery.data
      const l = launches[i]
      const launched        = d[off]?.status === 'success' ? (d[off].result as boolean) : false
      const genesisDeadline = d[off + 1]?.status === 'success' ? (d[off + 1].result as bigint) : 0n
      const totalEth        = d[off + 2]?.status === 'success' ? (d[off + 2].result as bigint) : 0n
      const softCap         = d[off + 3]?.status === 'success' ? (d[off + 3].result as bigint) : 0n
      const symbol          = d[off + 4]?.status === 'success' ? (d[off + 4].result as string) : '???'
      const name            = d[off + 5]?.status === 'success' ? (d[off + 5].result as string) : 'Unknown'
      const reg             = registry.get(l.token.toLowerCase())
      const progress        = softCap > 0n
        ? Math.min(100, Number((totalEth * 10000n) / softCap) / 100)
        : 0
      const tab             = bucket(launched, totalEth, softCap, genesisDeadline, nowSec)
      out.push({
        ...l,
        launched, genesisDeadline, totalEth, softCap, symbol,
        name: reg?.name || name,
        logoUrl: reg?.logo_url ?? null,
        website: reg?.website ?? null,
        twitter: reg?.twitter ?? null,
        description: reg?.description ?? null,
        tab, progress,
      })
    }
    out.sort((a, b) => Number(b.createdAt - a.createdAt))
    return out
  }, [phaseQuery.data, launches, registry, nowSec])

  const counts = useMemo(() => ({
    live:       projects.filter(p => p.tab === 'live').length,
    launching:  projects.filter(p => p.tab === 'launching').length,
    completed:  projects.filter(p => p.tab === 'completed').length,
    archived:   projects.filter(p => p.tab === 'archived').length,
  }), [projects])

  const loading = countLoading || (launchCount > 0 && launchesQuery.isLoading)
    || (launches.length > 0 && phaseQuery.isLoading) || nowSec === 0

  return { projects, counts, loading, refetch, launchCount }
}

export function fmtEth(wei: bigint): string {
  const n = Number(formatUnits(wei, 18))
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}
