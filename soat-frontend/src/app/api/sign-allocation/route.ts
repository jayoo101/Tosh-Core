/**
 * POST /api/sign-allocation
 * ─────────────────────────────────────────────────────────────────────────────
 *  Proof-of-Gas telemetry & cryptographic attestation gateway  (v4.3)
 *
 *  Two cryptographic gates, in this exact order:
 *
 *  GATE 1 · WALLET AUTH DOMAIN  (EIP-191 personal_sign)
 *    message ≡ `Tosh PoG Scan Request\nAddress: {addr}\nTimestamp: {ms}`
 *    framed  ≡ "\x19Ethereum Signed Message:\n{len}" || message
 *    The caller proves wallet custody by signing this domain-prefixed
 *    message.  Anything that does NOT recover to `userAddress` is refused.
 *    Replay window is ±30 min via SESSION_AUTH_TTL_MS.  Clean SaaS-style
 *    bodies (no domain) are refused by construction — the recovery fails.
 *
 *  GATE 2 · POG ATTESTATION SIGNATURE  (EIP-191 over keccak256)
 *    digest    ≡ keccak256(abi.encode(
 *                  sender, maxAlloc, nonce, deadline, factory, chainId))
 *    attestSig ≡ ECDSA(privKey, "\x19Ethereum Signed Message:\n32" || digest)
 *    The "Tosh" branding stays in GATE 1.  Adding it to the GATE-2 digest
 *    would change the on-chain recovery and brick attestation forever.
 *
 *  RESPONSE — clean JSON, raw fields only:
 *    {
 *      signature  : "0x<130-hex>",   // raw 65-byte EIP-191 sig
 *      maxAlloc   : "<wei>",
 *      nonce      : "<live on-chain nonce>",
 *      deadline   : "<unix sec, 24h hence>",
 *      issuer     : "0x<oracle EOA>",
 *      authDomain : "Tosh PoG Scan Request",
 *    }
 *
 *  REQUIRED ENV (soat-frontend/.env.local):
 *      POG_SIGNER_PRIVATE_KEY  — historical / preferred
 *      POG_PRIVATE_KEY         — spec-compliant alias (must equal SIGNER)
 *  OPTIONAL:
 *      NEXT_PUBLIC_RPC_URL     — endpoint for the target chain; see
 *                                `app/lib/serverRpc.ts` for the full order and
 *                                for why chain-named vars are not consulted on
 *                                a chain they do not name.
 */

