import { NextRequest, NextResponse } from 'next/server'
import {
  isAddress,
  parseEventLogs,
  recoverMessageAddress,
  type Address,
  type Hex,
} from 'viem'
import {
  supabase,
  REGISTRY_READ_DEADLINE_MS,
  REGISTRY_WRITE_DEADLINE_MS,
} from '../../lib/supabase'
import {
  applyCors,
  applyRateLimit,
  corsPreflight,
  readJsonBody,
} from '../../lib/apiGuard'
import { FACTORY_ABI } from '../../lib/abis'
import { assertServerChain, serverPublicClient } from '../../lib/serverRpc'
import { targetChain } from '@/lib/chain'
import { buildProjectAttestationMessage } from '@/lib/projectAttestation'
import { reportError } from '@/lib/observability'

// ─────────────────────────────────────────────────────────────────────────────
// HARDENING POLICIES
// ─────────────────────────────────────────────────────────────────────────────

const CORS_OPTS = { methods: ['GET', 'POST', 'OPTIONS'] as const } as const

/** Generous bucket: 20 burst, refilling at 2/sec.  Honest UIs hit this once on
 *  successful launch tx; bots that try to spam the projects table get blocked. */
const POST_RATE_LIMIT = {
  name: 'projects-post',
  capacity: 20,
  refillPerSec: 2,
} as const

/** GET is cheap and read-only — much higher cap. */
const GET_RATE_LIMIT = {
  name: 'projects-get',
  capacity: 60,
  refillPerSec: 10,
} as const

const FACTORY_ADDRESS = process.env.NEXT_PUBLIC_FACTORY_ADDRESS ?? ''

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req, CORS_OPTS)
}

/**
 * What the chain says about a launch, as opposed to what the caller claims.
 *
 * Everything here is decoded from the `LaunchCreated` log in the transaction's
 * own receipt, so it cannot be supplied, guessed, or front-run.
 */
interface OnChainLaunch {
  creator: Address
  token:   Address
  hook:    Address
  name:    string
  symbol:  string
}

/**
 * Resolve `txHash` to the launch it created, or explain why it is not one.
 *
 * Fails closed on an RPC outage with a 503 rather than a 4xx, because the two
 * are very different stories for whoever is on call: "we could not check" must
 * never be filed as "the caller lied".
 */
