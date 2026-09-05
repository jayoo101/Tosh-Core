/**
 * gasHistory.ts — the Proof-of-Gas scan, against real chains.
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES
 *
 * `scanGasHistoryForWallet` was `void userAddress; return MOCK_CHAIN_GAS` — a
 * constant four-row table. Every wallet that cleared the auth gate was attested
 * for the same 0.0033 ETH, and the address it was issued for was discarded
 * before it was used. That was defensible as a stub and wrong as a product: it
 * meant nothing distinguished one claimant from another, so the only thing
 * rationing genesis supply was how many addresses showed up, and the marginal
 * cost of a second claim was one `eth_accounts` call. §2.1 of the audit dossier
 * meanwhile described the signer as attesting to real gas history. PM-F9.
 *
 * WHY BLOCKSCOUT, WHICH IS NOT A FREE CHOICE
 *
 * Robinhood Chain decides it. Etherscan V2 is otherwise the obvious pick — one
 * key, one base URL, sixty chains — but its free tier answers Optimism and Base
 * with "Free API access is not supported for this chain", and it does not index
 * Robinhood Chain at any price. Neither does Alchemy or GoldRush. Robinhood
 * Chain runs its own Blockscout and `viem` already carries the `apiUrl`, so
 * Blockscout is the only provider covering all five with one request shape.
 *
 * WHICH ENDPOINT, PER CHAIN, AND WHY IT IS NOT UNIFORM
 *
 * Blockscout exposes two APIs with opposite trade-offs, and the split below was
 * settled by measurement, not preference:
 *
 *   v1 `txlist`  10,000 rows per request, both directions, and `gasUsed` and
 *                `gasPrice` but no fee total. Measured: 10,000 rows in 8.7 s;
 *                our own deployer's 1,480 rows in 1.5 s.
 *   v2           `filter=from` applied server-side and an exact `fee.value`,
 *                but a fixed page size of 50 — `items_count` and `limit` are
 *                both ignored, verified. Measured: 1.2 s per 50 rows, and on
 *                the heaviest wallet tested it could not return a single page
 *                inside 15 s.
 *
 * v2 is therefore unusable as the primary path. Enumerating our own deployer
 * took 29 pages and 34 s on Ethereum alone, and a genuinely heavy wallet timed
 * out outright — which would have failed the scan for exactly the claimants
 * with the most history, the precise opposite of what this is for. v1 returned
 * the same total, `0.11395591` ETH to the wei, in 1.5 s.
 *
 * But v1 alone is worse than it looks, because it cannot filter by direction —
 * `filter`, `filter_to` and `direction` are all accepted and silently ignored,
 * verified against an address with no sends: every variant still returned a full
 * page of inbound rows. An address with heavy INBOUND traffic therefore fills
 * every window with transactions it did not send. The burn address consumed the
 * whole four-window budget on two chains, took 140 s, and came back flagged
 * `truncated` — "this total is only a lower bound" — about a wallet whose true
 * answer was a certain zero. A user who has merely been spammed with airdrops
 * hits the same wall, and for them the sends it runs out of budget before
 * reaching would be real.
 *
 * So each chain is read probe-first:
 *
 *   1. One v2 page with `filter=from`. If it returns no `next_page_params`,
 *      this address sent at most fifty transactions here and the scan of this
 *      chain is already done — with v2's EXACT fees, L1 data fee included.
 *      Measured 0.6 s for the burn address, the case that used to cost 140 s.
 *   2. Only a second page proves the address is a heavy sender, and only then is
 *      v1's throughput worth its blindness to direction. The probe's rows are
 *      discarded and the chain is re-walked from block 0, so one chain's total
 *      never mixes two fee bases.
 *
 * The happy side effect: the OP-stack shortfall below now applies only to heavy
 * senders, because everyone who fits in a single v2 page is priced exactly.
 *
 * WHAT THE v1 FALLTHROUGH DOES NOT COUNT, STATED PLAINLY
 *
 * On an OP-stack chain the sender also pays an L1 data fee that lives on the
 * receipt, and v1 omits it — no `l1Fee`, `l1GasUsed` or `l1GasPrice` on
 * Optimism, Base or Arbitrum, verified by dumping the row keys. So on Optimism
 * and Base this scan measures execution fees, which are less than the fee paid.
 * Measured shortfall against v2's authoritative `fee.value`:
 *
 *     Base, recent                0 %
 *     Base, 2024-03-05         0.59 %
 *     Optimism, 2022-01-07    70.83 %   ← pre-Bedrock, when L1 data was the bulk
 *
 * The gap is real but it is old, and it is small in absolute terms next to L1:
 * one Ethereum transaction costs what a thousand L2 transactions cost, so
 * mainnet dominates this sum for essentially every wallet. It is also in the
 * only safe direction — see below. It is not corrected by a fudge factor,
 * because a made-up multiplier would be less honest than an acknowledged floor.
 *
 * `gas_usage_count` WOULD BE ONE CALL AND IS STILL NOT USED
 *
 * It does not measure what its name says. Against an address that has only ever
 * received, the counter reports 6,994,130,914 gas while the first five hundred
 * transactions contain none it sent. It totals the gas of every transaction the
 * address appears in, so it would credit people for inbound transfers they did
 * not pay for and did not ask for, and would hand any exchange deposit address
 * an unbounded score.
 *
 * FAILURE DIRECTION — THE RULE EVERY BOUND HERE FOLLOWS
 *
 * Each limit is chosen so that being wrong can only under-award:
 *
 *   · a chain that cannot be read fails the whole scan, because a partial sum
 *     is indistinguishable from a smaller wallet and the difference is money;
 *   · a history longer than the request budget yields the total so far, which
 *     is a lower bound, flagged `truncated` so the caller can say so;
 *   · the OP-stack shortfall above subtracts, never adds;
 *   · a boundary block that appears in two windows is de-duplicated by hash,
 *     because `startblock` is inclusive and double-counting is the one error
 *     that would award too much.
 */

