'use client'

/**
 * Tosh Protocol · CRYPTOGRAPHIC TRADING TERMINAL  (v5.0 — ETH-native)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   PHASE 1 · GENESIS
 *     ▸ Native ETH deposits via factory.deposit{value}(hook, referrer)
 *     ▸ H-01 PoG quota ledger
 *
 *   PHASE 2 · DISCRETE TIER SHELVES
 *     ▸ 4000 fixed-price rungs, 105 % min(spot, TWAP) unlock gate
 *     ▸ hook.mintBondingCurve{value}(tokenAmount)
 *
 *   PHASE 3 · REFUND
 *     ▸ hook.refund() returns 100 % of the ETH deposit
 */
import { useState, useEffect } from 'react'
import { useAccount, useBalance, useReadContract, useReadContracts } from 'wagmi'
import type { Address, ContractFunctionParameters } from 'viem'

import type { ProjectRow } from '@/app/lib/supabase'
import { FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI, BONDING_MAX } from '@/lib/contracts'
import { useBoundReferrer } from '@/lib/useReferral'
import { Card } from '@/components/ui'
import { resolvePhase, type Phase } from './phase'
import { ConnectGate } from './ConnectGate'
import { GenesisPanel } from './GenesisPanel'
import { AwaitingLaunchPanel } from './AwaitingLaunchPanel'
import { GenesisClaimPanel } from './GenesisClaimPanel'
import { BondingPanel } from './BondingPanel'
import { LiquidityPanel } from './LiquidityPanel'
import { RefundPanel } from './RefundPanel'
import { ReferralPanel } from './ReferralPanel'

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT  ·  ProjectTerminal
// ─────────────────────────────────────────────────────────────────────────────

