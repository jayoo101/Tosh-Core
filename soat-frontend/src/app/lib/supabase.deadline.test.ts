import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The registry read deadline is environment-dependent, and the risk that
 * creates is entirely one-directional.
 *
 * A budget that is too SHORT degrades one paint: the directory falls back to
 * on-chain name and symbol, which is the behaviour the fallback exists for. A
 * budget that is too LONG holds a visitor's page open on an unreachable
 * dependency, which is the fourteen-second stall the `abortSignal` work
 * removed in the first place.
 *
 * So the development escape hatch has to be provably unreachable from
 * production, and "we gated it on NODE_ENV" is a claim about code rather than
 * about behaviour. These tests re-import the module under each environment and
 * read the value it actually exports.
 */

const PROD_DEADLINE_MS = 1_200

/** `supabase.ts` throws at import without these. */
function stubRequiredEnv() {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_test')
}

async function readDeadline() {
  vi.resetModules()
  const mod = await import('./supabase')
  return mod.REGISTRY_READ_DEADLINE_MS
}

beforeEach(stubRequiredEnv)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('REGISTRY_READ_DEADLINE_MS', () => {
  it('is the production budget on a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(await readDeadline()).toBe(PROD_DEADLINE_MS)
  })

  it('ignores the override outside development', async () => {
    // The one failure that matters. An operator who set this while debugging
    // staging, or a `.env` that outlived its purpose, must not be able to hand
    // production a budget it was never measured for.
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('REGISTRY_READ_DEADLINE_MS', '30000')
    expect(await readDeadline()).toBe(PROD_DEADLINE_MS)
  })

  it('gives development room for a cold TLS handshake', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const ms = await readDeadline()
    // Measured cold: 2.8-3.2 s. Warm: ~0.9 s. The window has to clear the
    // former without becoming a stall of its own.
    expect(ms).toBeGreaterThan(3_200)
    expect(ms).toBeLessThanOrEqual(5_000)
  })

  it('honours a longer override in development', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('REGISTRY_READ_DEADLINE_MS', '9000')
    expect(await readDeadline()).toBe(9_000)
  })

  it('falls back to the development default when the override is nonsense', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('REGISTRY_READ_DEADLINE_MS', 'soon')
    // Not `NaN`, which `AbortSignal.timeout` rejects outright, and not 0,
    // which would abort the read before it was issued and present as "the
    // registry is always down".
    expect(await readDeadline()).toBeGreaterThan(3_200)
  })

  it('rejects a non-positive override rather than aborting instantly', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('REGISTRY_READ_DEADLINE_MS', '0')
    expect(await readDeadline()).toBeGreaterThan(3_200)
  })
})