import { POG_GAS_CAP_WEI } from './pogQuota'

// ─── Chains ──────────────────────────────────────────────────────────────────

/** Which Blockscout API a chain is read through. See the header. */
export type ScanApi = 'v1' | 'v2'

export interface GasScanChain {
  chain: string
  chainId: number
  /** Blockscout instance root, no trailing slash. */
  host: string
  api: ScanApi
  /**
   * Whether this host rejects a default server-side `User-Agent`.
   * Only Robinhood Chain does. See `BROWSER_UA`.
   */
  needsBrowserUa?: boolean
  /**
   * True where `gasUsed * gasPrice` is the whole fee. False on OP-stack, where
   * it omits the L1 data fee. Recorded per chain so the shortfall is visible in
   * the result instead of buried in this comment.
   */
  execFeeIsWholeFee: boolean
}

/**
 * The five chains whose spend counts, and nothing else.
 *
 * Ethereum is first because fees there are orders of magnitude larger, so it is
 * the chain most likely to reach the cap on its own and end the scan early.
 *
 * Robinhood Chain contributes almost nothing today — it is new — and is
 * included deliberately anyway: it is the chain this launchpad settles on, and
 * leaving it out would mean early users of the chain the product depends on got
 * no credit for using it.
 */
export const GAS_SCAN_CHAINS: readonly GasScanChain[] = [
  { chain: 'Ethereum', chainId: 1,     host: 'https://eth.blockscout.com',       api: 'v1', execFeeIsWholeFee: true  },
  { chain: 'Arbitrum', chainId: 42161, host: 'https://arbitrum.blockscout.com',  api: 'v1', execFeeIsWholeFee: true  },
  { chain: 'Optimism', chainId: 10,    host: 'https://optimism.blockscout.com',  api: 'v1', execFeeIsWholeFee: false },
  { chain: 'Base',     chainId: 8453,  host: 'https://base.blockscout.com',      api: 'v1', execFeeIsWholeFee: false },
  // v1 on this host times out; v2 answers in a few hundred ms, and total volume
  // on a chain this young is a page or two.
  {
    chain: 'Robinhood', chainId: 4663, host: 'https://robinhoodchain.blockscout.com',
    api: 'v2', needsBrowserUa: true, execFeeIsWholeFee: true,
  },
]

// ─── Budgets ─────────────────────────────────────────────────────────────────

/** Per-request timeout. A v1 window of 10,000 rows measured 8.7 s on the
 *  heaviest wallet tried, so 30 s is a stall rather than a slow page. */
const REQUEST_TIMEOUT_MS = 30_000

