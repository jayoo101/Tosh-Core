/**
 * apiGuard.ts  —  Production hardening primitives for Next.js Route Handlers
 * ───────────────────────────────────────────────────────────────────────────
 *  Pre-mainnet item #6 — now PM-F1 in `docs/PRE_MAINNET_CHECKLIST.md`, which is
 *  where the numbering is actually defined.  Provides three composable
 *  primitives that every public API route under `src/app/api/**` should adopt:
 *
 *    • `applyCors(res, req, opts)`   — closed-by-default CORS allow-list,
 *                                       echoes Vary, handles `OPTIONS` preflight.
 *    • `applyRateLimit(req, opts)`   — per-IP, async, backed by `rateLimitStore`.
 *    • `readJsonBody(req, max)`      — streaming bounded body reader, defends
 *                                       against JSON-bomb / oversized payloads.
 *
 *  Design notes
 *  ────────────
 *  • Rate-limit counters are no longer in this file.  They moved to
 *    `lib/rateLimitStore.ts`, which uses shared Redis when it is configured and
 *    per-process memory otherwise (PM-F5).  The one visible consequence here:
 *    `applyRateLimit` is `async`, because a shared store is a network call.
 *  • The allow-list comes from `ALLOWED_ORIGINS` env var (comma-separated).
 *    Falls back to the production sentinel `https://tosh.example` so a
 *    missing env var fails CLOSED (no `*` cowboy origin).
 *  • Routes compose the primitives directly; there is no wrapper to funnel
 *    through.  This file used to say "every route should funnel through
 *    `withApiHardening()`" and ship one, and not a single route used it — the
 *    per-method behaviour each route needs (different limits for GET and POST,
 *    a preflight naming only the methods that exist) does not fit one wrapper,
 *    so it was deleted rather than left as documentation of a lane nobody
 *    drives in.  The shape every route follows instead:
 *
 *      export async function OPTIONS(req) { return corsPreflight(req, CORS) }
 *      export async function POST(req) {
 *        const limited = await applyRateLimit(req, POST_LIMIT)
 *        if (limited) return applyCors(limited, req, CORS)
 *        ...
 *      }
 *
 *    One consequence to know: nothing catches a throw out of a handler, so an
 *    unhandled exception returns Next's bare 500 with no CORS headers on it.
 *    Routes therefore catch around anything that can throw — an RPC read, a
 *    Supabase call — and report it through `lib/observability`.
 *  • No third-party deps — ships in pure TypeScript so the bundle size
 *    and audit surface stay minimal.  The Redis backend talks REST over
 *    `fetch` for the same reason, and so it works in the edge runtime.
 */

import { NextResponse, type NextRequest } from 'next/server'

import { consumeRateLimit } from './rateLimitStore'

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
// RATE LIMITING (per-IP, pluggable backend — see lib/rateLimitStore.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface RateLimitOptions {
  /** Logical name — distinct routes get isolated counters. */
  name: string
  /** Bucket capacity (max burst). */
  capacity: number
  /** Refill rate in tokens per second. */
  refillPerSec: number
}

/**
 * The counters themselves live in `lib/rateLimitStore.ts`, which picks a shared
 * Redis backend when one is configured and an in-process one otherwise (PM-F5).
 *
 * `capacity` / `refillPerSec` are kept as the caller-facing knobs so no route
 * had to change when the backend became pluggable. The window the shared
 * backend counts over is the time to refill a full bucket, which preserves both
 * the burst size and the average rate; `rateLimitStore.ts` documents where fixed
 * -window and token-bucket semantics differ.
 */
function windowMsFor(opts: RateLimitOptions): number {
  return Math.max(1, Math.ceil((opts.capacity / opts.refillPerSec) * 1000))
}

/**
 * How many proxies sit between this app and the internet.
 *
 * `X-Forwarded-For` is a list that each hop APPENDS to, so the rightmost entry
 * is the address the nearest proxy actually observed and the leftmost is
 * whatever the original client claimed. With `n` trusted hops in front, the
 * real client is the `n`-th entry from the right.
 *
 * Default 1: exactly one trusted proxy (Vercel, Cloudflare, a single nginx),
 * which is the shape of every supported deployment. Set to 0 to ignore XFF
 * entirely when nothing trustworthy sits in front.
 */
