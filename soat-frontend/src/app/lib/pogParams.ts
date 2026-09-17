/**
 * pogParams.ts — the live Proof-of-Gas band, shared by every reader.
 * ───────────────────────────────────────────────────────────────────────────
 *  WHAT IS TUNABLE AND WHY IT IS HELD HERE
 *
 *  Three numbers decide what a wallet may deposit:
 *
 *    floorWei     lifetime gas required to qualify at all
 *    rate         BNB of quota earned per 1 ETH of historical gas
 *
 *                 Two coins in one line, deliberately. The quota is a deposit
 *                 allowance on the settlement chain; the gas was burned on
 *                 ETH-settled chains and is measured where it was spent. The
 *                 rate IS the conversion, so it cannot be dimensionless, and
 *                 writing both sides as one coin would either overstate
 *                 eligibility or misname the deposit.
 *    maxAllocWei  ceiling on one attestation, and so on one wallet
 *
 *  All three are owner-rotatable through `POST /api/admin/config`, and all
 *  three have to be readable by the two things that turn them into a signature:
 *  `api/sign-allocation` in this server and `scripts/pogSigner.ts` outside it.
 *  `app/lib/pogQuota.ts` holds their seeds and the arithmetic; the live values
 *  are here.
 *
 *  THE BUG THIS FILE EXISTS TO FIX
 *
 *  The rate — then the only tunable of the three — used to be a module-scoped
 *  `let` inside `api/admin/config/route.ts` with no exported accessor. `POST
 *  /api/admin/config` mutated it behind the full owner-signature apparatus —
 *  nonce monotonicity, a five-minute expiry window, `factory.owner()` recovery
 *  — and the only thing that could read the result was `GET /api/admin/config`.
 *
 *  `api/sign-allocation`, the route that actually turns a rate into a signed
 *  `maxAlloc`, could not reach it and used the compile-time
 *  `DEFAULT_GAS_TO_ETH_RATE` instead. So a rotation reported success, the GET
 *  echoed the new number back, the admin panel showed green — and not one
 *  issued attestation changed. An owner lowering the rate to throttle
 *  allocations got no throttling.
 *
 *  Worse, it drifted against the offline signer. `scripts/pogSigner.ts` calls
 *  `fetchPogBand(ADMIN_API_URL)`, which reads the live values, so after any
 *  rotation the CLI and the web route issued DIFFERENT `maxAlloc` for the same
 *  wallet — the exact divergence that the comments in
 *  `sign-allocation/route.ts` ("byte-identical `maxAlloc` values") and
 *  `pogQuota.ts` ("the two stay in lockstep") were written to rule out. Raise
 *  the rate past `factory.maxPogAllocationLimit` and CLI-issued attestations
 *  revert `ExceedsGlobalPogLimit` while web-issued ones keep working.
 *
 *  That history is why the floor and the ceiling were made tunable HERE, in one
 *  store read by one accessor, rather than as two more constants with an admin
 *  form in front of them.
 *
 *  BACKEND SELECTION
 *
 *  Mirrors `rateLimitStore.ts` deliberately: Upstash Redis REST when
 *  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are both set,
 *  in-process otherwise. Rotating a signing parameter is exactly the operation
 *  that must not be per-instance — without a shared store, a rotation lands on
 *  whichever instance served the POST and every other instance keeps signing
 *  at the old band, which is the same class of failure as the one above but
 *  harder to see.
 *
 *  A read failure against the shared store falls back to the last band this
 *  instance saw, and ultimately to the compile-time seeds, rather than
 *  throwing. That is the conservative direction: the seeds are the values the
 *  on-chain `maxPogAllocationLimit` ceiling was set against, so a store outage
 *  degrades to "the band you started with" instead of failing the signing path
 *  outright.
 */

import { reportError } from '@/lib/observability'
import {
  DEFAULT_POG_BAND,
  pogBandProblem,
  type PogBand,
} from './pogQuota'

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? ''
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? ''
const SHARED = Boolean(UPSTASH_URL && UPSTASH_TOKEN)

/** The rate keeps its original key so a band already rotated in production is
 *  not silently reset to the seed by this refactor. */
const RATE_KEY = 'tosh:pog:gasToSatoRate'
const FLOOR_KEY = 'tosh:pog:floorWei'
const MAX_ALLOC_KEY = 'tosh:pog:maxAllocWei'

/** Module-level so the value survives hot reloads in dev, as `rateLimitStore` does. */
const g = globalThis as Record<string, unknown>
if (!g.__toshPogBand) g.__toshPogBand = { ...DEFAULT_POG_BAND }

function local(): PogBand {
  return g.__toshPogBand as PogBand
}

