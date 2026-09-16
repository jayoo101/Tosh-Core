'use client'

/**
 * Auto gas lookup + optional on-chain quota registration for genesis.
 *
 * On connect with no PoG attestation: start an unsigned `/api/pog-scan` and open
 * the per-chain dialog when it finishes. Registering quota still needs one
 * EIP-191 message (for `sign-allocation`) and one `registerPoG` transaction —
 * that is custody of the allocation, not of the public fee totals.
 *
 * Answer state is stamped with the address it belongs to, so switching wallets
 * cannot flash the previous wallet's figures (same shape as `useReferralCode`).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChainId, usePublicClient, useSignMessage } from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS,
  isSupportedPogChain, buildPoGScanAuthMessage,
} from '@/lib/contracts'
import { useTxAction, toshToast } from '@/components/ui'
import { fmt } from './format'
import { readPogAuthCache, writePogAuthCache } from './pogAuthCache'
import {
  runUnsignedPogScan,
  type PogChainSpend,
  type PogScanResult,
} from './pogScanClient'

export type PogLookupPhase = 'idle' | 'scanning' | 'ready' | 'failed'

export type FinishedScan = PogScanResult & {
  totalGasWei: string
  chains: PogChainSpend[]
}

type Answer = {
  address: string
  phase: PogLookupPhase
  scan: FinishedScan | null
  error: string | null
}

export function usePogFlow({
  userAddress,
  unattested,
  refetch,
}: {
  userAddress: Address | undefined
  /** Connected, not banned, pogQuota === 0. */
  unattested: boolean
  refetch: () => void
}) {
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { signMessageAsync } = useSignMessage()

  const [answer, setAnswer] = useState<Answer | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const startedFor = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const mine = answer && userAddress && answer.address === userAddress.toLowerCase()
    ? answer
    : null
  const phase = mine?.phase ?? 'idle'
  const scan = mine?.scan ?? null
  const error = mine?.error ?? null

  const { send, isPending, isConfirming, isBusy } = useTxAction({
    action: 'register Proof-of-Gas',
    onConfirmed: () => {
      setDialogOpen(false)
      refetch()
    },
  })

  const startLookup = useCallback(async (force = false) => {
    if (!userAddress) return
    const key = userAddress.toLowerCase()
    if (!isSupportedPogChain(chainId)) {
      setAnswer({
        address: key,
        phase: 'failed',
        scan: null,
        error: `Unsupported chain (got ${chainId})`,
      })
      return
    }

    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    startedFor.current = key

    setAnswer({ address: key, phase: 'scanning', scan: null, error: null })
    try {
      const result = await runUnsignedPogScan(userAddress, chainId, {
        force,
        signal: ac.signal,
      })
      if (ac.signal.aborted) return
      setAnswer({ address: key, phase: 'ready', scan: result, error: null })
      setDialogOpen(true)

      const missing = result.unavailableChains ?? []
      if (result.truncated) {
        toshToast.info(
          missing.length > 0
            ? `${missing.join(' and ')} could not be read; this total is a lower bound.`
            : 'Some history was too large to page through; this is a lower bound.',
        )
      }
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
      startedFor.current = null
      const msg = err instanceof Error ? err.message : String(err)
      setAnswer({ address: key, phase: 'failed', scan: null, error: msg })
      toshToast.fromError(err)
    }
  }, [userAddress, chainId])

  useEffect(() => {
    if (!userAddress || !unattested) return
    const key = userAddress.toLowerCase()
    if (startedFor.current === key) return
    void startLookup(false)
  }, [userAddress, unattested, startLookup])

  useEffect(() => () => { abortRef.current?.abort() }, [])

  const registerQuota = useCallback(async () => {
    if (!userAddress) { toshToast.error('Connect a wallet first'); return }
    if (!isSupportedPogChain(chainId)) {
      toshToast.error(`Unsupported chain (got ${chainId})`)
      return
    }
    if (!scan?.eligible) {
      toshToast.error('This wallet is not eligible for a deposit quota yet.')
      return
    }

    try {
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userAddress,
          contractAddress: FACTORY_ADDRESS,
          chainId,
          timestamp: ts,
          signature: auth.signature,
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

      toshToast.info(`Quota sized · ${fmt(BigInt(maxAlloc))} ETH`)

      send({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI,
        functionName: 'registerPoG',
        args: [BigInt(maxAlloc), BigInt(deadline), BigInt(nonce), signature as `0x${string}`],
      })
    } catch (err) {
      toshToast.fromError(err)
    }
  }, [userAddress, chainId, scan, signMessageAsync, publicClient, send])

  return {
    phase,
    scan,
    error,
    dialogOpen,
    setDialogOpen,
    startLookup,
    registerQuota,
    registering: isBusy,
    isPending,
    isConfirming,
  }
}
