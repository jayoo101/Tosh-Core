/**
 * scanJobStore.ts — where a Proof-of-Gas scan's state lives between requests.
 * ───────────────────────────────────────────────────────────────────────────
 * PM-F9. A scan reads five chains and measured 10–23 s against live hosts, so it
 * cannot happen inside the request that signs an attestation. It runs as a job:
 * one request starts it, later requests read its state, and `sign-allocation`
 * refuses to sign until a finished one exists.
 *
 * Backend selection copies `rateLimitStore.ts` exactly — Upstash REST when both
 * env vars are set, in-process otherwise — and for the same reasons, including
 * that REST over `fetch` needs no dependency and works where a socket client
 * does not. What differs is the consequence of losing the store: a dropped rate
 * limit degrades a defence, whereas a dropped scan job only costs the user a
 * re-scan. So this one has no circuit breaker and no silent fallback; if the
 * shared store is unreachable the error surfaces and the client retries, which
 * is exactly the button the product already has.
 *
 * WHY A LEASE, AND NOT JUST A STATUS
 *
 * `after()` runs the scan, and per Next's own docs it "will run for the
 * platform's default or configured max duration of your route" — it is not an
 * unbounded background worker. A scan that overruns `maxDuration` is killed
 * mid-flight with no chance to write a failure, which would leave `running` in
 * the store forever and a spinner on screen forever.
 *
 * So `running` is a lease, not a state: a job whose `startedAt` is older than
 * `JOB_LEASE_MS` is reported as `failed` by `readScanJob`, whatever the stored
 * status says. Nothing has to clean up, and a killed invocation self-heals into
 * a retryable error.
 */

// ─── Shape ───────────────────────────────────────────────────────────────────

export type ScanJobStatus = 'running' | 'done' | 'failed'

/** Per-chain figures, wei as decimal strings because this round-trips JSON. */
export interface StoredChainSpend {
  chain: string
  chainId: number
  weiSpent: string
  /** `weiSpent` in ETH, which is the only figure that may be summed or shown
   *  beside the total. Stored rather than converted on read so a row and the
   *  total it belongs to are always the same scan's arithmetic, even if the
   *  pinned rate moves while this result is still inside its TTL.
   *
   *  Optional for the reason `unavailable` is: results written before chain 56
   *  joined carry only `weiSpent`, and a cached job must stay readable. The
   *  route converts those on read. */
  ethEquivalentWei?: string
  sentTxs: number
  truncated: boolean
  stoppedAtCap: boolean
  skipped: boolean
  /** Read failed on an optional chain, so its figure is unknown and counted as
   *  zero. Optional in the stored shape because results written before the
   *  per-chain failure policy existed do not carry it, and a cached job must not
   *  become unreadable because a field was added. */
  unavailable?: boolean
  execFeeOnly: boolean
}

export interface ScanJob {
  status: ScanJobStatus
  /** Lower-cased. The key is derived from this, never from raw caller input. */
  address: string
  /** Unix ms the job was started. Also the lease clock — see the header. */
  startedAt: number
  /** Unix ms the scan finished, present on `done`. */
  finishedAt?: number
  /** Present on `done`. */
  result?: {
    chains: StoredChainSpend[]
    totalWei: string
    truncated: boolean
    scannedAt: number
  }
  /** Present on `failed`. Safe to show a user; never carries a stack. */
  error?: string
}

// ─── Budgets ─────────────────────────────────────────────────────────────────

/**
 * How long a `running` job is believed before it is treated as dead.
 *
 * Must exceed the worst honest scan and stay under any sane `maxDuration`, so
 * that a job which really is still working is not declared dead while a job
 * killed by the platform is. Measured worst case through a local proxy was 23 s;
 * 120 s is generous for a slow day and still bounded.
 */
export const JOB_LEASE_MS = 120_000

/**
 * How long a finished scan is served without re-reading every chain.
 *
 * Gas history only grows, and the figure feeds a floor-and-cap decision rather
 * than a price, so a stale answer is not a wrong one. The refresh button exists
 * precisely so nobody has to wait this out.
 *
 * A day, not the hour this was, and the hour was not a judgement about staleness
 * — the docblock above argued freshness barely matters and then picked the short
 * window anyway. What forced the correction is cost. A scan is 5-25 upstream
 * calls at ~20 credits against 100,000 a day, so the ceiling is a few hundred
 * scans a day for the whole product; at a one-hour TTL a wallet that visits
 * across a session paid for itself repeatedly, and production ran the budget
 * dry, answering `503 at capacity` to everyone and taking the raise funnel with
 * it. Twenty-four hours is the longest window that still lets a claimant who
 * tops up gas qualify the same day, which is the only case the short TTL served.
 */
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000

