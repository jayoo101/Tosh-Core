'use client'

/**
 * Gas lookup + optional on-chain quota registration.
 *
 * A scan is started from exactly one place: the `unattested` gate in
 * `GenesisPanel`, which is to say on a project page, once quota has been read as
 * zero and is the thing standing between the reader and a deposit. That gate
 * starts it on mount and offers the button only as a retry. (There is also
 * `PogScanButton`, which nothing imports outside its own test — do not count it
 * as a route in until something mounts it.)
 *
 * What matters is that this hook does not start one itself. It used to, the
 * moment a wallet connected, and since `PogLookupProvider` is mounted in
 * `app/providers.tsx` that meant every page: anyone who connected a wallet to
 * read the homepage spent a scan. A scan is 5-25 upstream calls against a credit
 * budget, production exhausted it, every caller got `503 at capacity`, and the
 * raise funnel went down with it because quota cannot be sized without a scan.
 * The fix is that the caller is now the component that needs the answer, not the
 * shell that happens to hold the state — so keep `startLookup` out of any effect
 * in here.
 *
 * Registering quota still needs one EIP-191 message
 * (for `sign-allocation`) and one `registerPoG` transaction; that is custody of
 * the allocation, not of the public fee totals.
 *
 * Answer state is stamped with the address it belongs to, so switching wallets
 * cannot flash the previous wallet's figures (same shape as `useReferralCode`).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, usePublicClient, useSignMessage } from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS,
  isSupportedPogChain, buildPoGScanAuthMessage,
} from '@/lib/contracts'
import { useTxAction, toshToast } from '@/components/ui'
import { fill, useT } from '@/i18n'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { useWalletChainId } from '@/lib/useWalletChainId'
import { fmtQuote } from './format'
import { readPogAuthCache, writePogAuthCache } from './pogAuthCache'
import { formatMissingChainList } from '@/app/lib/gasScanCopy'
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
  const chainId = useWalletChainId()
  const publicClient = usePublicClient()
  const { signMessageAsync } = useSignMessage()
  const t = useT().gas

  const [answer, setAnswer] = useState<Answer | null>(null)
  const [dialogOpen, setDialogOpenRaw] = useState(false)
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
    action: t.txAction,
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
    if (!isSupportedPogChain(chainId)) {
      setAnswer({
        address: key,
        phase: 'failed',
        scan: null,
        error: fill(t.unsupportedChain, { chain: chainId ?? t.noChain }),
      })
      return
    }

    // Aborting the previous controller drops OUR listener, not the server's
    // scan. That is fine and is not a leak of budget: `/api/pog-scan` joins an
    // in-flight scan rather than starting a second one, and charges nothing for
    // the join, so a double click costs one scan.
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setAnswer({ address: key, phase: 'scanning', scan: null, error: null })
    if (!dialogDismissed(key)) setDialogOpenRaw(true)
    try {
      const result = await runUnsignedPogScan(userAddress, chainId, {
        force,
        signal: ac.signal,
      })
      if (ac.signal.aborted) return
      setAnswer({ address: key, phase: 'ready', scan: result, error: null })
      if (!dialogDismissed(key)) setDialogOpenRaw(true)

      const missing = result.unavailableChains ?? []
      if (result.truncated) {
        toshToast.info(
          missing.length > 0
            ? fill(t.lowerBoundMissing, { chains: formatMissingChainList(missing, t) })
            : t.lowerBoundPaged,
        )
      }
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      setAnswer({ address: key, phase: 'failed', scan: null, error: msg })
      if (!dialogDismissed(key)) setDialogOpenRaw(true)
      toshToast.fromError(err)
    }
  }, [userAddress, chainId, t])

  // Disconnect only. Connecting a wallet deliberately does nothing here — see
  // the header for what starting a scan costs and what that cost took down.
  useEffect(() => {
    if (userAddress) return
    abortRef.current?.abort()
  }, [userAddress])

  useEffect(() => () => { abortRef.current?.abort() }, [])

  const registerQuota = useCallback(async () => {
    if (!userAddress) { toshToast.error(t.connectFirst); return }
    if (!isSupportedPogChain(chainId)) {
      toshToast.error(fill(t.unsupportedChain, { chain: chainId ?? t.noChain }))
      return
    }
    if (!scan?.eligible) {
      toshToast.error(t.notEligible)
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
      toshToast.info(fill(t.quotaToast, { amount: fmtQuote(BigInt(maxAlloc)), quote: QUOTE_SYMBOL }))

      send({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI,
        functionName: 'registerPoG',
        args: [BigInt(maxAlloc), BigInt(deadline), BigInt(nonce), signature as `0x${string}`],
      })
    } catch (err) {
      toshToast.fromError(err)
    }
  }, [userAddress, chainId, scan, signMessageAsync, publicClient, send, t])

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