/** v1 rows per request. Blockscout enforces `page * offset <= 10000`, verified:
 *  page 2 at this offset answers "Result window is too large". Depth past the
 *  wall comes from `startblock` windowing instead. */
const V1_PAGE_SIZE = 10_000

/** v1 block-windows per chain. Four windows is 40,000 transactions on one
 *  chain; a wallet past that which still has not reached the cap is reported
 *  `truncated` rather than silently short. */
const MAX_V1_WINDOWS = 4

/** v2 pages of 50 for a chain read entirely through v2 (Robinhood). The
 *  probe-first path on the other four uses a budget of exactly one. */
const MAX_V2_PAGES = 20

/** Retries per request for a transient 429 or 5xx. Beyond this it is an outage,
 *  and an outage has to surface rather than become a small allocation. */
const MAX_RETRIES = 3

/**
 * Robinhood Chain's Blockscout is behind Cloudflare and answers a default Node
 * `fetch` with a 403 challenge; a browser `User-Agent` gets a 200. Verified
 * both ways.
 *
 * This is recorded as a dependency, not offered as a solution. It is exactly as
 * durable as a Cloudflare configuration that is not ours, and when it tightens
 * the Robinhood leg fails closed — which, by the failure rule above, takes the
 * whole scan with it.
 *
 * THERE IS NO RPC FALLBACK, though this comment used to claim one. Counting the
 * chain from the RPC we already operate for the watcher sounds like the obvious
 * escape until the chain is measured: Robinhood is an Arbitrum Nitro rollup with
 * a 0.20 s block time, which put it at 54.8 M blocks 127 days after launch.
 * JSON-RPC has no `eth_getTransactionsByAddress` — that index is the thing an
 * explorer exists to maintain — so finding one wallet's sends means walking every
 * block: ~548,000 batched requests, for one wallet, on one chain. `trace_filter`
 * and `arbtrace_filter` are both absent from that node, so there is no shortcut,
 * and `eth_getLogs` cannot substitute because a plain ETH send emits no logs.
 *
 * The real fallback is the keyed PRO API at `api.blockscout.com`, which reaches
 * 4663 by `chain_id` and never touches this host. See `checkBlockscoutKey.mjs`.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

function headersFor(chain: GasScanChain): Record<string, string> {
  return chain.needsBrowserUa
    ? { Accept: 'application/json', 'User-Agent': BROWSER_UA }
    : { Accept: 'application/json' }
}

/**
 * A free Blockscout key, and why the scan is not deployable without one.
 *
 * Measured 2026-09-05 against the unkeyed public instances, walking each host up
 * to its limit until it refused:
 *
 * | Host | `x-ratelimit-limit` | Window | Effective |
 * |---|---|---|---|
 * | Ethereum, Optimism | 180 | ~60 s | 3 req/s |
 * | Arbitrum, Base | **10** | **~40 min** | **10 req/hour** |
 *
 * Both of the low ones returned `429 {"message":"Too many requests. Increase
 * limits now at https://dev.blockscout.com"}` on the tenth request, twice,
 * reproducibly. Since a scan needs at least one request per chain and every
 * chain must succeed for the total to be a total, **the unkeyed ceiling is about
 * ten wallets an hour** — set by the two tightest hosts, not by anything in this
 * codebase. The 240/hour budget in `/api/pog-scan` is not the binding constraint
 * and never was.
 *
 * With a key (free at dev.blockscout.com: 5 req/s, 100k credits/day, and at the
 * documented 20 credits per call about 5,000 calls/day) the same ceiling is
 * roughly a thousand wallets a day. Paid tiers raise the rate, not the coverage.
 *
 * Unset is therefore a deployment error rather than a degraded mode, and
 * `assertScanKeyPresent()` exists so it fails at boot instead of at the tenth
 * claimant. Left optional here only so tests and the offline signer run without
 * one.
 *
 * NOT YET VERIFIED: that the per-instance hosts honour a key on the `apikey`
 * query parameter. It is what their own 429 points at and what the
 * Etherscan-compatible v1 route implies, but nobody has held a key against it.
 * The alternative, if they do not, is the PRO API at `api.blockscout.com` with a
 * `chain_id` parameter — which would also retire the Cloudflare `User-Agent`
 * workaround, since Robinhood Chain (4663) is in that registry.
 */