const TRUSTED_PROXY_HOPS = (() => {
  const raw = Number.parseInt(process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS ?? '', 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : 1
})()

/**
 * Best-effort client IP, chosen so a client cannot pick its own rate-limit
 * bucket.
 *
 * THE BUG THIS REPLACES
 *
 * This used to return the LEFTMOST `X-Forwarded-For` entry. That entry is
 * supplied by the caller: proxies that append rather than overwrite — nginx
 * with `proxy_add_x_forwarded_for`, or any direct-to-Node deployment — leave
 * it fully attacker-controlled. Since the bucket id is
 * `${name}::${clientIp(req)}`, a fresh random value in that header meant a
 * fresh full bucket on every request, and the limit protecting
 * `/api/sign-allocation` — a key-signing endpoint, and the whole point of
 * PM-F5 — came off with one header.
 *
 * ORDER OF PREFERENCE
 *
 * 1. Platform headers the edge sets itself and strips from client input.
 *    These are the only unspoofable options, so they win when present.
 * 2. `X-Forwarded-For`, counted from the right by `TRUSTED_PROXY_HOPS`.
 * 3. `X-Real-IP` / `.ip`, only when no XFF exists at all.
 *
 * Falling back to a shared `'unknown'` bucket is deliberate: an unidentifiable
 * caller should share a bucket with every other unidentifiable caller rather
 * than get a private one.
 */
function clientIp(req: NextRequest | Request): string {
  const platform =
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-vercel-forwarded-for') ??
    req.headers.get('true-client-ip')
  if (platform) return platform.trim()

  const xff = req.headers.get('x-forwarded-for')
  if (xff && TRUSTED_PROXY_HOPS > 0) {
    const hops = xff.split(',').map(s => s.trim()).filter(Boolean)
    if (hops.length > 0) {
      // Clamp rather than wrap: fewer entries than configured hops means the
      // request did not traverse the expected chain, and the leftmost is then
      // the closest thing to an observed address we have.
      const idx = Math.max(0, hops.length - TRUSTED_PROXY_HOPS)
      return hops[idx]
    }
  }

  const real = req.headers.get('x-real-ip')
  if (real && TRUSTED_PROXY_HOPS > 0) return real.trim()

  // NextRequest exposes `.ip`; standard Request does not.
  const ip = (req as { ip?: string }).ip
  return ip ?? 'unknown'
}

/**
 * Returns null when the request is allowed, or a populated 429 response
 * when it's rate-limited.  Caller short-circuits with `if (rl) return rl`.
 *
 * Async since PM-F5: the shared backend is a network hop. Every call site must
 * `await`, and forgetting to is a type error rather than a limiter that quietly
 * never rejects.
 */
export async function applyRateLimit(
  req: NextRequest | Request,
  opts: RateLimitOptions
): Promise<NextResponse | null> {
  const result = await consumeRateLimit(
    `${opts.name}::${clientIp(req)}`,
    opts.capacity,
    windowMsFor(opts)
  )
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
  // Surfaces "this instance is counting alone" on the response itself, so a
  // degraded limiter is visible from a curl during an incident rather than only
  // in the error tracker.
  if (result.degraded) res.headers.set('X-RateLimit-Backend', 'degraded-memory')
  return res
}

// ─────────────────────────────────────────────────────────────────────────────
// BODY SIZE LIMIT
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BODY_BYTES = 32 * 1024 // 32 KiB — plenty for our JSON shapes

/**
 * Read the body, giving up as soon as it exceeds `maxBytes`.
 *
 * TWO BUGS THIS REPLACES
 *
 * 1. The cap did not bound memory. The old slow path was `await req.text()`,
 *    which buffers the ENTIRE body before anything is measured, so the 413 was
 *    issued after the damage. A request with `Transfer-Encoding: chunked` and
 *    no `Content-Length` skips the header check above and was fully
 *    materialized; Next's App Router imposes no body limit of its own on route
 *    handlers, so on a self-hosted deployment 32 KiB was a response-shaping
 *    rule and not a defence.
 *
 * 2. It counted the wrong unit. `String.length` is UTF-16 code units, so
 *    32,768 astral-plane characters is 128 KiB on the wire — the effective
 *    limit was up to 4x the documented one. Bytes off the stream cannot drift
 *    from what the socket actually carried.
 *
 * The stream is cancelled on breach rather than drained, so the sender is
 * disconnected instead of being allowed to finish uploading.
 */
async function readBodyCapped(
  req: NextRequest | Request,
  maxBytes: number,
): Promise<{ text: string } | { tooLarge: true } | { unreadable: true }> {
  const stream = req.body
  if (!stream) {
    // No stream to meter (some runtimes and test doubles). Measure the decoded
    // text in bytes — still correct, just without the memory bound.
    try {
      const text = await req.text()
      if (new TextEncoder().encode(text).length > maxBytes) return { tooLarge: true }
      return { text }
    } catch {
      return { unreadable: true }
    }
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { tooLarge: true }
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return { text }
  } catch {
    return { unreadable: true }
  }
}

/**
 * Reads and validates the request body as JSON, rejecting oversized bodies.
 * Returns the parsed value OR a populated error response.  Caller must check.
 */
export async function readJsonBody<T>(
  req: NextRequest | Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES
): Promise<{ data: T; error: null } | { data: null; error: NextResponse }> {
  const tooLarge = () => ({
    data: null as null,
    error: NextResponse.json(
      { error: `Body too large (max ${maxBytes} bytes)` },
      { status: 413 }
    ),
  })

  // Fast path: reject on the declared length before reading a single byte.
  // Advisory only — a client that omits or understates the header still gets
  // metered by `readBodyCapped`.
  const cl = req.headers.get('content-length')
  if (cl !== null) {
    const n = Number.parseInt(cl, 10)
    if (Number.isFinite(n) && n > maxBytes) return tooLarge()
  }

  const body = await readBodyCapped(req, maxBytes)
  if ('tooLarge' in body) return tooLarge()
  if ('unreadable' in body) {
    return {
      data: null,
      error: NextResponse.json({ error: 'Could not read body' }, { status: 400 }),
    }
  }
  const raw = body.text

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

