import { describe, expect, it } from 'vitest'

import { planPayouts } from './autopayPlan'

const U = 10n ** 18n
const P = '0xp', Q = '0xq'

describe('automatic rebate payouts', () => {
  it('pays balances of at least 5 USDT and leaves smaller ones for later', () => {
    const plan = planPayouts([{ partner: P, owed: 5n * U }, { partner: Q, owed: 4n * U }], new Map(), null)
    expect(plan).toEqual({ kind: 'pay', total: 5n * U, items: [{ partner: P, amount: 5n * U }], usesApproval: false })
  })

  it('pays a partner listed twice once', () => {
    const plan = planPayouts([{ partner: P, owed: 7n * U }, { partner: P.toUpperCase(), owed: 7n * U }], new Map(), null)
    expect(plan).toEqual({ kind: 'pay', total: 7n * U, items: [{ partner: P, amount: 7n * U }], usesApproval: false })
  })

  it('does not pay again what is still in flight', () => {
    expect(planPayouts([{ partner: P, owed: 50n * U }], new Map([[P, 50n * U]]), null)).toEqual({ kind: 'idle' })
  })

  it('holds a run above 1,000 USDT, or 500 to one partner, until approved', () => {
    const big = [{ partner: P, owed: 400n * U }, { partner: Q, owed: 700n * U }]
    expect(planPayouts(big, new Map(), null).kind).toBe('held')
    expect(planPayouts([{ partner: P, owed: 501n * U }], new Map(), null).kind).toBe('held')
    expect(planPayouts(big, new Map(), 1_000n * U).kind).toBe('held')
    const approved = planPayouts(big, new Map(), 1_100n * U)
    expect(approved.kind === 'pay' && approved.usesApproval).toBe(true)
  })
})
