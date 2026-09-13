'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Retail LP data layer.
//
// POSITION DISCOVERY IS THE HARD PART.  V4 positions are ERC-721s held by the
// PositionManager, and posm is NOT ERC721Enumerable — there is no
// `tokenOfOwnerByIndex`, and no "positions by owner and pool" view anywhere in
// the periphery.  So we reconstruct the set from two sources and merge them:
//
//   1. `Transfer(_, to = user, id)` logs from posm.  Authoritative, but log
//      queries are rate-limited and range-capped on public RPCs, so this is
//      done over a bounded lookback and is allowed to fail silently.
//   2. A localStorage cache written whenever THIS UI mints a position.  Covers
//      the freshly-minted case where the RPC's log index has not caught up,
//      and the case where the lookback window has scrolled past the mint.
//
// Every candidate is then verified on-chain (`ownerOf`, `getPoolAndPositionInfo`
// against this hook, non-zero liquidity), so a stale or hostile cache entry can
// only ever cause a wasted read, never a wrong balance.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePublicClient, useReadContract } from 'wagmi'
import { getAddress, type Address } from 'viem'

import { POSITION_MANAGER, STATE_VIEW, TARGET_CHAIN_ID, targetChain } from './contracts'
import { POSM_ABI, STATE_VIEW_ABI } from './lpAbis'
import { amountsForLiquidity, poolIdOf, toshPoolKey } from './v4Math'

/** Public RPCs cap `eth_getLogs` spans; walk the window in slices. */
const LOG_PAGE_SIZE = 50_000n

/**
 * The window this scan would like to cover.
 *
 * The lookback used to be a flat `600_000n` explained as "Base blocks are ~2s,
 * so this is roughly a fortnight". Both halves had stopped being true. The
 * chain is Robinhood, measured at 0.101 s/block, so 600,000 blocks is about
 * 17 hours — and nothing announced the change, because a block count cannot:
 * it keeps meaning blocks while the time it stands for shrinks twentyfold.
 */
const LOG_TARGET_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/**
 * The ceiling that actually binds, and the reason the window above is a wish.
 *
 * A fortnight of 100 ms blocks is 12.1M blocks, which is 242 paged
 * `eth_getLogs` calls. This runs in a panel with somebody waiting on it, and
 * the endpoint rate-limits well before that (see the pacing below), so the
 * target is capped by what a scan can spend rather than the other way round.
 *
 * 24 pages is ~6 s of paced requests. Deliberately double the 12 the flat
 * constant worked out to, because that number was never chosen — it fell out
 * of an arithmetic error about a different chain.
 */
const LOG_PAGE_BUDGET = 24n

/**
 * Blocks to scan, and how long that actually covers.
 *
 * `blockTime` is absent from some chain definitions, including the Robinhood
 * testnet's. Falling back to the page budget is right for that case: it spends
 * exactly what the scan is allowed to spend, which is the same answer the
 * budget gives on a chain we can measure, just without a span to report.
 */
function lookbackPlan(): { blocks: bigint; coverageMs: number | undefined } {
  const budgetBlocks = LOG_PAGE_SIZE * LOG_PAGE_BUDGET
  const ms = targetChain.blockTime
  if (!ms) return { blocks: budgetBlocks, coverageMs: undefined }

  const wanted = BigInt(Math.ceil(LOG_TARGET_WINDOW_MS / ms))
  const blocks = wanted < budgetBlocks ? wanted : budgetBlocks
  return { blocks, coverageMs: Number(blocks) * ms }
}

/**
 * How recent a position has to be for the log scan to find it, as prose.
 *
 * Exported because the panel's degraded notice used to promise nothing about
 * coverage, which was survivable while the window was two weeks and is not now
 * that it is hours. A user who cannot see a position they hold should be told
 * the boundary rather than left to infer it.
 */
