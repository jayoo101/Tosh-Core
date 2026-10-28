/**
 * Chains this protocol has left.
 *
 * Keyed by id because that is what a script has in hand — either as a pinned
 * constant or as the answer to `eth_chainId` — and matching on the id rather
 * than on a name means a build that only ever wrote `46630` is still covered.
 *
 * A retired chain's endpoint can still answer: on 2026-09-18 the Robinhood
 * testnet RPC served `eth_chainId` as 46630. A build pointed at one therefore
 * connects and reads real contracts rather than failing, which is why it is
 * refused by id instead of being left to a network error.
 */
export const RETIRED_CHAINS = {
  4663: {
    name: 'Robinhood Chain mainnet',
    left: 'Settlement moved to BNB Smart Chain 56 with PancakeSwap Infinity.',
  },
  46630: {
    name: 'Robinhood Chain testnet',
    left: 'Rehearsals moved to BNB Smart Chain testnet 97.',
  },
}

/** What `chainId` was, or `null` when it is a chain this protocol still uses. */
export function retiredChain(chainId) {
  return RETIRED_CHAINS[String(BigInt(chainId))] ?? null
}