const API_KEY = process.env.BLOCKSCOUT_API_KEY ?? ''

export function scanKeyPresent(): boolean {
  return API_KEY.length > 0
}

/** Append the key to a Blockscout URL, if we have one. */
function withKey(url: string): string {
  if (!API_KEY) return url
  return `${url}${url.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(API_KEY)}`
}

// ─── Results ─────────────────────────────────────────────────────────────────

export interface ChainSpend {
  chain: string
  chainId: number
  /** Fees this address paid on this chain, in wei. All five settle in ETH, so
   *  summing across them is addition of like units. */
  weiSpent: bigint
  /** Transactions sent by the address that were counted. */
  sentTxs: number
  /** Request budget ran out before the history did: `weiSpent` is a floor. */
  truncated: boolean
  /** Stopped because the running total already reached the cap, so more
   *  requests could not change the answer. Not a defect. */
  stoppedAtCap: boolean
  /** Never looked, because the cap was already reached. Distinct from a real
   *  zero, so the breakdown never implies an absence it did not check. */
  skipped: boolean
  /** This figure is execution fees only and excludes the OP-stack L1 data fee.
   *  Mirrors `execFeeIsWholeFee` into the result so a caller does not have to
   *  re-derive it from the chain table. */
  execFeeOnly: boolean
}

export interface GasHistory {
  chains: ChainSpend[]
  /** Sum over chains, uncapped and unfloored. The figure shown to the user. */
  totalWei: bigint
  /** Any chain's budget was exhausted below the cap, so `totalWei` is a lower
   *  bound on the true figure. */
  truncated: boolean
  /** Unix ms, so a caller can age a cached scan. */
  scannedAt: number
}

/** A chain could not be read. Never swallowed: a scan missing one of five reads
 *  as a smaller wallet, and that difference is an allocation. */
