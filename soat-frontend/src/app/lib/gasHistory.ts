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
 * RE-MEASURED 2026-09-18 — HALF OF THAT PARAGRAPH IS NOW STALE
 *
 * `api.etherscan.io/v2/chainlist` advertises 63 chains and Robinhood 4663 is
 * one of them, so "does not index Robinhood Chain at any price" no longer
 * holds. The other half does: the free tier still refuses Optimism and Base.
 *
 * The fact worth keeping is HOW that was measured, because it needs no key and
 * so can be repeated by anyone reading this. The tier refusal is evaluated
 * BEFORE the key check, so an unkeyed `module=account&action=txlist` answers
 * either "Missing/Invalid API Key" — meaning the free tier reaches that chain —
 * or "Free API access is not supported for this chain". By that probe:
 *
 *   free tier reaches    1 Ethereum · 42161 Arbitrum · 4663 Robinhood
 *   paid plan required  10 Optimism · 8453 Base · 56 BNB Smart Chain · 97
 *
 * The gate is per MODULE, not per chain: on 56 and 97 `account`, `proxy` and
 * `stats` are refused while `contract` reads through to the key check. That is
 * why contract verification on BSC works from a free key and a gas scan does
 * not — the same key, the same chain, a different answer.
 *
 * So moving this file to Etherscan v2 is no longer blocked on coverage. It is
 * blocked on a bill, for three of the six chains, and that is somebody's
 * spending decision rather than an engineering one.
 *
 * The fallbacks were checked too, and both are closed. BscScan V1
 * (`api.bscscan.com`) now answers every request with "You are using a
 * deprecated V1 endpoint", and Blockscout's own directory of 708 hosted
 * instances contains no BNB Smart Chain — which corroborates, from outside,
 * the claim below that Blockscout cannot serve 56 at any tier.
 *
 * ONE HOST, NOT FIVE — THE PRO API
 *
 * This used to read five separate public instances: `eth.blockscout.com`,
 * `arbitrum.…`, `optimism.…`, `base.…` and `robinhoodchain.…`. That worked and
 * was not deployable, for two reasons measured rather than feared: unkeyed,
 * Arbitrum and Base advertise `x-ratelimit-limit: 10` on a window near forty
 * minutes, capping the whole product at about ten wallets an hour; and the
 * Robinhood instance sits behind a Cloudflare challenge that a default Node
 * `fetch` fails, so that leg only worked while we spoofed a browser
 * `User-Agent` — a dependency on someone else's WAF configuration.
 *
 * The keyed PRO API replaces all five with `api.blockscout.com/{chainId}/…`,
 * and both problems go with them. Verified against a live key, all five chains,
 * 2026-09-05:
 *
 *   · every chain answers 200 on both dialects, Robinhood (4663) included;
 *   · Robinhood needs no `User-Agent` override, so the WAF workaround is gone;
 *   · a 429 from a burst past the rate limit resets in **306 ms**, not forty
 *     minutes, which is what makes retrying it sane again (see
 *     `RETRYABLE_RESET_MS`);
 *   · unkeyed the host answers 402 and a bad key 401, so a missing key is a
 *     loud deployment failure and never a quiet degradation.
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
 *
 * Re-measured per chain on the PRO API, 2026-09-05, by pulling one busy sender's
 * transactions through both dialects and diffing `gasUsed * gasPrice` against
 * v2's authoritative `fee.value` on the same hashes:
 *
 *     Ethereum      50 txs      0.0000 %   exact, to the wei
 *     Arbitrum      50 txs      0.0000 %   exact — see below
 *     Optimism      50 txs      2.3000 %   worst single transaction 49.09 %
 *     Base          50 txs      0.0200 %   worst single transaction  0.02 %
 *     Robinhood     50 txs      0.0000 %   exact — see below
 *
 * Arbitrum and Robinhood come out exact because both are Nitro, and Nitro bills
 * the L1 data cost through an inflated `gasUsed` instead of a separate `l1Fee`
 * field. So `gasUsed * gasPrice` is the whole fee there, which is what
 * `execFeeIsWholeFee` records, and it is why Robinhood is safe to read through
 * the v1 fallthrough rather than being pinned to v2.
 *
 * That leaves Optimism and Base as the only two that under-count, and only for
 * senders heavy enough to fall through the v2 probe. The gap is small in
 * absolute terms next to L1 — one Ethereum transaction costs what a thousand L2
 * transactions cost, so mainnet dominates this sum for essentially every wallet
 * — and it is in the only safe direction; see below. It is not corrected by a
 * fudge factor, because a made-up multiplier would be less honest than an
 * acknowledged floor.
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
 *   · a chain that cannot be read fails the whole scan IF it is `required` —
 *     because a partial sum is indistinguishable from a smaller wallet and the
 *     difference is money. See the next section for the one chain that is not;
 *   · a history longer than the request budget yields the total so far, which
 *     is a lower bound, flagged `truncated` so the caller can say so;
 *   · the OP-stack shortfall above subtracts, never adds;
 *   · a boundary block that appears in two windows is de-duplicated by hash,
 *     because `startblock` is inclusive and double-counting is the one error
 *     that would award too much.
 *
 * WHY ROBINHOOD IS NOT `required`, WHICH IS A DELIBERATE INCONSISTENCY
 *
 * The two rules above did not agree with each other. A history past the request
 * budget was allowed to yield a flagged lower bound, while a chain that could not
 * be read was fatal — yet both are the same error, an under-count, differing only
 * in how much they can hide. That difference is the whole argument, and it is not
 * uniform across the five:
 *
 *   · an unreadable Ethereum can hide 24 ETH — the heaviest wallet tested spent
 *     that much there alone, and it is why four chains stay fatal;
 *   · an unreadable Robinhood hides almost nothing. Measured 2026-09-05: a busy
 *     4663 account's fifty most recent transactions cost 0.00403 ETH in total.
 *     Against the seeded 0.025 ETH eligibility floor that is 16 %, and against
 *     the 1 ETH cap it is 0.4 %. Omitting it changes an outcome only for a
 *     claimant already close to the floor, and then only downward.
 *
 * Set against that: while 4663 is fatal, its indexer's availability IS the
 * availability of genesis allocation for everybody. That is not theoretical — it
 * was measured going wrong. On 2026-09-05 the 4663 leg answered 1/12 requests
 * while Ethereum answered 12/12 on the same key, and its own instance was down
 * simultaneously (502 with the browser UA, 403 without), which places the fault in
 * the chain's indexer rather than in either access path. Roughly nine in ten scans
 * would have failed, on a chain contributing 0.4 % of a capped total.
 *
 * So the trade is: risk under-awarding by up to 8 % of the floor, in the safe
 * direction and flagged as a lower bound, rather than blocking every claim
 * whenever a four-month-old chain's explorer restarts. The flag matters — an
 * unreadable chain sets `truncated`, so nothing downstream can present the figure
 * as complete.
 *
 * This is also safe adversarially, which is the part worth checking: an attacker
 * who could make 4663 look unreadable would only reduce their own total. There is
 * no version of this that awards more.
 */

