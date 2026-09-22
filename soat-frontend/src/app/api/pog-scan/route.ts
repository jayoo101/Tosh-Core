/**
 * /api/pog-scan — start, refresh and poll a Proof-of-Gas gas-history scan.
 * ───────────────────────────────────────────────────────────────────────────
 * PM-F9. `sign-allocation` used to derive an allocation from a constant table,
 * so it could do everything in one request. A real scan reads five chains and
 * measured 10–23 s, which does not belong inside the request that signs. So the
 * work moves here and becomes a job:
 *
 *   POST  starts one (or returns the fresh result it already has, or the one
 *         already in flight), authenticated as the wallet being scanned.
 *   GET   reports state, for polling.
 *
 * `sign-allocation` then reads the finished job instead of doing the work, and
 * refuses to sign if there is not one.
 *
 * WHY POST MAY BE UNSIGNED, AND GET IS UNSIGNED
 *
 * A scan is the expensive thing this service does: five chains, up to four
 * 10,000-row windows each, against Blockscout credits. The product now starts
 * that read the moment a wallet connects — before any signature prompt — so
 * POST no longer requires EIP-191. What bounds the spend instead is the stack
 * below: per-IP, global hourly, per-address, credit reserve, and the one-hour
 * result cache. Those were always the real ceilings; keypairs are free, so
 * wallet auth never stopped a determined caller from rotating addresses.
 *
 * A signature is still accepted when present (the deposit path may already
 * hold one for `sign-allocation`) and is verified the same way. It is not
 * required to start a read of public fee totals.
 *
 * GET carries no auth because it discloses nothing private: every figure in it
 * is a sum of public transaction fees, readable by anyone with the address.
 *
 * It is still bucketed, and the sentence that used to be here — "writes cost us
 * money, reads do not" — is why it was not. A read costs an Upstash command
 * before it can even find out the address is unknown, and Upstash is what the
 * rate limiter runs on, so the cheapest way to weaken every budget below was to
 * hammer the one handler that had none. See `GET_RATE_LIMIT`. Auth and
 * throttling are separate questions and only the first one is settled by the
 * data being public.
 *
 * WHY `after()` AND WHAT ITS ACTUAL LIMIT IS
 *
 * Next's own documentation is explicit that `after` "will run for the platform's
 * default or configured max duration of your route" — it is not an unbounded
 * background worker, and there is no queue here pretending otherwise. So
 * `maxDuration` below is the real budget, and a scan that overruns it is killed
 * without getting to record a failure. That case is handled in
 * `scanJobStore.ts` by treating `running` as a lease rather than a state, so a
 * killed invocation self-heals into a retryable error instead of a spinner that
 * never stops.
 */

import { NextResponse } from 'next/server'
import { after } from 'next/server'
import { isAddress, verifyMessage, type Address } from 'viem'

import { reportError } from '@/lib/observability'
import {
  POG_SCAN_AUTH_DOMAIN,
  POG_SESSION_AUTH_TTL_MS,
  buildPoGScanAuthMessage,
  isSupportedPogChain,
} from '@/lib/contracts'
import {
  scanGasHistory, GasScanUnavailable, scanKeyPresent, lastObservedCredits,
  ethEquivalentWeiFor,
} from '@/app/lib/gasHistory'
import {
  readScanJob, startScanJob, finishScanJob, failScanJob,
  isFresh, JOB_LEASE_MS, RESULT_TTL_MS,
  recordCreditBalance, readCreditBalance,
  type ScanJob,
} from '@/app/lib/scanJobStore'
import {
  computeMaxAllocFromWei, isPogEligible, pogCapWei,
} from '@/app/lib/pogQuota'
import { getPogBand } from '@/app/lib/pogParams'
import {
  applyCors, applyRateLimit, corsPreflight, readJsonBody,
} from '@/app/lib/apiGuard'
import { consumeRateLimit } from '@/app/lib/rateLimitStore'

