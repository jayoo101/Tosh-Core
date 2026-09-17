/**
 * Admin Global Config API
 *
 * GET  /api/admin/config        — read current config (public)
 * POST /api/admin/config        — rotate the PoG band (authenticated)
 *
 * ── What can be rotated ──────────────────────────────────────────────────────
 *  { newRate }         BNB of deposit quota per 1 ETH of historical gas
 *  { newFloorWei }     lifetime gas required to qualify, wei, decimal string
 *  { newMaxAllocWei }  ceiling on one attestation, wei, decimal string
 *
 *  `newRate` is always required; the two wei dials are optional and left where
 *  they are when omitted — but see `ADMIN_CONFIG_KEEP`: "omitted" is itself
 *  part of the signed message, so the owner signs what is NOT moving too.
 *
 *  The ceiling is refused above the live `ToshFactory.maxPogAllocationLimit`.
 *  That is not caution: an attestation over the on-chain dial reverts
 *  `registerPoG` with `ExceedsGlobalPogLimit`, for everybody, until somebody
 *  notices. Raising the deposit cap is therefore two steps in one order —
 *  `setMaxPogAllocationLimit` on chain first, this endpoint second.
 *
 * ── Auth (POST) ──────────────────────────────────────────────────────────────
 *  Two acceptance paths:
 *
 *  1. On-chain owner signature  (default, strongest)
 *     Body: { newRate, nonce, expiresAt, signature }
 *     • signature is an EIP-191 sig over the canonical message built by
 *       `lib/adminConfigMessage.ts` — the single copy of that format, shared
 *       with the admin panel, this route's tests and the CLI script.
 *     • Server reads `ToshFactory.owner()` over the configured RPC, then asks
 *       whether the signature authorises THAT address — an ECDSA recovery when
 *       the owner is an EOA, ERC-1271 `isValidSignature` when it is a contract.
 *       Both arms go through one `verifyMessage` call on the public client.
 *     • Replay is blocked by a monotonic `nonce` held in the shared store
 *       (`app/lib/adminNonce.ts`); `expiresAt` bounds freshness, sized by the
 *       owner's shape (`SIGNATURE_WINDOW_SEC`).
 *
 *     WHY THE CONTRACT ARM IS LOAD BEARING, NOT DEFENSIVE POLISH
 *
 *     This used to `recoverMessageAddress` and compare the result to `owner()`.
 *     That works only while the owner is an EOA. `transferOwnership` moved the
 *     factory to a 2-of-3 Gnosis Safe, and a Safe cannot produce an ECDSA
 *     signature over anything: it is a contract, so a recovery returns whichever
 *     signer's EOA held the pen and that address is never the Safe. Every
 *     well-formed request therefore 403'd, for every possible input.
 *
 *     Combined with `ADMIN_SECRET` being pinned `absent` in
 *     `scripts/checkSecretStore.mjs` — on the stated grounds that the signature
 *     path is "the posture we want" — the endpoint had no reachable arm at all.
 *     The exchange rate is documented in `app/lib/pogQuota.ts` as the dial an
 *     owner turns to throttle allocations, and it was frozen at its seeded
 *     value: production answered `lastSeenNonce: 0`, meaning no rotation had
 *     ever succeeded. Found by trying to use it, 2026-09-13.
 *
 *     ACCEPTING THE SIGNATURE WAS NOT ENOUGH TO MAKE THE DIAL TURN
 *
 *     The 1271 arm above landed first and the endpoint was still unusable, for
 *     two reasons that had nothing to do with signature verification and were
 *     found the same way — by trying to use it:
 *
 *       • The window was five minutes for everyone. A Safe signature is two
 *         confirmations from two people on two devices; the instruction expired
 *         before the second owner opened their phone. Fixed by sizing the window
 *         to the owner's shape, which in turn required persisting the nonce —
 *         see `SIGNATURE_WINDOW_SEC` and `app/lib/adminNonce.ts`.
 *
 *       • Nothing in the browser can connect a Safe. `providers.tsx` registers
 *         `injected()` and nothing else, so `useAccount().address` is always an
 *         extension EOA — never the owner the server now checks against. The
 *         admin panel therefore cannot produce a valid signature no matter how
 *         correct it is, and says so instead of offering a button that 403s; the
 *         working path is `scripts/rotateGasRate.mjs`.
 *
 *  2. Shared-secret header (fallback)
 *     Header: `Authorization: Bearer <ADMIN_SECRET>`
 *     Enabled only when the `ADMIN_SECRET` env var is set.  Intended for CI
 *     scripts and emergency rollback — the on-chain path remains preferred.
 *
 * Body for shared-secret path: { newRate }  (nonce/expiresAt not required)
 *
 * The band itself lives in `app/lib/pogParams.ts`, not here. The rate used to
 * be a module-scoped `let` in this file with no exported accessor, which meant
 * `api/sign-allocation` — the only route that turns a rate into a signed
 * allocation — could not read it and used the compile-time default instead. A
 * rotation therefore reported success, echoed back from the GET below, and
 * changed nothing about any issued attestation. See that file's header.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  isAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
} from 'viem'
import { FACTORY_ABI } from '@/app/lib/abis'
import { assertServerChain, serverPublicClient } from '@/app/lib/serverRpc'
import { targetChain } from '@/lib/chain'
import { reportError } from '@/lib/observability'
import {
  applyCors,
  applyRateLimit,
  corsPreflight,
  readJsonBody,
} from '@/app/lib/apiGuard'
import { rateLimitBackendKind } from '@/app/lib/rateLimitStore'
import {
  getPogBand,
  parseWeiDial,
  pogParamsBackendKind,
  setPogBand,
} from '@/app/lib/pogParams'
import { pogBandProblem, pogCapWei, type PogBand } from '@/app/lib/pogQuota'
import {
  adminNonceBackendKind,
  claimAdminNonce,
  lastSeenAdminNonce,
  MAX_ADMIN_NONCE,
} from '@/app/lib/adminNonce'
import {
  buildAdminConfigMessage,
  SIGNATURE_WINDOW_SEC,
} from '@/lib/adminConfigMessage'

// ─────────────────────────────────────────────────────────────────────────────
// HARDENING POLICIES
// ─────────────────────────────────────────────────────────────────────────────

const CORS_OPTS = { methods: ['GET', 'POST', 'OPTIONS'] as const } as const

/** Tight rate limit for the admin write path — 3-burst, 1 token per 30s.
 *  Owner-driven config rotations are inherently low-frequency. */
