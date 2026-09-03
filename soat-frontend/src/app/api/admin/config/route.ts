/**
 * Admin Global Config API
 *
 * GET  /api/admin/config        — read current config (public)
 * POST /api/admin/config        — update globalGasToSatoRate (authenticated)
 *
 * ── Auth (POST) ──────────────────────────────────────────────────────────────
 *  Two acceptance paths:
 *
 *  1. On-chain owner signature  (default, strongest)
 *     Body: { newRate, nonce, expiresAt, signature }
 *     • signature is an EIP-191 sig over the canonical message:
 *         `Tosh Admin Config Update
 *          rate:      <newRate>
 *          nonce:     <nonce>
 *          expiresAt: <unix-seconds>`
 *     • Server recovers the signer address from the signature, then reads
 *       `ToshFactory.owner()` over the configured RPC.  Update is accepted
 *       only when `recovered === owner`.
 *     • Per-process monotonic `nonce` blocks replay; `expiresAt` (≤ 5 min in
 *       the future) keeps the signed window tight.
 *
 *  2. Shared-secret header (fallback)
 *     Header: `Authorization: Bearer <ADMIN_SECRET>`
 *     Enabled only when the `ADMIN_SECRET` env var is set.  Intended for CI
 *     scripts and emergency rollback — the on-chain path remains preferred.
 *
 * Body for shared-secret path: { newRate }  (nonce/expiresAt not required)
 *
 * The rate itself lives in `app/lib/gasToSatoRate.ts`, not here. It used to be
 * a module-scoped `let` in this file with no exported accessor, which meant
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
  gasToSatoRateBackendKind,
  getGasToSatoRate,
  setGasToSatoRate,
} from '@/app/lib/gasToSatoRate'

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

// ─── In-memory state (resets on server restart) ──────────────────────────────
let lastSeenNonce: bigint = 0n           // monotonic replay guard

// ─── Config ──────────────────────────────────────────────────────────────────
const ADMIN_SECRET     = process.env.ADMIN_SECRET            ?? ''
const FACTORY_ADDRESS  = process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? ''

/** Max future drift allowed on `expiresAt` (seconds). 5 minutes is enough for
 *  honest clock skew while keeping the signed window tight. */
const MAX_SIGNATURE_WINDOW_SEC = 5 * 60

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build the exact message that the owner must sign (kept in sync with the
 *  client-side `signMessage` call).  Any change here is a breaking protocol
 *  change for the admin UI. */
function buildSignableMessage(rate: number, nonce: bigint, expiresAt: number): string {
  return (
    `Tosh Admin Config Update\n` +
    `rate:      ${rate}\n` +
    `nonce:     ${nonce.toString()}\n` +
    `expiresAt: ${expiresAt}`
  )
}

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
  return corsify(
    req,
    NextResponse.json({
      globalGasToSatoRate: await getGasToSatoRate(),
      lastSeenNonce: lastSeenNonce.toString(),
      rateStore: gasToSatoRateBackendKind(),
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

  // ── Path 2: ADMIN_SECRET bearer-token shortcut ─────────────────────────
  // Allowed only when explicitly enabled; preferred path is the on-chain
  // signature below.
  const authHeader = req.headers.get('authorization')
  if (ADMIN_SECRET.length > 0 && bearerMatches(authHeader, ADMIN_SECRET)) {
    return corsify(req, await applyUpdate({ newRate, authMethod: 'admin-secret' }))
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

  // Anti-replay: nonce must strictly increase
  if (nonce <= lastSeenNonce) {
    return corsify(
      req,
      NextResponse.json(
        { error: `nonce ${nonce} is stale; must exceed ${lastSeenNonce}` },
        { status: 409 }
      )
    )
  }

  // Expiry window
  const now = Math.floor(Date.now() / 1000)
  if (rawExpires < now) {
    return corsify(req, NextResponse.json({ error: 'signature expired' }, { status: 401 }))
  }
  if (rawExpires - now > MAX_SIGNATURE_WINDOW_SEC) {
    return corsify(
      req,
      NextResponse.json(
        { error: `expiresAt too far in the future (max ${MAX_SIGNATURE_WINDOW_SEC}s ahead)` },
        { status: 400 }
      )
    )
  }

  // Recover signer
  const message = buildSignableMessage(newRate, nonce, rawExpires)
  let recovered: Address
  try {
    recovered = await recoverMessageAddress({
      message,
      signature: signature as Hex,
    })
  } catch (err) {
    console.error('[admin/config] signature recovery failed:', err)
    return corsify(req, NextResponse.json({ error: 'Invalid signature' }, { status: 401 }))
  }

  // On-chain owner check
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
  if (recovered.toLowerCase() !== owner.toLowerCase()) {
    console.warn('[admin/config] unauthorized signer', { recovered, owner })
    return corsify(
      req,
      NextResponse.json(
        { error: 'Signer is not the on-chain factory owner' },
        { status: 403 }
      )
    )
  }

  // Commit nonce *before* applying so a concurrent retry is rejected.
  lastSeenNonce = nonce
  return corsify(
    req,
    await applyUpdate({ newRate, authMethod: 'owner-signature', signer: recovered, nonce })
  )
}

// ─── Internal apply ──────────────────────────────────────────────────────────
async function applyUpdate(opts: {
  newRate: number
  authMethod: 'admin-secret' | 'owner-signature'
  signer?: Address
  nonce?: bigint
}) {
  const previous = await setGasToSatoRate(opts.newRate)

  console.log('[admin/config] rate updated', {
    previous,
    next: opts.newRate,
    authMethod: opts.authMethod,
    signer: opts.signer,
    nonce: opts.nonce?.toString(),
    store: gasToSatoRateBackendKind(),
    updatedAt: new Date().toISOString(),
  })

  return NextResponse.json(
    {
      success: true,
      previous,
      globalGasToSatoRate: opts.newRate,
      authMethod: opts.authMethod,
      rateStore: gasToSatoRateBackendKind(),
      updatedAt: new Date().toISOString(),
    },
    { status: 200 }
  )
}