/**
 * The budget for the whole scan, and therefore for `after()`.
 *
 * Sized against measurement, not hope: the slowest honest scan observed was
 * 23 s (a wallet with 1,450 sent transactions, through a local proxy), and the
 * heaviest wallet finished in 11 s because it reached the cap on Ethereum and
 * skipped the remaining four chains. 120 s leaves room for a bad day and
 * matches `JOB_LEASE_MS`, so the lease expires at the same moment the platform
 * would have killed the work — the two cannot disagree about whether a job is
 * still alive.
 */
export const maxDuration = 120

const CORS_OPTS = { methods: ['POST', 'GET', 'OPTIONS'] as const } as const

/**
 * Deliberately tighter than `sign-allocation`'s bucket. That endpoint does
 * arithmetic and one `eth_call`; this one can issue twenty upstream requests
 * across several hosts.
 *
 * Six in a burst then two a minute, up from three and one. Two things moved
 * under this bucket and both of them made the old figures punish the wrong
 * requests. A scan is no longer started by connecting a wallet, so a request
 * here is now a deliberate click rather than something the page did on its own.
 * And this bucket is consumed BEFORE the cache is consulted, so a repeat within
 * `RESULT_TTL_MS` — which costs nothing upstream, and after that TTL went to a
 * day is most repeats — was being refused by a limiter that exists to bound
 * upstream cost. Meanwhile the defences that bound real abuse are elsewhere and
 * unchanged in kind: `ADDRESS_SCAN_LIMIT` caps one wallet at six an hour, and
 * `GLOBAL_SCAN_LIMIT` caps everyone.
 */
const RATE_LIMIT_OPTS = {
  name: 'pog-scan',
  capacity: 6,
  refillPerSec: 1 / 30,
} as const

/**
 * GET's bucket, which this route did without.
 *
 * The omission had a reason written above it — "writes cost us money, reads do
 * not" — and the reason is false. A GET spends one Upstash command in
 * `readScanJob` before it can even discover the address is unknown, and two once
 * the job is `done`, because `present()` reads the live rate. Unauthenticated and
 * unbucketed, that made this the one handler in the app with no ceiling on how
 * much shared store it can be made to spend: every other GET here is throttled,
 * including `admin/config`'s, whose comment describes this exact case — public
 * data, no auth, "still throttled to fend off scrapers".
 *
 * What makes it worth more than a bill is which store it is. Upstash backs the
 * rate limiter itself, and `consumeRateLimit` answers a store failure by falling
 * back to per-instance counting for 30 s. `pog-scan:global` is a per-instance
 * ceiling at that point, so the hourly ceiling sized to protect the Blockscout
 * credit budget stops being global exactly when something is straining the store.
 * The
 * end of that chain is the failure this file already names: credits exhausted,
 * `CREDIT_RESERVE` refusing, and genesis allocation closed for everybody.
 *
 * Sized so legitimate polling cannot trip it: the genesis panel polls every 2 s for
 * at most 135 s, so ~0.5 req/s sustained and ~68 per scan. 10/s refill leaves a
 * twentyfold margin and matches what `projects` already calls a cheap read.
 */
const GET_RATE_LIMIT = {
  name: 'pog-scan-get',
  capacity: 60,
  refillPerSec: 10,
} as const

/**
 * Two further budgets, because neither of the defences above bounds the thing
 * that actually breaks.
 *
 * The bucket above counts by IP, and the auth signature proves the caller
 * controls the address it names. Neither is scarce. Keypairs are free, so every
 * fresh address is a fresh cache key and therefore a real five-chain read; and a
 * rented proxy pool multiplies the per-IP bucket by however many IPs were
 * rented. What that threatens is not the bill — these hosts charge nothing — it
 * is our standing with them. Blockscout's public instances are goodwill, a scan
 * fails closed when they refuse us, and a closed scan blocks genesis allocation
 * for everyone. An IP ban here is a denial of service on the launch that we
 * deliver to ourselves.
 */