export default function ProjectTerminal({ project }: { project: ProjectRow }) {
  const { address, isConnected } = useAccount()
  const [mounted, setMounted] = useState(false)
  // SSR/CSR mount guard — defers wagmi-dependent state to the client paint.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setMounted(true) }, [])
  const userAddress = mounted ? (address as Address | undefined) : undefined
  const wConnected  = mounted ? isConnected : false

  const hookAddress = project.hook_address as Address | undefined
  const symbol      = project.symbol || 'TOK'

  const { data: ethBal } = useBalance({
    address: userAddress,
    query:   { enabled: !!userAddress },
  })
  const ethBalance = ethBal?.value ?? 0n

  // External-clock pattern — single ticking second used by Genesis countdown
  // and cooldown logic.  Lifted to the top of the component so React's purity
  // rule never sees Date.now() called from render.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  // Bulk chain reads.
  //
  // Typed as a plain `ContractFunctionParameters[]` rather than left to
  // inference: wagmi builds a per-entry mapped type over the whole ABI, and
  // with HOOK_ABI at ~130 entries that tuple blows past TypeScript's
  // instantiation depth limit.  Every result below is cast explicitly anyway,
  // so the precise inference was buying nothing.
  const bulkContracts: ContractFunctionParameters[] = hookAddress ? [
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'totalEthDeposited' },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'launched'           },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'p0'                 },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'phase2Minted'       },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'canRefund'          },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'genesisDeadline'    },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'softCap'            },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'BONDING_MAX'        },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'currentBondingPrice'},
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'ethDeposited',
        args: userAddress ? [userAddress] : undefined },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'pogQuota',
        args: userAddress ? [userAddress] : undefined },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'eligibility',
        args: userAddress ? [userAddress, hookAddress] : undefined },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'userLaunchCooldownEnd',
        args: userAddress ? [userAddress, hookAddress] : undefined },
      { address: hookAddress,    abi: HOOK_ABI,    functionName: 'shelfP0'           },
      { address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'blacklistedUntil',
        args: userAddress ? [userAddress] : undefined },
    ] : []

  const { data, refetch } = useReadContracts({
    contracts: bulkContracts,
    query: { enabled: !!hookAddress, refetchInterval: 12_000 },
  })

  const totalEthDeposited  = (data?.[0]?.result  as bigint  | undefined) ?? 0n
  const launched           = (data?.[1]?.result  as boolean | undefined) ?? false
  const p0                 = (data?.[2]?.result  as bigint  | undefined) ?? 0n
  const phase2Minted       = (data?.[3]?.result  as bigint  | undefined) ?? 0n
  const canRefund          = (data?.[4]?.result  as boolean | undefined) ?? false
  const genesisDeadline    = (data?.[5]?.result  as bigint  | undefined) ?? 0n
  const softCap            = (data?.[6]?.result  as bigint  | undefined) ?? 0n
  const bondingMax         = (data?.[7]?.result  as bigint  | undefined) ?? BONDING_MAX
  const currentPrice       = (data?.[8]?.result  as bigint  | undefined) ?? 0n
  const userEthDeposited   = (data?.[9]?.result  as bigint  | undefined) ?? 0n
  const pogQuota           = (data?.[10]?.result as bigint  | undefined) ?? 0n
  const cooldownEnd        = (data?.[12]?.result as bigint  | undefined) ?? 0n
  const shelfP0           = (data?.[13]?.result as bigint  | undefined) ?? 0n
  const blacklistedUntil   = (data?.[14]?.result as bigint  | undefined) ?? 0n

  // (eligible, remainingQuota, cooldownRemaining) — the factory's own verdict,
  // which is the only place that knows whether a lapsed quota window has been
  // credited back yet.  `cooldownEnd` above still drives the ticking countdown;
  // this tuple only supplies the spendable headroom.
  const eligibility        = data?.[11]?.result as readonly [boolean, bigint, bigint] | undefined
  const quotaRemaining     = eligibility?.[1] ?? 0n

  // Read separately rather than appended to the bulk call above: the token
  // address is fixed at deploy, so polling it every 12s would be waste.
  const { data: tokenAddress } = useReadContract({
    address: hookAddress, abi: HOOK_ABI, functionName: 'projectToken',
    query: { enabled: !!hookAddress, staleTime: Infinity },
  })

  // Immutable, and only needed to decide whether to offer the launch button —
  // so it is read once here rather than added to the 12s bulk poll.
  const { data: creatorAddress } = useReadContract({
    address: hookAddress, abi: HOOK_ABI, functionName: 'creator',
    query: { enabled: !!hookAddress, staleTime: Infinity },
  })
  const isCreator = !!userAddress && !!creatorAddress
    && (creatorAddress as Address).toLowerCase() === userAddress.toLowerCase()

  // Snapshotted into the hook at creation and never written again, so it rides
  // outside the 12s bulk poll — which also keeps that contracts tuple from
  // growing any deeper.
  const { data: perWalletCapRaw } = useReadContract({
    address: hookAddress, abi: HOOK_ABI, functionName: 'perWalletCap',
    query: { enabled: !!hookAddress, staleTime: Infinity },
  })
  const perWalletCap = (perWalletCapRaw as bigint | undefined) ?? 0n

  const referrer = useBoundReferrer(userAddress)

  const phase: Phase = resolvePhase({
    totalEthDeposited, softCap, canRefund, launched, genesisDeadline, nowSec,
  })



  if (!hookAddress) {
    return (
      <div className="flex flex-col">
        <Card id="ERR" title="HOOK BINDING MISSING">
          <p className="font-mono text-[11px] text-[#888] leading-relaxed">
            This project row has no <span className="text-brand">hook_address</span> on file.
            Deploy may still be pending — refresh after the createLaunch tx confirms.
          </p>
        </Card>
      </div>
    )
  }

  // Vertical rhythm lives on the container rather than as `mt-6` on each panel:
  // a Card carrying its own top margin only spaces correctly when it happens to
  // have a sibling above it.
  return (
    <div className="flex flex-col gap-section rounded-panel border border-border-subtle bg-surface-card p-card-lg shadow-panel font-sans">
      <p className="font-mono text-label text-text-tertiary uppercase">{`/// Action Terminal`}</p>
      {!wConnected ? (
        <ConnectGate />
      ) : phase === 'genesis' ? (
        <GenesisPanel
          hookAddress={hookAddress}
          symbol={symbol}
          userAddress={userAddress}
          isConnected={wConnected}
          totalEthDeposited={totalEthDeposited}
          softCap={softCap}
          ethBalance={ethBalance}
          pogQuota={pogQuota}
          quotaRemaining={quotaRemaining}
          blacklistedUntil={blacklistedUntil}
          cooldownEnd={cooldownEnd}
          nowSec={nowSec}
          perWalletCap={perWalletCap}
          userDeposited={userEthDeposited}
          genesisDeadline={genesisDeadline}
          referrer={referrer}
          refetch={() => { void refetch() }}
        />
      ) : phase === 'awaiting_launch' ? (
        <AwaitingLaunchPanel
          hookAddress={hookAddress}
          symbol={symbol}
          isCreator={isCreator}
          totalEthDeposited={totalEthDeposited}
          genesisDeadline={genesisDeadline}
          nowSec={nowSec}
          refetch={() => { void refetch() }}
        />
      ) : phase === 'bonding' ? (
        <>
          <GenesisClaimPanel
            hookAddress={hookAddress}
            symbol={symbol}
            userAddress={userAddress}
            ethDeposited={userEthDeposited}
            refetch={() => { void refetch() }}
          />
          <BondingPanel
            hookAddress={hookAddress}
            symbol={symbol}
            userAddress={userAddress}
            isConnected={wConnected}
            p0={p0}
            shelfP0={shelfP0}
            currentPrice={currentPrice}
            phase2Minted={phase2Minted}
            bondingMax={bondingMax}
            ethBalance={ethBalance}
            nowSec={nowSec}
            refetch={() => { void refetch() }}
          />
          {launched && (
            <LiquidityPanel
              hookAddress={hookAddress}
              tokenAddress={tokenAddress}
              symbol={symbol}
              userAddress={userAddress}
              isConnected={wConnected}
              ethBalance={ethBalance}
              nowSec={nowSec}
            />
          )}
        </>
      ) : (
        <RefundPanel
          hookAddress={hookAddress}
          ethDeposited={userEthDeposited}
          refetch={() => { void refetch() }}
        />
      )}

      {wConnected && (
        <ReferralPanel
          hookAddress={hookAddress}
          userAddress={userAddress}
          refetch={() => { void refetch() }}
        />
      )}
    </div>
  )
}
