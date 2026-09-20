// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'
import { toshToast } from '@/components/ui'

import { PogScanButton } from './PogScanButton'

/**
 * The attestation-signer check, tested through the decision it makes.
 *
 * `sign-allocation` returns `issuer` — the address derived from whichever key
 * the deployment loaded — and until 2026-09-10 the client discarded it,
 * destructuring only the four fields the on-chain verifier consumes. A key that
 * had drifted from `factory.pogSigner()` therefore reached the user as
 * `InvalidSignature()` from `registerPoG`, after the transaction was signed and
 * the gas spent, naming the signature rather than the misconfiguration.
 *
 * What is pinned here is not the string of the message but the branch: whether
 * `registerPoG` is dispatched. That is the whole point of the guard — it exists
 * to stop a doomed transaction — and it is also the only thing a caller can
 * observe. Three of the four cases below assert that the transaction still
 * goes out, because a client-side check that blocks a user the chain would have
 * accepted is worse than the confusing error it replaced.
 *
 * The case-insensitivity test is the one that matters most and is the least
 * obvious. `issuer` arrives EIP-55 checksummed from viem while an `eth_call`
 * result may come back lower-cased, so a naive `!==` on the two strings would
 * report a mismatch for every correctly configured deployment and block every
 * legitimate registration. That failure mode is invisible in staging with a
 * single casing and total in production; it gets its own test.
 */

// `contracts.ts` throws at import without a factory address, and the component
// reads `FACTORY_ADDRESS`/`TARGET_CHAIN_ID` at module scope. Hoisting is the only
// place early enough to beat the static imports above.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const HOOK = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const

/** Checksummed, as viem's `account.address` produces it in the API route. */
const SIGNER = '0x9A1a8C7b7D68d391909F02e8bD5B148b4B95b736' as const
/** A different key entirely — the shape of a half-finished rotation. */
const STRANGER = '0x0E496Bd529646770192C7c35c65Ee1BB0e554E1b' as const

const writeContract = vi.fn()
const signMessageAsync = vi.fn(async () => '0xsig' as `0x${string}`)
/** Set per test: what `factory.pogSigner()` answers, or a rejection. */
let readContract = vi.fn(async () => SIGNER as string)

vi.mock('wagmi', () => ({
  usePublicClient: () => ({ readContract: (...a: unknown[]) => readContract(...(a as [])) }),
  useSignMessage: () => ({ signMessageAsync }),
  useWriteContract: () => ({
    writeContract, writeContractAsync: vi.fn(),
    data: undefined, isPending: false, error: null, reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined, isLoading: false, isSuccess: false, error: null,
  }),
  // `chainId` here, not on `useChainId`: both the wrong-network gate and this
  // button's own `isSupportedPogChain` check read the connection, because the
  // config's chain cannot report a chain the config does not list. A mock
  // without it is a wallet on no chain, which both correctly refuse.
  useAccount: () => ({ isConnected: true, chainId: 97 }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
}))

/**
 * A scan that completes on the POST, so no test waits on the 2 s poll interval.
 * Eligible and above the floor: every blocker before the signer check has to be
 * out of the way, or a test passes because the scan refused rather than because
 * the guard fired.
 */
function stubFetch(allocation: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/pog-scan')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'done',
          eligible: true,
          totalGasWei: '500000000000000000',
          floorWei: '50000000000000000',
          truncated: false,
        }),
      }
    }
    if (String(url).startsWith('/api/sign-allocation')) {
      return { ok: true, status: 200, json: async () => allocation }
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

const ALLOCATION = {
  maxAlloc: '100000000000000000',
  nonce: '0',
  deadline: String(Math.floor(Date.now() / 1000) + 600),
  signature: '0xattestation',
}

/** Click the scan button and let the fetch -> fetch -> read -> send chain settle. */
async function runScan() {
  const ui = mount(<PogScanButton userAddress={USER} hookAddress={HOOK} refetch={vi.fn()} />)
  try {
    await act(async () => { ui.button('Activate deposit quota').click() })
    for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve() })
  } finally {
    ui.unmount()
  }
}

let errors: unknown[]

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  readContract = vi.fn(async () => SIGNER as string)
  errors = []
  vi.spyOn(toshToast, 'fromError').mockImplementation((e) => { errors.push(e) })
  // Returns a toast id, so the stub has to as well or `tsc` rejects the mock.
  vi.spyOn(toshToast, 'info').mockImplementation(() => 'toast-id')
})

function message(): string {
  return errors.map((e) => (e instanceof Error ? e.message : String(e))).join(' | ')
}

describe('attestation signer check', () => {
  it('refuses to send registerPoG when issuer is not the on-chain pogSigner', async () => {
    vi.stubGlobal('fetch', stubFetch({ ...ALLOCATION, issuer: STRANGER }))

    await runScan()

    expect(writeContract).not.toHaveBeenCalled()
    // Both addresses named, because "signer mismatch" alone leaves the operator
    // guessing which of the two stores is the stale one.
    expect(message()).toContain(STRANGER)
    expect(message()).toContain(SIGNER)
    expect(message()).toMatch(/deployment fault/i)
  })

  it('sends when issuer and pogSigner differ only by address casing', async () => {
    // The API checksums; an eth_call result may not. A naive string comparison
    // fails here and would block every correctly configured deployment.
    readContract = vi.fn(async () => SIGNER.toLowerCase())
    vi.stubGlobal('fetch', stubFetch({ ...ALLOCATION, issuer: SIGNER }))

    await runScan()

    expect(errors).toEqual([])
    expect(writeContract).toHaveBeenCalledTimes(1)
    expect(writeContract.mock.calls[0][0]).toMatchObject({ functionName: 'registerPoG' })
  })

  it('sends when the response carries no issuer, leaving the verdict to the chain', async () => {
    // Non-regressive by construction: before this guard existed, every response
    // took this path. A client that hard-failed on a missing field would couple
    // the button to the route's exact shape and could refuse a valid attestation.
    vi.stubGlobal('fetch', stubFetch({ ...ALLOCATION }))

    await runScan()

    expect(errors).toEqual([])
    expect(writeContract).toHaveBeenCalledTimes(1)
  })

  it('sends when pogSigner cannot be read, rather than blocking on an RPC hiccup', async () => {
    readContract = vi.fn(async () => { throw new Error('rpc down') })
    vi.stubGlobal('fetch', stubFetch({ ...ALLOCATION, issuer: SIGNER }))

    await runScan()

    expect(errors).toEqual([])
    expect(writeContract).toHaveBeenCalledTimes(1)
  })
})
