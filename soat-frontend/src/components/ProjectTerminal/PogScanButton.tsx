'use client'
import { useState, useCallback } from 'react'
import { useChainId, useSignMessage } from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS,
  isSupportedPogChain, buildPoGScanAuthMessage,
} from '@/lib/contracts'
import { ActionButton, useActionGate, useTxAction, toshToast } from '@/components/ui'
import { fmt } from './format'
import { readPogAuthCache, writePogAuthCache } from './pogAuthCache'


export function PogScanButton({
  userAddress, hookAddress, refetch,
}: {
  userAddress: Address | undefined
  hookAddress: Address | undefined
  refetch:     () => void
}) {
  const chainId = useChainId()
  const { signMessageAsync } = useSignMessage()
  const [scanning, setScanning] = useState(false)

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

    setScanning(true)
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
      toshToast.info(`Quota sized · ${fmt(BigInt(maxAlloc))} ETH`)

      send({
        address: FACTORY_ADDRESS, abi: FACTORY_ABI,
        functionName: 'registerPoG',
        args: [BigInt(maxAlloc), BigInt(deadline), BigInt(nonce), signature as `0x${string}`],
      })
    } catch (err) {
      toshToast.fromError(err)
    } finally {
      setScanning(false)
    }
  }, [userAddress, hookAddress, chainId, signMessageAsync, send])

  const gate = useActionGate({
    action: 'Run gas-proof scan',
    onAct: () => { void run() },
    tx: { isBusy: scanning || isBusy, isPending, isConfirming },
  })

  return <ActionButton gate={gate} full={false} />
}
