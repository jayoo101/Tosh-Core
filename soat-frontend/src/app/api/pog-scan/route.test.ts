import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What bounds the cost of a Proof-of-Gas scan.
 *
 * The scan reads five public Blockscout instances that charge nothing and owe us
 * nothing. Wallet auth proves a caller controls the address it names, but
 * keypairs are free, so auth bounds nothing an attacker cares about: every fresh
 * address is a fresh cache key and therefore a real five-chain read. The per-IP
 * bucket is the only other gate, and a proxy pool multiplies it. So the budgets
 * below are what stands between a rented botnet and an IP ban that would fail
 * every scan closed — which, since scanning gates genesis allocation, is a
 * denial of service on the launch delivered by us to ourselves.
 *
 * These tests are about the route's wiring rather than the limiter's arithmetic
 * (`apiGuard.test.ts` covers that): which keys get charged, in what order, and —
 * the part that is easy to get backwards — which requests are free.
 */

const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const SUPPORTED_CHAIN = 4663

let authRecovers: boolean

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return { ...actual, verifyMessage: async () => authRecovers }
})

/** `after()` would run the real five-chain scan. Swallowed, and recorded so the
 *  tests can assert a scan was or was not scheduled. */
let scheduled: number
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: () => { scheduled += 1 } }
})

vi.mock('@/lib/observability', () => ({ reportError: () => {} }))
vi.mock('@/app/lib/gasHistory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/gasHistory')>()
  return { ...actual, scanGasHistory: async () => { throw new Error('not in this test') } }
})
vi.mock('@/app/lib/gasToSatoRate', () => ({ getGasToSatoRate: async () => 0.1 }))

/** The IP bucket is not what these tests are measuring; it has its own file. */
vi.mock('@/app/lib/apiGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/apiGuard')>()
  return { ...actual, applyRateLimit: async () => null }
})

// ─── The store, as a plain map so the tests can see what survived ────────────

type Job = {
  status: 'running' | 'done' | 'failed'
  address: string
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
}

let store: Map<string, Job>
let freshness: boolean

vi.mock('@/app/lib/scanJobStore', () => ({
  readScanJob: async (a: string) => store.get(a.toLowerCase()) ?? null,
  startScanJob: async (a: string) => {
    const job: Job = { status: 'running', address: a.toLowerCase(), startedAt: Date.now() }
    store.set(a.toLowerCase(), job)
    return job
  },
  finishScanJob: async () => {},
  failScanJob: async () => {},
  clearScanJob: async (a: string) => { store.delete(a.toLowerCase()) },
  isFresh: () => freshness,
  JOB_LEASE_MS: 120_000,
  RESULT_TTL_MS: 60 * 60 * 1000,
}))

// ─── The limiter, as a recorder the tests can make refuse ────────────────────

let charged: string[]
let refuse: Set<string>

vi.mock('@/app/lib/rateLimitStore', () => ({
  consumeRateLimit: async (id: string) => {
    charged.push(id)
    return refuse.has(id)
      ? { ok: false, remaining: 0, resetMs: 900_000, degraded: false }
      : { ok: true, remaining: 5, resetMs: 0, degraded: false }
  },
}))

const GLOBAL_KEY = 'pog-scan:global'
const ADDRESS_KEY = `pog-scan:addr:${USER.toLowerCase()}`

async function post(body: Record<string, unknown> = {}) {
  const { POST } = await import('./route')
  return POST(new Request('https://tosh.test/api/pog-scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://tosh.test' },
    body: JSON.stringify({
      userAddress: USER,
      chainId: SUPPORTED_CHAIN,
      timestamp: Date.now(),
      signature: `0x${'ab'.repeat(65)}`,
      ...body,
    }),
  }))
}

function doneJob(): Job {
  return {
    status: 'done',
    address: USER.toLowerCase(),
    startedAt: Date.now(),
    finishedAt: Date.now(),
    result: { chains: [], totalWei: '1000', truncated: false, scannedAt: Date.now() },
  }
}