/** Redis TTL. Comfortably past `RESULT_TTL_MS` so expiry is this module's
 *  decision rather than Redis's, which keeps the two from disagreeing about
 *  whether a result exists. */
const REDIS_TTL_SEC = Math.ceil((RESULT_TTL_MS * 2) / 1000)

// ─── Backend ─────────────────────────────────────────────────────────────────

interface JobBackend {
  readonly kind: 'memory' | 'redis'
  get(key: string): Promise<ScanJob | null>
  set(key: string, job: ScanJob): Promise<void>
  del(key: string): Promise<void>
  /** A small opaque scalar with its own TTL, for shared state that is not a job.
   *  The only user is the credit gauge below; it lives here rather than in a
   *  third store module because it needs exactly this backend selection and
   *  nothing else. */
  getScalar(key: string): Promise<string | null>
  setScalar(key: string, value: string, ttlSec: number): Promise<void>
}

class MemoryJobBackend implements JobBackend {
  readonly kind = 'memory' as const
  private readonly jobs = new Map<string, { job: ScanJob; expiresAt: number }>()

  async get(key: string): Promise<ScanJob | null> {
    const e = this.jobs.get(key)
    if (!e) return null
    if (Date.now() > e.expiresAt) { this.jobs.delete(key); return null }
    return e.job
  }

  async set(key: string, job: ScanJob): Promise<void> {
    this.jobs.set(key, { job, expiresAt: Date.now() + REDIS_TTL_SEC * 1000 })
    // Bounded without a timer: any write is a chance to drop what has expired.
    if (this.jobs.size > 512) {
      const now = Date.now()
      for (const [k, v] of this.jobs) if (now > v.expiresAt) this.jobs.delete(k)
    }
  }

  async del(key: string): Promise<void> {
    this.jobs.delete(key)
  }

  private readonly scalars = new Map<string, { value: string; expiresAt: number }>()

  async getScalar(key: string): Promise<string | null> {
    const e = this.scalars.get(key)
    if (!e) return null
    if (Date.now() > e.expiresAt) { this.scalars.delete(key); return null }
    return e.value
  }

  async setScalar(key: string, value: string, ttlSec: number): Promise<void> {
    this.scalars.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 })
  }
}

class UpstashJobBackend implements JobBackend {
  readonly kind = 'redis' as const

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async command(args: (string | number)[]): Promise<unknown> {
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([args.map(String)]),
      cache: 'no-store',
    })
    if (!res.ok) {
      throw new Error(`upstash ${args[0]} failed: ${res.status} ${res.statusText}`)
    }
    const body = (await res.json()) as Array<{ result?: unknown; error?: string }>
    const first = body?.[0]
    if (first?.error) throw new Error(`upstash ${args[0]} errored: ${first.error}`)
    return first?.result ?? null
  }

  async get(key: string): Promise<ScanJob | null> {
    const raw = await this.command(['GET', key])
    if (typeof raw !== 'string' || raw.length === 0) return null
    try {
      return JSON.parse(raw) as ScanJob
    } catch {
      // A value we cannot parse is treated as absent rather than thrown. The
      // only ways to get one are a format change or corruption, and in both
      // cases re-scanning is right and failing the request is not.
      return null
    }
  }

  async set(key: string, job: ScanJob): Promise<void> {
    await this.command(['SET', key, JSON.stringify(job), 'EX', REDIS_TTL_SEC])
  }

  async del(key: string): Promise<void> {
    await this.command(['DEL', key])
  }

  async getScalar(key: string): Promise<string | null> {
    const raw = await this.command(['GET', key])
    return typeof raw === 'string' && raw.length > 0 ? raw : null
  }

  async setScalar(key: string, value: string, ttlSec: number): Promise<void> {
    await this.command(['SET', key, value, 'EX', ttlSec])
  }
}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? ''
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? ''

/** Module-level so the in-memory map survives a dev hot reload, matching what
 *  `rateLimitStore.ts` does with `__toshRlMemory`. */
const g = globalThis as Record<string, unknown>
const memory: MemoryJobBackend =
  (g.__toshScanJobMemory as MemoryJobBackend) ?? new MemoryJobBackend()
g.__toshScanJobMemory = memory

const backend: JobBackend =
  UPSTASH_URL && UPSTASH_TOKEN ? new UpstashJobBackend(UPSTASH_URL, UPSTASH_TOKEN) : memory

