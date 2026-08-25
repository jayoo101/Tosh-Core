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

import { POSITION_MANAGER, STATE_VIEW, TARGET_CHAIN_ID } from './contracts'
import { POSM_ABI, STATE_VIEW_ABI } from './lpAbis'
import { amountsForLiquidity, poolIdOf, toshPoolKey } from './v4Math'

/** How far back to scan posm `Transfer` logs.  Base blocks are ~2s, so this is
 *  roughly a fortnight — comfortably longer than any live testnet project. */
const LOG_LOOKBACK_BLOCKS = 600_000n

/** Public RPCs cap `eth_getLogs` spans; walk the window in slices. */
const LOG_PAGE_SIZE = 50_000n

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
      const floor = head > LOG_LOOKBACK_BLOCKS ? head - LOG_LOOKBACK_BLOCKS : 0n

      for (let to = head; to > floor; ) {
        const from = to > floor + LOG_PAGE_SIZE ? to - LOG_PAGE_SIZE : floor
        const logs = await client.getLogs({
          address: POSITION_MANAGER,
          event: POSM_ABI[5],
          args: { to: user },
          fromBlock: from,
          toBlock: to,
        })
        for (const log of logs) {
          const id = log.args.id
          if (id !== undefined) candidates.add(id.toString())
        }
        if (from === floor) break
        to = from - 1n
      }
    } catch {
      // Log scan unavailable (rate limit, range cap, unsupported RPC).  Fall
      // back to whatever this browser minted itself.
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
