'use client'

import { useCallback } from 'react'
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import type { Address } from 'viem'
import { FACTORY_ADDRESS, FACTORY_ABI, TARGET_CHAIN_ID } from '@/lib/contracts'

// ─────────────────────────────────────────────────────────────────────────────
// useTosh — wagmi v2 hook for ToshFactory interactions
//
// Two independent useWriteContract instances so createLaunch and registerPoG
// never share state (no cross-contamination of hash / isPending / error).
// ─────────────────────────────────────────────────────────────────────────────
export function useTosh() {

  // ── Slot A: createLaunch ─────────────────────────────────────────────────
  const {
    writeContractAsync: writeA,
    data:               hashA,
    isPending:          isPendingA,
    error:              errorA,
    reset:              resetA,
  } = useWriteContract()

  const {
    isLoading: isConfirmingA,
    isSuccess: settledA,
    error:     receiptErrorA,
    data:      receiptA,
  } = useWaitForTransactionReceipt({ hash: hashA })

  // `isSuccess` here means the receipt arrived, not that createLaunch worked:
  // viem resolves normally for a transaction that mined and then reverted. Both
  // this and `receiptErrorA` were previously dropped, so a reverted launch
  // rendered as "Confirmed" and an RPC failure left the toast spinning forever.
  const revertedA    = receiptA?.status === 'reverted'
  const isConfirmedA = settledA && !revertedA

  // ── Slot B: registerPoG ──────────────────────────────────────────────────
  const {
    writeContractAsync: writeB,
    data:               hashB,
    isPending:          isPendingB,
    error:              errorB,
    reset:              resetB,
  } = useWriteContract()

  const {
    isLoading: isConfirmingB,
    isSuccess: settledB,
    error:     receiptErrorB,
    data:      receiptB,
  } = useWaitForTransactionReceipt({ hash: hashB })

  const revertedB    = receiptB?.status === 'reverted'
  const isConfirmedB = settledB && !revertedB

  // ── createLaunch ─────────────────────────────────────────────────────────
  // Owner-only and unpaid: the factory reverts `OwnableUnauthorizedAccount`
  // for any other sender, and there is no launch fee to send.
  //
  // Explicit gas cap bypasses eth_estimateGas so an RPC can't surface a
  // misleading "exceeds block gas limit" error on simulation revert.
  //
  //   • developer → the project treasury baked into the hook, and the address
  //     the Circuit NFT is minted to. MUST be non-zero.
  //   • hardCap / walletCap / genesisDuration → immutable clone args, so they
  //     MUST be the values the salt was derived against or the hook will not
  //     land at the predicted address.
  //   • via → the factory, or the `ToshLaunchGateway` that owns it, which
  //     takes the same call from any signer of its Safe.
  const createLaunch = useCallback(
    async (
      name:            string,
      symbol:          string,
      developer:       Address,
      hookSalt:        `0x${string}`,
      hardCap:         bigint,
      walletCap:       bigint,
      genesisDuration: bigint,
      via:             Address = FACTORY_ADDRESS,
    ): Promise<`0x${string}`> =>
      writeA({
        address:      via,
        abi:          FACTORY_ABI,
        functionName: 'createLaunch',
        args:         [name, symbol, developer, hookSalt, hardCap, walletCap, genesisDuration],
        gas:          6_000_000n,
        chainId:      TARGET_CHAIN_ID,
      }),
    [writeA]
  )

  // ── registerPoG — 6D anti-replay (MeritX format, uses Slot B) ───────────
  // signature = ECDSA(keccak256(sender, maxAlloc, nonce, deadline, contract, chainId))
  // Uses Slot B so it never clobbers createLaunch's pending/hash/error state.
  const registerPoG = useCallback(
    async (
      maxAlloc:  bigint,
      deadline:  bigint,
      nonce:     bigint,
      signature: `0x${string}`
    ): Promise<`0x${string}`> =>
      writeB({
        address:      FACTORY_ADDRESS,
        abi:          FACTORY_ABI,
        functionName: 'registerPoG',
        args:         [maxAlloc, deadline, nonce, signature],
        chainId:      TARGET_CHAIN_ID,
      }),
    [writeB]
  )

  return {
    // ── Slot A: createLaunch ───────────────────────────────────────────────
    createLaunch,
    hash:        hashA,
    receipt:     receiptA,
    isPending:   isPendingA,
    isConfirming:isConfirmingA,
    isConfirmed: isConfirmedA,
    error:       errorA ?? receiptErrorA ?? (revertedA
      ? new Error('Reverted on-chain — createLaunch was rejected by the factory.')
      : null),
    reset:       resetA,

    // ── Slot B: registerPoG ────────────────────────────────────────────────
    registerPoG,
    pogHash:        hashB,
    pogIsPending:   isPendingB,
    pogIsConfirming:isConfirmingB,
    pogIsConfirmed: isConfirmedB,
    pogError:       errorB ?? receiptErrorB ?? (revertedB
      ? new Error('Reverted on-chain — registerPoG was rejected by the factory.')
      : null),
    pogReset:       resetB,
  }
}
