'use client'

import { useEffect, useState } from 'react'
import { erc20Abi, type Address } from 'viem'
import { useAccount, useBalance, useReadContract } from 'wagmi'

import { useTxAction } from '@/components/ui'
import { fill, useT } from '@/i18n'
import { NATIVE_SYMBOL, TARGET_CHAIN_ID } from '@/lib/chain'
import { WRAPPED_NATIVE_ABI } from '@/lib/quoteAssets'
import type { V2Quote } from '@/lib/v2/config'

/** Seconds since epoch, ticking once a second. */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

/** `owner` defaults to the connected wallet. */
export function useTokenBalance(token: Address | undefined, owner?: Address) {
  const { address: connected } = useAccount()
  const address = owner ?? connected
  return useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!token && !!address, refetchInterval: 10_000 },
  })
}

/** BNB kept back for gas when wrapping. */
const GAS_RESERVE = 3_000_000_000_000_000n

/**
 * WBNB a step needs beyond what the wallet holds, and a `wrap()` that deposits
 * exactly that gap. Inert on USDT projects.
 */
export function useWrapShortfall(quote: V2Quote, needed: bigint, onDone: () => void) {
  const tw = useT().wrap
  const { address } = useAccount()
  const wrapped = useTokenBalance(quote.asset)
  const native = useBalance({ address, chainId: TARGET_CHAIN_ID, query: { enabled: !!address && quote.native } })
  const tx = useTxAction({ action: fill(tw.txAction, { native: NATIVE_SYMBOL }), onConfirmed: () => { void wrapped.refetch(); onDone() } })
  const held = wrapped.data ?? 0n
  const gap = quote.native && needed > held ? needed - held : 0n
  const canWrap = gap > 0n && (native.data?.value ?? 0n) >= gap + GAS_RESERVE
  return {
    gap,
    canWrap,
    tx,
    wrap: () => tx.send({ address: quote.asset, abi: WRAPPED_NATIVE_ABI, functionName: 'deposit', value: gap }),
    refetch: () => void wrapped.refetch(),
  }
}
