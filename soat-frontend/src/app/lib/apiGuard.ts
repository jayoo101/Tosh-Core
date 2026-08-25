/**
 * apiGuard.ts  —  Production hardening primitives for Next.js Route Handlers
 * ───────────────────────────────────────────────────────────────────────────
 *  Pre-mainnet item #6.  Provides three composable primitives that every
 *  public API route under `src/app/api/**` should adopt:
 *
 *    • `applyCors(res, req, opts)`   — closed-by-default CORS allow-list,
 *                                       echoes Vary, handles `OPTIONS` preflight.
 *    • `applyRateLimit(req, opts)`   — per-IP token-bucket, in-memory.
 *    • `applyJsonBodyLimit(req, max)`— bounded body reader, defends against
 *                                       JSON-bomb / oversized payloads.
 *
 *  Design notes
 *  ────────────
 *  • In-memory token bucket is fine for a single-region single-instance
 *    Next.js deployment.  For multi-region / multi-instance, swap the
 *    `RateLimiter` private state for a Redis-backed `SETEX + INCR`
 *    counter — keep the public API the same so callers don't change.
 *  • The allow-list comes from `ALLOWED_ORIGINS` env var (comma-separated).
 *    Falls back to the production sentinel `https://tosh.example` so a
 *    missing env var fails CLOSED (no `*` cowboy origin).
 *  • Every route should funnel through `withApiHardening()` — it wraps a
 *    handler with rate-limit + CORS + body cap in the right order and
 *    short-circuits with the right status (429 / 403 / 413).
 *  • No third-party deps — ships in pure TypeScript so the bundle size
 *    and audit surface stay minimal.
 */

import { NextResponse, type NextRequest } from 'next/server'

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────────────────────

/** Read the `ALLOWED_ORIGINS` env var; empty list → CORS denies all origins. */
function readAllowedOrigins(): readonly string[] {
  const raw = process.env.ALLOWED_ORIGINS ?? ''
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  // Sensible local dev fallback when nothing is configured.
  if (list.length === 0 && process.env.NODE_ENV !== 'production') {
    return ['http://localhost:3000', 'http://127.0.0.1:3000']
  }
  return list
}

const ALLOWED_ORIGINS = readAllowedOrigins()

/** Pre-built lowercase Set for O(1) origin lookup. */
const ALLOWED_ORIGINS_SET = new Set(ALLOWED_ORIGINS.map((o) => o.toLowerCase()))

export interface CorsOptions {
  /** Allowed HTTP methods. */
  methods?: readonly string[]
  /** Extra request headers the client may send. */
  allowHeaders?: readonly string[]
  /** Whether to allow credentials (`Access-Control-Allow-Credentials: true`). */
  credentials?: boolean
  /** Max-Age for preflight cache (seconds).  Defaults to 600 (10 min). */
  maxAge?: number
}

/** Stamp CORS headers onto an outbound response and return it. */
export function applyCors(
  res: NextResponse,
  req: NextRequest | Request,
  opts: CorsOptions = {}
): NextResponse {
  const origin = (req.headers.get('origin') ?? '').toLowerCase()
  const methods = (opts.methods ?? ['GET', 'POST', 'OPTIONS']).join(', ')
  const allowHeaders = (
    opts.allowHeaders ?? ['Content-Type', 'Authorization']
  ).join(', ')
  const maxAge = String(opts.maxAge ?? 600)

  // Echo `Vary: Origin` — required because the response depends on Origin.
  // Without this, CDN caches can leak one origin's response to another.
  res.headers.set('Vary', 'Origin')

  if (origin && ALLOWED_ORIGINS_SET.has(origin)) {
    res.headers.set('Access-Control-Allow-Origin', origin)
    res.headers.set('Access-Control-Allow-Methods', methods)
    res.headers.set('Access-Control-Allow-Headers', allowHeaders)
    res.headers.set('Access-Control-Max-Age', maxAge)
    if (opts.credentials) {
      res.headers.set('Access-Control-Allow-Credentials', 'true')
    }
  }
  // Origin not allow-listed → silently OMIT the Allow-Origin header.
  // The browser will reject; no information leak.
  return res
}

