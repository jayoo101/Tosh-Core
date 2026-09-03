'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import { formatUnits, type Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI, ERC20_ABI, LAUNCH_WINDOW_SECONDS,
} from '@/lib/contracts'
import { useIsHydrated, useNowSec } from '@/components/ui'

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

/**
 * How often the directory re-buckets projects into tabs.
 *
 * NOT the one-second clock. A tab only flips when a deadline is crossed, but
 * feeding `useNowSec()` into the list memo rebuilt every card object once a
 * second and re-rendered the whole grid with it. Each card still subscribes to
 * the one-second cadence for its own countdown text, so the visible clock is
 * unchanged — only the list rebuild slowed down.
 */
const BUCKET_CADENCE_MS = 10_000

/** Matches the dynamic poll below, so returning to `/` repaints from cache. */
const DIRECTORY_STALE_MS = 20_000

/**
 * Takes a reason string, never an `Error`. Handing the object to `console.warn`
 * makes Next expand a full code frame in the dev terminal on every mount, and
 * the frame points at our own `throw` rather than at the cause — the upstream
 * failure is already logged server-side by the route. One line is the whole of
 * what this adds over the silence it replaced.
 */
function warnRegistryUnavailable(reason: string): null {
  console.warn(
    `[Tosh] Project metadata is unavailable (${reason}), so cards fall back to their ` +
    'on-chain name and symbol. Refresh retries it.',
  )
  return null
}

