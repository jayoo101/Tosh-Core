import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverMessageAddress, type Address, type Hex } from 'viem'
import { buildAdminConfigMessage, SIGNATURE_WINDOW_SEC } from '@/lib/adminConfigMessage'

/**
 * The one property these tests exist for: the owner is a 2-of-3 Gnosis Safe, and
 * a Safe cannot produce an ECDSA signature over anything.
 *
 * The route used to `recoverMessageAddress` and compare the result to `owner()`.
 * Against a Safe that comparison can never hold — a recovery returns whichever
 * signer's EOA held the pen, never the contract — so every well-formed request
 * 403'd for every possible input. With `ADMIN_SECRET` pinned `absent` by
 * `checkSecretStore.mjs`, the endpoint had no reachable arm at all and the PoG
 * exchange rate was frozen at its seeded value.
 *
 * There was no test file here at all, which is why "the dial is documented" and
 * "the dial can be turned" stayed different facts for as long as they did. The
 * Safe case below is the regression test.
 */

const FACTORY = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
/** Stands in for the Safe. Nothing signs as this address, which is the point. */
const SAFE    = '0x1111111111111111111111111111111111111111'

const SIGNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const signerEoa  = privateKeyToAccount(SIGNER_KEY)

// ── Mocked collaborators ─────────────────────────────────────────────────────
let owner: Address | null
let chainOk: boolean

/** Overrides the default (real EOA recovery) for the contract and outage cases. */
let verifyImpl: (() => Promise<boolean>) | null

/** `'0x'` for an EOA, anything else for a contract, null to fail the read. */
let ownerCode: Hex | null

/**
 * Which store the replay guard reports.
 *
 * Only `adminNonceBackendKind` is replaced — `claimAdminNonce` and
 * `lastSeenAdminNonce` run for real, in their in-process mode. That split is
 * deliberate: it lets these tests drive the window decision, which is what the
 * route owns, while the guard's own monotonicity stays under test rather than
 * stubbed into always agreeing. The store's Redis arm is covered in
 * `app/lib/adminNonce.test.ts`.
 */
let nonceStoreKind: 'memory' | 'redis'

/** Overrides the real (in-process) claim, for the store-outage case only. */
let claimImpl: (() => Promise<'claimed' | 'replayed' | 'unavailable'>) | null

/** The factory's live per-wallet ceiling. `null` fails the read, which the route
 *  must treat as "cannot check" rather than "no ceiling". */
let onChainPogLimit: bigint | null

const verifyCalls: { address: Address; message: string; signature: Hex }[] = []
const applied: { rate?: number; floorWei?: bigint; maxAllocWei?: bigint }[] = []

vi.mock('@/app/lib/serverRpc', () => ({
  assertServerChain: async () => chainOk,
  serverPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'maxPogAllocationLimit') {
        if (onChainPogLimit === null) throw new Error('rpc down')
        return onChainPogLimit
      }
      if (owner === null) throw new Error('rpc down')
      return owner
    },
    getCode: async () => {
      if (ownerCode === null) throw new Error('rpc down')
      return ownerCode
    },
    // Default behaviour is viem's real EOA semantics, so the EOA test below is
    // an end-to-end recovery rather than a stub agreeing with itself. Only the
    // contract and outage cases replace it.
    verifyMessage: async ({ address, message, signature }: {
      address: Address; message: string; signature: Hex
    }) => {
      verifyCalls.push({ address, message, signature })
      if (verifyImpl) return verifyImpl()
      const recovered = await recoverMessageAddress({ message, signature })
      return recovered.toLowerCase() === address.toLowerCase()
    },
  }),
}))

vi.mock('@/app/lib/adminNonce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/adminNonce')>()
  return {
    ...actual,
    adminNonceBackendKind: () => nonceStoreKind,
    claimAdminNonce: async (n: bigint) =>
      claimImpl ? claimImpl() : actual.claimAdminNonce(n),
  }
})

/** The band the store is holding before each request. `parseWeiDial` is NOT
 *  stubbed — it is the parser the route depends on to refuse a wei figure that
 *  arrived as a double, so stubbing it would stub out the property under test. */
vi.mock('@/app/lib/pogParams', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/pogParams')>()
  return {
    ...actual,
    pogParamsBackendKind: () => 'memory',
    getPogBand: async () => ({
      rate: 0.5,
      floorWei: 25_000_000_000_000_000n,
      maxAllocWei: 500_000_000_000_000_000n,
    }),
    setPogBand: async (next: { rate?: number; floorWei?: bigint; maxAllocWei?: bigint }) => {
      applied.push(next)
      return { rate: 0.5, floorWei: 25_000_000_000_000_000n, maxAllocWei: 500_000_000_000_000_000n }
    },
  }
})