const POST_RATE_LIMIT = {
  name: 'admin-config-post',
  capacity: 3,
  refillPerSec: 1 / 30,
} as const

/** Read path is unauthenticated by design (it returns only the public rate),
 *  but still throttled to fend off scrapers. */
const GET_RATE_LIMIT = {
  name: 'admin-config-get',
  capacity: 30,
  refillPerSec: 5,
} as const

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req, CORS_OPTS)
}

// ─── Config ──────────────────────────────────────────────────────────────────
const ADMIN_SECRET     = process.env.ADMIN_SECRET            ?? ''
const FACTORY_ADDRESS  = process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? ''

// The replay guard lives in `app/lib/adminNonce.ts`. It used to be a
// module-scoped `let` here, annotated "resets on server restart" — see that
// file's header for why both the per-instance and the reset-to-zero halves of
// that were the reason this endpoint's signing window had to stay too short for
// a Safe to satisfy.

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Reject values that are not secrets.
 *
 * This guard exists because the deployed `.env.local` had `ADMIN_SECRET` set to
 * the owner's own EVM address.  An address is not a secret — it is the first
 * thing an explorer shows for this factory, and `factory.owner()` is a public
 * read — so the bearer fallback was accepting a credential that anybody could
 * derive in one RPC call, silently bypassing the signature path that the rest
 * of this file exists to enforce.
 *
 * A misconfiguration that turns authentication off must fail loudly rather than
 * degrade quietly, so this refuses the token AND logs, instead of shrugging.
 */
function looksLikeARealSecret(value: string): boolean {
  if (value.length < 32) return false
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return false      // an EVM address
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return false      // a private key / hash
  return true
}