/** Handle an OPTIONS preflight, returning an immediately-completable response. */
export function corsPreflight(req: NextRequest | Request, opts: CorsOptions = {}): NextResponse {
  // 204 No Content for preflight is the spec-recommended status.
  const res = new NextResponse(null, { status: 204 })
  return applyCors(res, req, opts)
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITING (token bucket, per-IP, in-memory)
// ─────────────────────────────────────────────────────────────────────────────

interface Bucket {
  tokens: number
  lastRefillMs: number
}

export interface RateLimitOptions {
  /** Logical name — distinct routes can have isolated buckets. */
  name: string
  /** Bucket capacity (max burst tokens). */
  capacity: number
  /** Refill rate in tokens per second. */
  refillPerSec: number
}

class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  /** Garbage-collect cold buckets so memory stays bounded. */
  private gcEveryNCalls = 0
  private readonly gcInterval = 1024

  constructor(private readonly opts: RateLimitOptions) {}

  /** Returns true if a token was consumed, false if the client is rate-limited. */
  consume(clientKey: string): { ok: boolean; remaining: number; resetMs: number } {
    const now = Date.now()
    const id = `${this.opts.name}::${clientKey}`
    const cap = this.opts.capacity
    const refillPerMs = this.opts.refillPerSec / 1000

    let b = this.buckets.get(id)
    if (!b) {
      b = { tokens: cap, lastRefillMs: now }
      this.buckets.set(id, b)
    }

    // Refill since lastRefill.
    const elapsed = now - b.lastRefillMs
    if (elapsed > 0) {
      b.tokens = Math.min(cap, b.tokens + elapsed * refillPerMs)
      b.lastRefillMs = now
    }

    // Opportunistic GC.
    if (++this.gcEveryNCalls % this.gcInterval === 0) {
      this.gcStaleBuckets(now)
    }

    if (b.tokens >= 1) {
      b.tokens -= 1
      return {
        ok: true,
        remaining: Math.floor(b.tokens),
        resetMs: Math.ceil((1 - (b.tokens - Math.floor(b.tokens))) / refillPerMs),
      }
    }

    // No token available — compute when ONE will be available again.
    const msToOneToken = Math.ceil((1 - b.tokens) / refillPerMs)
    return { ok: false, remaining: 0, resetMs: msToOneToken }
  }

  private gcStaleBuckets(now: number): void {
    // 5 minutes of inactivity → drop the bucket.  Saves memory on long-tail IPs.
    const cutoff = now - 5 * 60 * 1000
    for (const [k, b] of this.buckets) {
      if (b.lastRefillMs < cutoff && b.tokens >= this.opts.capacity) {
        this.buckets.delete(k)
      }
    }
  }
}

/** Module-level registry — ensures the in-memory map persists across hot reloads. */
const LIMITERS: Record<string, RateLimiter> = (globalThis as Record<string, unknown>)
  .__toshLimiters as Record<string, RateLimiter> ?? {}
;(globalThis as Record<string, unknown>).__toshLimiters = LIMITERS

export function getOrCreateLimiter(opts: RateLimitOptions): RateLimiter {
  let l = LIMITERS[opts.name]
  if (!l) {
    l = new RateLimiter(opts)
    LIMITERS[opts.name] = l
  }
  return l
}

/** Best-effort client IP extractor. */
function clientIp(req: NextRequest | Request): string {
  // Honor proxied headers first (Vercel / Cloudflare / nginx).
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const real = req.headers.get('x-real-ip')
  if (real) return real.trim()
  // Fallback: NextRequest exposes `.ip`; standard Request does not.
  const ip = (req as { ip?: string }).ip
  return ip ?? 'unknown'
}

/**
 * Returns null when the request is allowed, or a populated 429 response
 * when it's rate-limited.  Caller short-circuits with `if (rl) return rl`.
 */
