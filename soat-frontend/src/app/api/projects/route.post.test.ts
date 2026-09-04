import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `POST /api/projects` — who is allowed to write the directory's metadata.
 *
 * The route already proves the caller is the creator: it reads the launch out
 * of the receipt, recovers the signer from a `personal_sign` attestation, and
 * requires that signer to equal `launch.creator`. `lib/projectAttestation.ts`
 * explains the attack that check exists for — watch for `LaunchCreated`, POST
 * that txHash first with your own links, and the real creator's publish comes
 * back `{ duplicate: true }` while the project page serves your site to their
 * audience.
 *
 * None of that binds a writer who never calls the route. PostgREST does not
 * run this file, so the check only holds while the table refuses writes from
 * the key the browser holds — and the policy originally prescribed for it,
 * `FOR INSERT WITH CHECK (true)` with no `TO` clause, applied to `anon` too.
 * The front door was locked and the side door was not.
 *
 * So these tests pin the half that lives in this repository: the insert goes
 * out under the service role, which `supabase/migrations/0001` is the only
 * role permitted to write. Reverting it to the anon client re-opens the
 * bypass without changing a single line of the authorisation above, and that
 * is precisely the change that should not pass quietly.
 */

const CREATOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const TOKEN   = '0xa783CDc72e34a174CCa57a6d9a74904d0Bec05A9'
const HOOK    = '0x21A52C56C15258B3f36B6455dA92d1241fB875FD'
const TX_HASH = `0x${'ab'.repeat(32)}`

// `app/lib/supabase.ts` throws at module load without these, and `vi.mock`
// factories are hoisted above `beforeEach`.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://registry.test.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

type Chain = Record<string, unknown>

/** Counts what each client was asked to do, so "wrote via anon" is visible. */
let anonInserts: number
let adminInserts: number
let adminSignal: AbortSignal | undefined
let adminResult: { data: unknown; error: unknown }
let adminUnavailable: boolean
let recovered: string
/** The row handed to `.insert()`, so what is written can be asserted. */
let adminRow: Record<string, unknown> | undefined
/** The argument to `.limit()`, so the directory read's ceiling can be asserted. */
let selectLimit: unknown

function builder(
  onInsert: (row: Record<string, unknown>) => void,
  onSignal: (s: AbortSignal) => void,
): Chain {
  const chain: Chain = {}
  // `eq` is here because the READ paths filter on chain_id. It is a no-op for
  // POST, and its absence would surface as "chain.eq is not a function" from a
  // GET test rather than as anything about chains.
  for (const method of ['from', 'select', 'order', 'or', 'single', 'eq']) {
    chain[method] = () => chain
  }
  chain.limit = (n: unknown) => { selectLimit = n; return chain }
  chain.insert = (row: Record<string, unknown>) => { onInsert(row); return chain }
  chain.abortSignal = (s: AbortSignal) => { onSignal(s); return chain }
  chain.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
    Promise.resolve(adminResult).then(resolve)
  return chain
}

vi.mock('../../lib/supabase', async () => {
  const actual =
    await vi.importActual<typeof import('./../../lib/supabase')>('../../lib/supabase')
  return { ...actual, supabase: builder(() => { anonInserts++ }, () => {}) as never }
})

vi.mock('../../lib/supabaseAdmin', async () => {
  const actual =
    await vi.importActual<typeof import('./../../lib/supabaseAdmin')>('../../lib/supabaseAdmin')
  return {
    ...actual,
    getSupabaseAdmin: () => {
      if (adminUnavailable) throw new actual.SupabaseAdminUnavailable('SUPABASE_SERVICE_ROLE_KEY')
      return builder(
        (row) => { adminInserts++; adminRow = row },
        (s) => { adminSignal = s },
      ) as never
    },
  }
})

vi.mock('../../lib/serverRpc', () => ({
  assertServerChain: async () => true,
  serverPublicClient: () => ({
    getTransactionReceipt: async () => ({ status: 'success', logs: [] }),
  }),
}))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    // The receipt's logs are mocked empty; the launch identity comes from here.
    parseEventLogs: () => [{
      args: { creator: CREATOR, token: TOKEN, hook: HOOK, name: 'E2E', symbol: 'E2E' },
    }],
    recoverMessageAddress: async () => recovered,
  }
})

vi.mock('@/lib/observability', () => ({ reportError: () => {} }))

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FACTORY_ADDRESS', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0')
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '31337')
  vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined as unknown as string)
  anonInserts = 0
  adminInserts = 0
  adminSignal = undefined
  adminRow = undefined
  selectLimit = undefined
  adminUnavailable = false
  recovered = CREATOR
  adminResult = { data: { id: 'row-1' }, error: null }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