/** Timing-safe bearer-token comparison. */
function bearerMatches(headerValue: string | null, expected: string): boolean {
  if (!expected) return false
  if (!headerValue) return false

  if (!looksLikeARealSecret(expected)) {
    console.error(
      '[admin/config] ADMIN_SECRET is set to a value that is not a secret ' +
      '(an address, a key-shaped hex string, or under 32 chars). The bearer ' +
      'fallback is DISABLED. Use a random 32+ char token or unset the variable.'
    )
    return false
  }

  const m = headerValue.match(/^Bearer\s+(.+)$/i)
  if (!m) return false

  const got = Buffer.from(m[1].trim(), 'utf8')
  const want = Buffer.from(expected, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // expected length, so compare a fixed-width digest of each side instead.
  return timingSafeEqual(
    createHash('sha256').update(got).digest(),
    createHash('sha256').update(want).digest(),
  )
}

async function readChainOwner(): Promise<Address | null> {
  if (!FACTORY_ADDRESS || !isAddress(FACTORY_ADDRESS)) return null
  try {
    // This read decides who may rotate the PoG rate, so an answer from some
    // other chain is worse than no answer at all.
    if (!(await assertServerChain())) {
      console.error(
        `[admin/config] RPC does not report chain ${targetChain.id} — refusing the owner check`,
      )
      return null
    }
    const client = serverPublicClient()
    const owner = await client.readContract({
      address: FACTORY_ADDRESS as Address,
      abi: FACTORY_ABI,
      functionName: 'owner',
    })
    return owner as Address
  } catch (err) {
    console.error('[admin/config] readChainOwner failed:', err)
    // Returning null here makes the owner check fail closed, so an RPC outage
    // presents as "you are not the owner" to a legitimate admin — exactly the
    // wrong story to be debugging during an incident. Report it (#26).
    reportError(err, {
      surface: 'api-route',
      extra: { route: 'admin/config', stage: 'readChainOwner' },
    })
    return null
  }
}

/**
 * The live on-chain ceiling an attestation may not exceed.
 *
 * `undefined` means the question could not be answered. That is deliberately
 * distinct from a number: this value gates a raise of `maxAllocWei`, and
 * treating an RPC outage as "no ceiling" would let a rotation through that
 * bricks `registerPoG` platform-wide, while treating it as zero would refuse
 * every rotation including the ones that lower the dial.
 */
async function readChainPogLimit(): Promise<bigint | undefined> {
  if (!FACTORY_ADDRESS || !isAddress(FACTORY_ADDRESS)) return undefined
  try {
    if (!(await assertServerChain())) return undefined
    const limit = await serverPublicClient().readContract({
      address: FACTORY_ADDRESS as Address,
      abi: FACTORY_ABI,
      functionName: 'maxPogAllocationLimit',
    })
    return limit as bigint
  } catch (err) {
    reportError(err, {
      surface: 'api-route',
      extra: { route: 'admin/config', stage: 'readChainPogLimit' },
    })
    return undefined
  }
}

/**
 * Three outcomes, because collapsing them loses the one that matters.
 *
 * `unavailable` is not `rejected`: an RPC that could not answer means the check
 * was never performed, and reporting that as "you are not the owner" sends an
 * admin to look at their wallet while the fault is in the network. Same
 * reasoning as `readChainOwner` returning null rather than throwing.
 */
type SignatureVerdict = 'ok' | 'rejected' | 'unavailable'

/**
 * Does `signature` authorise `owner` over `message`?
 *
 * One call covers both signer shapes: `verifyMessage` on a public client does an
 * ECDSA recovery for an EOA and an ERC-1271 `isValidSignature` call for a
 * contract. See this file's header for why the contract arm is what makes the
 * endpoint reachable at all.
 */
async function ownerSignatureVerdict(
  owner: Address,
  message: string,
  signature: Hex,
): Promise<SignatureVerdict> {
  try {
    const valid = await serverPublicClient().verifyMessage({
      address: owner,
      message,
      signature,
    })
    return valid ? 'ok' : 'rejected'
  } catch (err) {
    console.error('[admin/config] verifyMessage could not run:', err)
    reportError(err, {
      surface: 'api-route',
      extra: { route: 'admin/config', stage: 'ownerSignatureVerdict', owner },
    })
    return 'unavailable'
  }
}

/**
 * The EOA behind a rejected signature, for the log line only.
 *
 * Never used to authorise anything — that is `ownerSignatureVerdict`'s job. It
 * exists because "signature does not authorise the owner" with no second address
 * in it is the same debugging dead end for a Safe signer as for an EOA one: the
 * usual cause is the wrong wallet selected, and naming it is the whole fix.
 * Returns null for a signature that does not even recover, which is a different
 * mistake and should not be dressed up as an address.
 */
async function recoveredForDiagnostics(message: string, signature: Hex): Promise<Address | null> {
  try {
    return await recoverMessageAddress({ message, signature })
  } catch {
    return null
  }
}

/**
 * Is the owner an EOA or a contract?
 *
 * This decides how long a signed instruction may remain valid, which is not a
 * cosmetic difference: an EOA signs once, in one wallet, in one gesture, while a
 * 2-of-3 Safe needs confirmations from two people who are not in the same room.
 * See `SIGNATURE_WINDOW_SEC` for the full reasoning.
 *
 * Deliberately derived from `getCode` rather than from configuration. An
 * `owner()` that changes shape — `transferOwnership` from the deploy EOA to the
 * Safe, which is exactly what happened here — must move the window with it
 * without anybody remembering to edit an env var, because the failure mode of
 * forgetting is an endpoint that no longer has a reachable arm.
 *
 * Null means the question could not be answered, and the caller turns that into
 * a 503 rather than guessing. Guessing `eoa` would hand a Safe operator a
 * "signature expired" during an RPC blip; guessing `contract` would silently
 * widen the window on an EOA deployment.
 */
type OwnerShape = 'eoa' | 'contract'

async function readOwnerShape(owner: Address): Promise<OwnerShape | null> {
  try {
    const code = await serverPublicClient().getCode({ address: owner })
    return code && code !== '0x' ? 'contract' : 'eoa'
  } catch (err) {
    console.error('[admin/config] getCode failed, cannot size the signature window:', err)
    reportError(err, {
      surface: 'api-route',
      extra: { route: 'admin/config', stage: 'readOwnerShape', owner },
    })
    return null
  }
}

/**
 * How far ahead of now `expiresAt` may sit, given who is signing.
 *
 * The long contract window is licensed by the nonce being persisted, not by the
 * owner being a contract — so if the shared store is absent, this falls back to
 * the tight window even for a Safe. That combination leaves the Safe path
 * unsatisfiable again, which is a worse outcome than a wide window but a better
 * one than an open replay window, and it is reported in the rejection below
 * instead of presenting as an inexplicable clock complaint.
 */
function signatureWindowFor(shape: OwnerShape): {
  seconds: number
  degraded: boolean
} {
  if (shape === 'eoa') return { seconds: SIGNATURE_WINDOW_SEC.eoa, degraded: false }
  const shared = adminNonceBackendKind() === 'redis'
  return {
    seconds: shared ? SIGNATURE_WINDOW_SEC.contract : SIGNATURE_WINDOW_SEC.eoa,
    degraded: !shared,
  }
}

// Centralized CORS wrapper — every return path uses this.
function corsify(req: NextRequest, res: NextResponse) {
  return applyCors(res, req, CORS_OPTS)
}

// ─── GET — read current config ───────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const limited = await applyRateLimit(req, GET_RATE_LIMIT)
  if (limited) return corsify(req, limited)

  // The two `*Store` fields are here so an operator can tell at a glance
  // whether these values are shared or instance-local. On `memory` this GET
  // may answer differently per instance, and so may the signer — and the rate
  // limiter is enforcing per-instance quotas. `rateLimitBackendKind` had no
  // caller before this, so "we are silently running on per-instance limits"
  // was observable only from a 429 header nobody sees until it is too late.
  const band = await getPogBand()

  return corsify(
    req,
    NextResponse.json({
      globalGasToSatoRate: band.rate,
      // Wei as decimal strings: `scripts/pogSigner.ts` reads these to build the
      // same `maxAlloc` this server would, and a wei figure through `JSON`'s
      // number type is a wei figure through a double.
      pogFloorWei: band.floorWei.toString(),
      pogMaxAllocWei: band.maxAllocWei.toString(),
      // Derived, not stored — reported so an operator can see where the rate
      // stops paying for more history without recomputing it by hand.
      pogGasCapWei: pogCapWei(band).toString(),
      lastSeenNonce: (await lastSeenAdminNonce()).toString(),
      rateStore: pogParamsBackendKind(),
      // Distinct from `rateStore` because the two can disagree, and this one is
      // the difference between a real replay guard and a decorative one. It also
      // tells an operator which signing window POST will enforce for a Safe.
      nonceStore: adminNonceBackendKind(),
      rateLimitStore: rateLimitBackendKind(),
    })
  )
}

