'use client'

/**
 * useProtocolOwner — single source of truth for "is the connected wallet the
 * Tosh protocol owner?".
 *
 * The owner is resolved by reading `ToshFactory.owner()` on every render — no
 * hard-coded address ships to the bundle, so a transferOwnership() tx flips
 * the entire UI's admin-channel visibility on the next refresh, automatically.
 *
 * Returns:
 *   ▸ owner    — Address | undefined   (undefined while the on-chain read
 *                                       is in flight or RPC is unreachable)
 *   ▸ isOwner  — boolean               (strict, lower-cased comparison; only
 *                                       true once BOTH `address` and `owner`
 *                                       are known and match)
 *   ▸ isLoading — boolean              (mirrors wagmi's read state — useful
 *                                       for masking the admin redirect so we
 *                                       never bounce a legitimate owner
 *                                       during the first paint)
 *
 * Usage:
 *   const { isOwner, isLoading } = useProtocolOwner()
 *   if (!isLoading && !isOwner) router.push('/')
 */

import { useReadContract } from 'wagmi'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { FACTORY_ABI, FACTORY_ADDRESS } from '@/lib/contracts'

export interface UseProtocolOwnerResult {
  /** Connected wallet address (mirrored from wagmi for caller convenience). */
  address:   Address | undefined
  /** On-chain `factory.owner()` — the canonical admin address. */
  owner:     Address | undefined
  /** True iff connected wallet matches the on-chain owner (case-insensitive). */
  isOwner:   boolean
  /** True while the on-chain read is in flight (mask redirects with this). */
  isLoading: boolean
}

export function useProtocolOwner(): UseProtocolOwnerResult {
  const { address } = useAccount()

  const { data, isLoading } = useReadContract({
    address:      FACTORY_ADDRESS,
    abi:          FACTORY_ABI,
    functionName: 'owner',
  })

  const owner   = data as Address | undefined
  const isOwner =
    Boolean(address) &&
    Boolean(owner) &&
    address!.toLowerCase() === owner!.toLowerCase()

  return { address, owner, isOwner, isLoading }
}
