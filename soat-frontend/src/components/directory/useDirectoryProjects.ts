'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import { formatUnits, type Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI, ERC20_ABI,
  QUOTE_DECIMALS, GENESIS_DURATIONS,
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
  /**
   * The window the creator chose, in seconds — the countdown bar's denominator.
   *
   * DERIVED, NOT READ, and `0n` when the derivation cannot be trusted. See
   * `deriveGenesisDuration`.
   */
  genesisDuration: bigint
  totalNative:        bigint
  /** The hook's `canRefund()`. The `archived` tab is this and nothing else. */
  canRefund:       boolean
  symbol:          string
  name:            string
  logoUrl:         string | null
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
   * normal case — see `AgentDirectoryHome` for what a live pin overrides, and
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
 * Exported because a caller that presents itself as complete has to know it is
 * not. The directory can be bounded without lying — it sorts and filters a
 * recent window and says so — but `/referrals` claims to collect every project
 * that owes a wallet, and a referrer whose commission sits on launch #3 of 400
 * would be told they have none. That page reads this to bound its own claim.
 */
export const SCAN_DEPTH = 48

/**
 * The per-hook reads, in the order `rows` unpacks them.
 *
 * ONE list, so the stride cannot drift from the batch. These were written out
 * as literals in the `useReadContracts` call with a separate `i * 3` below and
 * a comment warning that the two "silently mis-read every field if they
 * disagree" — which is a hazard, not a mitigation. Adding `canRefund` was
 * exactly the edit that comment was afraid of, so the length now comes from
 * the list itself.
 *
 * `canRefund` costs the chain call `softCap` used to, and buys the one thing
 * the tabs cannot work out locally: whether a closed genesis owes refunds
 * today or in a week. The soft cap bought nothing — by the time it came out it
 * was displayed nowhere and bucketed on nothing.
 */
const HOOK_READS = [
  'launched',
  'genesisDeadline',
  'totalNativeDeposited',
  'canRefund',
] as const

const READS_PER_HOOK = HOOK_READS.length

/**
 * The genesis window's length, without spending a read on it.
 *
 * `genesisDuration()` is the authority and this is not it, so the reason for
 * deriving has to be better than "one fewer call". It is: the value is frozen
 * at deployment, so polling it every 20 s re-fetches a constant — 48 of them to
 * paint one grid, on a list whose read budget is why `SCAN_DEPTH` exists at all.
 *
 * The identity is exact rather than approximate. `initializeToken` sets
 * `genesisDeadline = block.timestamp + duration`, and the factory pushes
 * `LaunchInfo(..., block.timestamp)` later in the SAME `createLaunch` call, so
 * both timestamps are one block's and the difference is the duration to the
 * second.
 *
 * ⚠ THAT IS AN INVARIANT ACROSS TWO CONTRACTS, which is exactly the kind of
 *   thing a later refactor breaks without meaning to. So this does not trust
 *   it: the hook rejects any duration that is not one of three rungs
 *   (`InvalidDuration`), so a difference that is not a rung cannot be a real
 *   duration, and the only honest answer is `0n`. `genesisWindow` draws nothing
 *   on `0n`, so the failure mode is a missing bar rather than a bar measuring
 *   the raise against a number no contract agrees with.
 */
export function deriveGenesisDuration(genesisDeadline: bigint, createdAt: bigint): bigint {
  if (genesisDeadline <= createdAt) return 0n
  const span = genesisDeadline - createdAt
  const rungs: readonly bigint[] = Object.values(GENESIS_DURATIONS)
  return rungs.includes(span) ? span : 0n
}

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

