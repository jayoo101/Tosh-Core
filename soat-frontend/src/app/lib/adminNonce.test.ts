import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The replay guard behind `POST /api/admin/config`.
 *
 * These tests carry more weight than their size suggests, because this module is
 * what licenses the long signature window a Safe needs. If the guard is not
 * genuinely monotonic across instances and restarts, that window becomes a
 * rate-downgrade window — so "the nonce is shared" has to be a tested property
 * and not a comment.
 */

vi.mock('@/lib/observability', () => ({ reportError: () => {} }))

const URL_ = 'https://fake.upstash.io'
const TOKEN = 'tok'

/** Reset the cross-hot-reload copy, which `resetModules` does not clear. */
function clearLocal() {
  ;(globalThis as Record<string, unknown>).__toshAdminNonce = 0n
}

beforeEach(clearLocal)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.restoreAllMocks()
})

async function loadShared(handler: (cmd: string[]) => unknown) {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', URL_)
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', TOKEN)
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => ({
    ok: true,
    json: async () => ({ result: handler(JSON.parse(init.body) as string[]) }),
  })))
  vi.resetModules()
  return import('./adminNonce')
}

async function loadLocal() {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
  vi.resetModules()
  return import('./adminNonce')
}

describe('claimAdminNonce — in-process mode', () => {
  it('accepts a rising nonce and refuses one that does not rise', async () => {
    const { claimAdminNonce } = await loadLocal()

    expect(await claimAdminNonce(10n)).toBe('claimed')
    expect(await claimAdminNonce(11n)).toBe('claimed')
    expect(await claimAdminNonce(11n)).toBe('replayed')
    expect(await claimAdminNonce(4n)).toBe('replayed')
  })

  it('reports itself as the weaker backend', async () => {
    const { adminNonceBackendKind } = await loadLocal()
    // The route reads this to decide whether the long window is safe, so getting
    // it backwards would hand out the wide window in exactly the posture that
    // cannot support it.
    expect(adminNonceBackendKind()).toBe('memory')
  })
})

describe('claimAdminNonce — shared mode', () => {
  it('does the compare and the write in one round trip', async () => {
    // Not a style point. A GET followed by a SET leaves a window in which two
    // concurrent requests both read the old value and both accept — the guard
    // failing precisely while it is under load.
    const sent: string[][] = []
    const { claimAdminNonce } = await loadShared(cmd => { sent.push(cmd); return 1 })

    expect(await claimAdminNonce(99n)).toBe('claimed')
    expect(sent).toHaveLength(1)
    expect(sent[0][0]).toBe('EVAL')
  })

  it('reads the store\'s answer rather than deciding locally', async () => {
    // The in-process copy starts at zero, so a local decision would accept this.
    // Only the store knows the nonce was already spent on another instance.
    const { claimAdminNonce } = await loadShared(() => 0)

    expect(await claimAdminNonce(5000n)).toBe('replayed')
  })

  it('reports an outage as unavailable, never as a clean accept', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', URL_)
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', TOKEN)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    vi.resetModules()
    const { claimAdminNonce } = await import('./adminNonce')

    // Failing open here would be a replay window; the route turns this into a
    // 503 and declines to apply the rotation at all.
    expect(await claimAdminNonce(7n)).toBe('unavailable')
  })

  it('survives a restart, which the module-scoped `let` did not', async () => {
    // The whole point. `resetModules` below is the restart: with the old
    // per-process counter every nonce became spendable again at this line.
    let stored: string | null = null
    const handler = (cmd: string[]) => {
      if (cmd[0] === 'GET') return stored
      const candidate = cmd[4]
      if (stored !== null && Number(stored) >= Number(candidate)) return 0
      stored = candidate
      return 1
    }

    const first = await loadShared(handler)
    expect(await first.claimAdminNonce(1_700_000_000_000n)).toBe('claimed')

    clearLocal()
    const afterRestart = await loadShared(handler)
    expect(await afterRestart.claimAdminNonce(1_700_000_000_000n)).toBe('replayed')
  })

  it('exposes the last nonce for the admin GET', async () => {
    const { lastSeenAdminNonce } = await loadShared(() => '4242')

    expect(await lastSeenAdminNonce()).toBe(4242n)
  })
})
