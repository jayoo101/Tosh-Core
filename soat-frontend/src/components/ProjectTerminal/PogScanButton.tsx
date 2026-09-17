'use client'

/**
 * Manual entry point kept for tests and any surface that still wants an
 * explicit button. The app shell auto-starts the unsigned lookup on connect;
 * this button runs the same path on click (lookup without a signature, then
 * attestation with one).
 */

import { useState, useCallback } from 'react'
import { useChainId, usePublicClient, useSignMessage } from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS,
  isSupportedPogChain, buildPoGScanAuthMessage,
} from '@/lib/contracts'
import { ActionButton, useActionGate, useTxAction, toshToast } from '@/components/ui'
import { fmt } from './format'
import { readPogAuthCache, writePogAuthCache } from './pogAuthCache'
import { runUnsignedPogScan } from './pogScanClient'
import { NATIVE_SYMBOL } from '@/lib/chain'

type Phase = 'idle' | 'scanning' | 'signing'

export function PogScanButton({
  userAddress, hookAddress, refetch,
}: {
  userAddress: Address | undefined
  hookAddress: Address | undefined
  refetch:     () => void
}) {
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { signMessageAsync } = useSignMessage()
  const [phase, setPhase] = useState<Phase>('idle')

  const { send, isPending, isConfirming, isBusy } = useTxAction({
    action: 'register Proof-of-Gas',
    onConfirmed: refetch,
  })

  const run = useCallback(async () => {
    if (!userAddress) { toshToast.error('Connect a wallet first'); return }
    if (!hookAddress) { toshToast.error('No hook bound to this project'); return }
    if (!isSupportedPogChain(chainId)) {
      toshToast.error(`Unsupported chain (got ${chainId})`)
      return
    }

    try {
      setPhase('scanning')
      const scan = await runUnsignedPogScan(userAddress, chainId)
      const missing = scan.unavailableChains ?? []

      if (!scan.eligible) {
        throw new Error(
          `Not eligible — ${fmt(BigInt(scan.totalGasWei))} ETH of historical gas `
          + `across all chains, and the floor is ${fmt(BigInt(scan.floorWei))} ETH.`
          + (missing.length > 0
            ? ` ${missing.join(' and ')} could not be read, so this total may be`
              + ' slightly low — retrying later may change it.'
            : ''),
        )
      }
      if (scan.truncated) {
        toshToast.info(
          missing.length > 0
            ? `${missing.join(' and ')} could not be read; this total is a lower bound.`
            : 'Some history was too large to page through; this is a lower bound.',
        )
      }

      setPhase('signing')
      let auth = readPogAuthCache(userAddress)
      let ts = auth?.timestamp ?? Date.now()
      if (!auth) {
        ts = Date.now()
        const sig = await signMessageAsync({
          message: buildPoGScanAuthMessage(userAddress, ts),
        })
        auth = { signature: sig as `0x${string}`, timestamp: ts }
        writePogAuthCache(userAddress, auth)
      }

      const res = await fetch('/api/sign-allocation', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userAddress, contractAddress: FACTORY_ADDRESS,
          chainId, timestamp: ts, signature: auth.signature,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)

      const { maxAlloc, nonce, deadline, signature, issuer } = data

      if (issuer && publicClient) {
        const accepted = await publicClient.readContract({
          address: FACTORY_ADDRESS, abi: FACTORY_ABI,
          functionName: 'pogSigner',
        }).catch(() => undefined)
        if (accepted && String(accepted).toLowerCase() !== String(issuer).toLowerCase()) {
          throw new Error(
            `Attestation signer mismatch — this site signed with ${issuer}, but the `
            + `factory only accepts ${accepted}, so registerPoG would reject it. `
            + 'The signing key and the on-chain signer have drifted apart; this is a '
            + 'deployment fault, not a problem with your wallet.',
          )
        }
      }

      toshToast.info(`Quota sized · ${fmt(BigInt(maxAlloc))} ${NATIVE_SYMBOL}`)

      send({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI,
        functionName: 'registerPoG',
        args: [BigInt(maxAlloc), BigInt(deadline), BigInt(nonce), signature as `0x${string}`],
      })
    } catch (err) {
      toshToast.fromError(err)
    } finally {
      setPhase('idle')
    }
  }, [userAddress, hookAddress, chainId, publicClient, signMessageAsync, send])

  const gate = useActionGate({
    action: phase === 'scanning' ? 'Scanning five chains…'
      : phase === 'signing' ? 'Sizing quota…'
      : 'Activate deposit quota',
    onAct: () => { void run() },
    tx: { isBusy: phase !== 'idle' || isBusy, isPending, isConfirming },
  })

  return <ActionButton gate={gate} full={false} />
}