export function lpScanCoverageLabel(): string | undefined {
  const { coverageMs } = lookbackPlan()
  if (coverageMs === undefined) return undefined
  const hours = coverageMs / 3_600_000
  if (hours < 48) return `${Math.round(hours)} hours`
  return `${Math.round(hours / 24)} days`
}

/**
 * Minimum spacing between `eth_getLogs` calls, and the retries that spacing
 * cannot save us from.
 *
 * The Robinhood mainnet endpoint returns `Too Many Requests` on roughly the
 * seventh tight sequential `eth_getLogs`. The flat lookback issued twelve, so
 * this scan did not merely return a short window on mainnet — it threw partway
 * through and landed in the `catch` below, every time, leaving discovery to the
 * localStorage cache alone while the panel reported a degraded RPC. The same
 * limit took the on-chain watcher blind for a full pass. 250 ms is the
 * interval measured to be clean.
 */
const LOG_MIN_INTERVAL_MS = 250
const LOG_MAX_RETRIES = 3
const LOG_BACKOFF_MS = 400

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const isRateLimit = (e: unknown): boolean =>
  /429|too many requests|rate ?limit/i.test(
    e instanceof Error ? `${e.message}` : String(e),
  )

const cacheKey = (user: Address, hook: Address) =>
  `tosh.lp.${TARGET_CHAIN_ID}.${user.toLowerCase()}.${hook.toLowerCase()}`

export function rememberLpPosition(user: Address, hook: Address, tokenId: bigint): void {
  if (typeof window === 'undefined') return
  try {
    const key = cacheKey(user, hook)
    const prev = JSON.parse(window.localStorage.getItem(key) ?? '[]') as string[]
    const next = Array.from(new Set([...prev, tokenId.toString()]))
    window.localStorage.setItem(key, JSON.stringify(next))
  } catch {
    // A full or disabled localStorage must not break minting; the log scan
    // will find the position on the next refresh anyway.
  }
}

function readCache(user: Address, hook: Address): bigint[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(cacheKey(user, hook))
    if (!raw) return []
    return (JSON.parse(raw) as string[]).map(BigInt)
  } catch {
    return []
  }
}

export interface LpPosition {
  tokenId: bigint
  liquidity: bigint
  /** ETH currently backing the position. */
  amount0: bigint
  /** Project tokens currently backing the position. */
  amount1: bigint
}

export interface LpPoolState {
  sqrtPriceX96: bigint
  /** Total in-range liquidity across every LP, including the genesis position. */
  totalLiquidity: bigint
  poolId: `0x${string}`
}

/** Live pool price and depth for the ETH/token pair behind `hook`. */
export function useLpPoolState(token: Address | undefined, hook: Address | undefined): LpPoolState {
  const poolId = useMemo(
    () => (token && hook ? poolIdOf(toshPoolKey(token, hook)) : undefined),
    [token, hook],
  )

  const { data: slot0 } = useReadContract({
    address: STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: 'getSlot0',
    args: poolId ? [poolId] : undefined,
    query: { enabled: !!poolId, refetchInterval: 12_000 },
  })

  const { data: liq } = useReadContract({
    address: STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: 'getLiquidity',
    args: poolId ? [poolId] : undefined,
    query: { enabled: !!poolId, refetchInterval: 12_000 },
  })

  return {
    sqrtPriceX96: slot0?.[0] ?? 0n,
    totalLiquidity: liq ?? 0n,
    poolId: poolId ?? '0x',
  }
}

/**
 * The connected wallet's full-range positions in this project's pool.
 *
 * Returns `[]` — never throws — when discovery is unavailable, so a flaky RPC
 * degrades the panel to "add liquidity only" rather than blanking the page.
 */