export class GasScanUnavailable extends Error {
  constructor(readonly chain: string, readonly reason: string) {
    super(`gas scan failed on ${chain}: ${reason}`)
    this.name = 'GasScanUnavailable'
  }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Longest `x-ratelimit-reset` still worth waiting out by retrying.
 *
 * Measured, not chosen: unkeyed Arbitrum and Base answer with
 * `x-ratelimit-limit: 10` and a reset around 2,370,000 ms — a ten-request budget
 * that refills in about forty minutes. Retrying that on a 400 ms backoff spends
 * three more of a budget that has none left and cannot recover inside the
 * request, so the retry was pure noise aimed at a host that had just asked us to
 * stop. Anything past this bound is reported as the exhaustion it is.
 */
const RETRYABLE_RESET_MS = 5_000

/** `x-ratelimit-reset` in ms, or null when the host does not say. All four
 *  Blockscout hosts that answered did say; the value is a plain countdown. */
function resetMsOf(res: Response): number | null {
  const raw = res.headers.get('x-ratelimit-reset')
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

async function getJson<T>(url: string, chain: GasScanChain): Promise<T> {
  let lastReason = 'unknown'
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(400 * attempt)
    try {
      const res = await fetch(withKey(url), {
        headers: headersFor(chain),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: 'no-store',
      })
      if (res.status === 429) {
        // Retry only a limit that is about to refill anyway. A long reset means
        // the budget is gone for this window, and the honest move is to say so
        // rather than knock three more times.
        const resetMs = resetMsOf(res)
        if (resetMs !== null && resetMs > RETRYABLE_RESET_MS) {
          const limit = res.headers.get('x-ratelimit-limit') ?? '?'
          throw new GasScanUnavailable(
            chain.chain,
            `rate limited (${limit}/window, resets in ${Math.ceil(resetMs / 1000)}s)`
            + '; set BLOCKSCOUT_API_KEY to raise it',
          )
        }
        lastReason = 'HTTP 429'
        continue
      }
      // 5xx deserves another attempt. Any other non-2xx is a request we built
      // wrong, and repeating it only burns the budget.
      if (res.status >= 500) {
        lastReason = `HTTP ${res.status}`
        continue
      }
      if (!res.ok) throw new GasScanUnavailable(chain.chain, `HTTP ${res.status}`)
      return (await res.json()) as T
    } catch (e) {
      if (e instanceof GasScanUnavailable) throw e
      lastReason = e instanceof Error ? e.message : String(e)
    }
  }
  throw new GasScanUnavailable(chain.chain, lastReason)
}

// ─── v1: txlist ──────────────────────────────────────────────────────────────

interface V1Row {
  hash?: string
  from?: string
  gasUsed?: string
  gasPrice?: string
  blockNumber?: string
}
interface V1Response {
  status?: string
  message?: string
  result?: V1Row[] | string | null
}

/**
 * Walk one chain with v1 `txlist`, windowing on `startblock` to get past the
 * 10,000-row wall.
 *
 * `startblock` is INCLUSIVE, verified: the second window began on the same
 * block the first ended on. Transactions in that shared block would otherwise
 * be counted twice, which is the one direction of error this must never make,
 * so hashes seen in the previous window are remembered and skipped.
 */
async function scanChainV1(
  address: string,
  chain: GasScanChain,
  alreadyWei: bigint,
): Promise<ChainSpend> {
  const target = address.toLowerCase()
  let weiSpent = 0n
  let sentTxs = 0
  let truncated = false
  let stoppedAtCap = false
  let startBlock = 0
  /** Hashes from the boundary block of the previous window only — not the whole
   *  history — so this stays O(rows in one block) rather than O(history). */
  let boundaryHashes = new Set<string>()

  for (let window = 0; window < MAX_V1_WINDOWS; window++) {
    const url = `${chain.host}/api?module=account&action=txlist&address=${address}`
      + `&page=1&offset=${V1_PAGE_SIZE}&sort=asc&startblock=${startBlock}`
    const body = await getJson<V1Response>(url, chain)

    // v1 signals "nothing found" as status "0" with a string result. That is not
    // an error, and must not be treated as one, or every fresh wallet would
    // fail the scan instead of scoring zero.
    const rows = Array.isArray(body.result) ? body.result : []
    if (rows.length === 0) break

    const lastBlock = Number(rows[rows.length - 1].blockNumber ?? 0)
    const nextBoundary = new Set<string>()

    for (const row of rows) {
      const hash = (row.hash ?? '').toLowerCase()
      if (Number(row.blockNumber ?? 0) === lastBlock && hash) nextBoundary.add(hash)
      if (boundaryHashes.has(hash)) continue
      // v1 returns both directions; the from-side filter is ours to apply. This
      // check is the whole difference between measuring what a claimant PAID and
      // measuring what happened to arrive at their address, which is the mistake
      // `gas_usage_count` makes.
      if ((row.from ?? '').toLowerCase() !== target) continue
      if (!row.gasUsed || !row.gasPrice) continue
      try {
        weiSpent += BigInt(row.gasUsed) * BigInt(row.gasPrice)
        sentTxs++
      } catch { /* a row we cannot price is skipped, never guessed at */ }
    }

    if (alreadyWei + weiSpent >= POG_GAS_CAP_WEI) { stoppedAtCap = true; break }

    // Short window means the history ran out before the budget did.
    if (rows.length < V1_PAGE_SIZE) break
    if (window === MAX_V1_WINDOWS - 1) { truncated = true; break }

    boundaryHashes = nextBoundary
    startBlock = lastBlock
  }

  return {
    chain: chain.chain, chainId: chain.chainId,
    weiSpent, sentTxs, truncated, stoppedAtCap, skipped: false,
    execFeeOnly: !chain.execFeeIsWholeFee,
  }
}

// ─── v2: addresses/{a}/transactions ──────────────────────────────────────────

interface V2Item {
  from?: { hash?: string } | string
  fee?: { value?: string }
  gas_used?: string
  gas_price?: string
}
interface V2Response {
  items?: V2Item[]
  next_page_params?: Record<string, unknown> | null
}

/** `from` is `{ hash }` on current v2 and a bare string on some instances.
 *  Normalising both rather than trusting one keeps a schema change from
 *  silently counting nothing. */
function fromHash(from: unknown): string {
  if (typeof from === 'string') return from.toLowerCase()
  if (from && typeof from === 'object' && 'hash' in from) {
    const h = (from as { hash?: unknown }).hash
    if (typeof h === 'string') return h.toLowerCase()
  }
  return ''
}

/** `fee.value` is Blockscout's own total and is what the sender paid. The
 *  product fallback is for an instance that omits it. */
function feeOfV2(item: V2Item): bigint {
  if (item.fee?.value) {
    try { return BigInt(item.fee.value) } catch { /* fall through */ }
  }
  if (item.gas_used && item.gas_price) {
    try { return BigInt(item.gas_used) * BigInt(item.gas_price) } catch { /* fall through */ }
  }
  return 0n
}

async function scanChainV2(
  address: string,
  chain: GasScanChain,
  alreadyWei: bigint,
  maxPages: number = MAX_V2_PAGES,
): Promise<ChainSpend> {
  const target = address.toLowerCase()
  let weiSpent = 0n
  let sentTxs = 0
  let truncated = false
  let stoppedAtCap = false
  let cursor: Record<string, unknown> | null = null

  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ filter: 'from' })
    for (const [k, v] of Object.entries(cursor ?? {})) {
      if (v !== null && v !== undefined) q.set(k, String(v))
    }
    const body = await getJson<V2Response>(
      `${chain.host}/api/v2/addresses/${address}/transactions?${q}`, chain)
    const items = body.items ?? []

    for (const item of items) {
      // Re-checked even though `filter=from` is server-side: one query-parameter
      // typo would otherwise turn this back into the inbound-counting metric.
      if (fromHash(item.from) !== target) continue
      weiSpent += feeOfV2(item)
      sentTxs++
    }

    if (alreadyWei + weiSpent >= POG_GAS_CAP_WEI) { stoppedAtCap = true; break }

    cursor = body.next_page_params ?? null
    if (!cursor) break
    if (page === maxPages - 1) truncated = true
  }

  return {
    chain: chain.chain, chainId: chain.chainId,
    weiSpent, sentTxs, truncated, stoppedAtCap, skipped: false,
    // A total assembled from v2 is exact on every chain, including OP-stack,
    // because `fee.value` already contains the L1 data fee.
    execFeeOnly: false,
  }
}

