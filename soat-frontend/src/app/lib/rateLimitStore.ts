/**
 * rateLimitStore.ts — the counter behind `applyRateLimit`.
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  `apiGuard.ts` shipped with an in-process token bucket and a note saying to
 *  swap it for Redis before multi-instance deployment. This is that swap, done
 *  as a pluggable backend rather than a replacement, because the in-memory path
 *  is still the right one for local dev, for CI, and as the failure mode when
 *  the shared store is unreachable.
 *
 *  Why the in-memory limiter is not enough in production
 *  ────────────────────────────────────────────────────
 *  Counters live in one process, so N instances multiply every quota by N, and
 *  a rolling deploy resets all of them. On a platform that scales per request
 *  this is close to having no rate limit at all: each request can land on a
 *  cold instance with a full bucket. Nothing errors — the limiter reports
 *  healthy and enforces almost nothing.
 *
 *  Backend selection
 *  ─────────────────
 *  Upstash Redis REST when `UPSTASH_REDIS_REST_URL` and
 *  `UPSTASH_REDIS_REST_TOKEN` are both set; in-memory otherwise. REST over
 *  `fetch` rather than a TCP client is deliberate: it needs no dependency, and
 *  it works in the edge runtime, where a socket-based client does not.
 *
 *  Absent config → in-memory, silently and by design. Same principle as the
 *  Sentry DSN in `lib/observability.ts`: a missing env var must not
 *  half-enable something.
 */

import { reportError } from '@/lib/observability'

export interface RateLimitDecision {
  ok: boolean
  /** Requests left in the current window. */
  remaining: number
  /** Milliseconds until the caller may retry. */
  resetMs: number
}

export interface RateLimitBackend {
  readonly kind: 'memory' | 'redis'
  /**
   * @param id       Already-namespaced key (`route::client`).
   * @param capacity Max requests per window.
   * @param windowMs Window length.
   */
  consume(id: string, capacity: number, windowMs: number): Promise<RateLimitDecision>
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory backend
// ─────────────────────────────────────────────────────────────────────────────

interface Bucket {
  tokens: number
  lastRefillMs: number
}

/**
 * Token bucket, per process. Lifted from the original `RateLimiter` in
 * `apiGuard.ts` so both backends sit behind one interface.
 */
class MemoryBackend implements RateLimitBackend {
  readonly kind = 'memory' as const

  private readonly buckets = new Map<string, Bucket>()
  private calls = 0
  private readonly gcInterval = 1024

  async consume(id: string, capacity: number, windowMs: number): Promise<RateLimitDecision> {
    const now = Date.now()
    const refillPerMs = capacity / windowMs

    let b = this.buckets.get(id)
    if (!b) {
      b = { tokens: capacity, lastRefillMs: now }
      this.buckets.set(id, b)
    }

    const elapsed = now - b.lastRefillMs
    if (elapsed > 0) {
      b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerMs)
      b.lastRefillMs = now
    }

    if (++this.calls % this.gcInterval === 0) this.gc(now, capacity)

    if (b.tokens >= 1) {
      b.tokens -= 1
      return {
        ok: true,
        remaining: Math.floor(b.tokens),
        resetMs: Math.ceil((1 - (b.tokens - Math.floor(b.tokens))) / refillPerMs),
      }
    }

    return { ok: false, remaining: 0, resetMs: Math.ceil((1 - b.tokens) / refillPerMs) }
  }