import { DEFAULT_POG_BAND, pogCapWei } from './pogQuota'

/**
 * The cap to page up to when a caller does not say.
 *
 * Derived from the seeded band, not from the live one: this module is called
 * from a script as well as from the server, and a default that silently reached
 * for a shared store would make an offline scan depend on Upstash. Callers that
 * hold the live band — `api/pog-scan`, `api/sign-allocation` — pass its cap in.
 */
const SEEDED_CAP_WEI = pogCapWei(DEFAULT_POG_BAND)

// ─── Chains ──────────────────────────────────────────────────────────────────

/** Which Blockscout API a chain is read through. See the header. */
export type ScanApi = 'v1' | 'v2'

export interface GasScanChain {
  chain: string
  chainId: number
  api: ScanApi
  /**
   * Whether being unable to read this chain fails the whole scan.
   *
   * True for the four that can hide real money. False only for Robinhood, whose
   * measured contribution is a fraction of a percent of the cap and whose
   * indexer would otherwise gate every genesis allocation. See the header.
   */
  required: boolean
  /**
   * True where `gasUsed * gasPrice` is the whole fee. False on OP-stack, where
   * it omits the L1 data fee. Recorded per chain so the shortfall is visible in
   * the result instead of buried in this comment.
   */
  execFeeIsWholeFee: boolean
  /**
   * What one wei of this chain's gas coin is worth in ETH wei, scaled by 1e18.
   *
   * Exists because the totals this module produces are ETH-denominated and not
   * every chain worth scanning settles in ETH. `ChainSpend.weiSpent` stays in
   * the chain's OWN coin — that is what the user paid and what a breakdown
   * should show — and this is the factor that makes summing them legitimate.
   *
   * `10n ** 18n` means "already ETH" and is not merely the default: the
   * conversion helpers short-circuit on it, so an ETH chain pays no rounding
   * and no arithmetic for a feature it does not use.
   *
   * A non-unit factor is a PRICE, and prices drift, so the rule from the
   * failure-direction section applies with full force: set it BELOW spot so
   * drift under-awards. There is deliberately no oracle here. A scan that
   * silently re-prices itself between two signers is the divergence hazard
   * `pogParams.ts` exists to document, and a gas history that changes because
   * a market moved is not a history.
   */
  nativeToEthX18: bigint
}

