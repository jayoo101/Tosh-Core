/**
 * GET /api/projects/launch-tx?hook=0x… — which transaction created this launch.
 * ───────────────────────────────────────────────────────────────────────────
 *  `POST /api/projects` is keyed and authorised by the launch's txHash: the
 *  server reads that receipt, pulls `creator` out of the `LaunchCreated` log,
 *  and compares it against the recovered signer. That is the right anchor and
 *  it is not changing here. But it means a creator can only publish their
 *  listing while they still HOLD the txHash — which, until this route existed,
 *  was for exactly as long as the launch page stayed mounted.
 *
 *  When that publish does not land, the launch is on chain and the registry row
 *  is not, and `getProject` serves a chain-only fallback with no logo, no links
 *  and no description. Recovering from that used to require the creator to dig
 *  their own transaction out of an explorer and hand it back to us. The chain
 *  already knows, so this route asks it.
 *
 *  WHY IT IS SAFE TO SERVE PUBLICLY
 *  ────────────────────────────────
 *  It returns nothing that is not already public: the txHash is in every
 *  explorer and `hook.creator()` is a public getter. It authorises nothing —
 *  the signature check in `POST /api/projects` is still the only thing standing
 *  between a caller and a row, and that check does not care where the caller
 *  learned the txHash.
 */

import { NextRequest, NextResponse } from 'next/server'
import { encodeEventTopics } from 'viem'
import type { Address, Hex } from 'viem'

import { FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI } from '@/lib/contracts'
import { applyCors, applyRateLimit, corsPreflight } from '@/app/lib/apiGuard'
import { assertServerChain, serverPublicClient } from '@/app/lib/serverRpc'

const CORS_OPTS = { methods: ['GET', 'OPTIONS'] as const } as const

/**
 * Tighter than the lookup route's. A miss here costs a log scan across the
 * chain's whole history, which is the most expensive read this app performs,
 * and the only legitimate caller is a creator recovering one launch.
 */
const RATE_LIMIT = {
  name: 'projects-launch-tx',
  capacity: 6,
  refillPerSec: 0.2,
} as const

/**
 * Immutable once known — a launch is created by exactly one transaction — so a
 * repeat call from the same creator never re-scans. Bounded because the key
 * space is attacker-controlled: without a cap, probing distinct hook addresses
 * would grow this map without limit.
 */
const RESOLVED = new Map<string, Hex>()
const RESOLVED_MAX = 256

/**
 * How far either side of the estimated creation block the fallback scan looks.
 *
 * The estimate comes from a timestamp bisection, which lands on the FIRST block
 * carrying the creation timestamp — and on a chain with sub-second blocks many
 * blocks share one, so the real log sits at or shortly after it. 5 000 blocks
 * is ~8 minutes even at one block per 100ms, which is far more slack than that
 * needs.
 */
const SCAN_MARGIN = 5_000n

/**
 * The creating block, located by timestamp rather than by scanning.
 *
 * `genesisDeadline` is stamped as `block.timestamp + genesisDuration()` when
 * the hook is initialised, so the difference of the two public getters IS the
 * creation timestamp. Bisecting block headers for it is exact and costs ~26
 * reads regardless of how old the launch is; interpolating from an average
 * block time would be one read, and wrong by however much the block time has
 * drifted over the chain's life.
 *
 * Headers are used deliberately: this chain's public RPC prunes historical
 * STATE (an `eth_getCode` at an old block fails) but retains headers to block
 * one, so a bisection over timestamps works where one over `getCode` does not.
 */
async function creationBlock(hook: Address): Promise<bigint> {
  const client = serverPublicClient()

  const [deadline, duration, head] = await Promise.all([
    client.readContract({ address: hook, abi: HOOK_ABI, functionName: 'genesisDeadline' }) as Promise<bigint>,
    client.readContract({ address: hook, abi: HOOK_ABI, functionName: 'genesisDuration' }) as Promise<bigint>,
    client.getBlockNumber(),
  ])
  const createdAt = deadline - duration

  let lo = 0n
  let hi = head
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const { timestamp } = await client.getBlock({ blockNumber: mid })
    if (timestamp >= createdAt) hi = mid
    else lo = mid + 1n
  }
  return lo
}

/**
 * `eth_getLogs` over an explicit topic filter, via `request` rather than viem's
 * `getLogs`.
 *
 * The topics come from `encodeEventTopics` against `FACTORY_ABI`, so the event
 * signature is not written out a second time here — a copy of it would be free
 * to drift from `ToshFactory.sol` while still compiling. Nothing needs decoding
 * either: `transactionHash` is the whole answer, and it is on the raw log.
 */
