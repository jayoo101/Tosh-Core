/**
 * A BSC provider that survives the public endpoints.
 *
 * Extracted because every script that reads mainnet learned the same lesson
 * separately. The free endpoints do not fail in one way that a single retry
 * would cover — they fail in several that look alike from the call site:
 *
 *   - `bsc-dataseed.bnbchain.org` answers `cast` happily while resetting
 *     Node's TLS connection outright (ECONNRESET before the handshake).
 *   - `publicnode` serves recent blocks and refuses anything older with
 *     `-32602 Archive requests require a personal token`.
 *   - The `dataseed` family returns errors ethers cannot even parse, which
 *     surface as the unhelpful `could not coalesce error`.
 *   - `blastapi` and `1rpc` rate-limit into `exceeded maximum retry limit`.
 *
 * A paid endpoint in `BSC_RPC` is always tried first when present, because the
 * above is what the alternative looks like.
 */

import { ethers } from 'ethers'

export const BSC_CHAIN_ID = 56

/** Ordered by preference: paid first, then the endpoints that fail least. */
export function candidateRpcs() {
  return [
    process.env.BSC_RPC,
    process.env.MM_RPC_URL,
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-dataseed1.ninicoin.io',
    'https://bsc.drpc.org',
    'https://bsc-dataseed.bnbchain.org',
  ].filter(Boolean)
}

/**
 * The first endpoint that answers a trivial request.
 *
 * `staticNetwork` is not an optimisation. Without it ethers opens with a
 * network-detection round trip, and on a host that resets TLS that failure
 * reports as "failed to detect network" — which sends you to check the chain id
 * when the problem is the socket.
 */
export async function connect() {
  const failures = []
  for (const url of candidateRpcs()) {
    try {
      const provider = new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, {
        staticNetwork: true,
        // The dataseed nodes mishandle JSON-RPC batches; one call per request
        // is slower and is the only thing they answer reliably.
        batchMaxCount: 1,
      })
      const blockNumber = await provider.getBlockNumber()
      return { provider, url, blockNumber, paid: url === process.env.BSC_RPC }
    } catch (e) {
      failures.push(`${url}: ${e.shortMessage || e.message}`)
    }
  }
  throw new Error(`no usable BSC RPC:\n  ${failures.join('\n  ')}`)
}

/**
 * Retry a read across endpoints.
 *
 * For the case where the endpoint that answered `getBlockNumber` then fails on
 * something real. Takes a function of a provider rather than a provider so the
 * caller's whole read is retried, not just one call inside it.
 */
export async function withFallback(fn) {
  const failures = []
  for (const url of candidateRpcs()) {
    try {
      const provider = new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, {
        staticNetwork: true, batchMaxCount: 1,
      })
      return await fn(provider)
    } catch (e) {
      failures.push(`${url}: ${e.shortMessage || e.message}`)
    }
  }
  throw new Error(`every endpoint failed:\n  ${failures.join('\n  ')}`)
}
