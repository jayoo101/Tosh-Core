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
 *      BASE_SEPOLIA_RPC        — fallback https://sepolia.base.org
 */

import { NextResponse } from 'next/server'
import {
  encodeAbiParameters, isAddress, keccak256, verifyMessage,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { fetchPogNonce } from '@/app/lib/onchainNonce'
import {
  POG_SCAN_AUTH_DOMAIN,
  POG_SESSION_AUTH_TTL_MS,
  buildPoGScanAuthMessage,
  isSupportedPogChain,
} from '@/lib/contracts'
import {
  MOCK_CHAIN_GAS,
  totalGasEth,
  computeMaxAllocWei,
  DEFAULT_GAS_TO_SATO_RATE,
  type ChainGasData,
} from '@/app/lib/pogQuota'
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

/** Attestation TTL — registerPoG() must land before this hits.  24 h is a
 *  conservative ceiling for human-paced wallet flows. */
const ATTESTATION_TTL_SEC: number = 24 * 60 * 60

// ─────────────────────────────────────────────────────────────────────────────
// PROOF-OF-GAS MULTI-CHAIN SCANNER
// ─────────────────────────────────────────────────────────────────────────────
// Single swap-point for the future real indexer (Etherscan / Alchemy /
// Covalent / Dune).  Today this resolves to the shared `MOCK_CHAIN_GAS` table
// so this Next.js route and the offline CLI signer (`scripts/pogSigner.ts`)
// produce byte-identical `maxAlloc` values for any given wallet.
//
// Wire a live indexer behind this seam — everything else in the pipeline
// (rate fetch, computeMaxAllocWei, nonce sync, digest framing) is already
// downstream and stays untouched.
async function scanGasHistoryForWallet(userAddress: Address): Promise<ChainGasData[]> {
  void userAddress
  return MOCK_CHAIN_GAS
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
  const limited = applyRateLimit(req, RATE_LIMIT_OPTS)
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

  // ── Live on-chain nonce sync ─────────────────────────────────────────
  let onchainNonce: bigint
  try {
    onchainNonce = await fetchPogNonce(
      contractAddress as Address,
      userAddress     as Address,
      chainId,
    )
  } catch (e) {
    console.error('[sign-allocation] Failed to fetch on-chain nonce', e)
    return corsify(req, clientError('Unable to sync nonce from chain — try again', 503))
  }

  // ── Proof-of-Gas allocation derivation ───────────────────────────────
  // Pipeline: multi-chain gas scan → sum ETH spend → computeMaxAllocWei.
  // Floors at MAX_ALLOC_ETH_WEI (0.1 ETH).  Reminder: the on-chain
  // `factory.maxPogAllocationLimit` MUST be >= the resulting maxAlloc, or
  // `registerPoG` will revert with `ExceedsGlobalPogLimit`.
  const gasData     = await scanGasHistoryForWallet(userAddress as Address)
  const gasEth      = totalGasEth(gasData)
  const gasToSatoRate = DEFAULT_GAS_TO_SATO_RATE
  const maxAlloc    = computeMaxAllocWei(gasEth, gasToSatoRate)

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
  // used by the on-chain `_verifyPoGSignature` recover path.
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
    gasEth,
    gasToSatoRate,
    maxAllocWei:   maxAlloc.toString(),
  })

  // ── Clean JSON envelope ──────────────────────────────────────────────
  // Proof-of-Gas telemetry fields (`gasEth`, `gasToSatoRate`) are advisory
  // metadata for the UI — the on-chain verifier consumes only `maxAlloc`,
  // `nonce`, `deadline`, `signature`.
  return corsify(req, NextResponse.json({
    signature:     attestationSig,
    maxAlloc:      maxAlloc.toString(),
    nonce:         onchainNonce.toString(),
    deadline:      deadline.toString(),
    issuer:        account.address,
    authDomain:    POG_SCAN_AUTH_DOMAIN,
    gasEth,
    gasToSatoRate,
  }))
}