async function readLaunchFromChain(
  txHash: Hex,
): Promise<{ launch: OnChainLaunch } | { error: NextResponse }> {
  if (!FACTORY_ADDRESS || !isAddress(FACTORY_ADDRESS)) {
    console.error('[Tosh API] NEXT_PUBLIC_FACTORY_ADDRESS is unset or malformed')
    return {
      error: NextResponse.json(
        { error: 'Project verification is not configured on this deployment' },
        { status: 503 },
      ),
    }
  }

  // The creator identity that authorises this listing is read out of the
  // receipt, so the receipt has to come from the chain this deployment
  // actually serves. Read it from the wrong one and a launch minted on a free
  // testnet authenticates a listing in the mainnet directory: the caller
  // genuinely is that launch's creator, the signature genuinely verifies, and
  // the row is still a forgery. Endpoint selection is chain-scoped now, but a
  // wrong URL under the right name is still possible, and this is the one
  // caller where being wrong hands out someone else's name.
  if (!(await assertServerChain())) {
    console.error(
      `[Tosh API] RPC for chain ${targetChain.id} does not report that chain id — ` +
      'refusing to authenticate a listing against it',
    )
    return {
      error: NextResponse.json(
        { error: 'Project verification is not configured on this deployment' },
        { status: 503 },
      ),
    }
  }

  const client = serverPublicClient()

  let receipt
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash })
  } catch (err) {
    // viem throws for "not found" as well as for transport faults, and the two
    // are indistinguishable here without parsing messages. A pending or
    // unknown hash is the caller's problem (404); anything else is ours — but
    // guessing wrong in the safe direction just means an honest creator
    // retries, so treat it as not-yet-visible and report it for the on-call.
    reportError(err, {
      surface: 'api-route',
      extra: { route: 'POST /api/projects', stage: 'getTransactionReceipt' },
    })
    return {
      error: NextResponse.json(
        { error: 'That transaction is not visible on chain yet' },
        { status: 404 },
      ),
    }
  }

  if (receipt.status !== 'success') {
    return {
      error: NextResponse.json({ error: 'That transaction reverted' }, { status: 422 }),
    }
  }

  // Scoped to the factory's own logs: any contract may emit an event with the
  // same signature, and an attacker who could point this at their own emitter
  // would be back to naming themselves creator.
  const logs = parseEventLogs({
    abi: FACTORY_ABI,
    eventName: 'LaunchCreated',
    logs: receipt.logs.filter(
      (l) => l.address.toLowerCase() === FACTORY_ADDRESS.toLowerCase(),
    ),
  })

  if (logs.length === 0) {
    return {
      error: NextResponse.json(
        { error: 'That transaction did not create a launch' },
        { status: 422 },
      ),
    }
  }

  const args = logs[0].args as {
    creator: Address; token: Address; hook: Address; name: string; symbol: string
  }
  return {
    launch: {
      creator: args.creator,
      token:   args.token,
      hook:    args.hook,
      name:    args.name,
      symbol:  args.symbol,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared payload type — imported by page.tsx for the POST body
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Only the fields the caller is actually allowed to choose.
 *
 * `tokenAddress`, `hookAddress`, `name` and `symbol` used to be here and are
 * gone on purpose: all four are in the `LaunchCreated` event, so the server
 * reads them from the receipt instead of believing the body. A payload that
 * cannot express them is a payload that cannot lie about them.
 */
export interface ProjectPayload {
  txHash:       string
  logoUrl:      string
  website:      string
  twitter:      string
  telegram:     string
  description?: string
  /** personal_sign over `buildProjectAttestationMessage`, by the creator. */
  signature:    string
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/projects — insert a new project row after on-chain confirmation
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const limited = await applyRateLimit(req, POST_RATE_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const parsed = await readJsonBody<ProjectPayload>(req)
  if (parsed.error) return applyCors(parsed.error, req, CORS_OPTS)
  const body = parsed.data

  const { txHash, logoUrl, website, twitter, telegram, description, signature } = body

  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return applyCors(
      NextResponse.json({ error: 'txHash must be a 32-byte hex string' }, { status: 422 }),
      req,
      CORS_OPTS,
    )
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return applyCors(
      NextResponse.json({ error: 'signature (hex string) required' }, { status: 401 }),
      req,
      CORS_OPTS,
    )
  }

  // ── Does this launch exist? ────────────────────────────────────────────────
  const chain = await readLaunchFromChain(txHash as Hex)
  if ('error' in chain) return applyCors(chain.error, req, CORS_OPTS)
  const launch = chain.launch

  // ── Is the caller the creator? ─────────────────────────────────────────────
  const message = buildProjectAttestationMessage({
    chainId:     targetChain.id,
    txHash,
    logoUrl:     logoUrl     ?? '',
    website:     website     ?? '',
    twitter:     twitter     ?? '',
    telegram:    telegram    ?? '',
    description: description ?? '',
  })

  let signer: Address
  try {
    signer = await recoverMessageAddress({ message, signature: signature as Hex })
  } catch {
    return applyCors(
      NextResponse.json({ error: 'Invalid signature' }, { status: 401 }),
      req,
      CORS_OPTS,
    )
  }

  if (signer.toLowerCase() !== launch.creator.toLowerCase()) {
    console.warn('[Tosh API] project metadata signed by a non-creator', {
      txHash, signer, creator: launch.creator,
    })
    return applyCors(
      NextResponse.json(
        { error: 'That signature is not from the address that created this launch' },
        { status: 403 },
      ),
      req,
      CORS_OPTS,
    )
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({
      // Identity from the chain, presentation from the (now authenticated) body.
      tx_hash:       txHash,
      token_address: launch.token,
      hook_address:  launch.hook,
      name:          launch.name,
      symbol:        launch.symbol,
      logo_url:  logoUrl  || null,
      website:   website  || null,
      twitter:   twitter  || null,
      telegram:  telegram || null,
      description: description?.trim() || null,
    })
    .select()
    // Before `.single()`: that returns the terminal builder, which no longer
    // carries the transform methods.
    .abortSignal(AbortSignal.timeout(REGISTRY_WRITE_DEADLINE_MS))
    .single()

  if (error) {
    if (error.code === '23505') {
      return applyCors(
        NextResponse.json({ ok: true, duplicate: true }, { status: 200 }),
        req,
        CORS_OPTS
      )
    }
    console.error('[Tosh API] Supabase insert error:', error)
    // Next's `onRequestError` hook only sees uncaught throws. A handled error
    // returned as a 500 is invisible to it, so report it explicitly (#26).
    reportError(error, {
      surface: 'api-route',
      extra: { route: 'POST /api/projects', code: error.code },
    })
    return applyCors(
      // The detail goes to the on-call, not to the caller: Supabase errors can
      // name columns and constraints, and this route is public.
      NextResponse.json({ error: 'Failed to record the project' }, { status: 500 }),
      req,
      CORS_OPTS
    )
  }

  console.log('[Tosh API] Project inserted:', data)
  return applyCors(
    NextResponse.json({ ok: true, data }, { status: 200 }),
    req,
    CORS_OPTS
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/projects — return all projects ordered by newest first
// ─────────────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const limited = await applyRateLimit(req, GET_RATE_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })
    .abortSignal(AbortSignal.timeout(REGISTRY_READ_DEADLINE_MS))

  if (error) {
    console.error('[Tosh API] Supabase select error:', error)
    reportError(error, {
      surface: 'api-route',
      extra: { route: 'GET /api/projects', code: error.code },
    })
    // 503, not 500, and for the same reason `lookup` returns 503 rather than
    // 404: "the registry is unreachable" is a transient condition the caller
    // should retry, not a defect in the request it just made. `no-store` keeps
    // a CDN from pinning the outage, and `Retry-After` matches lookup's.
    //
    // The directory tolerates this — it renders from chain and overlays
    // registry metadata when it arrives — so failing fast and honestly is
    // strictly better than the fourteen-second 500 this used to be.
    return applyCors(
      NextResponse.json(
        { error: 'registry unreachable' },
        { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } },
      ),
      req,
      CORS_OPTS
    )
  }

  return applyCors(
    NextResponse.json({ ok: true, data }, { status: 200 }),
    req,
    CORS_OPTS
  )
}
