'use client'

/**
 * Auto gas lookup + optional on-chain quota registration.
 *
 * A connected wallet starts an unsigned `/api/pog-scan` from the app shell, on
 * any page — not only the genesis deposit card — and the per-chain dialog opens
 * as soon as the read begins. Registering quota still needs one EIP-191 message
 * (for `sign-allocation`) and one `registerPoG` transaction; that is custody of
 * the allocation, not of the public fee totals.
 *
 * Answer state is stamped with the address it belongs to, so switching wallets
 * cannot flash the previous wallet's figures (same shape as `useReferralCode`).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, useChainId, usePublicClient, useSignMessage } from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS,
  isSupportedPogChain, buildPoGScanAuthMessage,
} from '@/lib/contracts'
import { useTxAction, toshToast } from '@/components/ui'
import { NATIVE_SYMBOL } from '@/lib/chain'
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

const DISMISS_PREFIX = 'tosh:pog-dialog:'

function dialogDismissed(address: string): boolean {
  try {
    return sessionStorage.getItem(DISMISS_PREFIX + address) === '1'
  } catch {
    return false
  }
}

function markDialogDismissed(address: string): void {
  try {
    sessionStorage.setItem(DISMISS_PREFIX + address, '1')
  } catch {
    /* private mode */
  }
}

export function usePogFlow() {
  const { address: userAddress } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { signMessageAsync } = useSignMessage()

  const [answer, setAnswer] = useState<Answer | null>(null)
  const [dialogOpen, setDialogOpenRaw] = useState(false)
  const startedFor = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const refetchListeners = useRef(new Set<() => void>())

  const addrKey = userAddress?.toLowerCase() ?? null
  const mine = answer && addrKey && answer.address === addrKey ? answer : null
  const phase = mine?.phase ?? 'idle'
  const scan = mine?.scan ?? null
  const error = mine?.error ?? null

  const bindRefetch = useCallback((fn: () => void) => {
    refetchListeners.current.add(fn)
    return () => { refetchListeners.current.delete(fn) }
  }, [])

  const { send, isPending, isConfirming, isBusy } = useTxAction({
    action: 'register Proof-of-Gas',
    onConfirmed: () => {
      setDialogOpenRaw(false)
      if (addrKey) markDialogDismissed(addrKey)
      refetchListeners.current.forEach(fn => fn())
    },
  })

  const setDialogOpen = useCallback((open: boolean) => {
    setDialogOpenRaw(open)
    if (!open && addrKey) markDialogDismissed(addrKey)
  }, [addrKey])

  const startLookup = useCallback(async (force = false) => {
    if (!userAddress) return
    const key = userAddress.toLowerCase()
    const runKey = `${key}:${chainId}`
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
    startedFor.current = runKey

    setAnswer({ address: key, phase: 'scanning', scan: null, error: null })
    if (!dialogDismissed(key)) setDialogOpenRaw(true)
    try {
      const result = await runUnsignedPogScan(userAddress, chainId, {
        force,
        signal: ac.signal,
      })
      if (ac.signal.aborted) {
        if (startedFor.current === runKey) startedFor.current = null
        return
      }
      setAnswer({ address: key, phase: 'ready', scan: result, error: null })
      if (!dialogDismissed(key)) setDialogOpenRaw(true)

      const missing = result.unavailableChains ?? []
      if (result.truncated) {
        toshToast.info(
          missing.length > 0
            ? `${missing.join(' and ')} could not be read; this total is a lower bound.`
            : 'Some history was too large to page through; this is a lower bound.',
        )
      }
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        if (startedFor.current === runKey) startedFor.current = null
        return
      }
      startedFor.current = null
      const msg = err instanceof Error ? err.message : String(err)
      setAnswer({ address: key, phase: 'failed', scan: null, error: msg })
      if (!dialogDismissed(key)) setDialogOpenRaw(true)
      toshToast.fromError(err)
    }
  }, [userAddress, chainId])

  useEffect(() => {
    if (!userAddress) {
      abortRef.current?.abort()
      startedFor.current = null
      return
    }
    const runKey = `${userAddress.toLowerCase()}:${chainId}`
    if (startedFor.current === runKey) return
    void startLookup(false)
  }, [userAddress, chainId, startLookup])

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

      // The quota is what the wallet may DEPOSIT, so it is the settlement coin
      // — not the ETH the gas history that sized it was measured in.
      toshToast.info(`Quota sized · ${fmt(BigInt(maxAlloc))} ${NATIVE_SYMBOL}`)

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
    userAddress: userAddress as Address | undefined,
    phase,
    scan,
    error,
    dialogOpen,
    setDialogOpen,
    startLookup,
    registerQuota,
    bindRefetch,
    registering: isBusy,
    isPending,
    isConfirming,
  }
}

export type PogFlow = ReturnType<typeof usePogFlow>
