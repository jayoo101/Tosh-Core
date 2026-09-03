'use client'

import { useEffect, useState } from 'react'
import { useAccount, useChainId, useSwitchChain } from 'wagmi'
import {
  TARGET_CHAIN_ID,
  MAINNET_CHAIN_LABEL,
  ACTIVE_CHAIN_LABEL,
  IS_TESTNET,
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
    <div className="border-b border-warning/20 bg-warning/5 px-4 py-2">
      <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2">
        <p className="text-note font-mono text-warning tracking-wide">
          {/* The "staging runs on" clause is only true off mainnet; on a
              production build it would read "settles on Ethereum; staging runs
              on Ethereum". */}
          Wrong network — Tosh settles on {MAINNET_CHAIN_LABEL}
          {IS_TESTNET && <>; staging runs on {ACTIVE_CHAIN_LABEL}</>}. Switch to continue.
        </p>
        <button
          type="button"
          onClick={() => switchChainAsync({ chainId: TARGET_CHAIN_ID }).catch(() => {})}
          className="text-label font-bold uppercase tracking-wider px-3 py-1 rounded-md
                     border border-warning/40 text-warning hover:bg-warning/10 transition-colors"
        >
          Switch network
        </button>
      </div>
    </div>
  )
}
