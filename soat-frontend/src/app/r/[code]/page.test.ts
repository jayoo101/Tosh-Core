import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'

/**
 * `/r/[code]` — the short referral link.
 *
 * This page is a translator: it turns `/r/swift-amber-otter?p=RHRSL` into the
 * same `/projects/<token>?ref=<address>` URL the long links always used, so
 * `ReferralCapture` and `useBoundReferrer` never learn that short links exist.
 * That makes the redirect target the entire observable behaviour, and the
 * reason it is worth a test file of its own is that two of its decisions are
 * not recoverable if they are wrong.
 *
 * ONE. `?ref=` names a payee. A referral binds a wallet to a referrer once,
 * platform-wide and permanently, and pays that referrer a cut of every genesis
 * deposit. Landing with no `ref` costs a commission and is recoverable — no
 * binding exists until the first deposit, so the link works on the next click.
 * Landing with SOMEONE ELSE'S address in `ref` is not recoverable by anything
 * the interface can do afterwards.
 *
 * TWO. `?p=<symbol>` resolves oldest-row-first, and that ordering is a
 * security property rather than a tidy default. Symbols are not unique on
 * chain — nothing stops a second launch calling itself RHRSL — so if the
 * NEWEST match won, anyone could redirect every link already in circulation
 * by launching a token with the right ticker. There is no assertion in the
 * route that states this; the only witness is the `.order()` call, so it is
 * pinned here.
 *
 * Both are asserted through the redirect target, because that is what a
 * visitor actually receives.
 */

const ADDRESS_LOWER = '0x30ad7d2d9a1b0f4e3c8b5a6d7e8f9a0b1c2d3e9e'
/** Derived. `isAddress` validates the EIP-55 checksum, so a hand-written
 *  mixed-case address is rejected as malformed and the assertions below would
 *  be testing the wrong branch. */
const ADDRESS_CHECKSUMMED = getAddress(ADDRESS_LOWER)

const TOKEN_LOWER = '0x489851b576f0043c56872a5e13991ac6e239dbe5'
const TOKEN_CHECKSUMMED = getAddress(TOKEN_LOWER)

// `app/lib/supabase.ts` throws at module load without these, and `vi.mock`
// factories hoist above `beforeEach`.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://registry.test.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

type Result = { data: unknown; error: unknown }
type Chain = Record<string, unknown>

/**
 * Answers keyed by table, because this page queries two of them in one render
 * and the interesting cases are the ones where they disagree — a code that
 * resolves and a symbol that does not, and the reverse. A single queue would
 * make the assertions depend on which of the two the page happens to await
 * first, which is an implementation detail and not a promise.
 */
let answers: Record<string, Result>

/** What each query filtered and ordered by, so the hijack test can look. */
type Seen = {
  table: string
  eq: Record<string, unknown>
  ascending?: boolean
  deadline: boolean
}
let seen: Seen[]

function makeQuery(table: string): Chain {
  const chain: Chain = {}
  const record: Seen = { table, eq: {}, deadline: false }
  seen.push(record)

  for (const m of ['select', 'maybeSingle', 'single', 'limit', 'not']) {
    chain[m] = () => chain
  }
  chain.eq = (col: string, val: unknown) => {
    record.eq[col] = val
    return chain
  }
  chain.order = (_col: string, opts?: { ascending?: boolean }) => {
    record.ascending = opts?.ascending
    return chain
  }
  chain.abortSignal = () => {
    record.deadline = true
    return chain
  }
  chain.then = (resolve: (v: Result) => unknown) =>
    Promise.resolve(answers[table] ?? { data: null, error: null }).then(resolve)
  return chain
}

vi.mock('@/app/lib/supabase', async () => {
  const actual = await vi.importActual<typeof import('@/app/lib/supabase')>('@/app/lib/supabase')
  return { ...actual, supabase: { from: (t: string) => makeQuery(t) } as never }
})

vi.mock('@/lib/observability', () => ({ reportError: () => {} }))

/**
 * `redirect()` throws in Next.js so that nothing after it can run, and the
 * page relies on that. Mocked to throw a sentinel carrying the target, which
 * keeps the control flow honest: a test that forgot to expect a throw fails
 * rather than silently asserting on a page that returned normally.
 */
class Redirected extends Error {
  constructor(public readonly to: string) { super(`redirect:${to}`) }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Redirected(to) },
}))

const Page = (await import('./page')).default

/** Runs the page and returns wherever it sent the visitor. */
async function land(code: string, p?: string): Promise<string> {
  try {
    await Page({
      params: Promise.resolve({ code }),
      searchParams: Promise.resolve(p === undefined ? {} : { p }),
    })
  } catch (err) {
    if (err instanceof Redirected) return err.to
    throw err
  }
  throw new Error('the page returned without redirecting')
}

beforeEach(() => {
  answers = {}
  seen = []
})

