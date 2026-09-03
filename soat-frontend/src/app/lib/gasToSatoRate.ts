/**
 * gasToSatoRate.ts — the live Proof-of-Gas exchange rate, shared by every
 * reader.
 * ───────────────────────────────────────────────────────────────────────────
 *  THE BUG THIS FILE EXISTS TO FIX
 *
 *  The rate used to be a module-scoped `let` inside `api/admin/config/route.ts`
 *  with no exported accessor. `POST /api/admin/config` mutated it behind the
 *  full owner-signature apparatus — nonce monotonicity, a five-minute expiry
 *  window, `factory.owner()` recovery — and the only thing that could read the
 *  result was `GET /api/admin/config`.
 *
 *  `api/sign-allocation`, the route that actually turns a rate into a signed
 *  `maxAlloc`, could not reach it and used the compile-time
 *  `DEFAULT_GAS_TO_ETH_RATE` instead. So a rotation reported success, the GET
 *  echoed the new number back, the admin panel showed green — and not one
 *  issued attestation changed. An owner lowering the rate to throttle
 *  allocations got no throttling.
 *
 *  Worse, it drifted against the offline signer. `scripts/pogSigner.ts` calls
 *  `fetchGasToSatoRate(ADMIN_API_URL)`, which reads the live value, so after
 *  any rotation the CLI and the web route issued DIFFERENT `maxAlloc` for the
 *  same wallet — the exact divergence that the comments in
 *  `sign-allocation/route.ts` ("byte-identical `maxAlloc` values") and
 *  `pogQuota.ts` ("the two stay in lockstep") were written to rule out. Raise
 *  the rate past `factory.maxPogAllocationLimit` and CLI-issued attestations
 *  revert `ExceedsGlobalPogLimit` while web-issued ones keep working.
 *
 *  BACKEND SELECTION
 *
 *  Mirrors `rateLimitStore.ts` deliberately: Upstash Redis REST when
 *  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are both set,
 *  in-process otherwise. Rotating a signing parameter is exactly the operation
 *  that must not be per-instance — without a shared store, a rotation lands on
 *  whichever instance served the POST and every other instance keeps signing
 *  at the old rate, which is the same class of failure as the one above but
 *  harder to see.
 *
 *  A read failure against the shared store falls back to the compile-time
 *  default rather than throwing. That is the conservative direction: the
 *  default is the value the on-chain `maxPogAllocationLimit` ceiling was set
 *  against, so a store outage degrades to "the rate you started with" instead
 *  of failing the signing path outright.
 */

import { reportError } from '@/lib/observability'
import { DEFAULT_GAS_TO_ETH_RATE } from './pogQuota'

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? ''
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? ''
const SHARED = Boolean(UPSTASH_URL && UPSTASH_TOKEN)
const KEY = 'tosh:pog:gasToSatoRate'

/** Module-level so the value survives hot reloads in dev, as `rateLimitStore` does. */
const g = globalThis as Record<string, unknown>
if (typeof g.__toshGasToSatoRate !== 'number') g.__toshGasToSatoRate = DEFAULT_GAS_TO_ETH_RATE

function local(): number {
  return g.__toshGasToSatoRate as number
}

/** A rate is only usable if it is a finite positive number. */
export function isValidRate(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

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

/** The rate every signer must use. Never throws. */
export async function getGasToSatoRate(): Promise<number> {
  if (!SHARED) return local()
  try {
    const raw = await upstash(['GET', KEY])
    const parsed = typeof raw === 'string' ? Number(raw) : NaN
    if (isValidRate(parsed)) {
      // Keep the in-process copy warm so a later store outage degrades to the
      // last value this instance saw rather than all the way to the default.
      g.__toshGasToSatoRate = parsed
      return parsed
    }
    return local()
  } catch (e) {
    reportError(e, { surface: 'api-route', extra: { store: 'gasToSatoRate', op: 'get' } })
    return local()
  }
}

/**
 * Rotate the rate. Returns the value it replaced, for the admin response.
 *
 * The in-process copy is updated whether or not the shared write lands, so a
 * store outage still rotates the instance that served the request — degraded,
 * but not silently inert, which is the failure this whole file is about.
 */
export async function setGasToSatoRate(next: number): Promise<number> {
  const previous = await getGasToSatoRate()
  g.__toshGasToSatoRate = next
  if (SHARED) {
    try {
      await upstash(['SET', KEY, String(next)])
    } catch (e) {
      reportError(e, { surface: 'api-route', extra: { store: 'gasToSatoRate', op: 'set' } })
    }
  }
  return previous
}

/** Reported by `GET /api/admin/config` so an operator can see whether a rotation is instance-local. */
export function gasToSatoRateBackendKind(): 'memory' | 'redis' {
  return SHARED ? 'redis' : 'memory'
}
