'use client'

import { useEffect, useState } from 'react'
import { useAccount, useChainId, useSwitchChain } from 'wagmi'
import {
  TARGET_CHAIN_ID,
  MAINNET_CHAIN_LABEL,
  TESTNET_CHAIN_LABEL,
} from '@/lib/contracts'

/** Wrong-network strip — wallet connected but not on the settlement chain. */
export function NetworkGuard() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  const { isConnected } = useAccount()
  const chainId         = useChainId()
  const { switchChainAsync } = useSwitchChain()

  if (!mounted || !isConnected || chainId === TARGET_CHAIN_ID) return null

  return (
    <div className="border-b border-amber-500/20 bg-amber-500/5 px-4 py-2">
      <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-mono text-amber-400 tracking-wide">
          Wrong network — Tosh settles on {MAINNET_CHAIN_LABEL}; staging runs on {TESTNET_CHAIN_LABEL}. Switch to continue.
        </p>
        <button
          type="button"
          onClick={() => switchChainAsync({ chainId: TARGET_CHAIN_ID }).catch(() => {})}
          className="text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded-md
                     border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 transition-colors"
        >
          Switch network
        </button>
      </div>
    </div>
  )
}