/** `nativeToEthX18` for a chain that settles in ETH. */
const NATIVE_IS_ETH = 10n ** 18n

/** This chain's coin -> ETH. Exact for ETH chains, floor-rounded otherwise,
 *  which rounds against the claimant and so fails in the allowed direction. */
function toEthWei(nativeWei: bigint, chain: GasScanChain): bigint {
  if (chain.nativeToEthX18 === NATIVE_IS_ETH) return nativeWei
  return (nativeWei * chain.nativeToEthX18) / NATIVE_IS_ETH
}

/** ETH -> this chain's coin, for carrying an ETH-denominated budget into a
 *  scanner that counts in the chain's own units. Rounds UP so converting a
 *  budget can never shrink it below what the ETH figure allowed. */
function toNativeWei(ethWei: bigint, chain: GasScanChain): bigint {
  if (chain.nativeToEthX18 === NATIVE_IS_ETH) return ethWei
  return (ethWei * NATIVE_IS_ETH + chain.nativeToEthX18 - 1n) / chain.nativeToEthX18
}

/**
 * The five chains whose spend counts, and nothing else.
 *
 * Ethereum is first because fees there are orders of magnitude larger, so it is
 * the chain most likely to reach the cap on its own and end the scan early.
 *
 * Robinhood Chain is still in this table, and that is a live decision rather
 * than a missed rename. Its gas is ETH-denominated and counts toward the floor.
 * It is NOT the settlement chain any more — that is BNB Smart Chain, which is
 * absent because no transport this project pays for can reach it: Blockscout
 * has no chain-56 instance at any tier, and Etherscan v2 has one but puts
 * `account` behind a paid plan (measured 2026-09-18; see the header).
 *
 * Stated plainly, because the shape of it is easy to miss: **a wallet's BSC gas
 * history earns it nothing, on the chain the protocol now settles on.** That is
 * a policy consequence of a billing fact, and it should be decided rather than
 * inherited. Adding 56 means buying an Etherscan plan and moving at least
 * Optimism and Base across with it, since those two are gated identically and
 * running two vendors to save one subscription is the worse trade.
 *
 * A dialog that dropped 4663 while this table still queried it, or that named
 * 56 while this table does not, would be lying.
 */