// ─── POST — update config ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const limited = await applyRateLimit(req, POST_RATE_LIMIT)
  if (limited) return corsify(req, limited)

  const parsed = await readJsonBody<{
    newRate?: unknown
    newFloorWei?: unknown
    newMaxAllocWei?: unknown
    nonce?: unknown
    expiresAt?: unknown
    signature?: unknown
  }>(req)
  if (parsed.error) return corsify(req, parsed.error)
  const body = parsed.data

  // ── Validate rate (always required) ────────────────────────────────────
  const { newRate } = body
  if (typeof newRate !== 'number' || !Number.isFinite(newRate) || newRate <= 0) {
    return corsify(
      req,
      NextResponse.json(
        { error: 'newRate must be a positive finite number' },
        { status: 400 }
      )
    )
  }

  // ── Validate the two optional wei dials ────────────────────────────────
  // Strings only. A wei figure arriving as a JSON number has already been
  // through a double by the time this runs, and the signature was over the
  // decimal string, so accepting one would reject the owner's own request
  // under a signature error.
  const dials: { newFloorWei?: bigint; newMaxAllocWei?: bigint } = {}
  for (const key of ['newFloorWei', 'newMaxAllocWei'] as const) {
    const raw = body[key]
    if (raw === undefined || raw === null) continue
    const value = parseWeiDial(raw)
    if (value === null) {
      return corsify(
        req,
        NextResponse.json(
          { error: `${key} must be a positive integer of wei, as a decimal string` },
          { status: 400 }
        )
      )
    }
    dials[key] = value
  }

  const next: Partial<PogBand> = {
    rate: newRate,
    ...(dials.newFloorWei !== undefined && { floorWei: dials.newFloorWei }),
    ...(dials.newMaxAllocWei !== undefined && { maxAllocWei: dials.newMaxAllocWei }),
  }

  // Coherence and the on-chain ceiling, checked before any auth path applies
  // anything. Both are properties of the requested band rather than of the
  // requester, so checking them here keeps one copy instead of one per arm.
  const refusal = await bandRefusal(next)
  if (refusal) return corsify(req, refusal)

  // ── Path 2: ADMIN_SECRET bearer-token shortcut ─────────────────────────
  // Allowed only when explicitly enabled; preferred path is the on-chain
  // signature below.
  const authHeader = req.headers.get('authorization')
  if (ADMIN_SECRET.length > 0 && bearerMatches(authHeader, ADMIN_SECRET)) {
    return corsify(req, await applyUpdate({ next, authMethod: 'admin-secret' }))
  }

  // ── Path 1: on-chain owner signature ───────────────────────────────────
  const { nonce: rawNonce, expiresAt: rawExpires, signature } = body

  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return corsify(
      req,
      NextResponse.json(
        { error: 'signature (hex string) required for owner-signed updates' },
        { status: 401 }
      )
    )
  }
  if (typeof rawNonce !== 'string' && typeof rawNonce !== 'number') {
    return corsify(
      req,
      NextResponse.json({ error: 'nonce must be a string or number' }, { status: 400 })
    )
  }
  if (typeof rawExpires !== 'number' || !Number.isInteger(rawExpires) || rawExpires <= 0) {
    return corsify(
      req,
      NextResponse.json(
        { error: 'expiresAt must be a positive unix-seconds integer' },
        { status: 400 }
      )
    )
  }

  // Parse nonce
  let nonce: bigint
  try {
    nonce = BigInt(rawNonce as string | number)
  } catch {
    return corsify(req, NextResponse.json({ error: 'nonce parse failed' }, { status: 400 }))
  }
  if (nonce <= 0n || nonce > MAX_ADMIN_NONCE) {
    // Bounded because the shared guard compares through a Lua `tonumber`, which
    // is a double: past 2^53 adjacent nonces compare equal and monotonicity
    // stops holding. Refusing is the only honest answer, since accepting would
    // silently disable the replay guard at the top of the range.
    return corsify(
      req,
      NextResponse.json(
        { error: `nonce must be between 1 and ${MAX_ADMIN_NONCE} (use Date.now())` },
        { status: 400 }
      )
    )
  }

  // A cheap, friendly rejection for the common replay. It is NOT the guard —
  // that is the atomic claim after verification — because a check here followed
  // by a write there is a race, and because burning nonce space before the
  // signature is checked would let an unauthenticated caller lock the real owner
  // out by submitting one enormous nonce.
  const seen = await lastSeenAdminNonce()
  if (nonce <= seen) {
    return corsify(
      req,
      NextResponse.json(
        { error: `nonce ${nonce} is stale; must exceed ${seen}` },
        { status: 409 }
      )
    )
  }

  // Owner first, then the signature against it. This order is required, not
  // stylistic: an ERC-1271 check is a call INTO the owner, so there is nothing
  // to verify until the address is known. The owner's shape also sizes the
  // expiry window below, which is the second reason this cannot move later.
  const owner = await readChainOwner()
  if (!owner) {
    return corsify(
      req,
      NextResponse.json(
        { error: 'Factory owner lookup failed (check NEXT_PUBLIC_FACTORY_ADDRESS / NEXT_PUBLIC_RPC_URL)' },
        { status: 503 }
      )
    )
  }

  const shape = await readOwnerShape(owner)
  if (!shape) {
    return corsify(
      req,
      NextResponse.json(
        { error: 'Could not determine whether the owner is a contract — RPC unavailable' },
        { status: 503 }
      )
    )
  }

  // Expiry window
  const now = Math.floor(Date.now() / 1000)
  if (rawExpires < now) {
    return corsify(req, NextResponse.json({ error: 'signature expired' }, { status: 401 }))
  }
  const window = signatureWindowFor(shape)
  if (rawExpires - now > window.seconds) {
    return corsify(
      req,
      NextResponse.json(
        {
          error: `expiresAt too far in the future (max ${window.seconds}s ahead for a ${shape} owner)`,
          // Without this, an operator collecting Safe signatures over an hour
          // sees a bare clock complaint and has no way to learn that the cause
          // is an unconfigured Upstash rather than their own arithmetic.
          ...(window.degraded && {
            hint:
              'The long multi-signature window needs a shared nonce store. Set ' +
              'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or the window ' +
              'stays at the single-signer value because the replay guard would not ' +
              'survive a restart.',
          }),
        },
        { status: 400 }
      )
    )
  }

  // Rebuilt from the parsed values, and with `keep` standing in for a dial the
  // request left alone — so "move the rate only" and "move the rate and the
  // ceiling" are two different signatures over two different texts, rather than
  // one signature that authorises whichever fields happen to be in the body.
  const message = buildAdminConfigMessage({
    rate: newRate,
    floorWei: dials.newFloorWei ?? null,
    maxAllocWei: dials.newMaxAllocWei ?? null,
    nonce,
    expiresAt: rawExpires,
  })
  const verdict = await ownerSignatureVerdict(owner, message, signature as Hex)

  if (verdict === 'unavailable') {
    return corsify(
      req,
      NextResponse.json(
        { error: 'Could not verify the signature against the owner — RPC unavailable' },
        { status: 503 }
      )
    )
  }
  if (verdict === 'rejected') {
    console.warn('[admin/config] unauthorized signer', {
      owner,
      ownerShape: shape,
      recovered: await recoveredForDiagnostics(message, signature as Hex),
    })
    return corsify(
      req,
      NextResponse.json(
        { error: 'Signature does not authorise the on-chain factory owner' },
        { status: 403 }
      )
    )
  }

  // Claim the nonce *before* applying, and atomically, so a concurrent retry of
  // the same payload loses the race rather than both landing.
  const claim = await claimAdminNonce(nonce)
  if (claim === 'unavailable') {
    return corsify(
      req,
      NextResponse.json(
        { error: 'Could not record the nonce — refusing to apply without a replay guard' },
        { status: 503 }
      )
    )
  }
  if (claim === 'replayed') {
    return corsify(
      req,
      NextResponse.json({ error: `nonce ${nonce} was already used` }, { status: 409 })
    )
  }

  // `signer` is the owner, not a recovered EOA. For a Safe those differ, and the
  // authority that was actually checked is the owner — reporting the EOA that
  // happened to hold the pen would name a wallet with no standing here.
  return corsify(
    req,
    await applyUpdate({ next, authMethod: 'owner-signature', signer: owner, nonce })
  )
}

