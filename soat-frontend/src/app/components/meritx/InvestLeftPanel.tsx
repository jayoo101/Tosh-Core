'use client'

import { useEffect, useMemo, useState } from 'react'
import { useReadContracts } from 'wagmi'
import { type Address } from 'viem'

import type { ProjectRow } from '@/app/lib/supabase'
import { HOOK_ABI } from '@/lib/contracts'
import { fmtEth } from '../meritx/useDirectoryProjects'

export function InvestLeftPanel({ project }: { project: ProjectRow }) {
  const hook = project.hook_address as Address | undefined
  const [nowSec, setNowSec] = useState(0)
  useEffect(() => {
    const tick = () => setNowSec(Math.floor(Date.now() / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  const { data } = useReadContracts({
    contracts: hook ? [
      { address: hook, abi: HOOK_ABI, functionName: 'launched' },
      { address: hook, abi: HOOK_ABI, functionName: 'totalEthDeposited' },
      { address: hook, abi: HOOK_ABI, functionName: 'softCap' },
      { address: hook, abi: HOOK_ABI, functionName: 'genesisDeadline' },
      { address: hook, abi: HOOK_ABI, functionName: 'canRefund' },
    ] : [],
    query: { enabled: Boolean(hook), refetchInterval: 12_000 },
  })

  const launched    = (data?.[0]?.result as boolean | undefined) ?? false
  const totalEth    = (data?.[1]?.result as bigint | undefined) ?? 0n
  const softCap     = (data?.[2]?.result as bigint | undefined) ?? 0n
  const deadline    = (data?.[3]?.result as bigint | undefined) ?? 0n
  const canRefund   = (data?.[4]?.result as boolean | undefined) ?? false

  const progress = softCap > 0n ? Math.min(100, Number((totalEth * 10000n) / softCap) / 100) : 0

  // The window is the only thing that closes deposits — clearing the soft cap
  // does not.  Treat a zero deadline as "still loading" rather than expired.
  const windowOpen = deadline === 0n || nowSec === 0 || Number(deadline) > nowSec

  const status = useMemo(() => {
    if (canRefund) return { label: 'REFUND ELIGIBLE', cls: 'border-danger/30 bg-danger/[0.06] text-danger', dot: 'bg-danger' }
    if (launched) return { label: 'SHELF ACTIVE', cls: 'border-success/30 bg-success/[0.06] text-success', dot: 'bg-success' }
    if (!windowOpen) return { label: 'AWAITING LAUNCH', cls: 'border-admin/30 bg-admin/[0.06] text-admin', dot: 'bg-admin' }
    if (softCap > 0n && totalEth >= softCap) return { label: 'GENESIS OVERSUBSCRIBED', cls: 'border-brand/30 bg-brand/[0.06] text-brand', dot: 'bg-brand' }
    return { label: 'GENESIS FUNDING', cls: 'border-brand/30 bg-brand/[0.06] text-brand', dot: 'bg-brand' }
  }, [canRefund, launched, windowOpen, softCap, totalEth])

  const countdown = useMemo(() => {
    if (launched || deadline === 0n || nowSec === 0) return '--:--:--'
    const rem = Number(deadline) - nowSec
    if (rem <= 0) return '00:00:00'
    const h = Math.floor(rem / 3600)
    const m = Math.floor((rem % 3600) / 60)
    const s = rem % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }, [launched, deadline, nowSec])

  return (
    <>
      <div className={`rounded-xl border px-4 py-3 flex items-center gap-3 ${status.cls}`}>
        <span className={`w-2.5 h-2.5 rounded-full ${status.dot} dot-breathe`} />
        <span className="text-[11px] font-mono font-bold uppercase tracking-widest">Status: {status.label}</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-border-subtle bg-surface-card/50 p-4">
          <p className="text-[10px] font-bold text-text-tertiary uppercase tracking-widest mb-1">Total Deposited</p>
          <p className="text-xl font-black text-brand tabular-nums">{fmtEth(totalEth)} <span className="text-sm text-text-tertiary">ETH</span></p>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface-card/50 p-4">
          <p className="text-[10px] font-bold text-text-tertiary uppercase tracking-widest mb-1">Soft Cap</p>
          <p className="text-xl font-black text-admin tabular-nums">{fmtEth(softCap)} <span className="text-sm text-text-tertiary">ETH</span></p>
          <span className="inline-flex mt-2 px-2 py-0.5 rounded-md bg-admin/10 border border-admin/20 text-[9px] font-bold text-admin">GENESIS TARGET</span>
        </div>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface-card/20 p-4">
        <div className="flex justify-between items-baseline text-sm mb-2.5">
          <span className="text-text-secondary text-[10px] font-mono uppercase tracking-widest">Genesis Progress</span>
          <span className="font-mono tabular-nums font-bold text-text-primary">{progress.toFixed(1)}%</span>
        </div>
        <div className="w-full h-2 bg-surface-elevated rounded-full overflow-hidden">
          <div className="h-full rounded-full bar-glow transition-all duration-1000" style={{ width: `${Math.min(100, progress)}%` }} />
        </div>
        <div className="flex justify-between mt-2 text-[10px] font-mono text-text-quiet">
          <span>{fmtEth(totalEth)} / {fmtEth(softCap)} ETH</span>
          <span>Soft cap · 4000-rung shelf · 12.6M tokens</span>
        </div>
      </div>

      {canRefund && (
        <div className="rounded-xl border border-danger/30 bg-danger/[0.04] p-4 text-xs text-text-secondary leading-relaxed">
          <span className="text-danger font-bold uppercase tracking-wider text-[10px]">Refund path open — </span>
          Genesis soft cap was not met or the 7-day launch window expired without curve activation. Depositors can call{' '}
          <span className="text-text-primary font-mono">refund()</span> in the action terminal for a full ETH return.
        </div>
      )}

      {!launched && !canRefund && windowOpen && (
        <div className="rounded-xl border border-border-subtle bg-surface-card/20 p-4 flex items-center gap-4">
          <div className="flex-1">
            <div className="text-[10px] font-bold uppercase tracking-widest mb-1 font-mono text-text-tertiary">
              Genesis Window — Closes In
            </div>
            <div className="font-mono tabular-nums font-black text-2xl tracking-tight text-text-primary">
              {countdown}
            </div>
          </div>
          <span className="text-[8px] font-mono font-bold tracking-widest text-brand flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-brand dot-breathe" /> LIVE
          </span>
        </div>
      )}

      {!launched && !canRefund && !windowOpen && (
        <div className="rounded-xl border border-admin/30 bg-admin/[0.04] p-4 text-xs text-text-secondary leading-relaxed">
          <span className="text-admin font-bold uppercase tracking-wider text-[10px]">Awaiting launch — </span>
          The genesis window has closed and deposits are no longer accepted. The creator can now call{' '}
          <span className="text-text-primary font-mono">launch()</span> to seed the pool and open the shelf ladder.
          If they do not within 7 days, every depositor can reclaim their ETH in full.
        </div>
      )}
    </>
  )
}

export function EventStreamPanel({ hookAddress }: { hookAddress: string | null }) {
  if (!hookAddress) return null
  return (
    <div className="rounded-xl border border-border-subtle bg-surface-card/20 p-4">
      <p className="text-[10px] font-bold text-text-tertiary uppercase tracking-widest mb-3 font-mono">{`/// Event Stream`}</p>
      <p className="text-xs text-text-quiet font-mono">Live hook events render in the action terminal after wallet connect.</p>
    </div>
  )
}
