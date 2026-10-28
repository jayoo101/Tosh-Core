'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useReadContracts } from 'wagmi'
import { formatUnits, type Address } from 'viem'

import { ERC20_ABI, QUOTE_DECIMALS, type QuoteConfig } from '@/lib/contracts'
import { useIsHydrated, useNowSec } from '@/components/ui'
import { V2_FACTORY_ABI, V2_HOOK_ABI } from '@/lib/v2/abis'
import { V2_FACTORIES, v2QuoteConfig } from '@/lib/v2/config'

export type DirectoryTab = 'live' | 'launching' | 'completed' | 'ended'

export interface DirectoryProject {
  token:           Address
  hook:            Address
  creator:         Address
  createdAt:       bigint
  /** The v2 factory that created it; it fixes the quote asset. */
  factory:         Address
  launched:        boolean
  genesisDeadline: bigint
  /** The window the creator chose, in seconds — the countdown bar's denominator. */
  genesisDuration: bigint
  totalNative:        bigint
  /** What `totalNative` is denominated in: WBNB on the BNB factory, USDT on the other. */
  quote:           QuoteConfig
  symbol:          string
  name:            string
  logoUrl:         string | null
  /** The platform-set 16:9 card cover (migration 0007); absent or null means none. */
  coverUrl?:       string | null
  website:         string | null
  twitter:         string | null
  description:     string | null
  /**
   * When an operator's pin on this launch runs out, in unix milliseconds, or
   * `null` if it is not pinned.
   *
   * The only field here that is neither chain state nor presentation: it is an
   * editorial decision, and the one thing in the registry that changes what
   * order launches are shown in rather than what a card says. `null` is the
   * normal case; a live pin puts the launch in the homepage feature slot. See
   * `supabase/migrations/0005_projects_featured.sql` for why it expires.
   *
   * A PAST TIMESTAMP IS NOT NORMALISED TO `null` HERE. The comparison belongs
   * where the clock is: this hook re-derives rows only when a tab flips, so an
   * expiry folded in at this level would sit unevaluated until something else
   * moved the list.
   */
  featuredUntilMs: number | null
  tab:             DirectoryTab
}

/**
 * How many launches back the enumeration reaches, newest first.
 *
 * Per factory. The directory sorts and filters this recent window and says
 * when it truncates.
 */
const SCAN_DEPTH = 48

/**
 * The per-hook reads, in the order `rows` unpacks them. `soldOutAt` is there
 * because a sold-out genesis is closed even before its deadline.
 */
const HOOK_READS = [
  'launched',
  'genesisDeadline',
  'raised',
  'soldOutAt',
] as const

const READS_PER_HOOK = HOOK_READS.length

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
  /** ISO-8601 from Postgres `timestamptz`, or absent on a row written before 0005. */
  featured_until: string | null
  /** Absent on a row written before 0007. */
  cover_url?:    string | null
}

/**
 * `featured_until` as a number the sort can compare, or `null`.
 *
 * Tolerant in both of the ways this value can arrive wrong, because neither is
 * worth degrading the whole directory over: the column is missing on a
 * deployment that has not run migration 0005, and `Date.parse` returns `NaN`
 * rather than throwing on anything it cannot read. Both land on `null`, which
 * is "not pinned" — the state the page was in before this existed.
 */
function parseFeaturedUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/// Buys run until the deadline (or sell-out); after that a genesis that sold
/// anything is waiting on `launch()`, and one that sold nothing is over for
/// good, because `launch()` reverts `NothingRaised` and v2 has no refunds.
export function bucket(
  launched: boolean,
  genesisDeadline: bigint,
  nowSec: number,
  raised: bigint,
): DirectoryTab {
  if (launched) return 'completed'

  // nowSec === 0 means the clock has not ticked yet; do not call it expired.
  if (nowSec === 0 || Number(genesisDeadline) > nowSec) return 'live'

  return raised > 0n ? 'launching' : 'ended'
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

  // Both v2 factories; a launch lives on exactly one.
  const countsQuery = useReadContracts({
    contracts: V2_FACTORIES.map(address => ({
      address, abi: V2_FACTORY_ABI, functionName: 'launchCount' as const,
    })),
    query: { refetchInterval: 30_000, staleTime: DIRECTORY_STALE_MS },
  })
  const countLoading = countsQuery.isLoading
  const refetchCount = countsQuery.refetch
  // Joined to a primitive so the memo below does not re-run on every poll.
  const countsKey = V2_FACTORIES
    .map((_, i) => {
      const r = countsQuery.data?.[i]
      return r?.status === 'success' ? Number(r.result as bigint) : 0
    })
    .join(',')
  const launchCount = countsKey.split(',').reduce((a, n) => a + Number(n), 0)
  /** `SCAN_DEPTH` is per factory, so truncation is too. */
  const truncated = countsKey.split(',').some(n => Number(n) > SCAN_DEPTH)

  const launchRefs = useMemo(() => {
    const counts = countsKey.split(',').map(Number)
    return V2_FACTORIES.flatMap((factory, f) => {
      const n = counts[f] ?? 0
      const start = Math.max(0, n - SCAN_DEPTH)
      return Array.from({ length: n - start }, (_, i) => ({ factory, id: BigInt(start + i) }))
    })
  }, [countsKey])

  // `launches(id)` is written once at deploy and never again.
  const launchesQuery = useReadContracts({
    contracts: launchRefs.map(({ factory, id }) => ({
      address: factory, abi: V2_FACTORY_ABI, functionName: 'launches' as const, args: [id] as const,
    })),
    query: { enabled: launchRefs.length > 0, staleTime: Infinity },
  })

  const launches = useMemo(() => {
    if (!launchesQuery.data) return []
    const out: { token: Address; hook: Address; creator: Address; createdAt: bigint; factory: Address }[] = []
    launchesQuery.data.forEach((r, i) => {
      if (r.status !== 'success') return
      const t = r.result as readonly [Address, Address, Address, bigint]
      out.push({ token: t[0], hook: t[1], creator: t[2], createdAt: t[3], factory: launchRefs[i].factory })
    })
    return out
  }, [launchesQuery.data, launchRefs])

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
    contracts: launches.flatMap(l =>
      HOOK_READS.map(functionName => ({ address: l.hook, abi: V2_HOOK_ABI, functionName })),
    ),
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
      const off = i * READS_PER_HOOK
      const ioff = i * 2
      const l = launches[i]
      const launched        = d[off]?.status === 'success' ? (d[off].result as boolean) : false
      const deadline        = d[off + 1]?.status === 'success' ? (d[off + 1].result as bigint) : 0n
      const totalNative        = d[off + 2]?.status === 'success' ? (d[off + 2].result as bigint) : 0n
      const soldOutAt       = d[off + 3]?.status === 'success' ? (d[off + 3].result as bigint) : 0n
      const genesisDeadline = soldOutAt > 0n && soldOutAt < deadline ? soldOutAt : deadline
      const symbol          = ident?.[ioff]?.status === 'success' ? (ident[ioff].result as string) : '???'
      const name            = ident?.[ioff + 1]?.status === 'success' ? (ident[ioff + 1].result as string) : 'Unknown'
      const reg             = registry.get(l.token.toLowerCase())
      out.push({
        ...l,
        launched, genesisDeadline, totalNative,
        quote: v2QuoteConfig(l.factory),
        genesisDuration: deadline > l.createdAt ? deadline - l.createdAt : 0n,
        symbol: reg?.symbol || symbol,
        name: reg?.name || name,
        logoUrl: reg?.logo_url ?? null,
        coverUrl: reg?.cover_url ?? null,
        website: reg?.website ?? null,
        twitter: reg?.twitter ?? null,
        description: reg?.description ?? null,
        featuredUntilMs: parseFeaturedUntil(reg?.featured_until),
      })
    }
    out.sort((a, b) => Number(b.createdAt - a.createdAt))
    return out
  }, [phaseQuery.data, identityQuery.data, launches, registry])

  // Re-bucketing must not hand every card a new object. `ProjectCard` is
  // memoised on its `project` prop, so spreading a fresh row on every tick
  // would make that memo a no-op and re-render the whole grid for a boundary
  // nobody crossed. Collapsing the tabs to a primitive first keeps the memo
  // below pure and lets it hold its result until a tab genuinely flips.
  const tabKey = useMemo(
    () => rows
      .map(r => bucket(r.launched, r.genesisDeadline, nowSec, r.totalNative))
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
    ended:      projects.filter(p => p.tab === 'ended').length,
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

  return { projects, counts, loading, refetch, launchCount, truncated }
}

/** A raise, for the cards and the feed. */
export function fmtQuote(units: bigint, decimals: number = QUOTE_DECIMALS): string {
  const n = Number(formatUnits(units, decimals))
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}