beforeEach(() => {
  authRecovers = true
  scheduled = 0
  store = new Map()
  freshness = true
  charged = []
  refuse = new Set()
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0')
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', String(SUPPORTED_CHAIN))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('POST /api/pog-scan — what bounds the upstream cost', () => {
  it('charges both budgets and starts a scan when there is nothing cached', async () => {
    const res = await post()
    expect(res.status).toBe(202)
    expect(charged).toEqual([GLOBAL_KEY, ADDRESS_KEY])
    expect(scheduled).toBe(1)
  })

  it('charges the global budget before the per-address one', async () => {
    // Order is load-bearing during an attack. If the address bucket went first,
    // a flood that exhausts the global ceiling would also spend every waiting
    // user's own allowance on discovering that fact, locking honest callers out
    // for the hour on top of the outage they were already suffering.
    refuse.add(GLOBAL_KEY)
    const res = await post()
    expect(res.status).toBe(503)
    expect(charged).toEqual([GLOBAL_KEY])
    expect(charged).not.toContain(ADDRESS_KEY)
  })

  it('tells a caller how long to wait instead of inviting a poll', async () => {
    refuse.add(GLOBAL_KEY)
    const res = await post()
    expect(res.headers.get('Retry-After')).toBe('900')
    await expect(res.json()).resolves.toMatchObject({ retryAfterMs: 900_000 })
  })

  it('refuses one address that has scanned enough, without blaming the service', async () => {
    refuse.add(ADDRESS_KEY)
    const res = await post()
    // 429, not 503: this caller is the reason, and the service is fine.
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('900')
    expect(scheduled).toBe(0)
  })

  it('serves a fresh cached result without charging anything', async () => {
    // The budgets exist to bound upstream reads. A cache hit performs none, and
    // charging for it would let ordinary client polling exhaust the ceiling that
    // protects the dependency — the defence eating itself.
    store.set(USER.toLowerCase(), doneJob())
    const res = await post()
    expect(res.status).toBe(200)
    expect(charged).toEqual([])
    expect(scheduled).toBe(0)
  })

  it('joins a scan already in flight without charging anything', async () => {
    store.set(USER.toLowerCase(), {
      status: 'running', address: USER.toLowerCase(), startedAt: Date.now(),
    })
    const res = await post()
    expect(res.status).toBe(200)
    expect(charged).toEqual([])
    expect(scheduled).toBe(0)
  })

  it('joins an in-flight scan even when the caller asked to force a refresh', async () => {
    // "Refresh" cannot mean anything useful about a read that has not returned,
    // and honouring it would put two five-chain scans on one address, racing to
    // write the same key.
    store.set(USER.toLowerCase(), {
      status: 'running', address: USER.toLowerCase(), startedAt: Date.now(),
    })
    const res = await post({ force: true })
    expect(res.status).toBe(200)
    expect(charged).toEqual([])
    expect(scheduled).toBe(0)
  })

  it('re-scans on force even though the cached result is still fresh', async () => {
    store.set(USER.toLowerCase(), doneJob())
    const res = await post({ force: true })
    expect(res.status).toBe(202)
    expect(charged).toEqual([GLOBAL_KEY, ADDRESS_KEY])
    expect(scheduled).toBe(1)
  })

  it('keeps the cached result when force is refused by a budget', async () => {
    // The regression this pins: `force` used to delete the cached job before the
    // budgets were consulted. A refusal then landed after the old answer had
    // already been destroyed, so the message "you have scanned enough, the
    // existing result still stands" was false and the user lost the figure they
    // had. Overwriting on start instead of deleting up front makes the refusal
    // path leave the store untouched.
    store.set(USER.toLowerCase(), doneJob())
    refuse.add(ADDRESS_KEY)

    const res = await post({ force: true })
    expect(res.status).toBe(429)
    expect(scheduled).toBe(0)
    expect(store.get(USER.toLowerCase())?.status).toBe('done')
  })

  it('spends no budget on a request whose wallet auth does not recover', async () => {
    authRecovers = false
    const res = await post()
    expect(res.status).toBe(401)
    expect(charged).toEqual([])
    expect(scheduled).toBe(0)
  })
})
