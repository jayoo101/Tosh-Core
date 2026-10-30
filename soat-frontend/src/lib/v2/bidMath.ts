// Bigint mirror of ToshBidBook's escrow and fill arithmetic.
//
// The contract is the authority; this exists so the UI can preview a fill and
// build the `fill(hook, ids, qtys, minTotalOut)` call without one RPC round
// trip per bid. `bidMath.test.ts` pins it against hand-computed vectors that
// follow the Solidity line by line.
import { V2 } from './config'

export interface LiveBid {
  id: bigint
  bidder: `0x${string}`
  price: bigint
  qty: bigint
  filled: bigint
  escrow: bigint
}

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n)

/** ceil(price · f / 1e18): cumulative gross after `f` tokens. */
export const grossAt = (price: bigint, f: bigint) => ceilDiv(price * f, V2.ONE)

/** ceil(x · 1 %): the buyer-side fee on a cumulative gross. */
export const feeOf = (x: bigint) => ceilDiv(x * V2.FEE_BPS, V2.BPS)

/** Quote `placeBid(price, qty)` pulls. */
export function escrowFor(price: bigint, qty: bigint): bigint {
  const g = grossAt(price, qty)
  return g + feeOf(g)
}

/** Most whole tokens a bid at `price` buys for at most `budget` quote, fee included. */
export function qtyForBudget(price: bigint, budget: bigint): bigint {
  if (price === 0n || budget === 0n) return 0n
  let qty = (budget * V2.BPS * V2.ONE) / (price * (V2.BPS + V2.FEE_BPS))
  qty -= qty % V2.ONE
  while (qty > 0n && escrowFor(price, qty) > budget) qty -= V2.ONE
  return qty
}

export interface FillQuote {
  q: bigint
  gross: bigint
  buyerFee: bigint
  sellerFee: bigint
  out: bigint
}

/** One fill of `q` more tokens into `bid`, exactly as the contract books it. */
export function quoteFill(bid: Pick<LiveBid, 'price' | 'filled' | 'qty'>, q: bigint): FillQuote {
  const left = bid.qty - bid.filled
  if (q > left) q = left
  const g1 = grossAt(bid.price, bid.filled)
  const g2 = grossAt(bid.price, bid.filled + q)
  const gross = g2 - g1
  const buyerFee = feeOf(g2) - feeOf(g1)
  const sellerFee = (gross * V2.FEE_BPS) / V2.BPS
  return { q, gross, buyerFee, sellerFee, out: gross - sellerFee }
}

/** floor(currentGenesisPrice · 90 %): bids under this are skipped by `fill`. */
export const fillFloor = (genesisPrice: bigint) => (genesisPrice * V2.FILL_FLOOR_BPS) / V2.BPS

export interface SellPlan {
  ids: bigint[]
  qtys: bigint[]
  tokens: bigint
  out: bigint
}

/**
 * Sell up to `amount` tokens into the best bids first. Bids the contract would
 * skip (under the floor, a sub-token fill that does not finish the bid) are
 * left out, so the preview matches what executes unless someone races it.
 */
export function planSell(bids: readonly LiveBid[], amount: bigint, floor: bigint): SellPlan {
  const sorted = [...bids]
    .filter(b => b.price >= floor && b.qty > b.filled)
    .sort((a, b) => (a.price === b.price ? (a.id < b.id ? -1 : 1) : a.price > b.price ? -1 : 1))
  const plan: SellPlan = { ids: [], qtys: [], tokens: 0n, out: 0n }
  let rest = amount
  for (const b of sorted) {
    if (rest === 0n) break
    const left = b.qty - b.filled
    const q = rest < left ? rest : left
    if (q < V2.MIN_FILL_QTY && q !== left) continue
    const f = quoteFill(b, q)
    plan.ids.push(b.id)
    plan.qtys.push(q)
    plan.tokens += q
    plan.out += f.out
    rest -= q
  }
  return plan
}

/** `out` less a tolerance in bps, for `minTotalOut`. */
export const withSlippage = (out: bigint, bps: bigint) => (out * (V2.BPS - bps)) / V2.BPS

export interface DepthLevel {
  price: bigint
  tokens: bigint
  quote: bigint
  bids: number
}

/** Open bids aggregated by price, best first. */
export function depth(bids: readonly LiveBid[]): DepthLevel[] {
  const m = new Map<bigint, DepthLevel>()
  for (const b of bids) {
    const left = b.qty - b.filled
    if (left <= 0n) continue
    const lvl = m.get(b.price) ?? { price: b.price, tokens: 0n, quote: 0n, bids: 0 }
    lvl.tokens += left
    lvl.quote += grossAt(b.price, left)
    lvl.bids += 1
    m.set(b.price, lvl)
  }
  return [...m.values()].sort((a, b) => (a.price > b.price ? -1 : 1))
}