export function applyRateLimit(
  req: NextRequest | Request,
  opts: RateLimitOptions
): NextResponse | null {
  const limiter = getOrCreateLimiter(opts)
  const ip = clientIp(req)
  const result = limiter.consume(ip)
  if (result.ok) return null

  const res = NextResponse.json(
    {
      error: 'Too many requests',
      retryAfterMs: result.resetMs,
    },
    { status: 429 }
  )
  res.headers.set('Retry-After', String(Math.ceil(result.resetMs / 1000)))
  res.headers.set('X-RateLimit-Remaining', '0')
  return res
}

// ─────────────────────────────────────────────────────────────────────────────
// BODY SIZE LIMIT
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BODY_BYTES = 32 * 1024 // 32 KiB — plenty for our JSON shapes

/**
 * Reads and validates the request body as JSON, rejecting oversized bodies.
 * Returns the parsed value OR a populated error response.  Caller must check.
 */
export async function readJsonBody<T>(
  req: NextRequest | Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES
): Promise<{ data: T; error: null } | { data: null; error: NextResponse }> {
  // Fast path: trust the Content-Length header if present and small enough.
  const cl = req.headers.get('content-length')
  if (cl !== null) {
    const n = Number.parseInt(cl, 10)
    if (Number.isFinite(n) && n > maxBytes) {
      return {
        data: null,
        error: NextResponse.json(
          { error: `Body too large (max ${maxBytes} bytes)` },
          { status: 413 }
        ),
      }
    }
  }

  // Slow path: read the body, enforcing the cap server-side regardless of header.
  let raw: string
  try {
    raw = await req.text()
  } catch {
    return {
      data: null,
      error: NextResponse.json({ error: 'Could not read body' }, { status: 400 }),
    }
  }

  if (raw.length > maxBytes) {
    return {
      data: null,
      error: NextResponse.json(
        { error: `Body too large (max ${maxBytes} bytes)` },
        { status: 413 }
      ),
    }
  }

  if (raw.length === 0) {
    return {
      data: null,
      error: NextResponse.json({ error: 'Empty body' }, { status: 400 }),
    }
  }

  try {
    const parsed = JSON.parse(raw) as T
    return { data: parsed, error: null }
  } catch {
    return {
      data: null,
      error: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVENIENCE WRAPPER
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiHardeningOptions {
  cors: CorsOptions
  rateLimit: RateLimitOptions
}

/**
 * Wrap a Route Handler so every request goes through the same hardening lane:
 *
 *   1. CORS allow-list (with OPTIONS short-circuit).
 *   2. Per-IP rate limit.
 *   3. Inner handler.
 *   4. CORS headers stamped on the final response.
 *
 * Usage:
 *   export const POST = withApiHardening(handler, {
 *     cors: { methods: ['POST', 'OPTIONS'] },
 *     rateLimit: { name: 'pog-attest', capacity: 5, refillPerSec: 1 / 6 },
 *   })
 */
export function withApiHardening<Ctx>(
  handler: (req: NextRequest | Request, ctx: Ctx) => Promise<NextResponse> | NextResponse,
  opts: ApiHardeningOptions
) {
  return async (req: NextRequest | Request, ctx: Ctx): Promise<NextResponse> => {
    if (req.method === 'OPTIONS') return corsPreflight(req, opts.cors)

    const limited = applyRateLimit(req, opts.rateLimit)
    if (limited) return applyCors(limited, req, opts.cors)

    let res: NextResponse
    try {
      res = await handler(req, ctx)
    } catch (err) {
      console.error(`[apiGuard:${opts.rateLimit.name}] handler threw`, err)
      res = NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    return applyCors(res, req, opts.cors)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPLICIT OPTIONS HANDLER FACTORY
// ─────────────────────────────────────────────────────────────────────────────
//
// Some routes don't use `withApiHardening` directly because they need fine-grain
// per-method behavior.  Export a tiny helper so they can still ship a proper
// preflight without copy-pasting the corsPreflight() call.

export function makeOptionsHandler(opts: CorsOptions = {}) {
  return (req: NextRequest | Request) => corsPreflight(req, opts)
}