vi.mock('@/lib/observability', () => ({ reportError: () => {} }))

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', FACTORY)
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337')
  vi.stubEnv('ADMIN_SECRET', '')
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined as unknown as string)
  owner = SAFE
  ownerCode = '0xfe'          // matches the default owner: a contract
  chainOk = true
  onChainPogLimit = 500_000_000_000_000_000n   // 0.5 ETH, the deployed default
  nonceStoreKind = 'redis'    // the posture production is meant to run in
  verifyImpl = null
  claimImpl = null
  verifyCalls.length = 0
  applied.length = 0
  // The replay guard lives on `globalThis` so it survives hot reloads, which
  // also means `vi.resetModules()` does not clear it and every nonce spent in an
  // earlier test would still be spent here.
  ;(globalThis as Record<string, unknown>).__toshAdminNonce = 0n
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The canonical builder, imported rather than reimplemented.
 *
 * This used to be a hand copy carrying a comment claiming a divergence from the
 * route "should fail loudly". It could not: two independent copies of a template
 * agree until someone edits one, and then the test signs what the test expects
 * and passes while the real UI signs something the real route rejects. Importing
 * the one definition is what makes that comment true.
 */
const signable = buildAdminConfigMessage

/** A distinct source IP per call — the POST limiter is 3-burst, 1 token per 30s,
 *  so a shared IP would turn the fourth assertion in this file into a 429. */
let ipSeq = 0

async function post(body: unknown) {
  const { POST } = await import('./route')
  return POST(new NextRequest('https://tosh.test/api/admin/config', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `203.0.113.${ipSeq++ % 250}`,
    },
    body: JSON.stringify(body),
  }))
}

/** A request that is valid in every respect except whatever the test changes. */
async function signedPost(over: {
  rate?: number
  floorWei?: string
  maxAllocWei?: string
  nonce?: number
  expiresAt?: number
  signature?: Hex
} = {}) {
  const rate      = over.rate ?? 0.2
  const nonce     = over.nonce ?? 1
  const expiresAt = over.expiresAt ?? Math.floor(Date.now() / 1000) + 120
  const floorWei    = over.floorWei ?? null
  const maxAllocWei = over.maxAllocWei ?? null
  const signature = over.signature
    ?? await signerEoa.signMessage({
      message: signable({ rate, floorWei, maxAllocWei, nonce, expiresAt }),
    })
  return post({
    newRate: rate,
    ...(floorWei !== null && { newFloorWei: floorWei }),
    ...(maxAllocWei !== null && { newMaxAllocWei: maxAllocWei }),
    nonce,
    expiresAt,
    signature,
  })
}

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/config — owner is a Safe', () => {
  it('accepts a signature the Safe validates, though no EOA recovers to it', async () => {
    // The exact shape that used to be impossible: ERC-1271 says yes, and the
    // recovered EOA is not the owner and never could be.
    verifyImpl = async () => true

    const res = await signedPost({ rate: 0.2 })

    expect(res.status).toBe(200)
    expect(applied).toEqual([{ rate: 0.2 }])
    expect(verifyCalls).toHaveLength(1)
    expect(verifyCalls[0].address).toBe(SAFE)
  })

  it('credits the update to the Safe, not to the EOA that held the pen', async () => {
    // For a Safe these differ, and only one of them has any standing here.
    // Naming the EOA would point the audit trail at a wallet that is not the
    // owner and cannot become one. Asserted on the log rather than the response
    // because the log is where the audit trail actually lives — `applyUpdate`
    // does not put `signer` in the body.
    verifyImpl = async () => true
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await signedPost()

    const entry = log.mock.calls.find(([msg]) => msg === '[admin/config] band updated')
    expect(entry?.[1]).toMatchObject({ signer: SAFE, authMethod: 'owner-signature' })
    expect(signerEoa.address).not.toBe(SAFE)
    log.mockRestore()
  })

  it('rejects with 403 when the Safe does not validate the signature', async () => {
    verifyImpl = async () => false

    const res = await signedPost()

    expect(res.status).toBe(403)
    expect(applied).toEqual([])
  })

  it('signs over the canonical message, so the UI and the server agree', async () => {
    verifyImpl = async () => true
    const expiresAt = Math.floor(Date.now() / 1000) + 60

    await signedPost({ rate: 0.25, nonce: 7, expiresAt })

    expect(verifyCalls[0].message).toBe(signable({
      rate: 0.25, floorWei: null, maxAllocWei: null, nonce: 7, expiresAt,
    }))
  })
})