export const GAS_SCAN_CHAINS: readonly GasScanChain[] = [
  { chain: 'Ethereum',  chainId: 1,     api: 'v1', required: true,  execFeeIsWholeFee: true,  nativeToEthX18: NATIVE_IS_ETH },
  { chain: 'Arbitrum',  chainId: 42161, api: 'v1', required: true,  execFeeIsWholeFee: true,  nativeToEthX18: NATIVE_IS_ETH },
  { chain: 'Optimism',  chainId: 10,    api: 'v1', required: true,  execFeeIsWholeFee: false, nativeToEthX18: NATIVE_IS_ETH },
  { chain: 'Base',      chainId: 8453,  api: 'v1', required: true,  execFeeIsWholeFee: false, nativeToEthX18: NATIVE_IS_ETH },
  // Reads like the other four now. On its own instance v1 timed out, which is
  // why this was pinned to `v2` and a 20-page budget; on the PRO API it answers
  // a production-shaped `txlist` (offset 10,000, startblock 0) in 2.5 s, and
  // `gasUsed * gasPrice` there matches v2's `fee.value` to the wei because Nitro
  // has no separate L1 fee. So it takes the same probe-first path, which prices
  // a young chain's one-page histories exactly and still has a way out if one
  // grows.
  //
  // `required: false` is the one exception in this table, argued at length in the
  // header. Short version: it can hide 0.4 % of a capped total, and while it was
  // fatal its indexer's uptime was the uptime of genesis allocation.
  { chain: 'Robinhood', chainId: 4663,  api: 'v1', required: false, execFeeIsWholeFee: true,  nativeToEthX18: NATIVE_IS_ETH },
]

/**
 * The one host, keyed. `{chainId}` is the first path segment — verified against
 * a live key on all five chains rather than inferred from the docs, which
 * describe a `chain_id` query parameter this deployment does not use.
 */
const PRO_API_ROOT = 'https://api.blockscout.com'

function hostFor(chain: GasScanChain): string {
  return `${PRO_API_ROOT}/${chain.chainId}`
}

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

/** v2 pages of 50 for a chain configured `api: 'v2'`, which none now is — the
 *  probe-first path spends exactly one page and falls through to v1. Kept
 *  because `ScanApi` still permits `'v2'`, so a chain that loses its v1 route
 *  has somewhere to go without a code change. */
const MAX_V2_PAGES = 20

/** Retries per request for a transient 429 or 5xx. Beyond this it is an outage,
 *  and an outage has to surface rather than become a small allocation. */
const MAX_RETRIES = 3

/**
 * The same headers for every chain, which is itself the change.
 *
 * This was `headersFor(chain)` because the Robinhood instance sat behind a
 * Cloudflare challenge that answered a default Node `fetch` with 403 and a
 * spoofed browser `User-Agent` with 200. The PRO API does not serve that
 * challenge — verified, a default `fetch` gets 200 on 4663 — so there is nothing
 * left to vary and the per-chain indirection would only invite the workaround
 * back.
 */
const REQUEST_HEADERS: Record<string, string> = { Accept: 'application/json' }

/**
 * The PRO API key, without which this module cannot read anything at all.
 *
 * Unkeyed, `api.blockscout.com` answers `402 {"error":"Proceed with API key or
 * make a X402 payment to continue"}`, and a wrong key answers `401
 * {"error":"Unauthorized"}`. Neither is a degraded mode — both fail every chain,
 * and by the failure rule above a failed chain fails the whole scan. So an unset
 * key is a deployment error, which is what `assertScanKeyPresent()` is for; it
 * is read from the environment rather than required here only so the offline
 * tests and the offline signer keep working without one.
 *
 * WHAT THE KEY ON THIS DEPLOYMENT ACTUALLY GRANTS, measured 2026-09-05 from the
 * response headers rather than the pricing page:
 *
 * | | Value |
 * |---|---|
 * | `x-ratelimit-limit` | 5 req/s |
 * | Credit budget | 100,000/day (`x-credits-remaining` counts down) |
 * | Cost, v2 page | ~16.7 credits |
 * | Cost, v1 page | ~15 credits, and **the same 20 at `offset=10000` as at
 *   `offset=10`** — page size is free, which is why `V1_PAGE_SIZE` is maxed |
 * | 429 reset | 306 ms (a burst of 12 concurrent got 10×200, 2×429) |
 *
 * That is the FREE tier, not the $49 Builder tier: Builder is 15 req/s and 100M
 * credits/month. At 20 credits a call the daily budget is about 5,000 calls, and
 * since a light wallet is five (one v2 probe per chain) and a heavy one up to
 * twenty-five, capacity is roughly **1,000 light or 200 heavy wallets a day**.
 * The rate limit is not the binding constraint; the daily credit budget is,
 * which is why `/api/pog-scan` gates on observed credits and not just on a
 * request count.
 */
