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

function builder(onInsert: () => void, onSignal: (s: AbortSignal) => void): Chain {
  const chain: Chain = {}
  for (const method of ['from', 'select', 'order', 'or', 'limit', 'single']) {
    chain[method] = () => chain
  }
  chain.insert = () => { onInsert(); return chain }
  chain.abortSignal = (s: AbortSignal) => { onSignal(s); return chain }
  chain.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
    Promise.resolve(adminResult).then(resolve)
  return chain
}

vi.mock('../../lib/supabase', async () => {
  const actual =
    await vi.importActual<typeof import('./../../lib/supabase')>('../../lib/supabase')
  return { ...actual, supabase: builder(() => { anonInserts++ }, () => {}) }
})

vi.mock('../../lib/supabaseAdmin', async () => {
  const actual =
    await vi.importActual<typeof import('./../../lib/supabaseAdmin')>('../../lib/supabaseAdmin')
  return {
    ...actual,
    getSupabaseAdmin: () => {
      if (adminUnavailable) throw new actual.SupabaseAdminUnavailable('SUPABASE_SERVICE_ROLE_KEY')
      return builder(() => { adminInserts++ }, (s) => { adminSignal = s })
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
})