/// Order matters, and neither boundary is a funding level.
///
///   • `launching` once fired as soon as the soft cap was touched, while the
///     window was still open. Nothing is launching then: deposits are still
///     accepted and the creator cannot call `launch()` until the deadline
///     passes.
///   • After the deadline, an unlaunched raise is `launching` only while a
///     launch is still possible. `archived` means the refund door is open.
///
/// ⚠ THIS USED TO DERIVE `archived` FROM THE 7-DAY CLOCK, and that is now a
///   week late on every raise too small to carry a ladder. Those refund the
///   moment genesis closes — `launch()` is arithmetically impossible on them,
///   so there is no window to wait out — and the old rule filed them under
///   `launching` for seven days: a countdown to a launch that could never
///   happen, sitting on top of a refund the depositor could already take.
///
///   The justification that used to be here read "filing an under-target raise
///   as `archived` advertised a refund the hook would reject". That sentence
///   was true of the old hook and is now exactly backwards.
///
///   So the tab reads `canRefund()` instead of re-deriving it. That view is
///   the contract's own answer and already folds in both doors, which is the
///   whole reason it is worth a chain call: any local re-derivation is a
///   second copy of a rule that has now changed once.
///
/// ⚠ THE SOFT CAP PARAMETER IS GONE, and its absence is the point rather than
///   a tidy-up. It was `_softCap`, underscored because this function never
///   read it — two revisions of a tab rule that both concluded the raise's
///   size decides nothing about its phase. Keeping the argument invited the
///   next reader to wire it back in.
export function bucket(
  launched: boolean,
  canRefund: boolean,
  genesisDeadline: bigint,
  nowSec: number,
): DirectoryTab {
  if (launched) return 'completed'

  // nowSec === 0 means the clock has not ticked yet; do not call it expired.
  if (nowSec === 0 || Number(genesisDeadline) > nowSec) return 'live'

  // A failed read defaults `canRefund` to false, which lands here as
  // `launching`. That is the safe direction: it understates a refund rather
  // than advertising one the hook would reject.
  return canRefund ? 'archived' : 'launching'
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
    contracts: launches.flatMap(l =>
      HOOK_READS.map(functionName => ({ address: l.hook, abi: HOOK_ABI, functionName })),
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
      // Four reads per hook. This stride moves with the contract list above
      // and silently mis-reads every field if the two disagree — it was three
      // until `canRefund` joined the batch.
      const off = i * READS_PER_HOOK
      const ioff = i * 2
      const l = launches[i]
      const launched        = d[off]?.status === 'success' ? (d[off].result as boolean) : false
      const genesisDeadline = d[off + 1]?.status === 'success' ? (d[off + 1].result as bigint) : 0n
      const totalNative        = d[off + 2]?.status === 'success' ? (d[off + 2].result as bigint) : 0n
      const canRefund       = d[off + 3]?.status === 'success' ? (d[off + 3].result as boolean) : false
      const symbol          = ident?.[ioff]?.status === 'success' ? (ident[ioff].result as string) : '???'
      const name            = ident?.[ioff + 1]?.status === 'success' ? (ident[ioff + 1].result as string) : 'Unknown'
      const reg             = registry.get(l.token.toLowerCase())
      out.push({
        ...l,
        launched, genesisDeadline, totalNative, canRefund,
        genesisDuration: deriveGenesisDuration(genesisDeadline, l.createdAt),
        symbol: reg?.symbol || symbol,
        name: reg?.name || name,
        logoUrl: reg?.logo_url ?? null,
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
      .map(r => bucket(r.launched, r.canRefund, r.genesisDeadline, nowSec))
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

/**
 * A raise or a soft cap, for the cards and the feed.
 *
 * Renamed from `fmtQuote` and rescaled: every caller passes `totalNative` or
 * `softCap`, both of which are quote-asset amounts at 8 decimals. Left at 18 it
 * showed a 500-unit raise as `0.000005`, which reads as a project nobody has funded
 * rather than as a formatting fault — so every card in the directory would have
 * understated its progress bar by ten orders of magnitude while looking fine.
 */
export function fmtQuote(units: bigint): string {
  const n = Number(formatUnits(units, QUOTE_DECIMALS))
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}
