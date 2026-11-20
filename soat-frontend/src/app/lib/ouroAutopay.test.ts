import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, pad } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const { USDT, OLD, PARTNER, NEW_KEY } = vi.hoisted(() => ({
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  OLD: '0x00000000000000000000000000000000000000bb',
  PARTNER: '0x' + '1'.repeat(40),
  NEW_KEY: `0x${'11'.repeat(32)}` as const,
}))

const state = vi.hoisted(() => ({
  locked: true,
  receiptError: null as Error | null,
  releasedWith: [] as unknown[][],
  updates: [] as Record<string, unknown>[],
  pending: [] as Record<string, unknown>[],
  stored: [] as { to: string; value: bigint }[][],
  owed: '0',
  stale: null as string | null,
}))

vi.mock('@/app/lib/supabaseAdmin', () => ({
  getSupabaseAdmin: () => ({
    rpc: async () => ({ data: state.locked ? '2026-01-01T00:10:00+00:00' : null, error: null }),
    from: (table: string) => ({
      update: (row: Record<string, unknown>) => {
        const filters: unknown[][] = []
        const chain = {
          eq: (...f: unknown[]) => { filters.push(f); return chain },
          then: (done: (v: { error: null }) => void) => { state.updates.push(row); state.releasedWith.push(filters); done({ error: null }) },
        }
        return chain
      },
      select: () => {
        if (table === 'ouro_ref_pending') return Promise.resolve({ data: state.pending, error: null })
        const q = { is: () => q, gt: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: null, error: null }) }
        return q
      },
      delete: () => ({
        eq: async (_: string, hash: string) => { state.pending = state.pending.filter(r => r.tx_hash !== hash); return { error: null } },
      }),
    }),
  }),
}))
vi.mock('@/lib/ouroboros/config', async () => ({
  OURO_REF_PAYER: (await import('viem/accounts')).privateKeyToAccount(NEW_KEY).address,
  OURO_USDT: USDT,
}))
vi.mock('@/app/lib/serverRpc', () => ({
  serverRpcUrl: () => 'http://localhost',
  serverPublicClient: () => ({
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      if (state.receiptError) throw state.receiptError
      return {
      status: 'success',
      logs: [{
        address: USDT, transactionHash: hash, logIndex: 0, blockNumber: 1n,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          pad(OLD as `0x${string}`), pad(PARTNER as `0x${string}`),
        ],
        data: encodeAbiParameters([{ type: 'uint256' }], [7n * 10n ** 18n]),
      }],
      }
    },
  }),
}))
vi.mock('@/app/lib/ouroRef', () => ({
  refReport: async () => ({ partners: [{ partner: PARTNER, owed: state.owed }] }),
  storePartnerPayouts: async (t: { to: string; value: bigint }[]) => { state.stored.push(t); state.owed = '0'; return t.length },
}))

vi.mock('@/app/lib/ouroIndexer', () => ({ ouroIndexStaleness: async () => state.stale }))
vi.mock('@/app/lib/ouroContest', () => ({
  syncContestAwards: async () => 0,
  settleContestTransfers: async () => 0,
}))

import { runAutopay } from './ouroAutopay'

describe('automatic payout runs', () => {
  beforeEach(() => {
    Object.assign(state, { locked: true, receiptError: null, releasedWith: [], updates: [], pending: [], stored: [], owed: '0', stale: null })
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it('do nothing unless OURO_REF_AUTOPAY is 1', async () => {
    vi.stubEnv('OURO_REF_AUTOPAY', '')
    expect((await runAutopay()).status).toBe('disabled')
    expect(state.updates).toHaveLength(0)
  })

  it('skip while another run holds the lock', async () => {
    vi.stubEnv('OURO_REF_AUTOPAY', '1')
    state.locked = false
    expect((await runAutopay()).status).toBe('busy')
  })

  it('refuse a key that is not the payout wallet, and release the lock', async () => {
    vi.stubEnv('OURO_REF_AUTOPAY', '1')
    vi.stubEnv('OURO_REF_PAYER_KEY', generatePrivateKey())
    const result = await runAutopay()
    expect(result.status).toBe('failed')
    expect(result.detail).toMatch(/does not belong/)
    expect(state.updates[0]).toMatchObject({ last_status: 'failed' })
    expect(state.updates[0].locked_until).toBeDefined()
    expect(state.releasedWith[0]).toContainEqual(['locked_until', '2026-01-01T00:10:00+00:00'])
  })

  it('after a wallet swap, settle the old wallet\'s transfer instead of paying it again', async () => {
    vi.stubEnv('OURO_REF_AUTOPAY', '1')
    vi.stubEnv('OURO_REF_PAYER_KEY', NEW_KEY)
    expect(privateKeyToAccount(NEW_KEY).address.toLowerCase()).not.toBe(OLD)
    state.owed = (7n * 10n ** 18n).toString()
    state.pending = [{ tx_hash: '0xold', payer: OLD, nonce: 3, created_at: new Date().toISOString() }]

    const result = await runAutopay()
    expect(state.stored).toHaveLength(1)
    expect(state.stored[0][0]).toMatchObject({ to: expect.stringMatching(/^0x1{40}$/i), value: 7n * 10n ** 18n })
    expect(state.pending).toHaveLength(0)
    expect(result.status).toBe('idle')
  })

  it('wait while the index is behind, so a late-mined transfer is not paid twice', async () => {
    vi.stubEnv('OURO_REF_AUTOPAY', '1')
    vi.stubEnv('OURO_REF_PAYER_KEY', NEW_KEY)
    state.owed = (7n * 10n ** 18n).toString()
    state.stale = 'index is 900 blocks behind'

    const result = await runAutopay()
    expect(result.status).toBe('waiting')
    expect(result.detail).toMatch(/900 blocks/)
    expect(state.stored).toHaveLength(0)
  })

  it('keep an in-flight transfer when the node errors instead of answering not found', async () => {
    vi.stubEnv('OURO_REF_AUTOPAY', '1')
    vi.stubEnv('OURO_REF_PAYER_KEY', NEW_KEY)
    state.owed = (7n * 10n ** 18n).toString()
    state.receiptError = new Error('429 too many requests from https://rpc.example/key-123')
    state.pending = [{ tx_hash: '0xold', payer: OLD, nonce: 3, created_at: '2020-01-01T00:00:00Z' }]

    const result = await runAutopay()
    expect(result.status).toBe('failed')
    expect(result.detail).not.toMatch(/key-123/)
    expect(state.pending).toHaveLength(1)
    expect(state.stored).toHaveLength(0)
  })
})