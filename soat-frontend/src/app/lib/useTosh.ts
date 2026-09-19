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

  // ── createLaunch (v3.4) ──────────────────────────────────────────────────
  // Explicit gas cap bypasses eth_estimateGas so an RPC can't surface a
  // misleading "exceeds block gas limit" error on simulation revert.
  // Foundry reports ~3.7M for this call; 6M gives ample headroom.
  //
  // v3.4 wire-level changes:
  //   • projectAdmin → mutable admin that receives the 99 % Phase-2 cut.
  //     MUST be non-zero.
  //   • expectedFee  → slippage cap on the platform launchFee.  Caller MUST
  //     read `factory.launchFee()` immediately before invoking this and pass
  //     that exact value.  The factory aborts with FeeChanged if the live
  //     fee has since been bumped above the quote.
  //   • expectedSoftCap / expectedWalletCap → the `factory.defaultSoftCap()` and
  //     `factory.maxPogAllocationLimit()` the caller derived their predicted hook
  //     address from. EXACT, not bounds: the factory aborts with CapsChanged on
  //     any difference, in either direction, because a dial that moved re-rolls
  //     the CREATE2 address whether it moved favourably or not.
  //
  //     These replace what the address-miner used to catch by accident. Under
  //     Uniswap V4 a rotated dial produced an address that failed the permission
  //     mask ~98 % of the time; PancakeSwap Infinity takes permissions from the
  //     hook's own bitmap, so nothing would object without this.
  //   • genesisDuration → 3 h / 24 h / 72 h, in seconds.  Part of the hook's
  //     initcode hash, so this MUST be the same window the salt was derived
  //     against or the deployed address will not be the predicted one.
  const createLaunch = useCallback(
    async (
      name:              string,
      symbol:            string,
      projectTreasury:   Address,
      projectAdmin:      Address,
      hookSalt:          `0x${string}`,
      expectedFee:       bigint,
      expectedSoftCap:   bigint,
      expectedWalletCap: bigint,
      genesisDuration:   bigint
    ): Promise<`0x${string}`> =>
      writeA({
        address:      FACTORY_ADDRESS,
        abi:          FACTORY_ABI,
        functionName: 'createLaunch',
          args: [
            name, symbol, projectTreasury, projectAdmin, hookSalt,
            expectedFee, expectedSoftCap, expectedWalletCap, genesisDuration,
          ],
          // No `value`. `createLaunch` is no longer payable: it pulls the fee with
          // `transferFrom(creator, ladderTreasury)` against an allowance the caller
          // must already hold. `expectedFee` stays in the argument list, where it is
          // the creator's slippage bound against an owner raising the fee in the
          // same block — it is not, and never was, the funding.
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
