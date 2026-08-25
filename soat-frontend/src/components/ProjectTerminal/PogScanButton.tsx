'use client'
import { useState, useEffect, useCallback } from 'react'
import {
  useChainId, useSignMessage, useWriteContract, useWaitForTransactionReceipt,
} from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS,
  isSupportedPogChain, buildPoGScanAuthMessage,
} from '@/lib/contracts'
import { fmt } from './format'
import { readPogAuthCache, writePogAuthCache } from './pogAuthCache'
import { WriteButton, TxLine } from './primitives'


// ─────────────────────────────────────────────────────────────────────────────
// POG SCAN BUTTON
// ─────────────────────────────────────────────────────────────────────────────

export function PogScanButton({
  userAddress, hookAddress, refetch,
}: {
  userAddress: Address | undefined
  hookAddress: Address | undefined
  refetch:     () => void
}) {
  const chainId = useChainId()
  const { signMessageAsync } = useSignMessage()
  const [busy, setBusy] = useState(false)
  const [msg,  setMsg]  = useState<string | null>(null)
  const [tone, setTone] = useState<'fluo' | 'mute' | 'rust'>('fluo')

  const {
    writeContract: writeRegister,
    isPending:     isRegistering,
    data:          regHash,
  } = useWriteContract()
  const { isLoading: isRegConfirming, isSuccess: regOk } =
    useWaitForTransactionReceipt({ hash: regHash })
  useEffect(() => { if (regOk) refetch() }, [regOk, refetch])

  const run = useCallback(async () => {
    setMsg(null)
    if (!userAddress) { setTone('rust'); setMsg('Connect wallet'); return }
    if (!hookAddress) { setTone('rust'); setMsg('No hook bound'); return }
    if (!isSupportedPogChain(chainId)) {
      setTone('rust'); setMsg(`Unsupported chain (got ${chainId})`); return
    }

    setBusy(true)
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

      const { maxAlloc, nonce, deadline, signature } = data
      setTone('mute')
      setMsg(`GAS_TELEMETRY_LOGGED · ALLOC=${fmt(BigInt(maxAlloc))} ETH · NONCE=${nonce}`)

      writeRegister({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI,
        functionName: 'registerPoG',
        args: [BigInt(maxAlloc), BigInt(deadline), BigInt(nonce), signature as `0x${string}`],
      })
    } catch (err) {
      setTone('rust')
      setMsg(err instanceof Error ? err.message.slice(0, 160) : 'Scan failed')
    } finally {
      setBusy(false)
    }
  }, [userAddress, hookAddress, chainId, signMessageAsync, writeRegister])

  return (
    <div className="flex flex-col items-end gap-1">
      <WriteButton
        label="EXECUTE_GAS_PROOF_SCAN"
        onClick={() => void run()}
        busy={busy || isRegistering || isRegConfirming}
      />
      {msg && (
        <span className={`font-mono text-[10px] tracking-wider
                          ${tone === 'rust'
                            ? 'text-tosh-rust'
                            : tone === 'mute' ? 'text-[#888]' : 'text-tosh-fluo'}`}>
          {tone === 'rust' ? '⛔' : '→'} {msg}
        </span>
      )}
      {regHash && <TxLine hash={regHash} label="registerPoG" />}
    </div>
  )
}
