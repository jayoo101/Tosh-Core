'use client'

import { useAccount } from 'wagmi'

/**
 * The chain the WALLET is on — which is not what `useChainId()` answers.
 *
 * ⚠ `useChainId()` CANNOT DETECT A WRONG NETWORK, and every wrong-network check
 *   in this app was built on it. It returns `config.state.chainId`, and
 *   `createConfig`'s `syncConnectedChain` subscriber declines to move that
 *   value onto a chain the config does not list:
 *
 *       // If chain is not configured, then don't switch over to it.
 *       const isChainConfigured = chains.getState().some((x) => x.id === chainId)
 *       if (!isChainConfigured) return
 *
 *   `providers.tsx` registers two chains, the target and Foundry, so a wallet
 *   parked on anything else leaves `useChainId()` reporting the target id. The
 *   comparison `chainId !== TARGET_CHAIN_ID` then reads 97 !== 97 and concludes
 *   the wallet is exactly where it should be.
 *
 *   The failure is worst on the chains furthest from correct. A wallet on 4663
 *   — where this build used to point, so a real wallet really is still parked
 *   there — got no wrong-network strip, a live Deploy button, and
 *   `ChainMismatchError` thrown by viem at signing time, naming two chain ids
 *   and offering nothing to do about either. The gate that exists to catch this
 *   before the click was structurally incapable of firing.
 *
 * `useAccount()` reads the connection rather than the config. `getConnection`
 * returns `chainId: connection?.chainId` verbatim and resolves `chain` against
 * the configured list separately, so the id survives even when this build has
 * never heard of the chain. That is the value every check below wanted.
 *
 * Returns `undefined` while disconnected, so `chainId !== TARGET_CHAIN_ID` is
 * NOT a safe wrong-network test on its own — pair it with `isConnected`, the
 * way `useActionGate` and `NetworkGuard` do. A bare comparison would flag a
 * wallet that simply is not there yet.
 *
 * `scripts/checkWalletChain.ts` fails the build on a fresh `useChainId` import.
 */
export function useWalletChainId(): number | undefined {
  return useAccount().chainId
}