/** A rate is only usable if it is a finite positive number. */
export function isValidRate(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

/** A wei dial is only usable if it is a positive integer. Accepts the string
 *  form the store and the API body both carry, because a wei figure this size
 *  has no business passing through a double. */
export function parseWeiDial(raw: unknown): bigint | null {
  if (typeof raw === 'bigint') return raw > 0n ? raw : null
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null
  try {
    const v = BigInt(raw)
    return v > 0n ? v : null
  } catch {
    return null
  }
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

/**
 * Write several keys or none of them.
 *
 * Three separate `SET`s would let a rotation land partially — floor written,
 * ceiling not — and a partially rotated band is a band no owner signed. It can
 * even be coherent, so `pogBandProblem` on the read side would wave it through.
 * `multi-exec` removes the case instead of detecting it.
 */
async function upstashMultiExec(commands: readonly string[][]): Promise<void> {
  const res = await fetch(`${UPSTASH_URL}/multi-exec`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`upstash multi-exec failed: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as
    | { error?: string }
    | Array<{ result?: unknown; error?: string }>
  if (Array.isArray(body)) {
    const failed = body.find((r) => r.error)
    if (failed) throw new Error(`upstash multi-exec: ${failed.error}`)
    return
  }
  if (body.error) throw new Error(`upstash multi-exec: ${body.error}`)
}

/**
 * The band every signer must use. Never throws.
 *
 * One `MGET`, so the three values cannot be read across a rotation that lands
 * between them. A band assembled from a pre-rotation rate and a post-rotation
 * ceiling is not a band anybody chose.
 */
export async function getPogBand(): Promise<PogBand> {
  if (!SHARED) return local()
  try {
    const raw = await upstash(['MGET', RATE_KEY, FLOOR_KEY, MAX_ALLOC_KEY])
    const [rateRaw, floorRaw, maxAllocRaw] = Array.isArray(raw) ? raw : []

    const warm = local()
    const rate = typeof rateRaw === 'string' && isValidRate(Number(rateRaw))
      ? Number(rateRaw)
      : warm.rate
    const band: PogBand = {
      rate,
      floorWei: parseWeiDial(floorRaw) ?? warm.floorWei,
      maxAllocWei: parseWeiDial(maxAllocRaw) ?? warm.maxAllocWei,
    }
    if (pogBandProblem(band)) return warm

    // Keep the in-process copy warm so a later store outage degrades to the
    // last band this instance saw rather than all the way to the seeds.
    g.__toshPogBand = band
    return band
  } catch (e) {
    reportError(e, { surface: 'api-route', extra: { store: 'pogParams', op: 'get' } })
    return local()
  }
}

/** The rate alone, for callers that only report it. */
export async function getGasToSatoRate(): Promise<number> {
  return (await getPogBand()).rate
}

/**
 * Rotate any subset of the band. Returns the band it replaced, for the admin
 * response.
 *
 * The in-process copy is updated whether or not the shared write lands, so a
 * store outage still rotates the instance that served the request — degraded,
 * but not silently inert, which is the failure this whole file is about.
 *
 * Refuses an incoherent result rather than writing it. The admin route
 * validates first and reports the reason; this is the backstop for any other
 * caller, because a band that `pogBandProblem` rejects is one that signs
 * nothing for anybody.
 */
export async function setPogBand(next: Partial<PogBand>): Promise<PogBand> {
  const previous = await getPogBand()
  const merged: PogBand = { ...previous, ...next }

  const problem = pogBandProblem(merged)
  if (problem) throw new Error(`refusing to store an incoherent PoG band: ${problem}`)

  g.__toshPogBand = merged

  if (SHARED) {
    const writes: string[][] = []
    if (merged.rate !== previous.rate) writes.push(['SET', RATE_KEY, String(merged.rate)])
    if (merged.floorWei !== previous.floorWei) {
      writes.push(['SET', FLOOR_KEY, merged.floorWei.toString()])
    }
    if (merged.maxAllocWei !== previous.maxAllocWei) {
      writes.push(['SET', MAX_ALLOC_KEY, merged.maxAllocWei.toString()])
    }
    if (writes.length > 0) {
      try {
        await upstashMultiExec(writes)
      } catch (e) {
        reportError(e, {
          surface: 'api-route',
          extra: { store: 'pogParams', op: 'set', keys: writes.map((w) => w[1]).join(',') },
        })
      }
    }
  }

  return previous
}

/** Reported by `GET /api/admin/config` so an operator can see whether a rotation is instance-local. */
export function pogParamsBackendKind(): 'memory' | 'redis' {
  return SHARED ? 'redis' : 'memory'
}