// ─── Band validation ─────────────────────────────────────────────────────────

/**
 * Refuse a band that cannot work, with the reason, or null to proceed.
 *
 * Two distinct refusals, and the second is the one worth the RPC call. A
 * `maxAllocWei` above the live `ToshFactory.maxPogAllocationLimit` is not a
 * degraded configuration — every `registerPoG` reverts `ExceedsGlobalPogLimit`
 * from the moment it lands, for every wallet, and the only symptom is wallets
 * failing to activate a quota the site told them they had earned. It is cheaper
 * to refuse it here than to diagnose it there.
 *
 * An unreadable dial is a 503, not a shrug. Lowering the ceiling is always safe
 * and is allowed to wait for the RPC too: a rotation nobody can check is a
 * rotation nobody should apply, and an operator who needs one during an outage
 * has `setMaxPogAllocationLimit` on chain.
 */
async function bandRefusal(next: Partial<PogBand>): Promise<NextResponse | null> {
  const merged: PogBand = { ...(await getPogBand()), ...next }

  const problem = pogBandProblem(merged)
  if (problem) {
    return NextResponse.json({ error: `incoherent band: ${problem}` }, { status: 400 })
  }

  const onChain = await readChainPogLimit()
  if (onChain === undefined) {
    return NextResponse.json(
      {
        error: 'Could not read ToshFactory.maxPogAllocationLimit — refusing to rotate '
          + 'the band without knowing the on-chain ceiling',
      },
      { status: 503 }
    )
  }
  if (merged.maxAllocWei > onChain) {
    return NextResponse.json(
      {
        error: `maxAllocWei ${merged.maxAllocWei} exceeds the on-chain `
          + `maxPogAllocationLimit of ${onChain}. Every registerPoG would revert `
          + 'ExceedsGlobalPogLimit. Call setMaxPogAllocationLimit on the factory first.',
        onChainMaxPogAllocationLimit: onChain.toString(),
      },
      { status: 409 }
    )
  }

  return null
}

