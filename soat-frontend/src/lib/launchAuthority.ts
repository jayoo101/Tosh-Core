'use client'

import { useReadContract, useReadContracts } from 'wagmi'
import { parseAbi, type Address } from 'viem'

import { FACTORY_ADDRESS } from '@/lib/contracts'

/**
 * `ToshLaunchGateway`, less the `createLaunch` / `launch` pair it shares with
 * the factory word for word — those are sent with `FACTORY_ABI`, and listing
 * them twice would give viem two identical overloads to choose between.
 */
export const LAUNCH_GATEWAY_ABI = parseAbi([
  'function factory() view returns (address)',
  'function safe() view returns (address)',
  'function canLaunch(address account) view returns (bool)',
  'function getOwners() view returns (address[])',
  'error NotLauncher()',
  'error NotSafe()',
])

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

export interface LaunchAuthority {
  /** False until it is known whether `account` may launch. */
  resolved: boolean
  /** The gateway that owns the factory, or `undefined` when the owner is called directly. */
  gateway?: Address
  /** The Safe behind the gateway. */
  safe?: Address
  /** Where `createLaunch` and `launch` are sent. */
  target: Address
  /** The factory's `msg.sender`, which `finalSalt` and `creator` are bound to. */
  creator?: Address
  canLaunch: boolean
}

/**
 * Who may call `createLaunch` / `launch`, and through what.
 *
 * When the factory's owner is a `ToshLaunchGateway`, any current owner of its
 * Safe may, by calling the gateway; otherwise only the owner itself, calling
 * the factory. The gateway is recognised by asking the owner for `factory()`,
 * which a Safe or an EOA cannot answer with this factory's address.
 */
export function useLaunchAuthority(owner: Address | undefined, account: Address | undefined): LaunchAuthority {
  const probe = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: owner, abi: LAUNCH_GATEWAY_ABI, functionName: 'factory' },
      { address: owner, abi: LAUNCH_GATEWAY_ABI, functionName: 'safe' },
    ],
    query: { enabled: !!owner, staleTime: 60_000, retry: false },
  })
  const gateway = owner && same(probe.data?.[0]?.result as string | undefined, FACTORY_ADDRESS)
    ? owner : undefined
  const safe = gateway ? probe.data?.[1]?.result as Address | undefined : undefined

  const signer = useReadContract({
    address: gateway, abi: LAUNCH_GATEWAY_ABI, functionName: 'canLaunch',
    args: account ? [account] : undefined,
    query: { enabled: !!gateway && !!account, staleTime: 60_000 },
  })

  if (gateway) {
    return {
      resolved: !account || signer.isFetched,
      gateway, safe, target: gateway, creator: gateway,
      canLaunch: signer.data === true,
    }
  }
  return {
    resolved: !!owner && probe.isFetched,
    target: FACTORY_ADDRESS,
    creator: account,
    canLaunch: same(owner, account),
  }
}