const API_KEY = process.env.BLOCKSCOUT_API_KEY ?? ''

export function scanKeyPresent(): boolean {
  return API_KEY.length > 0
}

/**
 * Fail loudly, at the caller's choosing, rather than 402 per chain per claimant.
 *
 * The header above promised this function existed and it did not, so an unkeyed
 * deployment's first symptom would have been every claimant's scan failing with
 * a chain-level error that named Ethereum instead of naming the missing key.
 */
export function assertScanKeyPresent(): void {
  if (!API_KEY) {
    throw new Error(
      'BLOCKSCOUT_API_KEY is not set. The Proof-of-Gas scan reads '
      + 'api.blockscout.com, which answers 402 without a key, so every chain — '
      + 'and therefore every scan — would fail. Get one at dev.blockscout.com '
      + 'and verify it with `npm run check:blockscout`.',
    )
  }
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
  /** Fees this address paid on this chain, in THIS CHAIN's coin.
   *
   *  This used to carry the note "all five settle in ETH, so summing across
   *  them is addition of like units", and that was true until a chain whose
   *  coin is not ETH became worth scanning. Summing this field directly is now
   *  a unit error; `ethEquivalentWei` is what adds up. Kept in native units
   *  because a per-chain breakdown should say what the user actually paid. */
  weiSpent: bigint
  /** `weiSpent` converted through `GasScanChain.nativeToEthX18`. Equal to
   *  `weiSpent` on every ETH chain, and the only field `totalWei` accumulates. */
  ethEquivalentWei: bigint
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
  /**
   * Could not be read, and is not `required`, so the scan continued with this
   * chain counted as zero.
   *
   * Kept separate from `skipped` because the two mean opposite things about the
   * total: `skipped` is "already over the cap, looking cannot change the answer",
   * whereas this is "the answer is unknown and assumed zero". Conflating them
   * would let a UI present a lower bound as a complete figure.
   */
  unavailable: boolean
  /** This figure is execution fees only and excludes the OP-stack L1 data fee.
   *  Mirrors `execFeeIsWholeFee` into the result so a caller does not have to
   *  re-derive it from the chain table. */
  execFeeOnly: boolean
}

