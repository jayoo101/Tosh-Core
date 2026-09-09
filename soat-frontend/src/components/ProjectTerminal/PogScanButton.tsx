'use client'
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

/** What the button is waiting on, so the label can say which of the two waits
 *  the user is in. They have very different lengths — the scan is tens of
 *  seconds against five explorers, the signature is milliseconds. */
type Phase = 'idle' | 'scanning' | 'signing'

interface ScanResult {
  status: 'running' | 'done' | 'failed'
  eligible?: boolean
  totalGasWei?: string
  floorWei: string
  truncated?: boolean
  /** Chains counted as zero because they could not be read. Named, so the reason
   *  a total is a lower bound can be stated instead of hinted at. */
  unavailableChains?: string[]
  error?: string
  retryAfterMs?: number
}

/** How long to keep polling before giving up.
 *
 *  Sized off the server's own lease rather than guessed: `scanJobStore` reports
 *  a `running` job as failed once `JOB_LEASE_MS` (120 s) has passed, so a client
 *  that waits meaningfully longer is waiting for an answer that can no longer
 *  arrive, and one that gives up sooner abandons scans that were about to land. */
const POLL_BUDGET_MS = 135_000
const POLL_INTERVAL_MS = 2_000

/**
 * Start a scan and wait for it, returning the finished figures.
 *
 * The POST is idempotent by design — the route joins a scan already in flight
 * and serves a cached one — so a user who clicks twice does not pay twice, and
 * this needs no lock of its own.
 */
async function runScan(
  userAddress: Address,
  chainId: number,
  timestamp: number,
  signature: `0x${string}`,
  setPhase: (p: Phase) => void,
): Promise<ScanResult & { totalGasWei: string }> {
  setPhase('scanning')

  const started = await fetch('/api/pog-scan', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ userAddress, chainId, timestamp, signature }),
  })
  const first = (await started.json()) as ScanResult
  if (!started.ok) {
    // 429 and 503 both carry how long to wait, and both mean "the answer you
    // already have still stands". Surfacing the wait beats a bare failure.
    const wait = first.retryAfterMs
    throw new Error(
      (first.error ?? `HTTP ${started.status}`)
      + (wait ? ` Try again in ${Math.ceil(wait / 60_000)} min.` : ''),
    )
  }

  let latest = first
  const deadline = Date.now() + POLL_BUDGET_MS
  while (latest.status === 'running') {
    if (Date.now() > deadline) {
      throw new Error('Gas scan timed out. Try again.')
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    const polled = await fetch(
      `/api/pog-scan?address=${userAddress}`,
      { cache: 'no-store' },
    )
    latest = (await polled.json()) as ScanResult
    if (!polled.ok) throw new Error(latest.error ?? `HTTP ${polled.status}`)
  }

  if (latest.status !== 'done' || typeof latest.totalGasWei !== 'string') {
    throw new Error(latest.error ?? 'Gas scan failed. Try again.')
  }
  return { ...latest, totalGasWei: latest.totalGasWei }
}


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
      let auth = readPogAuthCache(userAddress)
      let ts   = auth?.timestamp ?? Date.now()
      if (!auth) {
        ts = Date.now()
        const sig = await signMessageAsync({
          message: buildPoGScanAuthMessage(userAddress, ts),
        })
        auth = { signature: sig as `0x${string}`, timestamp: ts }
        writePogAuthCache(userAddress, auth)
      }

      // Two calls, because the scan is a job. PM-F9 replaced the constant table
      // with a real read of five chains, which measured 10–23 s and therefore
      // cannot happen inside the request that signs; `sign-allocation` refuses
      // with 409 until a finished scan is on file. Skipping this step is not a
      // slow path, it is a guaranteed failure.
      const scan = await runScan(userAddress, chainId, ts, auth.signature, setPhase)

      const missing = scan.unavailableChains ?? []

      if (!scan.eligible) {
        // Said here rather than left to `sign-allocation`'s own refusal, so the
        // number the wallet failed to reach is visible next to the verdict.
        //
        // An unreadable chain is named in this message specifically, because being
        // told "not eligible" is where an under-count costs the user something and
        // where "try again later" is genuinely different advice from "you do not
        // qualify".
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
        // Only ever an under-count, so it can lose a wallet allocation it had
        // earned but never grant one it had not. Worth saying out loud, and worth
        // saying WHICH of the two causes it was: a history too long to page
        // through is permanent, while an unreadable chain clears up.
        toshToast.info(
          missing.length > 0
            ? `${missing.join(' and ')} could not be read; this total is a lower bound.`
            : 'Some history was too large to page through; this is a lower bound.',
        )
      }

      setPhase('signing')
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

      // Check who signed against who the factory will accept, before paying gas
      // to find out. A deployment whose signing key has drifted from the on-chain
      // `pogSigner` — precisely what a half-finished rotation leaves behind, since
      // the key lives in Vercel and the address lives in the factory — reaches the
      // user as `InvalidSignature()` from `registerPoG`: an error that names the
      // signature rather than the misconfiguration, and that arrives only after
      // the transaction has been signed and the gas spent.
      //
      // This is diagnosis, not enforcement. It runs on the client and therefore
      // cannot be a security boundary; `registerPoG` verifies the signature itself
      // and remains the only thing that decides. So a missing `issuer` and an
      // unreadable `pogSigner()` both fall through to that verdict rather than
      // blocking a user the contract would have accepted — this can turn a
      // confusing failure into a clear one, but must never invent a new one.
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
    } finally {
      setPhase('idle')
    }
  }, [userAddress, hookAddress, chainId, publicClient, signMessageAsync, send])

  const gate = useActionGate({
    // The scan reads five explorers and takes tens of seconds, so a button that
    // only said "busy" would look hung. Naming the phase is the difference
    // between waiting and wondering.
    action: phase === 'scanning' ? 'Scanning five chains…'
      : phase === 'signing' ? 'Sizing quota…'
      : 'Run gas-proof scan',
    onAct: () => { void run() },
    tx: { isBusy: phase !== 'idle' || isBusy, isPending, isConfirming },
  })

  return <ActionButton gate={gate} full={false} />
}