let ipSeq = 0
async function post(body: Record<string, unknown> = {}) {
  const { POST } = await import('./route')
  return POST(new NextRequest('https://tosh.test/api/projects', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `203.0.113.${ipSeq++ % 250}`,
    },
    body: JSON.stringify({
      txHash: TX_HASH,
      signature: `0x${'cd'.repeat(65)}`,
      logoUrl: 'https://example.test/logo.png',
      website: 'https://example.test',
      twitter: '', telegram: '', description: '',
      ...body,
    }),
  }))
}

describe('POST /api/projects — the writer', () => {
  it('inserts under the service role, not the key the browser holds', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(adminInserts).toBe(1)
    // The assertion that matters. RLS gives `anon` SELECT and nothing else, so
    // an insert routed back through the anon client would fail in production
    // while every test that only checks the status code kept passing.
    expect(anonInserts).toBe(0)
  })

  it('still refuses a signature that is not the creator, service role or not', async () => {
    recovered = '0x000000000000000000000000000000000000dEaD'
    const res = await post()
    expect(res.status).toBe(403)
    // A key that bypasses RLS makes the route the only thing standing between
    // a stranger and the table. It has to reject before it reaches for that.
    expect(adminInserts).toBe(0)
  })

  it('bounds the write, which is the call with no fallback', async () => {
    await post()
    expect(adminSignal).toBeInstanceOf(AbortSignal)
  })

  it('answers 503 and names the variable when the service key is absent', async () => {
    adminUnavailable = true
    const res = await post()
    // Not 500: the request was fine and the launch is already on chain. The
    // deployment is misconfigured, and the caller should come back.
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('5')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(anonInserts).toBe(0)
  })

  it('reports a duplicate as success, because only the creator can cause one', async () => {
    adminResult = { data: null, error: { code: '23505', message: 'duplicate key' } }
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true })
  })

  it('stamps the row with this deployment\'s chain', async () => {
    // A tx_hash names no chain, so a row without this says "some launch,
    // somewhere". `assertServerChain` does not cover it: that guards which
    // chain the write READ FROM, while this decides which directory the row is
    // shown in. One Supabase project backing a staging build and production is
    // the case where the difference is visible, and every individual write is
    // correctly authenticated in it.
    await post()
    expect(adminRow?.chain_id).toBe(31337)
  })

  it('writes the tx hash in one canonical casing, whatever casing was sent', async () => {
    // The uniqueness this route leans on for "one launch, one row" is the
    // database's, and Postgres compares `text` byte for byte. The validating
    // regex accepts `[0-9a-fA-F]`, so `0xAB..` and `0xab..` were two different
    // keys naming one transaction.
    //
    // What made that reachable rather than merely untidy: the signed message
    // built by `lib/projectAttestation.ts` lowercases the hash before signing.
    // So a single genuine signature from the real creator authorises EVERY
    // casing of their own hash — replay it recased and the unique index does
    // not object. The directory renders every row it gets back, which is the
    // squat that file's header describes, reopened one `.toUpperCase()` later.
    await post({ txHash: TX_HASH.toUpperCase().replace('0X', '0x') })
    expect(adminRow?.tx_hash).toBe(TX_HASH)
  })

  it('bounds the public directory read', async () => {
    // GET is unauthenticated, uncached, and returns whole rows including a
    // free-text description. Unbounded, its response size was set by however
    // many rows existed, and the read deadline turns a big enough table into a
    // 503 for every visitor rather than a slow page.
    const { GET } = await import('./route')
    await GET(new NextRequest('https://tosh.test/api/projects', {
      headers: { 'x-forwarded-for': `203.0.113.${ipSeq++ % 250}` },
    }))
    expect(selectLimit).toBeTypeOf('number')
    expect(selectLimit).toBeLessThanOrEqual(1_000)
  })

  it('takes identity from the receipt and never from the request body', async () => {
    // The chain_id above comes from configuration, which is trustworthy. These
    // come from the log, and the body is the one place they must not come from
    // — so send contradicting values and require them to be ignored.
    await post({
      chain_id:      999,
      name:          'Not The Real Name',
      symbol:        'FAKE',
      tokenAddress:  '0x000000000000000000000000000000000000dEaD',
      token_address: '0x000000000000000000000000000000000000dEaD',
    })
    expect(adminRow?.chain_id).toBe(31337)
    expect(adminRow?.name).toBe('E2E')
    expect(adminRow?.symbol).toBe('E2E')
    expect(adminRow?.token_address).toBe(TOKEN)
    expect(adminRow?.hook_address).toBe(HOOK)
  })
})
