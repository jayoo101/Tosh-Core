'use client'

import { useAccount, useChainId, useSwitchChain } from 'wagmi'
import {
  TARGET_CHAIN_ID,
  MAINNET_CHAIN_LABEL,
  ACTIVE_CHAIN_LABEL,
  IS_TESTNET,
} from '@/lib/contracts'
import { toshToast, useIsHydrated } from '@/components/ui'

/** Wrong-network strip — wallet connected but not on the settlement chain. */
export function NetworkGuard() {
  // `useIsHydrated`, not a hand-rolled `mounted` flag set from an effect. The
  // flag needed an `eslint-disable react-hooks/set-state-in-effect` to exist,
  // and it was the third copy of one: `useClock` exports this as an
  // external-store read for exactly this purpose, which is both the same
  // answer and one that does not need the rule switched off to get it.
  const hydrated = useIsHydrated()

  const { isConnected } = useAccount()
  const chainId         = useChainId()
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain()

  if (!hydrated || !isConnected || chainId === TARGET_CHAIN_ID) return null

  return (
    <div className="border-b border-warning/20 bg-warning/5 px-4 py-2">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
        <p className="text-note font-mono text-warning tracking-wide">
          {/* The "staging runs on" clause is only true off mainnet; on a
              production build it would read "settles on Ethereum; staging runs
              on Ethereum". */}
          Wrong network — Tosh settles on {MAINNET_CHAIN_LABEL}
          {IS_TESTNET && <>; staging runs on {ACTIVE_CHAIN_LABEL}</>}. Switch to continue.
        </p>
        {/* THIS BUTTON USED TO SWALLOW ITS OWN FAILURES — `.catch(() => {})`,
            which is the identical defect `actionGate.tsx` already carries the
            fix for, one component over. Its `reportWalletFailure` docblock
            describes this exact symptom: "dismissing the wallet's network
            prompt just re-enabled the button with nothing said." Here it was
            worse than on a panel, because this strip IS the wrong-network
            remedy — a wallet that refuses to add the chain left the banner up,
            the button live, and no account of why pressing it did nothing.

            `toshToast.fromError` is already silent for a user-dismissed
            prompt, so this speaks up only for the failures worth reporting: a
            locked wallet, or a chain the wallet will not add.

            `isSwitching` came with it. The prompt can sit open for as long as
            the user leaves it, and an enabled button in front of it invites a
            second request the wallet will queue behind the first. */}
        <button
          type="button"
          disabled={isSwitching}
          onClick={() => {
            void switchChainAsync({ chainId: TARGET_CHAIN_ID }).catch(toshToast.fromError)
          }}
          className="text-label font-bold uppercase tracking-wider px-3 py-1 rounded-md
                     border border-warning/40 text-warning transition-colors
                     hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSwitching ? 'Switching…' : 'Switch network'}
        </button>
      </div>
    </div>
  )
}
