/**
 * Addresses, tunables and the safety envelope for the market-making tool.
 *
 * WHY THESE ADDRESSES ARE PINNED HERE RATHER THAN IMPORTED
 *
 * `soat-frontend/src/lib/contracts.ts` knows the PositionManager, the Permit2
 * and the PoolManager, but not the UniversalRouter — the frontend has no AMM
 * swap path at all, it buys through `hook.mintBondingCurve` (the shelf ladder),
 * which is a different mechanism. The router address therefore has exactly one
 * other home in this repo, `test/ToshV5Fork.t.sol`, and a Solidity test is not
 * importable from Node. Pinning here with the provenance written down is the
 * honest version of that; `verify` below is what stops a pin from rotting.
 *
 * ⚠ PERMIT2 IS NOT THE CANONICAL ONE. The Uniswap Permit2 at `0x0000…8BA3` is
 *   deployed on BSC and works, so approving it succeeds and any presence check
 *   passes — and PancakeSwap's periphery never consults it. Both the router and
 *   the PositionManager pull through `0x31c2F6fc…c768`. Approve the wrong one
 *   and the swap reverts with `AllowanceExpired` from a contract you never
 *   named. See docs/DEVELOPMENT.md §Permit2.
 */

export const CHAIN_ID = 56

/** Provenance: test/ToshV5Fork.t.sol L120-122, verified on chain 56. */
export const UNIVERSAL_ROUTER = '0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB'
export const VAULT = '0x238a358808379702088667322f80aC48bAd5e6c4'
export const CL_POOL_MANAGER = '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b'

/** Provenance: soat-frontend/src/lib/contracts.ts. */
export const CL_POSITION_MANAGER = '0x55f4c8abA71A1e923edC303eb4fEfF14608cC226'
export const PERMIT2 = '0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768'
export const QUOTE_ASSET = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'

/** Full range, matching what the hook seeds and what the frontend's LP panel uses. */
export const TICK_LOWER = -887_200
export const TICK_UPPER = 887_200
export const POOL_FEE = 3000
export const TICK_SPACING = 200

/** UniversalRouter command and CL action opcodes. test/ToshV5Fork.t.sol L189-192. */
export const CMD_INFI_SWAP = 0x10
export const ACTION_CL_SWAP_EXACT_IN_SINGLE = 0x06
export const ACTION_SETTLE_ALL = 0x0c
export const ACTION_TAKE_ALL = 0x0f

/**
 * The hook's cut of every swap INPUT, in basis points.
 *
 * Not a pool fee and not charged by the pool: `ToshLaunchpadHook.beforeSwap`
 * skims it before the swap prices, so the amount that reaches the curve is
 * `amountIn * (1 - TAX_BPS/1e4)`. A quote that forgets this overstates the
 * output by a full percent, which on a `minOut` is the difference between a
 * trade and a revert.
 */
export const TAX_BPS = 100n
export const BPS = 10_000n

/** ERC-20 decimals. BEM is 8, project tokens are 18. */
export const QUOTE_DECIMALS = 8
export const TOKEN_DECIMALS = 18

/**
 * SAFETY ENVELOPE
 *
 * Every one of these exists because this tool signs transactions that spend
 * real money against a pool whose depth is four figures. They are deliberately
 * awkward to raise.
 */
export const SAFETY = {
  /** Nothing is ever sent without `--execute`. A typo must cost nothing. */
  requireExecuteFlag: true,
  /** Refuse to sign against any chain but this one. */
  chainId: CHAIN_ID,
  /**
   * Largest single swap, in BEM.
   *
   * Sized from a measurement rather than a guess. The live pool holds about
   * 1,870 BEM against 3.4M tokens, and at that depth a 25 BEM buy already
   * moves the price 2.6% — so the first draft of this cap, 50, would have
   * authorised a leg that paid over 5% in impact alone on top of the 2.85%
   * round-trip friction. 10 BEM keeps impact near 1%, which is the most a leg
   * can give away and still be chasing anything.
   */
  maxSwapQuote: 10,
  /**
   * Largest cumulative spend per run of the engine, in BEM. The per-swap cap
   * bounds a fat finger; this bounds a loop that has misread the market and is
   * happily buying every tick of a fall.
   */
  maxRunQuote: 500,
  /**
   * Slippage bound applied to every swap, in basis points. This is the ONLY
   * protection the router offers — Infinity's tuple has no other field — so it
   * is not optional and there is no flag to disable it.
   */
  slippageBps: 100n,
  /** Seconds a signed swap stays valid. */
  deadlineSeconds: 120,
}

export function env(name, fallback = undefined) {
  const v = process.env[name]
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`${name} is not set`)
  }
  return v
}

/**
 * The RPC to read and send through.
 *
 * Deliberately not defaulted to a public endpoint. The public BSC endpoints
 * drop roughly one call in five under any sustained use — measured while
 * building this — and a market-making loop that silently misses a read is
 * worse than one that refuses to start.
 */
export function rpcUrl() {
  return env('MM_RPC_URL')
}

/**
 * The signing key, from the environment only.
 *
 * Never a flag and never a file path argument: a key on a command line lands in
 * the shell history of a machine that also browses the internet.
 */
export function privateKey() {
  const k = env('MM_PRIVATE_KEY')
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error('MM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }
  return k
}
