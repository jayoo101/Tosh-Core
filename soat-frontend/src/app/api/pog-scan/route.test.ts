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

/**
 * Whether a Blockscout key is configured. Mocked rather than driven through
 * `BLOCKSCOUT_API_KEY`, because the real `scanKeyPresent` latches the variable at
 * module load and this file re-imports the route per test — so an env stub would
 * be racing the module registry, and the failure would look like a routing bug.
 * That the variable reaches the requests at all is `gasHistory.test.ts`'s job;
 * this file is about what the route does with the answer.
 */
let keyPresent: boolean
vi.mock('@/app/lib/gasHistory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/gasHistory')>()
  return {
    ...actual,
    scanGasHistory: async () => { throw new Error('not in this test') },
    scanKeyPresent: () => keyPresent,
    lastObservedCredits: () => null,
  }
})
vi.mock('@/app/lib/pogParams', () => ({
  getPogBand: async () => ({
    rate: 0.5,
    floorWei: 25_000_000_000_000_000n,
    maxAllocWei: 500_000_000_000_000_000n,
  }),
}))

/**
 * The IP bucket's arithmetic is not what these tests measure — `apiGuard.test.ts`
 * has that. Which bucket each verb is charged against is wiring, and is measured
 * here, so the stand-in records the name it was asked for and can be made to
 * refuse under it.
 */
let bucketsCharged: string[]
let refuseBucket: Set<string>
vi.mock('@/app/lib/apiGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/apiGuard')>()
  const { NextResponse } = await import('next/server')
  return {
    ...actual,
    applyRateLimit: async (_req: unknown, opts: { name: string }) => {
      bucketsCharged.push(opts.name)
      if (!refuseBucket.has(opts.name)) return null
      return NextResponse.json({ error: 'Too many requests', retryAfterMs: 1_000 }, { status: 429 })
    },
  }
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

/** The credit gauge, as a settable number. `null` is the "nothing recent is
 *  known" reading, which must admit rather than refuse. */
let creditBalance: number | null
let creditGaugeThrows: boolean

/** Every store read, in order. The point of recording them is that reaching the
 *  store at all is the cost the GET bucket exists to bound, so "was it charged"
 *  and "was the store spared" are two different assertions. */
let storeReads: string[]

vi.mock('@/app/lib/scanJobStore', () => ({
  readScanJob: async (a: string) => {
    storeReads.push(a.toLowerCase())
    return store.get(a.toLowerCase()) ?? null
  },
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
  recordCreditBalance: async () => {},
  readCreditBalance: async () => {
    if (creditGaugeThrows) throw new Error('gauge unavailable')
    return creditBalance
  },
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

/**
 * `origin` defaults to the un-allowlisted host the POST helper uses, matching the
 * rest of this file. The one test that asserts a CORS header passes an allowed
 * one instead: with `ALLOWED_ORIGINS` unset and `NODE_ENV` not production,
 * `apiGuard` falls back to localhost, and it omits `Access-Control-Allow-Origin`
 * for anything else — so asserting that header under `tosh.test` would have
 * measured the allow-list rather than the refusal path.
 */
async function get(address: string = USER, origin = 'https://tosh.test') {
  const { GET } = await import('./route')
  return GET(new Request(
    `https://tosh.test/api/pog-scan?address=${address}`,
    { headers: { origin } },
  ))
}

beforeEach(() => {
  authRecovers = true
  scheduled = 0
  bucketsCharged = []
  refuseBucket = new Set()
  storeReads = []
  store = new Map()
  freshness = true
  charged = []
  refuse = new Set()
  creditBalance = null
  creditGaugeThrows = false
  // Set explicitly rather than inherited from the environment. The route refuses
  // outright without a key, so while this was read from `BLOCKSCOUT_API_KEY` the
  // suite passed on a machine that happened to export one and would have failed
  // in CI — the same class of bug as the key plumbing these tests exist to guard.
  keyPresent = true
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

  it('spends no budget when a presented signature does not recover', async () => {
    authRecovers = false
    const res = await post()
    expect(res.status).toBe(401)
    expect(charged).toEqual([])
    expect(scheduled).toBe(0)
  })

  it('starts a scan with no signature — gas lookup no longer needs wallet auth', async () => {
    const { POST } = await import('./route')
    const res = await POST(new Request('https://tosh.test/api/pog-scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://tosh.test' },
      body: JSON.stringify({ userAddress: USER, chainId: SUPPORTED_CHAIN }),
    }))
    expect(res.status).toBe(202)
    expect(scheduled).toBe(1)
    expect(charged).toEqual([GLOBAL_KEY, ADDRESS_KEY])
  })

  it('rejects a signature without a timestamp (and the reverse)', async () => {
    const { POST } = await import('./route')
    const res = await POST(new Request('https://tosh.test/api/pog-scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://tosh.test' },
      body: JSON.stringify({
        userAddress: USER,
        chainId: SUPPORTED_CHAIN,
        signature: `0x${'ab'.repeat(65)}`,
      }),
    }))
    expect(res.status).toBe(400)
    expect(scheduled).toBe(0)
  })
})

