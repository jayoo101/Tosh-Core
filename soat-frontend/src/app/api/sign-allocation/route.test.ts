import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * Two properties of the attestation the oracle signs, both of which were
 * decided by values that arrived from the request or from a clock nobody was
 * comparing.
 *
 * The wallet-auth recovery is mocked to succeed: what is under test is what the
 * route puts in the digest once a caller is authenticated, not whether EIP-191
 * recovery works.
 */

// A throwaway key. The address it derives is asserted only against itself.
const TEST_PK = `0x${'11'.repeat(32)}`
const FACTORY = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

/** Mirrors `ToshFactory.MAX_SIG_VALIDITY`, which is the ceiling under test. */
const MAX_SIG_VALIDITY_SEC = 24 * 60 * 60

let authRecovers: boolean

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return { ...actual, verifyMessage: async () => authRecovers }
})

/**
 * `pogSigner` is what the factory will accept, so by default it answers with the
 * address `TEST_PK` derives — the agreeing case, which is the precondition for
 * every other assertion here rather than the thing one of them measures.
 */
let onchainSigner: string
vi.mock('@/app/lib/onchainNonce', () => ({
  fetchPogNonce:  async () => 0n,
  fetchPogSigner: async () => onchainSigner,
}))
vi.mock('@/lib/observability', () => ({ reportError: () => {} }))

/**
 * The route reads a finished scan rather than doing the work — PM-F9 moved the
 * five-chain read into `/api/pog-scan`, because it measured 10–23 s and cannot
 * sit inside the request that signs. So a signable request needs a fresh `done`
 * job on file, and these tests supply one comfortably above the floor.
 *
 * Stubbed rather than exercised: what is under test here is the deadline and the
 * contract address, and a real scan would make both depend on five live hosts.
 */
let scannedWei: bigint
vi.mock('@/app/lib/scanJobStore', () => ({
  readScanJob: async (address: string) => ({
    status: 'done' as const,
    address: address.toLowerCase(),
    startedAt: Date.now(),
    finishedAt: Date.now(),
    result: {
      chains: [{
        chain: 'Ethereum', chainId: 1, weiSpent: scannedWei.toString(),
        sentTxs: 42, truncated: false, stoppedAtCap: false, skipped: false,
        execFeeOnly: false,
      }],
      totalWei: scannedWei.toString(),
      truncated: false,
      scannedAt: Date.now(),
    },
  }),
  isFresh: () => true,
  JOB_LEASE_MS: 120_000,
  RESULT_TTL_MS: 60 * 60 * 1000,
}))

beforeEach(() => {
  authRecovers = true
  // Above POG_GAS_FLOOR_WEI (0.05 ETH) and under the 1 ETH cap, so eligibility
  // is not what any of these assertions is measuring.
  scannedWei = 2n * 10n ** 17n // 0.2 ETH
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', FACTORY)
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337')
  vi.stubEnv('POG_SIGNER_PRIVATE_KEY', TEST_PK)
  onchainSigner = privateKeyToAccount(TEST_PK as `0x${string}`).address
  // Keep the limiter and the rate store in-process.
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined as unknown as string)
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined as unknown as string)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

let ipSeq = 0
async function post(body: Record<string, unknown> = {}) {
  const { POST } = await import('./route')
  return POST(new Request('https://tosh.test/api/sign-allocation', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // A distinct bucket per call: this endpoint's limiter is 5 tokens.
      'x-vercel-forwarded-for': `203.0.113.${ipSeq++ % 250}`,
    },
    body: JSON.stringify({
      userAddress: USER,
      contractAddress: FACTORY,
      chainId: 31337,
      timestamp: Date.now(),
      signature: `0x${'cd'.repeat(65)}`,
      ...body,
    }),
  }))
}

describe('POST /api/sign-allocation — what ends up in the digest', () => {
  it('leaves headroom between the deadline it signs and the on-chain ceiling', async () => {
    // The on-chain check is `deadline > block.timestamp + MAX_SIG_VALIDITY ->
    // revert SignatureTooLong`. Signing `deadline = serverNow + MAX_SIG_VALIDITY`
    // cancels both ceiling terms and reduces the condition to
    // `serverNow > block.timestamp` — so every attestation was valid only while
    // this host's clock sat at or behind the mining block's timestamp, and a
    // one-second fast clock, or a chain whose timestamps lag wall time, failed
    // 100% of registrations under an error name about signature length.
    const before = Math.floor(Date.now() / 1000)
    const res = await post()
    expect(res.status).toBe(200)

    const { deadline } = await res.json()
    const margin = (before + MAX_SIG_VALIDITY_SEC) - Number(deadline)

    // Strictly positive is the property; the rest pins it somewhere useful
    // rather than at one second, which would satisfy "has margin" and tolerate
    // no real skew at all.
    expect(margin).toBeGreaterThanOrEqual(30 * 60)
    expect(Number(deadline)).toBeGreaterThan(before)
  })

  it('refuses to sign for a contract address the caller chose', async () => {
    // Not exploitable at the factory, which hashes `address(this)` — a
    // signature naming anything else cannot recover there. It is refused
    // because the endpoint was otherwise a service that would attest "<wallet>
    // may claim <amount> at <any address you name>", and those signatures
    // outlive the assumption that no second contract trusts `pogSigner`.
    const res = await post({ contractAddress: '0x000000000000000000000000000000000000dEaD' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/factory/i)
  })

  it('refuses to sign with a key the factory will not accept', async () => {
    // The failure this replaces was not a rejection, it was a 200. A key that
    // parses but belongs to another address signs a well-formed attestation, so
    // the route answered success and `registerPoG` reverted on the recovered
    // signer — every user paying gas to discover a server misconfiguration,
    // with nothing server-side recording one.
    //
    // It is worth checking on every request, not at boot, because the
    // production key is write-only in Vercel: no guard script and no CI job can
    // read the value in use, so signing time is the only place the comparison
    // can happen at all.
    onchainSigner = '0x000000000000000000000000000000000000dEaD'
    const res = await post()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/misconfigured/i)
  })

  it('still rejects a well-formed request whose wallet auth does not recover', async () => {
    // The mirror: pinning the contract must not have moved the check that
    // actually authenticates the claimant.
    authRecovers = false
    const res = await post()
    expect(res.status).toBe(401)
  })
})