export interface GasHistory {
  chains: ChainSpend[]
  /** Sum over chains, uncapped and unfloored. The figure shown to the user. */
  totalWei: bigint
  /**
   * `totalWei` is a lower bound rather than the figure.
   *
   * Set by either of the two ways this can under-count: a chain's request budget
   * ran out below the cap, or an optional chain could not be read at all. Both
   * are the same claim to a caller — "at least this much" — so they set the same
   * flag, and the per-chain breakdown says which.
   */
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
 * Measured, not chosen. The unkeyed instances this module used to read answered
 * with `x-ratelimit-limit: 10` and a reset around 2,370,000 ms — a ten-request
 * budget refilling in about forty minutes — and retrying that on a 400 ms
 * backoff spent three more attempts on a budget that had none left and could not
 * recover inside the request. The bound exists to call that what it is instead
 * of knocking again.
 *
 * On the PRO API the case it was written for no longer arises: a burst past
 * 5 req/s comes back with a reset of **306 ms**, comfortably inside this bound,
 * so those 429s are now retried and succeed. The bound stays because a credit
 * budget exhausted for the day would also arrive as a 429, and that one must not
 * be retried — it is the exhaustion `/api/pog-scan` needs to hear about.
 */
const RETRYABLE_RESET_MS = 5_000

/**
 * Credits left on the key, as last reported by any successful call.
 *
 * `x-credits-remaining` is on every 200 from both dialects (absent only on a
 * 404, verified), so a scan always leaves a fresh reading behind. It is kept
 * module-level and read afterwards rather than threaded through every return
 * type because the consumer is not the scan — it is the next request's admission
 * decision, one process later, via Redis. See `/api/pog-scan`.
 *
 * Null means nothing has been observed yet this process, which is deliberately
 * distinct from zero: an unknown budget must not read as an exhausted one, or a
 * cold start would refuse every claimant.
 */
let lastCredits: number | null = null

export function lastObservedCredits(): number | null {
  return lastCredits
}

/** `x-ratelimit-reset` in ms, or null when the host does not say. All four
 *  Blockscout hosts that answered did say; the value is a plain countdown. */
function resetMsOf(res: Response): number | null {
  const raw = res.headers.get('x-ratelimit-reset')
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Latch `x-credits-remaining` off any response that carries it. Monotonic
 *  decrease is not assumed — the budget resets daily, and a reading that went up
 *  is the reset, not a bug. */
function noteCredits(res: Response): void {
  const raw = res.headers.get('x-credits-remaining')
  if (!raw) return
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) lastCredits = n
}

async function getJson<T>(url: string, chain: GasScanChain): Promise<T> {
  let lastReason = 'unknown'
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(400 * attempt)
    try {
      const res = await fetch(withKey(url), {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: 'no-store',
      })
      // Recorded before any status branch, so an exhaustion is still observable
      // from the response that reported it.
      noteCredits(res)

      // A missing or rejected key. Retrying cannot fix either, and both would
      // otherwise surface as "could not read Ethereum" — which sends whoever is
      // on call to look at a chain instead of at an environment variable.
      if (res.status === 401 || res.status === 402) {
        throw new GasScanUnavailable(
          chain.chain,
          res.status === 402
            ? 'BLOCKSCOUT_API_KEY is missing (api.blockscout.com answered 402)'
            : 'BLOCKSCOUT_API_KEY was rejected (api.blockscout.com answered 401)',
        )
      }
      if (res.status === 429) {
        // Retry only a limit that is about to refill anyway. A long reset means
        // the budget is gone for this window, and the honest move is to say so
        // rather than knock three more times. On the PRO API the per-second
        // limit resets in ~306 ms and lands in the retryable branch; a daily
        // credit exhaustion does not, and must not.
        const resetMs = resetMsOf(res)
        if (resetMs !== null && resetMs > RETRYABLE_RESET_MS) {
          const limit = res.headers.get('x-ratelimit-limit') ?? '?'
          throw new GasScanUnavailable(
            chain.chain,
            `rate limited (${limit}/window, resets in ${Math.ceil(resetMs / 1000)}s)`
            + '; raise the tier at dev.blockscout.com',
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
  capWei: bigint,
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
    const url = `${hostFor(chain)}/api?module=account&action=txlist&address=${address}`
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

    if (alreadyWei + weiSpent >= capWei) { stoppedAtCap = true; break }

    // Short window means the history ran out before the budget did.
    if (rows.length < V1_PAGE_SIZE) break
    if (window === MAX_V1_WINDOWS - 1) { truncated = true; break }

    boundaryHashes = nextBoundary
    startBlock = lastBlock
  }

  return {
    chain: chain.chain, chainId: chain.chainId,
    weiSpent, ethEquivalentWei: toEthWei(weiSpent, chain),
    sentTxs, truncated, stoppedAtCap, skipped: false, unavailable: false,
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
  capWei: bigint,
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
      `${hostFor(chain)}/api/v2/addresses/${address}/transactions?${q}`, chain)
    const items = body.items ?? []

    for (const item of items) {
      // Re-checked even though `filter=from` is server-side: one query-parameter
      // typo would otherwise turn this back into the inbound-counting metric.
      if (fromHash(item.from) !== target) continue
      weiSpent += feeOfV2(item)
      sentTxs++
    }

    if (alreadyWei + weiSpent >= capWei) { stoppedAtCap = true; break }

    cursor = body.next_page_params ?? null
    if (!cursor) break
    if (page === maxPages - 1) truncated = true
  }

  return {
    chain: chain.chain, chainId: chain.chainId,
    weiSpent, ethEquivalentWei: toEthWei(weiSpent, chain),
    sentTxs, truncated, stoppedAtCap, skipped: false, unavailable: false,
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
  capWei: bigint,
): Promise<ChainSpend> {
  // Chains configured v2-only have no v1 to fall through to.
  if (chain.api === 'v2') return scanChainV2(address, chain, alreadyWei, capWei)

  const probe = await scanChainV2(address, chain, alreadyWei, capWei, 1)

  // `truncated` after a single page is this function's signal, not a defect: it
  // means a second page exists, so the sender is heavy enough to be worth v1.
  if (!probe.truncated) return probe
  if (probe.stoppedAtCap) return probe

  return scanChainV1(address, chain, alreadyWei, capWei)
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
 * `capWei` is where more history stops being able to change the allocation, so
 * it is a budget rather than a policy: passing the live band's cap makes the
 * short-circuit tighten and loosen with the dials, and passing the seeded one
 * only over-reads. Never pass a figure below the live cap, or the total becomes
 * a lower bound without the `truncated` flag that would say so.
 *
 * Throws `GasScanUnavailable` if any chain it needed could not be read.
 */
export async function scanGasHistory(
  address: string,
  capWei: bigint = SEEDED_CAP_WEI,
): Promise<GasHistory> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new GasScanUnavailable('input', `not an address: ${address}`)
  }

  const chains: ChainSpend[] = []
  let totalWei = 0n

  for (const chain of GAS_SCAN_CHAINS) {
    if (totalWei >= capWei) {
      chains.push({
        chain: chain.chain, chainId: chain.chainId,
        weiSpent: 0n, ethEquivalentWei: 0n, sentTxs: 0, truncated: false,
        stoppedAtCap: true, skipped: true, unavailable: false,
        execFeeOnly: !chain.execFeeIsWholeFee,
      })
      continue
    }

    let spend: ChainSpend
    try {
      // The budget crosses into the chain's own currency on the way in and the
      // result crosses back on the way out, so every comparison inside the
      // scanners — including the early stop at the cap — is like against like.
      // Converting only the result would leave those comparisons mixing units.
      spend = await scanChain(
        address, chain, toNativeWei(totalWei, chain), toNativeWei(capWei, chain),
      )
    } catch (e) {
      // Only a read failure is survivable, and only on a chain marked optional.
      // Anything else — a bug in here, a shape we cannot parse — must not be
      // quietly turned into a zero, because that is how a defect becomes an
      // allocation.
      if (chain.required || !(e instanceof GasScanUnavailable)) throw e
      spend = {
        chain: chain.chain, chainId: chain.chainId,
        weiSpent: 0n, ethEquivalentWei: 0n, sentTxs: 0,
        // `truncated` as well as `unavailable`: this chain's figure is a lower
        // bound, which is exactly what that flag means, and it is what carries
        // the fact up into `GasHistory.truncated` without a second rule.
        truncated: true, stoppedAtCap: false, skipped: false, unavailable: true,
        execFeeOnly: !chain.execFeeIsWholeFee,
      }
    }
    chains.push(spend)
    totalWei += spend.ethEquivalentWei
  }

  return {
    chains,
    totalWei,
    truncated: chains.some(c => c.truncated),
    scannedAt: Date.now(),
  }
}
