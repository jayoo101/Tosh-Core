'use client'

/**
 * App-shell host for the unsigned gas lookup.
 *
 * The scan used to live only inside the genesis deposit card, so connecting
 * from the navbar (home, directory, a project past genesis) did nothing. One
 * provider at the wagmi root starts the read on connect and owns the dialog.
 */

import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useReadContract } from 'wagmi'

import { FACTORY_ABI, FACTORY_ADDRESS } from '@/lib/contracts'
import { CLOCK_UNSYNCED, useNowSec } from '@/components/ui'
import { GasHistoryDialog } from './GasHistoryDialog'
import { usePogFlow, type PogFlow } from './usePogFlow'

const PogLookupCtx = createContext<PogFlow | null>(null)

export function usePogLookup(): PogFlow {
  const ctx = useContext(PogLookupCtx)
  if (!ctx) {
    throw new Error(
      '[pog] usePogLookup() outside <PogLookupProvider>. The gas dialog is '
      + 'owned by the app shell so it can open on connect from any page.',
    )
  }
  return ctx
}

export function PogLookupProvider({ children }: { children: ReactNode }) {
  const flow = usePogFlow()
  const nowSec = useNowSec()

  const { data: pogQuota, refetch: refetchQuota } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: 'pogQuota',
    args: flow.userAddress ? [flow.userAddress] : undefined,
    query: { enabled: Boolean(flow.userAddress) },
  })

  const { data: blacklistedUntil, refetch: refetchBan } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: 'blacklistedUntil',
    args: flow.userAddress ? [flow.userAddress] : undefined,
    query: { enabled: Boolean(flow.userAddress) },
  })

  const bindRefetch = flow.bindRefetch
  useEffect(
    () => bindRefetch(() => {
      void refetchQuota()
      void refetchBan()
    }),
    [bindRefetch, refetchQuota, refetchBan],
  )

  const quotaKnown = typeof pogQuota === 'bigint'
  const banned = blacklistedUntil != null
    && blacklistedUntil > 0n
    && nowSec !== CLOCK_UNSYNCED
    && BigInt(nowSec) < blacklistedUntil
  const unattested = Boolean(flow.userAddress)
    && quotaKnown
    && pogQuota === 0n
    && !banned
  const canActivate = unattested
    && flow.phase === 'ready'
    && Boolean(flow.scan?.eligible)

  return (
    <PogLookupCtx.Provider value={flow}>
      {children}
      {flow.userAddress && (
        <GasHistoryDialog
          open={flow.dialogOpen}
          onClose={() => flow.setDialogOpen(false)}
          userAddress={flow.userAddress}
          phase={flow.phase}
          scan={flow.scan}
          error={flow.error}
          onRetry={() => { void flow.startLookup(true) }}
          quotaKnown={quotaKnown}
          onActivate={canActivate ? () => { void flow.registerQuota() } : undefined}
          activating={flow.registering}
        />
      )}
    </PogLookupCtx.Provider>
  )
}
