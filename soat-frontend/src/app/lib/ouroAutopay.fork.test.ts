/**
 * Automatic payouts against a BSC fork: real USDT, real signing, broadcast and
 * receipts; the database is in memory. Runs only with OURO_FORK_RPC set to an
 * anvil fork of chain 56 on which the payer (key 0x11…11) holds USDT and BNB,
 * plus NEXT_PUBLIC_CHAIN_ID=56 and NEXT_PUBLIC_RPC_URL pointing at it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient, createWalletClient, erc20Abi, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

const C = vi.hoisted(() => ({
  RPC: process.env.OURO_FORK_RPC ?? '',
  USDT: '0x55d398326f99059fF775485246999027B3197955' as const,
  PAYER: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A' as const,
  KEY: `0x${'11'.repeat(32)}`,
  U: 10n ** 18n,
}))

const db = vi.hoisted(() => ({
  owed: new Map<string, bigint>(),
  payouts: [] as { txHash: string; logIndex: number; to: string; value: bigint }[],
  pending: [] as Record<string, unknown>[],
  approvals: [] as { id: number; max_total: string; used_at: string | null }[],
}))

vi.mock('@/lib/ouroboros/config', () => ({ OURO_REF_PAYER: C.PAYER, OURO_USDT: C.USDT }))
vi.mock('@/app/lib/ouroIndexer', () => ({ ouroIndexStaleness: async () => null }))
vi.mock('@/app/lib/ouroRef', () => ({
  refReport: async () => ({ partners: [...db.owed].map(([partner, owed]) => ({ partner, owed: owed.toString() })) }),
  storePartnerPayouts: async (ts: { txHash: string; logIndex: number; to: string; value: bigint }[]) => {
    let n = 0
    for (const t of ts) {
      if (db.payouts.some(p => p.txHash === t.txHash && p.logIndex === t.logIndex)) continue
      const key = t.to.toLowerCase()
      if (!db.owed.has(key)) continue
      db.payouts.push(t)
      db.owed.set(key, db.owed.get(key)! - t.value)
      n++
    }
    return n
  },
}))
vi.mock('@/app/lib/supabaseAdmin', () => ({
  getSupabaseAdmin: () => ({
    rpc: async () => ({ data: new Date(Date.now() + 600_000).toISOString(), error: null }),
    from: (table: string) => ({
      select: () => {
        if (table === 'ouro_ref_pending') return Promise.resolve({ data: db.pending, error: null })
        const open = db.approvals.find(a => a.used_at === null) ?? null
        const q = { is: () => q, gt: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: open, error: null }) }
        return q
      },
      insert: async (row: Record<string, unknown>) => { db.pending.push(row); return { error: null } },
      delete: () => ({ eq: async (_: string, v: string) => { db.pending = db.pending.filter(r => r.tx_hash !== v); return { error: null } } }),
      update: (row: Record<string, unknown>) => {
        let id: unknown
        const q = {
          eq: (col: string, v: unknown) => { if (col === 'id') id = v; return q },
          then: (done: (v: { error: null }) => void) => {
            if (table === 'ouro_ref_approvals') db.approvals.filter(a => a.id === id).forEach(a => { a.used_at = String(row.used_at) })
            done({ error: null })
          },
        }
        return q
      },
    }),
  }),
}))

import { runAutopay } from './ouroAutopay'

const chain = createPublicClient({ chain: bsc, transport: http(C.RPC || 'http://127.0.0.1:1') })
const balance = (a: `0x${string}`) => chain.readContract({ address: C.USDT, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
const fresh = () => `0x${[...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, '0')).join('')}` as const

describe.skipIf(!C.RPC)('automatic payouts on a BSC fork', () => {
  beforeEach(() => {
    vi.stubEnv('OURO_REF_AUTOPAY', '1')
    vi.stubEnv('OURO_REF_PAYER_KEY', C.KEY)
    db.owed.clear(); db.payouts = []; db.pending = []; db.approvals = []
  })

  it('pays each partner what is owed in USDT, records it, and pays nothing twice', async () => {
    const p = fresh(), q = fresh(), small = fresh()
    db.owed.set(p, 7n * C.U).set(q, 12n * C.U).set(small, 4n * C.U)
    const before = await balance(C.PAYER)

    const first = await runAutopay()
    expect(first).toMatchObject({ status: 'paid', paid: 2 })
    expect(await balance(p)).toBe(7n * C.U)
    expect(await balance(q)).toBe(12n * C.U)
    expect(await balance(small)).toBe(0n)
    expect(before - (await balance(C.PAYER))).toBe(19n * C.U)
    expect(db.pending).toHaveLength(0)
    expect(db.payouts.map(x => x.value).sort((a, b) => (a < b ? -1 : 1))).toEqual([7n * C.U, 12n * C.U])

    expect((await runAutopay()).status).toBe('idle')
    expect(await balance(p)).toBe(7n * C.U)
  }, 120_000)

  it('holds a run above the caps until approved, and stops when the wallet is short', async () => {
    const p = fresh()
    db.owed.set(p, 600n * C.U)
    expect((await runAutopay()).status).toBe('held')
    expect(await balance(p)).toBe(0n)

    db.approvals.push({ id: 1, max_total: (600n * C.U).toString(), used_at: null })
    expect((await runAutopay()).status).toBe('paid')
    expect(await balance(p)).toBe(600n * C.U)
    expect(db.approvals[0].used_at).not.toBeNull()

    // Leave the payer 100 USDT, whatever the fork was funded with.
    const left = (await balance(C.PAYER)) - 100n * C.U
    if (left > 0n) {
      const wallet = createWalletClient({ account: privateKeyToAccount(C.KEY as `0x${string}`), chain: bsc, transport: http(C.RPC) })
      const hash = await wallet.writeContract({ address: C.USDT, abi: erc20Abi, functionName: 'transfer', args: [fresh(), left] })
      await chain.waitForTransactionReceipt({ hash })
    }
    const q = fresh()
    db.owed.set(q, 450n * C.U)
    expect((await runAutopay()).status).toBe('short')
    expect(await balance(q)).toBe(0n)
  }, 120_000)
})
