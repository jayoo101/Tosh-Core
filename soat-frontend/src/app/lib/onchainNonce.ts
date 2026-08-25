// ─────────────────────────────────────────────────────────────────────────────
//  onchainNonce.ts — server-side helper for fetching the LIVE pogNonces value
//  from ToshFactory before the signing oracle issues an attestation.
//
//  Why this exists:
//    ToshFactory.registerPoG verifies the 6-D hash
//
//        keccak256(abi.encode(sender, maxAlloc, nonce, deadline, factory, chainId))
//
//    against `pogSigner`'s signature.  If the oracle signs with a stale or
//    caller-supplied `nonce`, the on-chain verifier rejects the call with
//    either `NonceConflict` (sender's slot already advanced) or
//    `InvalidSignature` (hash mismatch).  Either way the user pays gas to
//    revert.
//
//    Pulling the live `factory.pogNonces(user)` on the server side at signing
//    time guarantees freshness: even if the user races a second PoG scan in
//    flight, the LATER attestation will carry the higher nonce and the older
//    one becomes a no-op on submission (signature still valid only against
//    the now-stale nonce, which the contract rejects).
// ─────────────────────────────────────────────────────────────────────────────

import { createPublicClient, http } from 'viem'
import type { Address, Chain, PublicClient } from 'viem'
import { foundry } from 'viem/chains'

import { FACTORY_ABI } from './abis'
import { targetChain, TARGET_CHAIN_ID, FOUNDRY_CHAIN_ID } from '@/lib/chain'

const RPC_ENDPOINTS: Record<number, string> = {
  [TARGET_CHAIN_ID]:
    process.env.NEXT_PUBLIC_RPC_URL ??
    process.env.BASE_SEPOLIA_RPC ??
    process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ??
    (TARGET_CHAIN_ID === 84532 ? 'https://sepolia.base.org'
      : TARGET_CHAIN_ID === 8453 ? 'https://mainnet.base.org'
      : 'https://eth.llamarpc.com'),
  [FOUNDRY_CHAIN_ID]:
    process.env.LOCAL_RPC ?? 'http://127.0.0.1:8545',
}

const SUPPORTED_CHAINS: Record<number, Chain> = {
  [TARGET_CHAIN_ID]: targetChain,
  [FOUNDRY_CHAIN_ID]: foundry,
}

/**
 * Lazily-cached public clients keyed by chainId.  Reusing the same client
 * keeps viem's internal request batcher warm across hot signing bursts.
 */
const clientCache = new Map<number, PublicClient>()

export function getPublicClientForChain(chainId: number): PublicClient {
  const cached = clientCache.get(chainId)
  if (cached) return cached

  const chain = SUPPORTED_CHAINS[chainId]
  const rpc   = RPC_ENDPOINTS[chainId]
  if (!chain || !rpc) {
    throw new Error(
      `[onchainNonce] Unsupported chainId ${chainId}. ` +
      `Configure RPC_ENDPOINTS / SUPPORTED_CHAINS to add support.`
    )
  }

  const client = createPublicClient({ chain, transport: http(rpc) })
  clientCache.set(chainId, client)
  return client
}

/**
 * Read `ToshFactory.pogNonces(user)` from chain.  Returned as `bigint` —
 * callers MUST serialise it via `.toString()` before stuffing into JSON to
 * avoid silent BigInt precision loss in `JSON.stringify`.
 */
export async function fetchPogNonce(
  factory: Address,
  user:    Address,
  chainId: number,
): Promise<bigint> {
  const client = getPublicClientForChain(chainId)
  const nonce  = await client.readContract({
    address:      factory,
    abi:          FACTORY_ABI,
    functionName: 'pogNonces',
    args:         [user],
  })
  return nonce as bigint
}