describe('POST /api/admin/config — the floor and the ceiling', () => {
  beforeEach(() => { verifyImpl = async () => true })

  it('rotates all three dials in one signed instruction', async () => {
    const res = await signedPost({
      rate: 0.4, floorWei: '10000000000000000', maxAllocWei: '400000000000000000',
    })

    expect(res.status).toBe(200)
    expect(applied).toEqual([{
      rate: 0.4,
      floorWei: 10_000_000_000_000_000n,
      maxAllocWei: 400_000_000_000_000_000n,
    }])
  })

  it('leaves an omitted dial alone rather than resetting it', async () => {
    const res = await signedPost({ rate: 0.4 })

    expect(res.status).toBe(200)
    expect(applied).toEqual([{ rate: 0.4 }])
  })

  it('refuses a ceiling above the factory dial, which would brick registerPoG', async () => {
    // The failure this check exists for: an attestation over the on-chain limit
    // reverts `ExceedsGlobalPogLimit` for every wallet at once, and the only
    // symptom is activations failing after the site promised a quota.
    const res = await signedPost({ rate: 0.5, maxAllocWei: '600000000000000000' })

    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/setMaxPogAllocationLimit/)
    expect(applied).toEqual([])
  })

  it('allows lowering the ceiling, which is always safe on chain', async () => {
    const res = await signedPost({ rate: 0.5, maxAllocWei: '100000000000000000' })

    expect(res.status).toBe(200)
    expect(applied).toEqual([{ rate: 0.5, maxAllocWei: 100_000_000_000_000_000n }])
  })

  it('answers 503 when the on-chain ceiling cannot be read', async () => {
    // Guessing either way is worse: "no ceiling" lets a bricking rotation
    // through, and "zero" refuses the ones that lower the dial.
    onChainPogLimit = null

    const res = await signedPost({ rate: 0.5, maxAllocWei: '100000000000000000' })

    expect(res.status).toBe(503)
    expect(applied).toEqual([])
  })

  it('refuses a wei dial sent as a JSON number', async () => {
    // A wei figure in a JSON number has already been through a double, and the
    // signature was over the decimal string — so accepting one would reject the
    // owner's own request under a signature error instead of this one.
    const nonce = 11
    const expiresAt = Math.floor(Date.now() / 1000) + 120
    const signature = await signerEoa.signMessage({
      message: signable({ rate: 0.5, floorWei: '25000000000000000', nonce, expiresAt }),
    })
    const res = await post({
      newRate: 0.5, newFloorWei: 25_000_000_000_000_000, nonce, expiresAt, signature,
    })

    expect(res.status).toBe(400)
    expect(applied).toEqual([])
  })

  it('refuses a floor that sits above the cap, collapsing the band', async () => {
    /*
     * Above the cap every eligible wallet gets the whole ceiling, so the gas history
     * stops ranking anybody — a band nobody would choose on purpose.
     *
     * ALL THREE DIALS ARE POSTED, where this used to send only the rate and the floor
     * and let the ceiling default. That made the fixture depend on
     * `DEFAULT_POG_MAX_ALLOC_WEI`, and it stopped testing anything when the quote-asset
     * re-denomination moved that constant: a 5 ETH floor against the new 46.4-unit
     * ceiling at rate 0.5 puts the cap at 92.8 ETH, so the band became perfectly
     * coherent and the assertion failed on a 200. Naming the ceiling here keeps the
     * arithmetic self-contained: 1-unit ceiling ÷ rate 0.5 caps gas at 2 ETH, and the
     * 5 ETH floor sits above it.
     */
    const res = await signedPost({
      rate: 0.5,
      floorWei: '5000000000000000000', // 5 ETH of gas
      maxAllocWei: '100000000',        // 1 quote unit
    })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/incoherent band/)
    expect(applied).toEqual([])
  })

  it('rejects a dial the signed message did not name', async () => {
    // The attack the sentinel exists to block: sign "rate only", then add a
    // ceiling to the body on the way through.
    const nonce = 12
    const expiresAt = Math.floor(Date.now() / 1000) + 120
    const signature = await signerEoa.signMessage({
      message: signable({ rate: 0.5, nonce, expiresAt }),
    })
    verifyImpl = null                 // real recovery, so the message matters
    owner = signerEoa.address
    ownerCode = '0x'

    const res = await post({
      newRate: 0.5, newMaxAllocWei: '100000000000000000', nonce, expiresAt, signature,
    })

    expect(res.status).toBe(403)
    expect(applied).toEqual([])
  })
})

describe('POST /api/admin/config — owner is an EOA', () => {
  beforeEach(() => { ownerCode = '0x' })

  it('still accepts the owner EOA\'s own signature', async () => {
    // The contract arm must not have cost the EOA arm. `verifyImpl` stays null,
    // so this runs a real recovery against a real signature.
    owner = signerEoa.address

    const res = await signedPost()

    expect(res.status).toBe(200)
    expect(applied).toEqual([{ rate: 0.2 }])
  })

  it('rejects a signature from someone who is not the owner', async () => {
    owner = SAFE  // signerEoa is not the owner, and no 1271 stub rescues it

    const res = await signedPost()

    expect(res.status).toBe(403)
    expect(applied).toEqual([])
  })
})

