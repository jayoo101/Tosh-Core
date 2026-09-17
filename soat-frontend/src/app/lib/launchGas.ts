/**
 * What opening a project costs the creator, in gas.
 *
 * Quote the cost before the creator
 * signs. The launch fee alone is a misleading number — it is the smaller half
 * of the bill at any realistic L1 gas price.
 *
 * ── Two transactions, not one ───────────────────────────────────────────────
 *
 * `createLaunch` opens the genesis. `launch()` seeds the V4 pool once the raise
 * succeeds, and only the creator can call it. Quoting just the first one strands
 * a creator holding a funded genesis they cannot open, so both are surfaced.
 *
 * ── Where these numbers come from ───────────────────────────────────────────
 *
 * `test_gas_createLaunch` and `test_gas_launch` in `test/ToshV5.t.sol`, run
 * under `forge test --isolate` (without it Foundry keeps storage warm across a
 * test and understates every figure). Those tests hold budgets above these
 * values, so a change that makes this quote materially wrong fails CI rather
 * than silently under-quoting a creator.
 *
 * They are measured with `gasleft()` deltas, which EXCLUDE the 21,000
 * transaction base and the calldata cost — hence `TX_BASE_GAS` below. Skipping
 * that correction is the easy way to publish a quote that is quietly ~4 % light.
 *
 * ⚠ BOTH ROSE IN THE PANCAKESWAP INFINITY PORT, and `launch()` rose by 30 %.
 *   Infinity settles through a Vault that sits in front of the pool manager, so
 *   every `sync`/`settle`/`take` is an extra call across a contract boundary
 *   that Uniswap V4 kept inside one callee.
 *
 *   Under-quoting here is the failure that matters, and it is not symmetric with
 *   over-quoting. `launch()` can only be called by the creator, so a creator who
 *   budgeted from the old 502,719 and funded their wallet to the wei would be
 *   left holding a successfully funded genesis they cannot open, with nobody else
 *   able to open it for them. That is the exact stranding the two-transaction
 *   quote below exists to prevent, so these numbers have to be re-measured
 *   whenever the settlement path changes — not only when CI's budgets go red,
 *   since a budget with headroom stays green while this quote drifts.
 */

/** `test_gas_createLaunch`, `--isolate`. Both clone deployments are in here. */
export const CREATE_LAUNCH_GAS = 546_579n

/** `test_gas_launch`, `--isolate`. Pool initialisation and the genesis LP mint. */
export const LAUNCH_GAS = 655_948n

/**
 * Intrinsic cost of any transaction. Calldata is deliberately not modelled: for
 * `createLaunch` it is a few hundred gas that moves with the length of the name
 * and ticker, which is noise next to a half-million-gas call and not worth
 * pretending to predict.
 */
export const TX_BASE_GAS = 21_000n

export const CREATE_LAUNCH_GAS_TOTAL = CREATE_LAUNCH_GAS + TX_BASE_GAS
export const LAUNCH_GAS_TOTAL = LAUNCH_GAS + TX_BASE_GAS

/** Both creator transactions. This is the honest "what does it cost to launch". */
export const PROJECT_GAS_TOTAL = CREATE_LAUNCH_GAS_TOTAL + LAUNCH_GAS_TOTAL

/**
 * Cost in wei of `gas` units at `feePerGas`.
 *
 * Returns `null` rather than `0n` when the fee is unknown. A zero here would
 * render as "0 ETH gas", which reads as "free" instead of "not known yet" —
 * the same class of lie the `dialsReady` all-or-nothing gate exists to prevent.
 */
export function gasCostWei(gas: bigint, feePerGas: bigint | undefined): bigint | null {
  if (feePerGas === undefined) return null
  return gas * feePerGas
}

/**
 * Render an ESTIMATE in ETH, rounded to four significant digits.
 *
 * Deliberately not the page's `trimEth`, which only strips trailing zeros and
 * so prints all 18 decimals. That is right for the launch fee, where every
 * digit is a fact the factory will enforce, and wrong here: `0.001037884137798906
 * ETH` claims wei-level precision for a figure derived from a gas budget and a
 * fee oracle that will both have moved by the time the creator signs.
 *
 * Significant digits rather than fixed decimals because the same panel has to
 * read sensibly at testnet prices and at 30 gwei on L1, which are orders of
 * magnitude apart.
 */
export function formatEstimateEth(wei: bigint): string {
  const eth = Number(wei) / 1e18
  if (eth === 0) return '0'
  return eth.toLocaleString('en-US', { maximumSignificantDigits: 4, useGrouping: false })
}