  /** Drop buckets idle for 5 minutes so memory stays bounded on long-tail IPs. */
  private gc(now: number, capacity: number): void {
    const cutoff = now - 5 * 60 * 1000
    for (const [k, b] of this.buckets) {
      if (b.lastRefillMs < cutoff && b.tokens >= capacity) this.buckets.delete(k)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstash Redis REST backend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fixed-window counter: `INCR` a key that carries the window index, then set a
 * TTL so it cannot leak.
 *
 * Fixed window rather than a distributed token bucket on purpose. An exact
 * shared token bucket needs `EVAL` and a Lua script to stay atomic; a fixed
 * window is two pipelined commands with no server-side script to keep in sync
 * with this file. The cost is the well-known edge case: a client can send
 * `capacity` requests at the very end of one window and `capacity` more at the
 * start of the next, so the worst-case short burst is 2x what the token bucket
 * would have allowed. For the traffic this protects — a signing endpoint and
 * two CRUD routes — that is an acceptable trade against running a Lua script
 * nobody will remember to review.
 */
class UpstashBackend implements RateLimitBackend {
  readonly kind = 'redis' as const

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async consume(id: string, capacity: number, windowMs: number): Promise<RateLimitDecision> {
    const now = Date.now()
    const windowIndex = Math.floor(now / windowMs)
    const key = `tosh:rl:${id}:${windowIndex}`
    const resetMs = (windowIndex + 1) * windowMs - now

    // The key already carries the window index, so a new window is a new key.
    // That makes an unconditional PEXPIRE safe: the worst case is the previous
    // window's key outliving its usefulness slightly, never a window that keeps
    // extending itself while a client keeps hitting it.
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', key],
        ['PEXPIRE', key, String(windowMs)],
      ]),
      cache: 'no-store',
    })

    if (!res.ok) {
      throw new Error(`upstash pipeline failed: ${res.status} ${res.statusText}`)
    }

    const body = (await res.json()) as Array<{ result?: number; error?: string }>
    const incr = body?.[0]
    if (!incr || typeof incr.result !== 'number') {
      throw new Error(`upstash INCR returned no result: ${JSON.stringify(body?.[0] ?? null)}`)
    }

    const count = incr.result
    return {
      ok: count <= capacity,
      remaining: Math.max(0, capacity - count),
      resetMs,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection + degradation
// ─────────────────────────────────────────────────────────────────────────────

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? ''
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? ''

/**
 * Module-level so the in-memory map survives hot reloads in dev, matching what
 * `apiGuard` did with `globalThis.__toshLimiters`.
 */
const g = globalThis as Record<string, unknown>

const memory: MemoryBackend = (g.__toshRlMemory as MemoryBackend) ?? new MemoryBackend()
g.__toshRlMemory = memory

const shared: RateLimitBackend | null =
  UPSTASH_URL && UPSTASH_TOKEN ? new UpstashBackend(UPSTASH_URL, UPSTASH_TOKEN) : null

export function rateLimitBackendKind(): 'memory' | 'redis' {
  return shared ? shared.kind : memory.kind
}

/**
 * How long to stop calling the shared store after it fails, so one outage does
 * not add a failed network round-trip to every single request.
 */
const BREAKER_COOLDOWN_MS = 30_000
let breakerOpenUntil = 0

/**
 * Consume one unit of quota.
 *
 * **Degradation policy.** If the shared store errors, this falls back to the
 * in-process limiter for the current request and reports the failure once per
 * cooldown window.
 *
 * The two obvious alternatives are both worse. Failing *closed* turns a Redis
 * blip into a total API outage — the limiter becomes a bigger availability risk
 * than the abuse it prevents. Failing *open* (allowing everything) removes the
 * protection precisely when infrastructure is already unhealthy, which is when
 * a signing endpoint most wants a ceiling. Degrading to per-instance limits
 * keeps a real, if looser, bound and recovers by itself.
 */
export async function consumeRateLimit(
  id: string,
  capacity: number,
  windowMs: number,
): Promise<RateLimitDecision & { degraded: boolean }> {
  if (!shared || Date.now() < breakerOpenUntil) {
    const d = await memory.consume(id, capacity, windowMs)
    return { ...d, degraded: Boolean(shared) }
  }

  try {
    const d = await shared.consume(id, capacity, windowMs)
    return { ...d, degraded: false }
  } catch (err) {
    const firstFailure = breakerOpenUntil === 0 || Date.now() > breakerOpenUntil
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS

    if (firstFailure) {
      // Worth an alert: the platform is silently running on per-instance
      // limits, which is the state PM-F5 exists to get out of. Reported once
      // per cooldown rather than per request so an outage does not become its
      // own incident in the error tracker.
      reportError(err, {
        surface: 'api-route',
        extra: { route: 'rate-limit-store', stage: 'shared-backend', backend: 'upstash' },
      })
    }

    const d = await memory.consume(id, capacity, windowMs)
    return { ...d, degraded: true }
  }
}
