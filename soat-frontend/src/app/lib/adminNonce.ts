/**
 * adminNonce.ts — the replay guard for owner-signed admin instructions.
 *
 * ── What was wrong with the `let` ───────────────────────────────────────────
 *
 * `api/admin/config/route.ts` held `let lastSeenNonce = 0n` at module scope,
 * annotated "resets on server restart". Both halves of that are the bug:
 *
 *  • Per instance. On more than one serverless instance, each keeps its own
 *    counter, so a payload already spent on instance A is unseen on instance B
 *    and replays there. This is the same class of fault `pogParams.ts` was
 *    extracted to fix, in the same route, one variable over.
 *
 *  • Resets to zero. After any restart — a deploy, a cold start, a scale event —
 *    every previously-signed payload becomes acceptable again, because every
 *    nonce is greater than zero.
 *
 * With the counter reset to zero the only thing left refusing an old captured
 * payload was `expiresAt`, which is why the window had to stay short, and a
 * short window is exactly what made the Safe path unsatisfiable. So this file is
 * what buys the long window in `SIGNATURE_WINDOW_SEC.contract`: replay is
 * refused because the nonce is genuinely monotonic across instances and across
 * restarts, not because the instruction goes stale quickly.
 *
 * The threat it closes is a downgrade, not a forgery: an attacker cannot mint a
 * signature, but a signed "set the rate to 0.05" observed once is a valid
 * instruction forever unless something remembers it was already used. Replaying
 * it reverts a later, deliberate rotation — silently, since the response to the
 * replay is a success.
 *
 * BACKEND SELECTION — mirrors `pogParams.ts` and `rateLimitStore.ts`:
 * Upstash when both env vars are present, in-process otherwise. Unlike those
 * two, degrading to in-process here weakens a security property rather than a
 * consistency one, so `adminNonceBackendKind()` is consulted by the route when
 * it picks the signature window instead of being reported for information only.
 */

import { reportError } from '@/lib/observability'

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? ''
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? ''
const SHARED = Boolean(UPSTASH_URL && UPSTASH_TOKEN)
const KEY = 'tosh:admin:lastSeenNonce'

/** Module-level so the value survives hot reloads in dev, as the sibling stores do. */
const g = globalThis as Record<string, unknown>
if (typeof g.__toshAdminNonce !== 'bigint') g.__toshAdminNonce = 0n

/**
 * Accept `candidate` only if it is strictly greater than what we have seen, and
 * record it in the same step.
 *
 * Atomic on purpose. The read-then-write version of this has a window in which
 * two concurrent requests both read the old value and both accept — which for a
 * replay guard means the guard is absent precisely when someone is hammering
 * it. Redis runs the script single-threaded, so the compare and the write cannot
 * be interleaved.
 */
const CLAIM_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`.trim()

async function upstash(command: readonly string[]): Promise<unknown> {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`upstash ${command[0]} failed: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as { result?: unknown; error?: string }
  if (body.error) throw new Error(`upstash ${command[0]}: ${body.error}`)
  return body.result
}

/**
 * The largest nonce this guard can hold.
 *
 * The Lua comparison above goes through `tonumber`, which is a double, so a
 * nonce past 2^53 would compare equal to its neighbours and stop being
 * monotonic. Rather than let that degrade quietly, the route rejects anything
 * above this. `Date.now()` — what both the admin panel and the CLI use — is
 * around 1.7e12, so the usable range is roughly four thousand times the current
 * clock and this bound will not be met by an honest caller.
 */
export const MAX_ADMIN_NONCE = BigInt(Number.MAX_SAFE_INTEGER)

/** Distinguishes "already used" from "could not tell", which must not be conflated. */
export type NonceVerdict = 'claimed' | 'replayed' | 'unavailable'

/**
 * Claim `candidate`, refusing anything not strictly greater than the last one.
 *
 * Returns `unavailable` rather than throwing, and the route turns that into a
 * 503. Failing open would make a store outage into a replay window; failing
 * closed with a 403 would send an owner to inspect a wallet that is fine. Same
 * three-way split as `SignatureVerdict` in the route, for the same reason.
 */
export async function claimAdminNonce(candidate: bigint): Promise<NonceVerdict> {
  if (!SHARED) {
    if (candidate <= (g.__toshAdminNonce as bigint)) return 'replayed'
    g.__toshAdminNonce = candidate
    return 'claimed'
  }
  try {
    const result = await upstash(['EVAL', CLAIM_SCRIPT, '1', KEY, candidate.toString()])
    const accepted = Number(result) === 1
    if (accepted) g.__toshAdminNonce = candidate
    return accepted ? 'claimed' : 'replayed'
  } catch (e) {
    reportError(e, { surface: 'api-route', extra: { store: 'adminNonce', op: 'claim' } })
    return 'unavailable'
  }
}

/** The last nonce this instance knows about, for `GET /api/admin/config`. */
export async function lastSeenAdminNonce(): Promise<bigint> {
  if (!SHARED) return g.__toshAdminNonce as bigint
  try {
    const raw = await upstash(['GET', KEY])
    if (typeof raw !== 'string') return g.__toshAdminNonce as bigint
    const parsed = BigInt(raw)
    g.__toshAdminNonce = parsed
    return parsed
  } catch (e) {
    reportError(e, { surface: 'api-route', extra: { store: 'adminNonce', op: 'get' } })
    return g.__toshAdminNonce as bigint
  }
}

/**
 * Whether the guard survives a restart.
 *
 * Read by the route to decide how long a signed instruction may stay valid: the
 * long contract-owner window is only sound while this is `redis`. See
 * `SIGNATURE_WINDOW_SEC`.
 */
export function adminNonceBackendKind(): 'memory' | 'redis' {
  return SHARED ? 'redis' : 'memory'
}