import { NextResponse } from 'next/server'
import {
  encodeAbiParameters, isAddress, keccak256, verifyMessage,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { fetchPogNonce, fetchPogSigner } from '@/app/lib/onchainNonce'
import { reportError } from '@/lib/observability'
import {
  FACTORY_ADDRESS,
  POG_SCAN_AUTH_DOMAIN,
  POG_SESSION_AUTH_TTL_MS,
  buildPoGScanAuthMessage,
  isSupportedPogChain,
} from '@/lib/contracts'
import {
  ATTESTATION_TTL_SECONDS,
  computeMaxAllocFromWei,
  isPogEligible,
} from '@/app/lib/pogQuota'
import { readScanJob, isFresh } from '@/app/lib/scanJobStore'
import { getPogBand } from '@/app/lib/pogParams'
import {
  applyCors,
  applyRateLimit,
  corsPreflight,
  readJsonBody,
} from '@/app/lib/apiGuard'

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST BODY
// ─────────────────────────────────────────────────────────────────────────────

interface RequestBody {
  userAddress:     string
  contractAddress: string
  chainId:         number
  timestamp:       number
  signature:       string
  /** @deprecated — server reads live nonce from chain; ignored if present. */
  nonce?:          number
}

// ─────────────────────────────────────────────────────────────────────────────
// HARDENING POLICIES — applied before any business logic runs
// ─────────────────────────────────────────────────────────────────────────────

/** CORS: closed allow-list, POST + OPTIONS only.  Browsers from other origins
 *  will fail the preflight; same-origin and server-side callers are unaffected. */
const CORS_OPTS = { methods: ['POST', 'OPTIONS'] as const } as const

/** Rate limit: 5-token bucket, refilling at 1 token per 6 seconds (~10/min).
 *  PoG attestations are wallet-coupled, low-frequency events.  This budget is
 *  generous for honest users (5 burst + 10/min steady) and ruinous for bots. */
const RATE_LIMIT_OPTS = {
  name: 'pog-sign-allocation',
  capacity: 5,
  refillPerSec: 1 / 6,
} as const

// ─────────────────────────────────────────────────────────────────────────────
// LOCKED PARAMETERS — must match on-chain expectations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attestation TTL — `registerPoG()` must land before this hits.
 *
 * Imported rather than derived here, and that is the fix to a second defect
 * rather than tidying. This route worked out the margin below and applied it to a
 * local constant, while `pogQuota.computeDeadline()` — the shared helper, and what
 * `scripts/pogSigner.ts` calls — went on using the ceiling as its TTL. Everything
 * this comment says was therefore true of one signer and false of the other for
 * as long as the two numbers lived apart. Measured with
 * `scripts/probeDeadlineMargin.mjs`: the CLI path tolerated 0 s of clock skew and
 * reverted `SignatureTooLong` from a host 3 s fast.
 *
 * Deliberately BELOW `SIG_VALIDITY_SECONDS`, because the on-chain check is
 * two-sided and the upper side had no margin at all:
 *
 *   if (deadline > block.timestamp + MAX_SIG_VALIDITY) revert SignatureTooLong();
 *
 * With `deadline = serverNow + MAX_SIG_VALIDITY` the two `MAX_SIG_VALIDITY`
 * terms cancel and the condition reduces to `serverNow > block.timestamp` —
 * so an attestation was valid only while this server's clock was at or behind
 * the timestamp of the block that mines the registration.
 *
 * That is not a rare edge. It fails whenever this host's clock runs even one
 * second fast, and whenever the chain's timestamps lag wall time, which some
 * sequencers do routinely. And it fails CLOSED and TOTAL: not a slow path or a
 * degraded one, but `SignatureTooLong` on every registration for as long as the
 * skew lasts, with an error name that points at the signature's length rather
 * than at a clock. Nothing in the pipeline would have said which host was
 * wrong.
 *
 * An hour of headroom costs nothing — the window is sized for human-paced
 * wallet flows, where 23 h and 24 h are the same number — and buys tolerance
 * for any skew smaller than an hour in the direction that breaks.
 */
const ATTESTATION_TTL_SEC: number = ATTESTATION_TTL_SECONDS

// ─────────────────────────────────────────────────────────────────────────────
// PROOF-OF-GAS GAS HISTORY — read, not derived
// ─────────────────────────────────────────────────────────────────────────────
// This was `void userAddress; return MOCK_CHAIN_GAS` — a constant table, so
// every wallet that cleared the auth gate was attested for the same amount and
// the address it was issued for was thrown away unused. PM-F9 closed that.
//
// The scan itself is NOT done here. It reads five chains and measured 10–23 s
// against live hosts, which does not belong inside the request that signs, and
// it is idempotent enough to cache for an hour. So `/api/pog-scan` owns the
// work and this route reads its result.
//
// The consequence worth stating plainly: this endpoint can no longer produce an
// allocation on its own. If there is no finished scan for the wallet, it refuses
// rather than falling back to a default — a fallback here would be the mock
// again, reintroduced as a failure mode instead of a stub, and it would fire
// exactly when the indexer was down and nobody was watching.
async function readScannedGas(userAddress: Address): Promise<
  | { ok: true; totalWei: bigint; scannedAt: number; truncated: boolean }
  | { ok: false; status: number; error: string }
> {
  let job
  try {
    job = await readScanJob(userAddress)
  } catch (e) {
    reportError(e, {
      surface: 'api-route',
      extra: { route: 'POST /api/sign-allocation', stage: 'readScanJob' },
    })
    return { ok: false, status: 503, error: 'Scan store unavailable — try again' }
  }

  if (!job || job.status === 'failed') {
    return {
      ok: false, status: 409,
      error: 'No completed gas scan for this wallet. Run the scan first.',
    }
  }
  if (job.status === 'running') {
    return { ok: false, status: 409, error: 'Gas scan still running. Try again shortly.' }
  }
  if (!job.result) {
    return { ok: false, status: 409, error: 'Gas scan result missing. Run the scan again.' }
  }
  // A result older than its TTL is refused rather than used. The window is an
  // hour; anything past it is cheap to redo and the alternative is signing
  // against history that may since have grown.
  if (!isFresh(job)) {
    return { ok: false, status: 409, error: 'Gas scan is stale. Run the scan again.' }
  }

  return {
    ok: true,
    totalWei: BigInt(job.result.totalWei),
    scannedAt: job.result.scannedAt,
    truncated: job.result.truncated,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function clientError(error: string, status = 400) {
  return NextResponse.json({ error }, { status })
}

/** Wraps a response with the route's CORS headers — every return path uses this
 *  so a stray bare `NextResponse.json` can't slip past the allow-list. */
function corsify(req: Request, res: NextResponse) {
  return applyCors(res, req, CORS_OPTS)
}

function loadOracleAccount() {
  const primary = process.env.POG_SIGNER_PRIVATE_KEY
  const alias   = process.env.POG_PRIVATE_KEY
  const raw     = primary ?? alias
  if (!raw) {
    return {
      account: null,
      err: 'POG signer private key not configured. Set POG_SIGNER_PRIVATE_KEY '
         + '(preferred) or POG_PRIVATE_KEY in soat-frontend/.env.local.',
    } as const
  }
  if (primary && alias && primary !== alias) {
    console.warn(
      '[sign-allocation] POG_SIGNER_PRIVATE_KEY and POG_PRIVATE_KEY are both '
      + 'set with DIFFERENT values — using SIGNER.  Pick one and unset the other.'
    )
  }
  const pk = raw.startsWith('0x') ? raw : `0x${raw}`
  try {
    const account = privateKeyToAccount(pk as `0x${string}`)
    return { account, err: null } as const
  } catch (e) {
    return {
      account: null,
      err: `Invalid POG signer private key: ${e instanceof Error ? e.message : String(e)}`,
    } as const
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function OPTIONS(req: Request) {
  return corsPreflight(req, CORS_OPTS)
}

export async function POST(req: Request) {
  // ── Hardening Gate 0a · Rate limit ─────────────────────────────────────
  const limited = await applyRateLimit(req, RATE_LIMIT_OPTS)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  // ── Hardening Gate 0b · Body size + JSON parse ────────────────────────
  const parsed = await readJsonBody<RequestBody>(req)
  if (parsed.error) return applyCors(parsed.error, req, CORS_OPTS)
  const body = parsed.data

  const {
    userAddress, contractAddress, chainId,
    timestamp, signature: walletAuthSignature,
  } = body

  // ── Field validation ─────────────────────────────────────────────────
  if (!userAddress     || !isAddress(userAddress))     return corsify(req, clientError('Invalid userAddress'))
  if (!contractAddress || !isAddress(contractAddress)) return corsify(req, clientError('Invalid contractAddress'))
  // Pinned to the configured factory rather than merely well-formed.
  //
  // This is the address the oracle signs into the digest's `contract_` field,
  // and it arrived from the body. It is not exploitable today: `registerPoG`
  // hashes `address(this)`, so a signature naming anything else simply fails to
  // recover at the real factory and is worth nothing to whoever asked for it.
  //
  // It is pinned because the endpoint was, in effect, a service that would sign
  // "the Tosh oracle attests that <wallet> may claim <amount> at <any contract
  // you name>". That is only inert for as long as no second contract trusts
  // `pogSigner` — and the day one does, the pre-authorisations already exist,
  // issued long before anyone thought about it. The honest client has always
  // sent exactly this value (`PogScanButton.tsx`), so pinning it costs nothing
  // and removes the whole class rather than the current instance.
  //
  // Secondary, and the reason this is not merely hypothetical hygiene: the
  // value was passed straight to `fetchPogNonce`, making every request an
  // `eth_call` to a caller-chosen address on the server's RPC credentials.
  if (contractAddress.toLowerCase() !== FACTORY_ADDRESS.toLowerCase()) {
    return corsify(req, clientError('contractAddress is not this deployment\'s factory'))
  }
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    return corsify(req, clientError('Invalid chainId'))
  }
  if (!isSupportedPogChain(chainId)) {
    return corsify(req, clientError(`Unsupported chainId ${chainId}`, 400))
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return corsify(req, clientError('Invalid timestamp'))
  }
  if (typeof walletAuthSignature !== 'string' || !walletAuthSignature.startsWith('0x')) {
    return corsify(req, clientError('Invalid signature'))
  }

  // ── GATE 1 · WALLET AUTH (EIP-191 with "Tosh PoG Scan Request") ──────
  if (Math.abs(Date.now() - timestamp) >= POG_SESSION_AUTH_TTL_MS) {
    return corsify(req, clientError('Unauthorized — wallet auth window elapsed', 401))
  }

  const authMessage = buildPoGScanAuthMessage(userAddress, timestamp)
  // Belt-and-braces: the message we just built MUST start with the locked
  // domain.  Guards against helper-function drift.
  if (!authMessage.startsWith(POG_SCAN_AUTH_DOMAIN)) {
    return corsify(req, clientError('Server config error: auth domain prefix mismatch', 500))
  }

  let walletAuthValid = false
  try {
    walletAuthValid = await verifyMessage({
      address:   userAddress as Address,
      message:   authMessage,
      signature: walletAuthSignature as `0x${string}`,
    })
  } catch {
    walletAuthValid = false
  }
  if (!walletAuthValid) {
    // SaaS-style clean-text bodies (no "Tosh PoG Scan Request" prefix)
    // fail this check by construction.  Forged signatures fail too.
    return corsify(req, clientError('Unauthorized — auth signature does not recover to userAddress', 401))
  }

  // ── Load oracle signing key ──────────────────────────────────────────
  const { account, err } = loadOracleAccount()
  if (!account) return corsify(req, clientError(err, 500))

  // ── Live on-chain reads: nonce, and who the factory will accept ──────
  //
  // Paired rather than sequential because the signer read must not cost the
  // route a second round trip: it is the same host, and `Promise.all` makes the
  // added latency the difference between one call and the slower of two.
  let onchainNonce: bigint
  let onchainSigner: Address
  try {
    ;[onchainNonce, onchainSigner] = await Promise.all([
      fetchPogNonce(
        contractAddress as Address,
        userAddress     as Address,
        chainId,
      ),
      fetchPogSigner(contractAddress as Address, chainId),
    ])
  } catch (e) {
    console.error('[sign-allocation] Failed to read factory state', e)
    // Every PoG registration dies here when the RPC is unreachable, and the
    // user-facing text ("try again") is indistinguishable from a blip. Without
    // this report a total outage of the signing path looks like silence (#26).
    reportError(e, {
      surface: 'api-route',
      extra: { route: 'POST /api/sign-allocation', stage: 'factoryReads', chainId },
    })
    return corsify(req, clientError('Unable to sync nonce from chain — try again', 503))
  }

  // ── The key is the key the factory accepts ───────────────────────────
  //
  // Refusing costs the caller a 500 and nothing else. Signing costs the caller
  // gas: the attestation would be well-formed, the client would submit it, and
  // `registerPoG` would recover an address that is not `pogSigner` and revert.
  // So on a wrong key this is the difference between a route that is down and a
  // route that is quietly charging every user to fail, and the second one is
  // indistinguishable from the users being at fault.
  //
  // Fail-closed on mismatch, but note the asymmetry with the block above: an
  // unreadable factory is not evidence of a bad key, and it already returns 503
  // there. Only a definite disagreement lands here.
  if (onchainSigner.toLowerCase() !== account.address.toLowerCase()) {
    console.error(
      `[sign-allocation] POG signer key mismatch: configured key derives ` +
      `${account.address}, factory ${contractAddress} expects ${onchainSigner}`,
    )
    reportError(new Error('POG signer key does not match factory.pogSigner()'), {
      surface: 'api-route',
      extra: {
        route: 'POST /api/sign-allocation',
        stage: 'signerIdentity',
        chainId,
        configured: account.address,
        expected: onchainSigner,
      },
    })
    return corsify(req, clientError(
      'Signing oracle is misconfigured — allocations are unavailable', 500,
    ))
  }

  // ── Proof-of-Gas allocation derivation ───────────────────────────────
  // Pipeline: finished scan → floor check → band → computeMaxAllocFromWei.
  // Caps at the band's `maxAllocWei`. Reminder: the on-chain
  // `factory.maxPogAllocationLimit` MUST be >= the resulting maxAlloc, or
  // `registerPoG` will revert with `ExceedsGlobalPogLimit` — and that same dial
  // is frozen into every launch as its `perWalletCap`, so it is not a knob that
  // can be raised here alone. `POST /api/admin/config` refuses a ceiling above
  // the live on-chain dial, which is where that relationship is enforced.
  const scan = await readScannedGas(userAddress as Address)
  if (!scan.ok) return corsify(req, clientError(scan.error, scan.status))

  // The LIVE band, not the compile-time seeds. This route used to read
  // `DEFAULT_GAS_TO_SATO_RATE` while `scripts/pogSigner.ts` read the rotated
  // value, so every owner rotation silently split the two signers apart — see
  // `app/lib/pogParams.ts`. Read once, above the floor check, so the floor that
  // refuses a wallet and the rate that sizes it come from one snapshot.
  const band = await getPogBand()

  // The floor, enforced by refusing rather than by signing a small number.
  //
  // Signing zero would be worse than refusing: `registerPoG` would accept it,
  // `pogQuota` would be set to 0, and `deposit` reverts `NoPogQuota` on a
  // quota of zero — so the wallet would have spent gas to register, be told it
  // succeeded, and then be turned away at the only door that matters, with an
  // error naming a quota it just registered.
  if (!isPogEligible(scan.totalWei, band)) {
    return corsify(req, NextResponse.json({
      error: 'Gas history below the minimum for an allocation.',
      totalGasWei: scan.totalWei.toString(),
      floorWei: band.floorWei.toString(),
      eligible: false,
    }, { status: 403 }))
  }

  const gasToSatoRate = band.rate
  const maxAlloc      = computeMaxAllocFromWei(scan.totalWei, band)

  // Unreachable given the floor check above, and checked anyway: a zero here
  // would mean the rate itself is misconfigured, and signing a zero allocation
  // sends the user into the `NoPogQuota` trap described above.
  if (maxAlloc === 0n) {
    reportError(new Error('PoG allocation resolved to zero above the floor'), {
      surface: 'api-route',
      extra: { route: 'POST /api/sign-allocation', gasToSatoRate, totalGasWei: scan.totalWei.toString() },
    })
    return corsify(req, clientError('Allocation could not be sized — try again', 503))
  }

  // ── GATE 2 · POG ATTESTATION DIGEST ──────────────────────────────────
  const deadline = BigInt(Math.floor(Date.now() / 1000) + ATTESTATION_TTL_SEC)
  const digest   = keccak256(
    encodeAbiParameters(
      [
        { name: 'sender',    type: 'address' },
        { name: 'maxAlloc',  type: 'uint256' },
        { name: 'nonce',     type: 'uint256' },
        { name: 'deadline',  type: 'uint256' },
        { name: 'contract_', type: 'address' },
        { name: 'chainId',   type: 'uint256' },
      ],
      [
        userAddress     as Address,
        maxAlloc,
        onchainNonce,
        deadline,
        contractAddress as Address,
        BigInt(chainId),
      ]
    )
  )

  // EIP-191 personal_sign over the raw 32-byte digest.  Viem's
  //   signMessage({ message: { raw: digest } })
  // automatically frames as
  //   keccak256("\x19Ethereum Signed Message:\n32" || digest)
  // which matches OpenZeppelin's `MessageHashUtils.toEthSignedMessageHash`
  // used by the recover path inlined in `ToshFactory.registerPoG`.
  const attestationSig: `0x${string}` = await account.signMessage({
    message: { raw: digest },
  })

  console.log('[sign-allocation] PoG attestation issued', {
    userAddress,
    contractAddress,
    chainId,
    authTimestamp: timestamp,
    nonce:         onchainNonce.toString(),
    deadline:      deadline.toString(),
    issuer:        account.address,
    totalGasWei:   scan.totalWei.toString(),
    scannedAt:     scan.scannedAt,
    gasToSatoRate,
    maxAllocWei:   maxAlloc.toString(),
  })

  // ── Clean JSON envelope ──────────────────────────────────────────────
  // Proof-of-Gas telemetry fields (`totalGasWei`, `gasToSatoRate`, `truncated`)
  // are advisory metadata for the UI — the on-chain verifier consumes only
  // `maxAlloc`, `nonce`, `deadline`, `signature`.
  return corsify(req, NextResponse.json({
    signature:     attestationSig,
    maxAlloc:      maxAlloc.toString(),
    nonce:         onchainNonce.toString(),
    deadline:      deadline.toString(),
    issuer:        account.address,
    authDomain:    POG_SCAN_AUTH_DOMAIN,
    totalGasWei:   scan.totalWei.toString(),
    scannedAt:     scan.scannedAt,
    /** The scan hit its page budget, so `totalGasWei` is a lower bound and the
     *  allocation is correspondingly conservative. See `gasHistory.ts`. */
    truncated:     scan.truncated,
    gasToSatoRate,
  }))
}