export function useDirectoryProjects() {
  const nowSec = useNowSec(BUCKET_CADENCE_MS)
  const [registry, setRegistry] = useState<Map<string, RegistryRow>>(new Map())

  // Off-chain decoration only — descriptions, logos, links. The project list
  // itself comes off the factory, so a failure here degrades the cards rather
  // than emptying the directory, and the map is left at its last known value
  // instead of being cleared.
  //
  // It used to be a bare `useEffect` with `.catch(() => {})` and an empty
  // dependency list, which made a single 1.2s Supabase timeout permanent: the
  // fetch never ran again, REFRESH did not reach it, and every card spent the
  // rest of the session on fallback copy with nothing anywhere saying why.
  // Returns `null` rather than an empty map on failure, so a bad response is
  // never mistaken for "the registry knows about nothing" and cannot wipe the
  // rows already on screen.
  const fetchRegistry = useCallback(async (): Promise<Map<string, RegistryRow> | null> => {
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) return warnRegistryUnavailable(`/api/projects responded ${res.status}`)
      const payload: unknown = await res.json()
      const rows: RegistryRow[] = Array.isArray(payload)
        ? (payload as RegistryRow[])
        : ((payload as { data?: RegistryRow[] })?.data ?? [])
      const map = new Map<string, RegistryRow>()
      for (const r of rows) {
        if (r.token_address) map.set(r.token_address.toLowerCase(), r)
      }
      return map
    } catch (err) {
      return warnRegistryUnavailable(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchRegistry().then(map => { if (!cancelled && map) setRegistry(map) })
    return () => { cancelled = true }
  }, [fetchRegistry])

  const reloadRegistry = useCallback(async () => {
    const map = await fetchRegistry()
    if (map) setRegistry(map)
  }, [fetchRegistry])

  const { data: launchCountRaw, isLoading: countLoading, refetch: refetchCount } = useReadContract({
    address:      FACTORY_ADDRESS,
    abi:          FACTORY_ABI,
    functionName: 'launchCount',
    query:        { refetchInterval: 30_000, staleTime: DIRECTORY_STALE_MS },
  })
  const launchCount = launchCountRaw !== undefined ? Number(launchCountRaw as bigint) : 0

  const launchIds = useMemo(() => {
    const start = Math.max(0, launchCount - SCAN_DEPTH)
    return Array.from({ length: launchCount - start }, (_, i) => BigInt(start + i))
  }, [launchCount])

  // `launches(id)` is written once at deploy and never again.
  const launchesQuery = useReadContracts({
    contracts: launchIds.map(id => ({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launches' as const, args: [id] as const,
    })),
    query: { enabled: launchCount > 0, staleTime: Infinity },
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

  // ERC-20 name and symbol are immutable, so they rode the 15s poll for
  // nothing: a third of every refresh re-read two constants per project.
  const identityQuery = useReadContracts({
    contracts: launches.flatMap(l => [
      { address: l.token, abi: ERC20_ABI, functionName: 'symbol' as const },
      { address: l.token, abi: ERC20_ABI, functionName: 'name'   as const },
    ]),
    query: { enabled: launches.length > 0, staleTime: Infinity },
  })

  const phaseQuery = useReadContracts({
    contracts: launches.flatMap(l => [
      { address: l.hook, abi: HOOK_ABI, functionName: 'launched'          as const },
      { address: l.hook, abi: HOOK_ABI, functionName: 'genesisDeadline'   as const },
      { address: l.hook, abi: HOOK_ABI, functionName: 'totalEthDeposited' as const },
      { address: l.hook, abi: HOOK_ABI, functionName: 'softCap'           as const },
    ]),
    query: {
      enabled: launches.length > 0,
      refetchInterval: 20_000,
      staleTime: DIRECTORY_STALE_MS,
    },
  })

  // Chain state only. `tab` is derived separately below so a clock tick does
  // not rebuild every row object.
  const rows = useMemo(() => {
    if (!phaseQuery.data) return []
    const d = phaseQuery.data
    const ident = identityQuery.data
    const out: Omit<DirectoryProject, 'tab'>[] = []
    for (let i = 0; i < launches.length; i++) {
      const off = i * 4
      const ioff = i * 2
      const l = launches[i]
      const launched        = d[off]?.status === 'success' ? (d[off].result as boolean) : false
      const genesisDeadline = d[off + 1]?.status === 'success' ? (d[off + 1].result as bigint) : 0n
      const totalEth        = d[off + 2]?.status === 'success' ? (d[off + 2].result as bigint) : 0n
      const softCap         = d[off + 3]?.status === 'success' ? (d[off + 3].result as bigint) : 0n
      const symbol          = ident?.[ioff]?.status === 'success' ? (ident[ioff].result as string) : '???'
      const name            = ident?.[ioff + 1]?.status === 'success' ? (ident[ioff + 1].result as string) : 'Unknown'
      const reg             = registry.get(l.token.toLowerCase())
      const progress        = softCap > 0n
        ? Math.min(100, Number((totalEth * 10000n) / softCap) / 100)
        : 0
      out.push({
        ...l,
        launched, genesisDeadline, totalEth, softCap,
        symbol: reg?.symbol || symbol,
        name: reg?.name || name,
        logoUrl: reg?.logo_url ?? null,
        website: reg?.website ?? null,
        twitter: reg?.twitter ?? null,
        description: reg?.description ?? null,
        progress,
      })
    }
    out.sort((a, b) => Number(b.createdAt - a.createdAt))
    return out
  }, [phaseQuery.data, identityQuery.data, launches, registry])

  // Re-bucketing must not hand every card a new object. `MeritXProjectCard` is
  // memoised on its `project` prop, so spreading a fresh row on every tick
  // would make that memo a no-op and re-render the whole grid for a boundary
  // nobody crossed. Collapsing the tabs to a primitive first keeps the memo
  // below pure and lets it hold its result until a tab genuinely flips.
  const tabKey = useMemo(
    () => rows
      .map(r => bucket(r.launched, r.totalEth, r.softCap, r.genesisDeadline, nowSec))
      .join(','),
    [rows, nowSec],
  )

  const projects: DirectoryProject[] = useMemo(() => {
    const tabs = tabKey === '' ? [] : tabKey.split(',') as DirectoryTab[]
    return rows.map((r, i) => ({ ...r, tab: tabs[i] ?? 'live' }))
  }, [rows, tabKey])

  const counts = useMemo(() => ({
    live:       projects.filter(p => p.tab === 'live').length,
    launching:  projects.filter(p => p.tab === 'launching').length,
    completed:  projects.filter(p => p.tab === 'completed').length,
    archived:   projects.filter(p => p.tab === 'archived').length,
  }), [projects])

  // `/` is prerendered, and at build time wagmi reports `isLoading: false`
  // (nothing is in flight) while the hydration pass reports `true` (the query
  // starts fetching during that render). Consumers branch on this, so the two
  // renders disagreed about whether to emit the REFRESH_RADAR button. The
  // clock used to paper over it by forcing `loading` true on both sides;
  // hydration is the honest gate and it clears on the next render instead of
  // holding the grid back for up to a full second.
  const hydrated = useIsHydrated()
  const loading = !hydrated || countLoading
    || (launchCount > 0 && launchesQuery.isLoading)
    || (launches.length > 0 && phaseQuery.isLoading)

  // REFRESH_RADAR has to reach the phase reads too. Now that they carry a
  // `staleTime`, refetching only `launchCount` would leave the raise totals on
  // screen exactly as they were and make the button look broken.
  const refetchPhase = phaseQuery.refetch
  const refetch = useCallback(async () => {
    await Promise.all([refetchCount(), refetchPhase(), reloadRegistry()])
  }, [refetchCount, refetchPhase, reloadRegistry])

  return { projects, counts, loading, refetch, launchCount }
}

export function fmtEth(wei: bigint): string {
  const n = Number(formatUnits(wei, 18))
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}