describe('POST /api/pog-scan — the two limits that are not request counts', () => {
  it('refuses without an API key instead of starting five requests that all 402', async () => {
    // api.blockscout.com answers 402 unkeyed, on every chain. Starting the scan
    // anyway would spend a job slot and a budget charge to arrive at "your gas
    // history could not be read", which points a claimant at the chains when the
    // fault is an unset environment variable.
    keyPresent = false
    const res = await post()
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ error: /not configured/ })
    expect(charged).toEqual([])
    expect(scheduled).toBe(0)
  })

  it('still serves a cached result when the key is missing', async () => {
    // The key gates upstream reads, and a cache hit performs none. Refusing here
    // too would take the answer away from everyone who already has one, turning a
    // configuration slip into a wider outage than it is.
    keyPresent = false
    store.set(USER.toLowerCase(), doneJob())
    const res = await post()
    expect(res.status).toBe(200)
    expect(scheduled).toBe(0)
  })

  it('refuses when the credit gauge is below the reserve', async () => {
    // This tier is bounded by credits per day, not requests per second, and one
    // scan can cost 25 calls. Refusing at the reserve leaves room for scans
    // already in flight to finish, because a scan killed halfway spends the
    // credits and produces nothing.
    creditBalance = 1_999
    const res = await post()
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toMatchObject({ error: /daily limit/ })
    expect(charged).toEqual([])
    expect(scheduled).toBe(0)
  })

  it('admits at exactly the reserve, so the boundary is not off by one', async () => {
    creditBalance = 2_000
    const res = await post()
    expect(res.status).toBe(202)
    expect(scheduled).toBe(1)
  })

  it('admits when the gauge knows nothing, rather than treating unknown as empty', async () => {
    // The gauge expires after an hour of quiet so that yesterday's exhausted
    // reading cannot refuse everyone on a budget that has since reset. That only
    // works if a null reading admits.
    creditBalance = null
    const res = await post()
    expect(res.status).toBe(202)
    expect(scheduled).toBe(1)
  })

  it('does not treat a zero balance as unknown', async () => {
    // The mirror of the test above, and the reason `readCreditBalance` returns
    // `number | null` instead of a number defaulting to zero: conflating the two
    // would break one direction or the other, and both are outages.
    creditBalance = 0
    const res = await post()
    expect(res.status).toBe(503)
    expect(scheduled).toBe(0)
  })

  it('proceeds when the gauge itself is unreachable', async () => {
    // A gauge we cannot read is not evidence of exhaustion. The request-count
    // ceilings still bound the damage, so failing open here loses a refinement
    // rather than a defence.
    creditGaugeThrows = true
    const res = await post()
    expect(res.status).toBe(202)
    expect(charged).toEqual([GLOBAL_KEY, ADDRESS_KEY])
    expect(scheduled).toBe(1)
  })

  it('checks credits before charging either request budget', async () => {
    // A caller refused for a global shortage should not also lose one of their
    // six per-address attempts to find that out.
    creditBalance = 10
    await post()
    expect(charged).toEqual([])
  })
})

/**
 * GET had no bucket at all, on the reasoning that reads are free. They are not:
 * a GET spends an Upstash command in `readScanJob` before it can discover the
 * address is unknown, and Upstash is the substrate the rate limiter itself runs
 * on — `consumeRateLimit` answers a store failure by counting per-instance for
 * 30 s, at which point `pog-scan:global` is no longer global and the Blockscout
 * credit budget it protects is open. So the unauthenticated, unbucketed handler
 * was the cheapest lever on the outage this whole route is arranged to avoid.
 */
describe('GET /api/pog-scan — the bucket it used to be missing', () => {
  it('charges its own bucket', async () => {
    store.set(USER.toLowerCase(), doneJob())
    const res = await get()
    expect(res.status).toBe(200)
    expect(bucketsCharged).toEqual(['pog-scan-get'])
  })

  it('spends no store command on a request it refuses', async () => {
    // The ordering is the whole defence. Charging after the read would leave the
    // cost being bounded payable by every request that gets turned away.
    refuseBucket.add('pog-scan-get')
    const res = await get()
    expect(res.status).toBe(429)
    expect(storeReads).toEqual([])
  })

  it('charges the bucket even for an address nobody has ever scanned', async () => {
    // An unknown address still costs a lookup to establish that it is unknown, so
    // pointing a flood at random addresses must not be the free path.
    const res = await get('0x0000000000000000000000000000000000000009')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'absent' })
    expect(bucketsCharged).toEqual(['pog-scan-get'])
    expect(storeReads).toEqual(['0x0000000000000000000000000000000000000009'])
  })

  it('rejects a malformed address without reaching the store', async () => {
    const res = await get('not-an-address')
    expect(res.status).toBe(400)
    expect(storeReads).toEqual([])
  })

  it('reads from a different bucket than POST, so polling cannot lock out starting', async () => {
    // The trap in fixing this: reusing `RATE_LIMIT_OPTS` would have bucketed GET
    // at three tokens refilling once a minute, and `PogScanButton` polls every
    // two seconds for up to 135 s. One scan's own polling would then exhaust the
    // bucket that starts scans, so the fix for an abuse path would have broken
    // the ordinary one. Distinct names is what keeps the two from interfering.
    store.set(USER.toLowerCase(), doneJob())
    await get()
    await post({ force: true })
    expect(new Set(bucketsCharged).size).toBe(2)
    expect(bucketsCharged).toEqual(['pog-scan-get', 'pog-scan'])
  })

  it('still answers a refusal with CORS headers', async () => {
    // A 429 the browser cannot read is indistinguishable from the network being
    // down, and the client would retry into it.
    refuseBucket.add('pog-scan-get')
    const res = await get(USER, 'http://localhost:3000')
    expect(res.status).toBe(429)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000')
  })
})