export function scanJobBackendKind(): 'memory' | 'redis' {
  return backend.kind
}

// ─── API ─────────────────────────────────────────────────────────────────────

function keyFor(address: string): string {
  return `tosh:pogscan:${address.toLowerCase()}`
}

/**
 * Read a job, applying the lease.
 *
 * A `running` job past `JOB_LEASE_MS` comes back as `failed`, because the only
 * way to be in that state is an invocation that was killed before it could say
 * so. Returning it as `running` would spin a client forever.
 */
export async function readScanJob(address: string): Promise<ScanJob | null> {
  const job = await backend.get(keyFor(address))
  if (!job) return null

  if (job.status === 'running' && Date.now() - job.startedAt > JOB_LEASE_MS) {
    return {
      ...job,
      status: 'failed',
      error: 'Scan did not finish in time. Try again.',
    }
  }
  return job
}

/** True when a finished scan is still inside `RESULT_TTL_MS`. */
export function isFresh(job: ScanJob, now: number = Date.now()): boolean {
  return job.status === 'done'
    && typeof job.finishedAt === 'number'
    && now - job.finishedAt < RESULT_TTL_MS
}

export async function startScanJob(address: string): Promise<ScanJob> {
  const job: ScanJob = {
    status: 'running',
    address: address.toLowerCase(),
    startedAt: Date.now(),
  }
  await backend.set(keyFor(address), job)
  return job
}

export async function finishScanJob(
  address: string,
  result: NonNullable<ScanJob['result']>,
): Promise<void> {
  await backend.set(keyFor(address), {
    status: 'done',
    address: address.toLowerCase(),
    // `startedAt` is deliberately re-stamped rather than preserved: nothing
    // reads it once the job is `done`, and re-reading the old job first would
    // add a round trip to the hot path for a field with no consumer.
    startedAt: Date.now(),
    finishedAt: Date.now(),
    result,
  })
}

export async function failScanJob(address: string, error: string): Promise<void> {
  await backend.set(keyFor(address), {
    status: 'failed',
    address: address.toLowerCase(),
    startedAt: Date.now(),
    finishedAt: Date.now(),
    error,
  })
}

/** Drop any stored job. Backs the refresh button. */
export async function clearScanJob(address: string): Promise<void> {
  await backend.del(keyFor(address))
}

// ─── The credit gauge ────────────────────────────────────────────────────────

/**
 * How many PRO API credits the key had left, as last seen by a scan.
 *
 * The tier this deployment is on is bounded by credits, not by requests per
 * second: 100,000,000 a MONTH on Builder, at roughly 20 credits a call. A
 * request-count ceiling cannot bound that on its own, because a scan costs
 * between five calls (a one-page wallet) and twenty-five (a heavy sender on every
 * chain) — a factor of five, decided by whoever happens to show up. So the actual
 * balance is read off `x-credits-remaining` during a scan and left here for the
 * next request to admit or refuse against.
 *
 * WHY THIS EXPIRES, WHICH IS THE WHOLE DESIGN
 *
 * The reading is only ever a floor: between resets the balance falls, so an old
 * value is pessimistic. That is safe during traffic — every scan refreshes it —
 * and unsafe across a reset, where an exhausted reading from before it would
 * refuse every claimant on a budget that had just been refilled. A short TTL
 * makes silence expire into "unknown", and unknown admits. Under real traffic
 * the value is never more than a scan old; after an hour of quiet, nothing has
 * been draining the budget anyway.
 *
 * The reset used to be nightly and is now monthly, which does not change this
 * design but does change what it is worth. A stale-exhausted reading used to
 * cost at most the hours until midnight; now it could cost the rest of a month,
 * so expiring into "unknown" is load-bearing rather than tidy. What moved in the
 * other direction is `CREDIT_RESERVE`, which had to stop being a last-gasp floor
 * for the same reason — see its own note.
 */
const CREDIT_GAUGE_TTL_SEC = 60 * 60

const CREDIT_GAUGE_KEY = 'tosh:pogscan:credits'

export async function recordCreditBalance(credits: number): Promise<void> {
  if (!Number.isFinite(credits) || credits < 0) return
  await backend.setScalar(CREDIT_GAUGE_KEY, String(Math.floor(credits)), CREDIT_GAUGE_TTL_SEC)
}

/** Null when nothing recent is known, which callers must treat as "proceed" —
 *  see the TTL note above. Never conflate it with zero. */
export async function readCreditBalance(): Promise<number | null> {
  const raw = await backend.getScalar(CREDIT_GAUGE_KEY)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}