/**
 * Ceiling on scans started by anyone, per hour — burst control, not the budget.
 *
 * The history: this was 240, reasoned from what five public instances "ought to
 * absorb". Then they were asked, and unkeyed Arbitrum and Base turned out to
 * grant ten requests per forty-minute window, capping the product at about ten
 * wallets an hour. The fix was not a different constant, it was the migration to
 * the keyed PRO API, where the rate limit is 5 req/s and a 429 resets in 306 ms.
 *
 * So requests per second are no longer the scarce thing; **credits are**. A scan
 * costs between 5 calls (a one-page wallet) and 25 (a heavy sender that falls
 * through to v1 on every chain) at roughly 20 credits a call, so 100 to 500
 * credits. A request-count ceiling cannot bound a cost that varies five-fold, so
 * it is not asked to: `CREDIT_RESERVE` below does that, against the balance the
 * host itself reports.
 *
 * 500/hour, up from 120, and the 120 was not merely conservative — it claimed to
 * be "far more than organic demand" and production disproved that. The hourly
 * budget was exhausted by ordinary traffic, every caller got `503 at capacity`
 * for the rest of the window, and since quota cannot be sized without a scan the
 * raise funnel went down with it. The other half of that fix was making a scan
 * need a click; see `usePogFlow`.
 *
 * WHAT PACES THE MONTH, WHICH IS A DIFFERENT JOB FROM WHAT THIS USED TO DO
 *
 * On the free tier the allowance was 100,000 credits A DAY, so this ceiling was
 * only ever a burst flattener: overspend corrected itself at midnight. The
 * Builder tier is 100,000,000 a MONTH, which is 33x the headroom and removes the
 * nightly forgiveness — spend it early and the outage lasts until the month
 * rolls, not until tomorrow. So this ceiling is now also the pacing tool, and
 * 500 is chosen against the month rather than against a burst: at a mixed
 * ~240 credits a scan it is ~120k credits an hour, ~86M over thirty days,
 * inside the allowance. A month of nothing but heavy wallets would still
 * overrun it, which is deliberate — `CREDIT_RESERVE` and its alert are what
 * catch the tail, and sizing this for the worst case would refuse honest
 * traffic every day to insure against a distribution that has never shown up.
 */
const GLOBAL_SCAN_LIMIT = { capacity: 500, windowMs: 60 * 60 * 1000 } as const

/**
 * Credits below which no new scan is started.
 *
 * Refusing here is strictly better than letting the scan start and fail: a 503
 * from us can say "come back later", whereas the alternative is several 402s and
 * a claimant told their gas history could not be read. A scan killed halfway
 * spends the credits and produces nothing, which is the one outcome worse than
 * refusing it up front.
 *
 * 50,000, up from 2,000, because the tier change turned this from a floor into a
 * warning. 2,000 was sized as four worst-case scans — the least that could still
 * finish what was in flight — and that was the right size for a DAILY allowance,
 * where tripping it cost hours and midnight fixed it. The Builder tier is
 * MONTHLY, so tripping it costs days, and stopping at 0.002% remaining is a
 * warning that arrives after the thing it warns about. 50,000 is 0.05% of the
 * month and buys 100 worst-case scans of runway: enough that the alert below
 * lands while there is still something to decide, which is the only reason to
 * refuse early rather than late.
 */
const CREDIT_RESERVE = 50_000

/** How long a caller is told to wait when the credit budget is what ran out.
 *
 *  Six hours, not the hour this was. The hour was reasoned from a daily
 *  allowance — the reset was never more than a day out, and the gauge's own TTL
 *  noticed a genuine one within the hour. On a monthly allowance the reset can
 *  be weeks away, so an hour is not a conservative estimate, it is a promise
 *  that will be broken five more times. This is still far shorter than the true
 *  wait, deliberately: the value's job is to make clients back off and let the
 *  gauge re-read after a top-up or an upgrade, not to predict the reset. The
 *  copy below carries the honest part. */
const CREDIT_EXHAUSTED_RETRY_MS = 6 * 60 * 60 * 1000

/** Ceiling on scans for one address, per hour.
 *
 *  `force` deletes the cached result, so without this one wallet can pay the
 *  full five-chain cost as fast as the per-IP bucket refills — sixty times an
 *  hour, indefinitely. Six is more refreshes than an answer that grows this
 *  slowly can justify, and it stops a single wallet from taking a meaningful
 *  bite out of the global ceiling. */