export function useLpPositions(
  user: Address | undefined,
  hook: Address | undefined,
  sqrtPriceX96: bigint,
) {
  const client = usePublicClient()
  const [positions, setPositions] = useState<LpPosition[]>([])
  const [degraded, setDegraded] = useState(false)
  const [nonce, setNonce] = useState(0)

  // Pure collector: returns a result rather than writing state, so the effect
  // below can commit only after the network round trip settles.
  const collect = useCallback(async (): Promise<{ found: LpPosition[]; degraded: boolean }> => {
    if (!client || !user || !hook) return { found: [], degraded: false }

    let scanFailed = false
    const candidates = new Set<string>(readCache(user, hook).map(String))

    try {
      const head = await client.getBlockNumber()
      const { blocks } = lookbackPlan()
      const floor = head > blocks ? head - blocks : 0n

      // Paced and retried per page rather than wrapped around the whole walk.
      // A 429 on page seven used to abandon every page after it, so the pages
      // already fetched were discarded along with the ones never attempted;
      // backing off and continuing keeps what the scan has earned.
      let lastStartedAt = 0
      const pageLogs = async (from: bigint, to: bigint) => {
        for (let attempt = 0; ; attempt++) {
          const wait = LOG_MIN_INTERVAL_MS - (Date.now() - lastStartedAt)
          if (wait > 0) await sleep(wait)
          lastStartedAt = Date.now()
          try {
            return await client.getLogs({
              address: POSITION_MANAGER,
              event: POSM_ABI[5],
              args: { to: user },
              fromBlock: from,
              toBlock: to,
            })
          } catch (e) {
            if (attempt >= LOG_MAX_RETRIES || !isRateLimit(e)) throw e
            await sleep(LOG_BACKOFF_MS * 2 ** attempt)
          }
        }
      }

      for (let to = head; to > floor; ) {
        const from = to > floor + LOG_PAGE_SIZE ? to - LOG_PAGE_SIZE : floor
        for (const log of await pageLogs(from, to)) {
          const id = log.args.id
          if (id !== undefined) candidates.add(id.toString())
        }
        if (from === floor) break
        to = from - 1n
      }
    } catch {
      // Log scan unavailable (rate limit that outlasted the retries, range cap,
      // unsupported RPC).  Fall back to whatever this browser minted itself.
      scanFailed = true
    }

    const found: LpPosition[] = []
    for (const raw of candidates) {
      const tokenId = BigInt(raw)
      try {
        const [owner, info, liquidity] = await Promise.all([
          client.readContract({
            address: POSITION_MANAGER, abi: POSM_ABI, functionName: 'ownerOf', args: [tokenId],
          }),
          client.readContract({
            address: POSITION_MANAGER, abi: POSM_ABI,
            functionName: 'getPoolAndPositionInfo', args: [tokenId],
          }),
          client.readContract({
            address: POSITION_MANAGER, abi: POSM_ABI,
            functionName: 'getPositionLiquidity', args: [tokenId],
          }),
        ])

        if (getAddress(owner) !== getAddress(user)) continue
        if (getAddress(info[0].hooks) !== getAddress(hook)) continue
        if (liquidity === 0n) continue

        const { amount0, amount1 } = amountsForLiquidity(sqrtPriceX96, liquidity)
        found.push({ tokenId, liquidity, amount0, amount1 })
      } catch {
        // Burned, never existed, or a poisoned cache entry — skip it.
      }
    }

    found.sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1))
    return { found, degraded: scanFailed }
  }, [client, user, hook, sqrtPriceX96])

  useEffect(() => {
    let cancelled = false
    void collect().then(result => {
      if (cancelled) return
      setPositions(result.found)
      setDegraded(result.degraded)
    })
    return () => { cancelled = true }
  }, [collect, nonce])

  const refresh = useCallback(() => { setNonce(n => n + 1) }, [])

  const totals = useMemo(
    () =>
      positions.reduce(
        (acc, p) => ({
          liquidity: acc.liquidity + p.liquidity,
          amount0: acc.amount0 + p.amount0,
          amount1: acc.amount1 + p.amount1,
        }),
        { liquidity: 0n, amount0: 0n, amount1: 0n },
      ),
    [positions],
  )

  return { positions, totals, degraded, refresh }
}