/**
 * Read one chain, probing with v2 before committing to v1.
 *
 * The probe is what keeps an address's INBOUND volume from setting the cost of
 * scanning it. v1 cannot filter by direction, so without this a wallet buried in
 * airdrop spam burns the whole window budget on transactions it never sent; with
 * it, that wallet is answered by a single 0.6 s request. See the header.
 */
async function scanChain(
  address: string,
  chain: GasScanChain,
  alreadyWei: bigint,
): Promise<ChainSpend> {
  // Chains configured v2-only have no v1 to fall through to.
  if (chain.api === 'v2') return scanChainV2(address, chain, alreadyWei)

  const probe = await scanChainV2(address, chain, alreadyWei, 1)

  // `truncated` after a single page is this function's signal, not a defect: it
  // means a second page exists, so the sender is heavy enough to be worth v1.
  if (!probe.truncated) return probe
  if (probe.stoppedAtCap) return probe

  return scanChainV1(address, chain, alreadyWei)
}

// ─── The scan ────────────────────────────────────────────────────────────────

/**
 * Total lifetime gas spend for `address` across `GAS_SCAN_CHAINS`.
 *
 * Chains are walked in sequence, not in parallel, and that is the point: the cap
 * short-circuit only works if each chain knows what the previous ones found,
 * and for the wallets where this scan is expensive — the heavy ones — ending
 * early is worth far more than five-way concurrency. The heaviest wallet tested
 * reached the cap inside Ethereum's first window and never touched the other
 * four.
 *
 * Throws `GasScanUnavailable` if any chain it needed could not be read.
 */
export async function scanGasHistory(address: string): Promise<GasHistory> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new GasScanUnavailable('input', `not an address: ${address}`)
  }

  const chains: ChainSpend[] = []
  let totalWei = 0n

  for (const chain of GAS_SCAN_CHAINS) {
    if (totalWei >= POG_GAS_CAP_WEI) {
      chains.push({
        chain: chain.chain, chainId: chain.chainId,
        weiSpent: 0n, sentTxs: 0, truncated: false,
        stoppedAtCap: true, skipped: true,
        execFeeOnly: !chain.execFeeIsWholeFee,
      })
      continue
    }
    const spend = await scanChain(address, chain, totalWei)
    chains.push(spend)
    totalWei += spend.weiSpent
  }

  return {
    chains,
    totalWei,
    truncated: chains.some(c => c.truncated),
    scannedAt: Date.now(),
  }
}
