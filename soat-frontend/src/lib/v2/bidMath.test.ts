import { describe, expect, it } from 'vitest'
import { depth, escrowFor, planSell, quoteFill, withSlippage, type LiveBid } from './bidMath'

const E18 = 10n ** 18n
const bid = (id: bigint, price: bigint, qty: bigint, filled = 0n): LiveBid => ({
  id, bidder: '0x0000000000000000000000000000000000000001', price, qty, filled, escrow: 0n,
})

describe('bidMath', () => {
  it('escrow is gross plus a rounded-up 1 %', () => {
    // price 3 wei per token, qty 1e18 + 1 -> gross ceil(3e18+3 / 1e18) = 4
    expect(escrowFor(3n, E18 + 1n)).toBe(4n + 1n)
    expect(escrowFor(2n * 10n ** 13n, 10_000n * E18)).toBe(2n * 10n ** 17n + 2n * 10n ** 15n)
  })

  it('partial fills sum to the full escrow', () => {
    const price = 14_285_714_285_715n
    const qty = 12_345n * E18 + 7n
    const escrow = escrowFor(price, qty)
    let filled = 0n
    let paid = 0n
    for (const q of [E18, 333n * E18 + 1n, 5_000n * E18, qty]) {
      const f = quoteFill({ price, qty, filled }, q)
      paid += f.gross + f.buyerFee
      filled += f.q
    }
    expect(filled).toBe(qty)
    expect(paid).toBe(escrow)
  })

  it('seller fee is floor(1 %) of gross', () => {
    const f = quoteFill({ price: 10n ** 16n, qty: 1000n * E18, filled: 0n }, 999n * E18)
    expect(f.gross).toBe(999n * 10n ** 16n)
    expect(f.sellerFee).toBe(999n * 10n ** 14n)
    expect(f.out).toBe(f.gross - f.sellerFee)
  })

  it('planSell takes the best bids first and skips under the floor', () => {
    const bids = [bid(1n, 100n, 10n * E18), bid(2n, 300n, 5n * E18), bid(3n, 50n, 100n * E18), bid(4n, 300n, 5n * E18, 2n * E18)]
    const p = planSell(bids, 12n * E18, 90n)
    expect(p.ids).toEqual([2n, 4n, 1n])
    expect(p.qtys).toEqual([5n * E18, 3n * E18, 4n * E18])
    expect(p.tokens).toBe(12n * E18)
  })

  it('planSell skips a sub-token fill that would not finish the bid', () => {
    const p = planSell([bid(1n, 100n, 10n * E18)], E18 / 2n, 0n)
    expect(p.ids).toEqual([])
    const q = planSell([bid(1n, 100n, 10n * E18, 10n * E18 - E18 / 2n)], E18, 0n)
    expect(q.qtys).toEqual([E18 / 2n])
  })

  it('depth aggregates by price, best first', () => {
    const d = depth([bid(1n, 100n, 10n * E18), bid(2n, 100n, 5n * E18, E18), bid(3n, 200n, E18)])
    expect(d.map(l => l.price)).toEqual([200n, 100n])
    expect(d[1].tokens).toBe(14n * E18)
    expect(d[1].bids).toBe(2)
  })

  it('withSlippage', () => {
    expect(withSlippage(10_000n, 100n)).toBe(9_900n)
  })
})