const ADDRESS_SCAN_LIMIT = { capacity: 6, windowMs: 60 * 60 * 1000 } as const

interface ScanRequestBody {
  userAddress: string
  chainId: number
  /** Optional. When both are set they are verified; when absent the scan still
   *  starts under the rate-limit stack. See the header for why. */
  timestamp?: number
  signature?: string
  /** Discard any cached result and read the chains again. The refresh button. */
  force?: boolean
}

function clientError(error: string, status = 400) {
  return NextResponse.json({ error }, { status })
}

/** A refusal the caller should wait out, carrying how long. `Retry-After` is set
 *  because without it a client's only sane move is to poll, which is the load we
 *  just declined to take. */
function budgetError(error: string, status: number, resetMs: number) {
  const res = NextResponse.json(
    { error, retryAfterMs: resetMs },
    { status },
  )
  res.headers.set('Retry-After', String(Math.max(1, Math.ceil(resetMs / 1000))))
  return res
}

function corsify(req: Request, res: NextResponse) {
  return applyCors(res, req, CORS_OPTS)
}

// ─── Wire shape ──────────────────────────────────────────────────────────────

/**
 * What a client sees. Wei are decimal strings; a JSON number cannot hold
 * 1e18 without losing the low digits, and these figures decide an allocation.
 *
 * `eligible` and `maxAllocWei` are computed here rather than in the browser so
 * the floor and the cap have exactly one implementation. A UI that re-derived
 * them would eventually disagree with the signer, and the disagreement would
 * show up as a wallet being told it qualified and then refused.
 */
async function present(job: ScanJob) {
  // The live band, not the seeds. Every figure below — the floor the UI draws,
  // the cap it explains, the quota it promises — has to come from the same read
  // that the signer will use, or the dialog and the attestation disagree.
  const band = await getPogBand()
  const base = {
    status: job.status,
    address: job.address,
    floorWei: band.floorWei.toString(),
    capWei: pogCapWei(band).toString(),
    maxAllocCeilingWei: band.maxAllocWei.toString(),
    resultTtlMs: RESULT_TTL_MS,
    leaseMs: JOB_LEASE_MS,
  }

  if (job.status === 'running') {
    return { ...base, startedAt: job.startedAt }
  }
  if (job.status === 'failed') {
    return { ...base, error: job.error ?? 'Scan failed. Try again.', retryable: true }
  }

  const result = job.result
  if (!result) {
    // `done` without a result is not reachable through `finishScanJob`; if it
    // ever appears it is a format change, and saying so beats rendering zero.
    return { ...base, status: 'failed' as const, error: 'Scan result missing. Try again.', retryable: true }
  }

  const totalWei = BigInt(result.totalWei)

  return {
    ...base,
    finishedAt: job.finishedAt,
    scannedAt: result.scannedAt,
    fresh: isFresh(job),
    totalGasWei: totalWei.toString(),
    /** True when `totalGasWei` is a lower bound rather than the figure — either
     *  a page budget ran out or an optional chain could not be read. Which one is
     *  in the per-chain breakdown. */
    truncated: result.truncated,
    /** Chains counted as zero because they could not be read. Named rather than
     *  merely counted, so the UI can tell a user which history is missing instead
     *  of a vague "this may be incomplete". */
    unavailableChains: result.chains.filter(c => c.unavailable).map(c => c.chain),
    eligible: isPogEligible(totalWei, band),
    maxAllocWei: computeMaxAllocFromWei(totalWei, band).toString(),
    gasToSatoRate: band.rate,
    chains: result.chains.map(c => ({
      chain: c.chain,
      chainId: c.chainId,
      /**
       * ETH, not the chain's own coin, because this row is printed one column
       * away from the ETH total and the floor it is judged against.
       *
       * It used to send `weiSpent`, which is native by design — so a wallet with
       * BSC-only history showed a BNB figure labelled ETH, four times the total
       * directly beneath it. Nothing was mis-measured (eligibility has always
       * read `totalWei`, which accumulates the converted figure), but the
       * breakdown could not be added up, and the ticker beside it was wrong.
       */
      gasWei: c.ethEquivalentWei ?? ethEquivalentWeiFor(c.chainId, BigInt(c.weiSpent)).toString(),
      sentTxs: c.sentTxs,
      truncated: c.truncated,
      skipped: c.skipped,
      /** Could not be read; counted as zero. Distinct from `skipped`, which means
       *  the cap was already reached so looking could not change the answer. */
      unavailable: c.unavailable ?? false,
      /** This chain's figure omits the OP-stack L1 data fee. See
       *  `gasHistory.ts`; it can only under-count, never over. */
      execFeeOnly: c.execFeeOnly,
    })),
  }
}