// ─── Internal apply ──────────────────────────────────────────────────────────
async function applyUpdate(opts: {
  next: Partial<PogBand>
  authMethod: 'admin-secret' | 'owner-signature'
  signer?: Address
  nonce?: bigint
}) {
  let previous: PogBand
  try {
    previous = await setPogBand(opts.next)
  } catch (err) {
    // `setPogBand` re-checks coherence, so this is reachable only if the live
    // band moved between `bandRefusal` and here. Report the reason rather than
    // a bare 500; the caller can re-read the GET and try again.
    reportError(err, { surface: 'api-route', extra: { route: 'admin/config', stage: 'setPogBand' } })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'could not store the band' },
      { status: 409 }
    )
  }

  const applied: PogBand = { ...previous, ...opts.next }

  console.log('[admin/config] band updated', {
    previous: {
      rate: previous.rate,
      floorWei: previous.floorWei.toString(),
      maxAllocWei: previous.maxAllocWei.toString(),
    },
    next: {
      rate: applied.rate,
      floorWei: applied.floorWei.toString(),
      maxAllocWei: applied.maxAllocWei.toString(),
    },
    authMethod: opts.authMethod,
    signer: opts.signer,
    nonce: opts.nonce?.toString(),
    store: pogParamsBackendKind(),
    updatedAt: new Date().toISOString(),
  })

  return NextResponse.json(
    {
      success: true,
      previous: previous.rate,
      previousBand: {
        globalGasToSatoRate: previous.rate,
        pogFloorWei: previous.floorWei.toString(),
        pogMaxAllocWei: previous.maxAllocWei.toString(),
      },
      globalGasToSatoRate: applied.rate,
      pogFloorWei: applied.floorWei.toString(),
      pogMaxAllocWei: applied.maxAllocWei.toString(),
      pogGasCapWei: pogCapWei(applied).toString(),
      authMethod: opts.authMethod,
      rateStore: pogParamsBackendKind(),
      updatedAt: new Date().toISOString(),
    },
    { status: 200 }
  )
}
