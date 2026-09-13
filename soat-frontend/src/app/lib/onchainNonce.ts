// ─────────────────────────────────────────────────────────────────────────────
//  onchainNonce.ts — server-side reads of ToshFactory taken at signing time,
//  so that what the oracle attests is checked against chain and not against
//  configuration. Two of them: the live `pogNonces` value this file is named
//  for, and `pogSigner`, which says whether the oracle's own key is the key the
//  factory will accept.
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

import type { Address, PublicClient } from 'viem'

import { FACTORY_ABI } from './abis'
import { serverPublicClient } from './serverRpc'
import { isSupportedPogChain, supportedPogChainLabel } from '@/lib/chain'

/**
 * Endpoint selection lives in `serverRpc` so that the chain bound to the
 * client and the chain named by the URL cannot drift apart. This module used
 * to pick its own, with `BASE_SEPOLIA_RPC` sitting in the chain-agnostic slot:
 * on a mainnet build that read the nonce off Sepolia, and a nonce from the
 * wrong chain signs an attestation the factory then rejects — the user pays
 * gas to revert.
 */
export function getPublicClientForChain(chainId: number): PublicClient {
  // Asks `chain.ts` rather than restating the allowlist. This used to be its own
  // `chainId !== TARGET_CHAIN_ID && chainId !== FOUNDRY_CHAIN_ID`, a second
  // independent copy of the same decision — so tightening one of the two would
  // have left the other accepting what the first had just refused, and the
  // route's own check is the other one.
  if (!isSupportedPogChain(chainId)) {
    throw new Error(
      `[onchainNonce] Unsupported chainId ${chainId}. ` +
      `PoG signing accepts ${supportedPogChainLabel()}.`,
    )
  }
  return serverPublicClient(chainId)
}

/**
 * Read `ToshFactory.pogSigner()` from chain — the address whose signature
 * `registerPoG` will accept, and therefore the only authority on whether the
 * key in `POG_SIGNER_PRIVATE_KEY` is the right key.
 *
 * This exists because the signing route had no way to know it was wrong. It
 * derived an account from the configured key, checked that the key *parsed*,
 * and signed. A key that parses but belongs to some other address produces a
 * perfectly well-formed attestation: the route answers 200, the client submits
 * it, and `registerPoG` rejects the recovered signer. Every user pays gas to
 * revert, and nothing server-side registers a fault — the one failure the
 * operator most needs to hear about is the one that looks like success.
 *
 * Compare that to the other five fields of the digest. `nonce` is read live,
 * for the reason at the top of this file. `contract_` is pinned to
 * `FACTORY_ADDRESS`. `chainId` is checked against the allow-list. `sender` and
 * `maxAlloc` are derived from an authenticated scan. Signer identity was the
 * one input still taken on the word of an environment variable, and it is the
 * one nobody can audit from outside: the production key is write-only in
 * Vercel, so no guard script and no CI job can ever see the value that is
 * actually in use. Asking the chain at signing time is the only check that runs
 * where the real key is.
 */
export async function fetchPogSigner(
  factory: Address,
  chainId: number,
): Promise<Address> {
  const client = getPublicClientForChain(chainId)
  const signer = await client.readContract({
    address:      factory,
    abi:          FACTORY_ABI,
    functionName: 'pogSigner',
  })
  return signer as Address
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