// ─── The work ────────────────────────────────────────────────────────────────

/**
 * Runs inside `after()`, so nothing it throws can reach a client. Every exit
 * path therefore has to write the job's outcome itself, or the lease in
 * `scanJobStore` is the only thing that eventually frees the user.
 */
/**
 * Persist whatever the scan learned about the credit balance.
 *
 * Runs on both the success and the failure path, and the failure path is the one
 * that matters: a scan that died because the budget ran out is precisely the
 * scan whose last response proves it, and dropping that reading would mean the
 * next claimant rediscovers the same wall.
 *
 * Never allowed to throw. This is bookkeeping — losing it costs a degraded
 * admission decision, whereas letting it escape `after()` would lose the job
 * outcome that the client is waiting on.
 */
async function persistCreditReading(): Promise<void> {
  const credits = lastObservedCredits()
  if (credits === null) return
  try {
    await recordCreditBalance(credits)
  } catch (e) {
    reportError(e, {
      surface: 'api-route',
      extra: { route: 'POST /api/pog-scan', stage: 'recordCreditBalance' },
    })
  }
}

async function runScan(address: Address): Promise<void> {
  try {
    // Page up to the live cap. A raised ceiling or a lowered rate both move the
    // point where more history stops mattering, and a scan that stopped at the
    // old one would hand back a total too small to earn the new quota.
    const history = await scanGasHistory(address, pogCapWei(await getPogBand()))
    await finishScanJob(address, {
      chains: history.chains.map(c => ({
        chain: c.chain,
        chainId: c.chainId,
        weiSpent: c.weiSpent.toString(),
        ethEquivalentWei: c.ethEquivalentWei.toString(),
        sentTxs: c.sentTxs,
        truncated: c.truncated,
        stoppedAtCap: c.stoppedAtCap,
        skipped: c.skipped,
        unavailable: c.unavailable,
        execFeeOnly: c.execFeeOnly,
      })),
      totalWei: history.totalWei.toString(),
      truncated: history.truncated,
      scannedAt: history.scannedAt,
    })
  } catch (e) {
    const unavailable = e instanceof GasScanUnavailable
    // A chain we could not read is an outage, not a small wallet, and the whole
    // reason the scan fails closed is that those two are indistinguishable
    // downstream. It has to be visible to us, not just to the user.
    reportError(e, {
      surface: 'api-route',
      extra: {
        route: 'POST /api/pog-scan',
        stage: unavailable ? `chain:${(e as GasScanUnavailable).chain}` : 'scan',
      },
    })
    try {
      await failScanJob(
        address,
        unavailable
          ? `Could not read ${(e as GasScanUnavailable).chain} right now. Try again.`
          : 'Gas scan failed. Try again.',
      )
    } catch (writeErr) {
      // The store is down too. Nothing more to do here — the lease is what
      // frees the client, and it will.
      reportError(writeErr, {
        surface: 'api-route',
        extra: { route: 'POST /api/pog-scan', stage: 'failScanJob' },
      })
    }
  } finally {
    await persistCreditReading()
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function OPTIONS(req: Request) {
  return corsPreflight(req, CORS_OPTS)
}

export async function GET(req: Request) {
  // Before the store is touched, not after: the first Upstash command is the
  // cost being bounded, so charging for it afterwards would leave the whole
  // budget spendable by requests that are refused.
  const limited = await applyRateLimit(req, GET_RATE_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const address = new URL(req.url).searchParams.get('address') ?? ''
  if (!isAddress(address)) return corsify(req, clientError('Invalid address'))

  let job: ScanJob | null
  try {
    job = await readScanJob(address)
  } catch (e) {
    reportError(e, {
      surface: 'api-route',
      extra: { route: 'GET /api/pog-scan', stage: 'readScanJob' },
    })
    return corsify(req, clientError('Scan store unavailable — try again', 503))
  }

  if (!job) {
    const band = await getPogBand()
    return corsify(req, NextResponse.json({
      status: 'absent',
      address: address.toLowerCase(),
      floorWei: band.floorWei.toString(),
      capWei: pogCapWei(band).toString(),
      maxAllocCeilingWei: band.maxAllocWei.toString(),
    }))
  }
  return corsify(req, NextResponse.json(await present(job)))
}

export async function POST(req: Request) {
  const limited = await applyRateLimit(req, RATE_LIMIT_OPTS)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const parsed = await readJsonBody<ScanRequestBody>(req)
  if (parsed.error) return applyCors(parsed.error, req, CORS_OPTS)
  const { userAddress, chainId, timestamp, signature, force } = parsed.data

  if (!userAddress || !isAddress(userAddress)) {
    return corsify(req, clientError('Invalid userAddress'))
  }
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    return corsify(req, clientError('Invalid chainId'))
  }
  if (!isSupportedPogChain(chainId)) {
    return corsify(req, clientError(`Unsupported chainId ${chainId}`))
  }
  if (force !== undefined && typeof force !== 'boolean') {
    return corsify(req, clientError('Invalid force'))
  }

  // Auth is optional. Present → verified (same gate as `sign-allocation`).
  // Absent → the rate-limit stack below is the whole admission control.
  const hasSig = typeof signature === 'string' && signature.startsWith('0x')
  const hasTs = typeof timestamp === 'number' && Number.isFinite(timestamp)
  if (hasSig !== hasTs) {
    return corsify(req, clientError('timestamp and signature must both be set, or both omitted'))
  }
  if (hasSig && hasTs) {
    if (Math.abs(Date.now() - timestamp!) >= POG_SESSION_AUTH_TTL_MS) {
      return corsify(req, clientError('Unauthorized — wallet auth window elapsed', 401))
    }
    const authMessage = buildPoGScanAuthMessage(userAddress, timestamp!)
    if (!authMessage.startsWith(POG_SCAN_AUTH_DOMAIN)) {
      return corsify(req, clientError('Server config error: auth domain prefix mismatch', 500))
    }
    let authOk = false
    try {
      authOk = await verifyMessage({
        address: userAddress as Address,
        message: authMessage,
        signature: signature as `0x${string}`,
      })
    } catch {
      authOk = false
    }
    if (!authOk) {
      return corsify(req, clientError('Unauthorized — auth signature does not recover to userAddress', 401))
    }
  }

  try {
    const existing = await readScanJob(userAddress)
    // A scan already in flight is joined rather than duplicated, `force` or not.
    // Two invocations reading five chains for one address would double the cost
    // and race to write the same key, and "refresh" cannot mean anything useful
    // about a read that has not finished yet.
    if (existing?.status === 'running') {
      return corsify(req, NextResponse.json(await present(existing)))
    }
    // Skipping this is the entire job of `force`.
    if (!force && existing && isFresh(existing)) {
      return corsify(req, NextResponse.json(await present(existing)))
    }

    // Everything from here on is about to cause real upstream calls, and is
    // therefore reached only after the two free paths above have been ruled out.

    // Unkeyed, api.blockscout.com answers 402 on every chain, so a scan started
    // now would burn a job slot, run five failing requests and tell the claimant
    // their gas history could not be read. Saying so here instead keeps a
    // configuration mistake from looking like an outage.
    if (!scanKeyPresent()) {
      reportError(new Error('BLOCKSCOUT_API_KEY is not configured; PoG scanning is offline'), {
        surface: 'api-route',
        extra: { route: 'POST /api/pog-scan', stage: 'scanKeyPresent' },
      })
      return corsify(req, clientError(
        'Gas scanning is not configured on this deployment.', 503,
      ))
    }

    // The credit budget, which is what this tier actually runs out of, and on
    // Builder it is a MONTHLY one. Checked before the request-count budgets
    // because it is the constraint that cannot be waited out at all — the others
    // refill on their own — and because a caller refused for it should not also
    // lose one of their six per-address attempts.
    //
    // A null reading means nothing recent is known, and that admits — see the
    // gauge's TTL note. An unknown budget must not read as an exhausted one, or
    // the first claimant after a quiet hour would be refused on no evidence.
    let credits: number | null = null
    try {
      credits = await readCreditBalance()
    } catch (e) {
      // A gauge we cannot read is not a reason to refuse; the request-count
      // ceilings below still bound the damage.
      reportError(e, {
        surface: 'api-route',
        extra: { route: 'POST /api/pog-scan', stage: 'readCreditBalance' },
      })
    }
    if (credits !== null && credits < CREDIT_RESERVE) {
      reportError(new Error('PoG scan credit budget near exhaustion'), {
        surface: 'api-route',
        extra: {
          route: 'POST /api/pog-scan',
          stage: 'creditReserve',
          credits,
          reserve: CREDIT_RESERVE,
        },
      })
      return corsify(req, budgetError(
        'Gas scanning has run out of its budget. This is not a short wait — '
        + 'the operator has been alerted.',
        503, CREDIT_EXHAUSTED_RETRY_MS,
      ))
    }

    // Charged here, not at the top of the handler, so that a cached read and a
    // joined in-flight scan are free: neither touches an upstream host, and
    // charging for them would let ordinary polling exhaust budgets whose whole
    // purpose is to bound upstream load.
    //
    // Global before per-address, which matters during an attack: if the global
    // ceiling is what refuses, no honest caller's own allowance is spent finding
    // that out. The reverse order would let a flood burn through every waiting
    // user's six refreshes and lock them out for the hour as well.
    const globalBudget = await consumeRateLimit(
      'pog-scan:global',
      GLOBAL_SCAN_LIMIT.capacity,
      GLOBAL_SCAN_LIMIT.windowMs,
    )
    if (!globalBudget.ok) {
      // Worth knowing about: at this ceiling it fires under abuse or under a load
      // we mis-sized for, and both are things to find out from an alert rather
      // than from users reporting they cannot claim. That is not hypothetical —
      // the previous ceiling was mis-sized, and it was users who reported it.
      reportError(new Error('PoG scan global hourly budget exhausted'), {
        surface: 'api-route',
        extra: {
          route: 'POST /api/pog-scan',
          stage: 'globalBudget',
          capacity: GLOBAL_SCAN_LIMIT.capacity,
          resetMs: globalBudget.resetMs,
          degraded: globalBudget.degraded,
        },
      })
      return corsify(req, budgetError(
        'Gas scanning is temporarily at capacity. Try again shortly.',
        503, globalBudget.resetMs,
      ))
    }

    const addressBudget = await consumeRateLimit(
      `pog-scan:addr:${userAddress.toLowerCase()}`,
      ADDRESS_SCAN_LIMIT.capacity,
      ADDRESS_SCAN_LIMIT.windowMs,
    )
    if (!addressBudget.ok) {
      return corsify(req, budgetError(
        'Too many scans for this address. Results are cached for a day — '
        + 'the existing one is still valid.',
        429, addressBudget.resetMs,
      ))
    }

    // A plain overwrite, which is all `force` ever needed. Deleting first — as
    // this did — meant a budget refusal below landed after the cached result was
    // already destroyed, turning "you have scanned enough for now, the old
    // answer still stands" into a lie and costing the user the answer they had.
    const job = await startScanJob(userAddress)
    // Scheduled, not awaited: the response goes out now and the client polls.
    after(() => runScan(userAddress as Address))
    return corsify(req, NextResponse.json(await present(job), { status: 202 }))
  } catch (e) {
    reportError(e, {
      surface: 'api-route',
      extra: { route: 'POST /api/pog-scan', stage: 'startScanJob' },
    })
    return corsify(req, clientError('Scan store unavailable — try again', 503))
  }
}