describe('the referrer', () => {
  it('lands on the project with ref set, checksummed', async () => {
    answers.referral_codes = { data: { address: ADDRESS_LOWER }, error: null }
    answers.projects = { data: { token_address: TOKEN_LOWER }, error: null }

    expect(await land('swift-amber-otter', 'RHRSL'))
      .toBe(`/projects/${TOKEN_CHECKSUMMED}?ref=${ADDRESS_CHECKSUMMED}`)
  })

  it('lowercases the code before looking it up, so a link survives being title-cased', async () => {
    // Chat clients and email clients both capitalise the first letter of what
    // looks like a sentence, and the code sits in the path where that edit is
    // invisible to the sharer.
    answers.referral_codes = { data: { address: ADDRESS_LOWER }, error: null }

    await land('Swift-Amber-Otter')
    expect(seen.find(s => s.table === 'referral_codes')?.eq.code).toBe('swift-amber-otter')
  })

  it('never queries on a code that is not code-shaped', async () => {
    for (const bad of ['nope', 'swift-amber', 'swift amber otter', ADDRESS_LOWER]) {
      seen = []
      expect(await land(bad)).toBe('/projects')
      expect(seen.filter(s => s.table === 'referral_codes'), bad).toHaveLength(0)
    }
  })

  // The recoverable direction. Every one of these still lands the visitor,
  // because the referral slot stays open until their first deposit — so a
  // link that failed at 10:00 binds correctly when clicked again at 10:05.
  it('lands without ref rather than failing, on every resolve failure', async () => {
    const cases: Record<string, Result> = {
      'registry unreachable':   { data: null, error: { message: 'ECONNRESET' } },
      'unknown code':           { data: null, error: null },
      'row with a junk address': { data: { address: 'not-an-address' }, error: null },
      'row with a null address': { data: { address: null }, error: null },
    }
    for (const [label, answer] of Object.entries(cases)) {
      answers = { referral_codes: answer }
      expect(await land('swift-amber-otter'), label).toBe('/projects')
    }
  })

  // The unrecoverable direction, stated as its own test because it is the one
  // thing this page must never do: no input should produce a `ref` the
  // registry did not hand back.
  it('never invents a ref out of the code or the symbol', async () => {
    answers.referral_codes = { data: null, error: null }
    answers.projects = { data: { token_address: TOKEN_LOWER }, error: null }

    const to = await land('swift-amber-otter', 'RHRSL')
    expect(to).toBe(`/projects/${TOKEN_CHECKSUMMED}`)
    expect(to).not.toContain('ref=')
  })
})

describe('the project', () => {
  // The hijack guard. Ascending means the oldest row wins, so a `?p=RHRSL`
  // link points at the same project forever and a later launch claiming the
  // ticker cannot take over links already in circulation.
  it('resolves a symbol oldest-first, not newest-first', async () => {
    answers.referral_codes = { data: { address: ADDRESS_LOWER }, error: null }
    answers.projects = { data: { token_address: TOKEN_LOWER }, error: null }

    await land('swift-amber-otter', 'RHRSL')
    expect(seen.find(s => s.table === 'projects')?.ascending).toBe(true)
  })

  it('upper-cases the symbol and scopes it to the configured chain', async () => {
    answers.projects = { data: { token_address: TOKEN_LOWER }, error: null }

    await land('swift-amber-otter', 'rhrsl')
    const q = seen.find(s => s.table === 'projects')
    expect(q?.eq.symbol).toBe('RHRSL')
    // A row from another deployment is a different project with the same
    // ticker, so landing on it would be worse than landing on the directory.
    expect(q?.eq.chain_id).toBeTypeOf('number')
  })

  it('skips the query entirely when ?p= is junk or absent', async () => {
    for (const bad of [undefined, '', 'a', 'not a symbol', 'WAY-TOO-LONG-SYMBOL']) {
      seen = []
      await land('swift-amber-otter', bad)
      expect(seen.filter(s => s.table === 'projects'), String(bad)).toHaveLength(0)
    }
  })

  it('falls back to the directory but keeps the ref when the symbol misses', async () => {
    // The important half: a bad `?p=` costs a landing page, and must not cost
    // the commission the link was shared for.
    answers.referral_codes = { data: { address: ADDRESS_LOWER }, error: null }
    answers.projects = { data: null, error: { message: 'timeout' } }

    expect(await land('swift-amber-otter', 'RHRSL'))
      .toBe(`/projects?ref=${ADDRESS_CHECKSUMMED}`)
  })

  it('ignores a repeated ?p= rather than concatenating it', async () => {
    // `searchParams` hands over `string[]` for `?p=A&p=B`, and a naive read
    // would query for "A,B" and miss.
    answers.projects = { data: { token_address: TOKEN_LOWER }, error: null }

    await Page({
      params: Promise.resolve({ code: 'swift-amber-otter' }),
      searchParams: Promise.resolve({ p: ['RHRSL', 'OTHER'] }),
    }).catch(() => {})
    expect(seen.find(s => s.table === 'projects')?.eq.symbol).toBe('RHRSL')
  })
})

describe('deadlines', () => {
  // supabase-js has no default timeout and retries four times with backoff.
  // Unbounded, an unreachable registry holds a clicked link for ~14 s and then
  // lands the visitor on the directory anyway, so the wait buys nothing.
  // `checkSupabase.mjs` covers these two call sites; this restates it at the
  // level that matters, which is that the redirect is not held.
  it('bounds both queries', async () => {
    answers.referral_codes = { data: { address: ADDRESS_LOWER }, error: null }
    answers.projects = { data: { token_address: TOKEN_LOWER }, error: null }

    await land('swift-amber-otter', 'RHRSL')
    expect(seen).toHaveLength(2)
    expect(seen.every(s => s.deadline)).toBe(true)
  })
})