describe('POST /api/admin/config — failures that must not read as denials', () => {
  it('answers 503, not 403, when the verification could not be performed', async () => {
    // The distinction is the whole point: 403 sends an admin to look at their
    // wallet while the fault is in the network. Same reasoning as
    // `readChainOwner` returning null rather than throwing.
    verifyImpl = async () => { throw new Error('rpc down') }

    const res = await signedPost()

    expect(res.status).toBe(503)
    expect(applied).toEqual([])
  })

  it('answers 503 when the owner cannot be read at all', async () => {
    owner = null

    const res = await signedPost()

    expect(res.status).toBe(503)
    expect(verifyCalls).toEqual([])  // nothing to verify against
  })

  it('refuses to check the signature against an owner from another chain', async () => {
    // A wrong-chain `owner()` would be a different Safe, or an EOA, and either
    // would be answering a question about the wrong deployment.
    chainOk = false

    const res = await signedPost()

    expect(res.status).toBe(503)
    expect(applied).toEqual([])
  })
})

describe('POST /api/admin/config — replay', () => {
  it('rejects a replayed nonce even when the signature is valid', async () => {
    verifyImpl = async () => true

    const first = await signedPost({ nonce: 5 })
    expect(first.status).toBe(200)

    const replay = await signedPost({ nonce: 5 })
    expect(replay.status).toBe(409)
    expect(applied).toHaveLength(1)
  })

  it('refuses to apply when the nonce could not be recorded', async () => {
    // Failing open here would turn a store outage into a replay window, so the
    // rotation is abandoned rather than applied unguarded. 503, not 409: nothing
    // says this nonce was used, only that we cannot tell.
    verifyImpl = async () => true
    claimImpl = async () => 'unavailable'

    const res = await signedPost()

    expect(res.status).toBe(503)
    expect(applied).toEqual([])
  })

  it('rejects a nonce past the range the shared guard can compare', async () => {
    // The Lua comparison goes through `tonumber`, so above 2^53 adjacent nonces
    // are indistinguishable and monotonicity quietly stops holding. Accepting
    // one would disable the guard rather than merely stretch it.
    verifyImpl = async () => true

    const res = await signedPost({ nonce: Number.MAX_SAFE_INTEGER + 4096 })

    expect(res.status).toBe(400)
    expect(applied).toEqual([])
  })
})

describe('POST /api/admin/config — the signature window is sized to the signer', () => {
  it('gives a contract owner long enough to collect a second confirmation', async () => {
    // The property the Safe path needs and did not have. At the old flat
    // five-minute cap this exact request was a 400, which is why production
    // still reported `lastSeenNonce: 0` after the ERC-1271 arm had landed: two
    // people on two devices cannot both confirm inside five minutes.
    verifyImpl = async () => true
    const expiresAt = Math.floor(Date.now() / 1000) + 6 * 60 * 60

    const res = await signedPost({ expiresAt })

    expect(res.status).toBe(200)
    expect(SIGNATURE_WINDOW_SEC.contract).toBeGreaterThan(6 * 60 * 60)
  })

  it('keeps the tight window for an EOA owner, which signs in one gesture', async () => {
    owner = signerEoa.address
    ownerCode = '0x'
    const expiresAt = Math.floor(Date.now() / 1000) + SIGNATURE_WINDOW_SEC.eoa + 60

    const res = await signedPost({ expiresAt })

    expect(res.status).toBe(400)
    expect(applied).toEqual([])
  })

  it('will not grant the long window while the replay guard is per-instance', async () => {
    // Without a shared store the nonce resets to zero on every restart, and then
    // `expiresAt` is the only thing refusing an old captured payload. A wide
    // window in that posture is a rate-downgrade window, so it is withheld —
    // and the rejection says why, because otherwise it reads as a clock problem.
    verifyImpl = async () => true
    nonceStoreKind = 'memory'
    const expiresAt = Math.floor(Date.now() / 1000) + 6 * 60 * 60

    const res = await signedPost({ expiresAt })

    expect(res.status).toBe(400)
    expect((await res.json()).hint).toMatch(/UPSTASH_REDIS_REST_URL/)
  })

  it('answers 503 when the owner\'s shape cannot be read', async () => {
    // The window depends on this answer, so guessing would either hand a Safe
    // operator a spurious expiry or silently widen the window on an EOA.
    ownerCode = null

    const res = await signedPost()

    expect(res.status).toBe(503)
    expect(applied).toEqual([])
  })
})
