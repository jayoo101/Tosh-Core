'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useAccount, useConnect } from 'wagmi'
import { injected } from 'wagmi/connectors'

import { useProtocolOwner } from '@/lib/useProtocolOwner'
import { UserDrawer } from './UserDrawer'

/**
 * MeritX-style wallet control — adapted for Tosh:
 *   • Disconnected → CONNECT WALLET (fluo pulse on hover)
 *   • Connected    → truncated address pill → opens UserDrawer
 *   • Owner only   → hidden _sys_control link (zero recon surface)
 */
export function WalletPip({ variant = 'default' }: { variant?: 'default' | 'navbar' }) {
  const { address, isConnected } = useAccount()
  const { connect, isPending }   = useConnect()
  const { isOwner }              = useProtocolOwner()

  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  const [drawerOpen, setDrawerOpen] = useState(false)

  const connectCls = variant === 'navbar'
    ? `px-4 py-1.5 rounded-lg border border-brand/40 text-brand text-xs font-bold
       uppercase tracking-wider hover:bg-brand hover:text-bg-base transition-all
       shadow-[0_0_8px_rgba(0,255,163,0.15)]`
    : `inline-flex items-center gap-1.5 px-3 py-1.5 border border-border-subtle text-text-tertiary
       font-mono text-label tracking-[0.32em] uppercase hover:border-brand
       hover:text-brand transition-colors`

  const pipCls = variant === 'navbar'
    ? `group flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border-subtle
       bg-surface-card/80 hover:border-brand/40 transition-all text-xs font-mono`
    : `inline-flex items-center gap-1.5 px-3 py-1.5 border border-border-subtle text-text-primary
       font-mono text-label tracking-[0.32em] uppercase hover:border-brand transition-colors`

  // Always render a stable outer wrapper so the root element never changes
  // type between SSR (<button>) and CSR (<div> / Fragment). React reconciles
  // children without touching the wrapper node, eliminating removeChild errors.
  const connected = mounted && isConnected && Boolean(address)
  const short     = connected ? `${address!.slice(0, 6)}…${address!.slice(-4)}` : ''

  return (
    <div className="flex items-center gap-2">
      {!connected ? (
        <button
          type="button"
          onClick={() => connect({ connector: injected() })}
          disabled={isPending}
          className={`${connectCls} disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {isPending ? 'CONNECTING…' : 'CONNECT WALLET'}
        </button>
      ) : (
        <>
          {isOwner && (
            <Link
              href="/admin"
              title="protocol operator console"
              className="hidden sm:inline-flex items-center px-2.5 py-1.5 rounded-lg
                         border border-admin/30 text-admin font-mono
                         text-label tracking-widest uppercase hover:border-admin
                         transition-colors"
            >
              sys_control
            </Link>
          )}
          <button
            type="button"
            onClick={() => setDrawerOpen(o => !o)}
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            className={pipCls}
          >
            <span aria-hidden className="w-2 h-2 rounded-full bg-brand dot-breathe shrink-0" />
            <span className="text-text-secondary group-hover:text-text-primary tabular-nums">
              {short}
            </span>
          </button>
        </>
      )}
      {connected && <UserDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
    </div>
  )
}