async function scan(hook: Address, fromBlock: bigint, toBlock: bigint | 'latest'): Promise<Hex | null> {
  const client = serverPublicClient()
  const topics = encodeEventTopics({
    abi: FACTORY_ABI,
    eventName: 'LaunchCreated',
    args: { hook },
  })

  const logs = await client.request({
    method: 'eth_getLogs',
    params: [{
      address: FACTORY_ADDRESS,
      topics,
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: toBlock === 'latest' ? 'latest' : `0x${toBlock.toString(16)}`,
    }],
  } as never) as { transactionHash: Hex }[]

  return logs[0]?.transactionHash ?? null
}

type Resolution =
  | { status: 'found'; txHash: Hex; creator: Address }
  | { status: 'not-found' }
  | { status: 'unavailable' }

async function resolve(hook: Address): Promise<Resolution> {
  const client = serverPublicClient()

  // Also the existence check. `creator()` reverts on any address that is not
  // one of our hooks, so a revert here is "no such launch" and not a failure to
  // look — the same distinction `getProject` draws for `projectToken`.
  let creator: Address
  try {
    creator = await client.readContract({
      address: hook, abi: HOOK_ABI, functionName: 'creator',
    }) as Address
  } catch {
    return { status: 'not-found' }
  }

  const cached = RESOLVED.get(hook.toLowerCase())
  if (cached) return { status: 'found', txHash: cached, creator }

  let txHash: Hex | null = null
  try {
    // The whole chain in one query. The `hook` topic is indexed, so a provider
    // that serves logs from an index answers this in well under a second even
    // over 60M blocks, and it needs no estimate to be correct.
    txHash = await scan(hook, 0n, 'latest')
  } catch {
    // Many providers cap the block span of a single `eth_getLogs` and reject
    // the query above outright. That is a limit on the request, not on the
    // chain, so fall back to a narrow window around where the launch must be.
    try {
      const est = await creationBlock(hook)
      const from = est > SCAN_MARGIN ? est - SCAN_MARGIN : 0n
      txHash = await scan(hook, from, est + SCAN_MARGIN)
    } catch {
      return { status: 'unavailable' }
    }
  }

  // A hook whose `creator()` answered but whose creating log cannot be found is
  // a gap in what the RPC will serve, not evidence that the launch is not
  // there. Retrying against a fuller node can change the answer, so this must
  // not be cached or reported as an absence.
  if (!txHash) return { status: 'unavailable' }

  if (RESOLVED.size >= RESOLVED_MAX) RESOLVED.clear()
  RESOLVED.set(hook.toLowerCase(), txHash)
  return { status: 'found', txHash, creator }
}

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req, CORS_OPTS)
}

export async function GET(req: NextRequest) {
  const limited = await applyRateLimit(req, RATE_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const hook = (req.nextUrl.searchParams.get('hook') ?? '').trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(hook)) {
    return applyCors(
      NextResponse.json(
        { error: 'hook must be a 20-byte hex address' },
        { status: 400, headers: { 'Cache-Control': 'public, s-maxage=60' } },
      ),
      req,
      CORS_OPTS,
    )
  }

  // The creator returned below is compared against a signature by the caller's
  // NEXT request, so an endpoint on the wrong chain would have this route name
  // one chain's creator for a listing written on another.
  if (!(await assertServerChain())) {
    return applyCors(
      NextResponse.json(
        { error: 'server is not pointed at the expected chain' },
        { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } },
      ),
      req,
      CORS_OPTS,
    )
  }

  const found = await resolve(hook as Address)

  if (found.status === 'unavailable') {
    return applyCors(
      NextResponse.json(
        { error: 'could not read the creating transaction from the chain' },
        { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } },
      ),
      req,
      CORS_OPTS,
    )
  }

  if (found.status === 'not-found') {
    return applyCors(
      NextResponse.json(
        { error: 'not found' },
        { status: 404, headers: { 'Cache-Control': 'public, s-maxage=30' } },
      ),
      req,
      CORS_OPTS,
    )
  }

  return applyCors(
    NextResponse.json(
      { txHash: found.txHash, creator: found.creator },
      // Immutable, so this is as long as the CDN will take it.
      { headers: { 'Cache-Control': 'public, s-maxage=86400, immutable' } },
    ),
    req,
    CORS_OPTS,
  )
}
