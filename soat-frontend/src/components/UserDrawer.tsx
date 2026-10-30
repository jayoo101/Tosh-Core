'use client'

/**
 * UserDrawer — the connected wallet's slide-in panel off the navbar pip:
 * account switch / disconnect, the way into `/portfolio`, and a one-click
 * unwrap when the wallet holds WBNB.
 */

import { useEffect } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { useAccount, useDisconnect, useReadContract } from 'wagmi'
import { formatUnits, type Address } from 'viem'

import { CHAIN_BYLINE, ERC20_ABI } from '@/lib/contracts'
import { NATIVE_SYMBOL } from '@/lib/chain'
import { WRAPPED_NATIVE_ABI } from '@/lib/quoteAssets'
import { V2_WBNB } from '@/lib/v2/config'
import { useTxAction } from '@/components/ui'
import { useWalletPicker } from '@/components/WalletPicker'
import { fill, useT } from '@/i18n'

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTERS
// ─────────────────────────────────────────────────────────────────────────────

const WBNB_DECIMALS = 18
const WRAP_VARS = { native: NATIVE_SYMBOL, wrapped: `W${NATIVE_SYMBOL}` }

function formatQuote(units: bigint, decimals: number): string {
  const n = Number(formatUnits(units, decimals))
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

function shortAddr(a: Address): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// SIDE EFFECTS — ESC-to-close + body scroll lock
// ─────────────────────────────────────────────────────────────────────────────

function useDrawerSideEffects(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAWER
// ─────────────────────────────────────────────────────────────────────────────

export interface UserDrawerProps {
  open:    boolean
  onClose: () => void
}

export function UserDrawer({ open, onClose }: UserDrawerProps) {
  const { address }    = useAccount()
  const { disconnect, disconnectAsync } = useDisconnect()
  const picker = useWalletPicker()
  const t = useT().drawer

  useDrawerSideEffects(open, onClose)

  const handleDisconnect = () => {
    disconnect()
    onClose()
  }

  // Disconnect, then reopen the wallet picker. Asking `window.ethereum` for
  // `wallet_requestPermissions` instead did nothing over WalletConnect and in
  // most mobile wallet browsers, which left phones stuck on the first wallet.
  // Reconnecting an injected wallet still shows its account picker: wagmi's
  // injected connector requests permissions after a disconnect.
  const handleSwitchAccount = async () => {
    onClose()
    await disconnectAsync().catch(() => {})
    if (picker) picker.open()
  }

  return (
    <>
      {/* Backdrop — invisible click target that closes the drawer.  A
          <button> (not <div>) so keyboard users can also dismiss it. */}
      <button
        type="button"
        aria-label={t.closeDrawer}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-bg-base/70 transition-opacity duration-200
                    ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
      />

      {/* Drawer panel — right-anchored, slides 100% off-screen when closed. */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-50 w-full sm:w-80 max-w-[100vw]
                    bg-bg-base border-l border-border-subtle/80 shadow-[0_0_80px_rgba(0,0,0,0.6)]
                    text-text-primary font-sans
                    transform transition-transform duration-300 ease-out
                    ${open ? 'translate-x-0' : 'translate-x-full'}
                    flex flex-col`}
      >
        <DrawerHeader
          address={address}
          onClose={onClose}
          onDisconnect={handleDisconnect}
          onSwitchAccount={handleSwitchAccount}
        />

        <div className="flex-1 overflow-y-auto overscroll-contain">
          <PortfolioLink onNavigate={onClose} />
          {V2_WBNB && address && <UnwrapPanel address={address} wbnb={V2_WBNB} />}
        </div>

        <DrawerFooter />
      </aside>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAWER CHROME
// ─────────────────────────────────────────────────────────────────────────────

function DrawerHeader({
  address, onClose, onDisconnect, onSwitchAccount,
}: {
  address?:         Address
  onClose:          () => void
  onDisconnect:     () => void
  onSwitchAccount:  () => void
}) {
  const initials = address ? address.slice(2, 4).toUpperCase() : '--'
  const t = useT().drawer

  return (
    <header className="p-5 pb-4 border-b border-border-subtle/60 shrink-0">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-black text-text-primary uppercase tracking-widest">{t.title}</h2>
          <p className="text-label text-text-quiet font-mono mt-0.5">{CHAIN_BYLINE}</p>
        </div>
        <button
          type="button"
          aria-label={t.close}
          onClick={onClose}
          className="w-8 h-8 rounded-lg bg-surface-card border border-border-subtle flex items-center justify-center text-text-tertiary hover:text-text-primary hover:border-border-strong transition-all"
        >
          ×
        </button>
      </div>

      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand/20 to-admin/20 border border-brand/20 flex items-center justify-center shrink-0">
          <span className="text-brand font-black text-sm">{initials}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-mono text-text-secondary truncate">
            {address ? shortAddr(address) : '—'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onSwitchAccount}
          title={t.switchTitle}
          className="group flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                     border border-border-subtle bg-surface-card/50
                     text-label tracking-[0.32em] uppercase font-mono text-text-secondary
                     hover:border-brand/40 hover:text-brand hover:bg-brand/5
                     transition-all"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          <span>{t.switch}</span>
        </button>

        <button
          type="button"
          onClick={onDisconnect}
          title={t.disconnectTitle}
          className="group flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                     border border-border-subtle bg-surface-card/50
                     text-label tracking-[0.32em] uppercase font-mono text-text-secondary
                     hover:border-danger/40 hover:text-danger hover:bg-danger/5
                     transition-all"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
          <span>{t.disconnect}</span>
        </button>
      </div>
    </header>
  )
}

/** The v2 drawer's one row: the connected wallet's `/portfolio`. */
function PortfolioLink({ onNavigate }: { onNavigate: () => void }) {
  const t = useT().drawer
  return (
    <section className="px-4 pb-4 pt-4">
      <Link
        href="/portfolio"
        onClick={onNavigate}
        className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle/70
                   bg-surface-card/50 p-4 transition-colors hover:border-brand/40"
      >
        <span className="min-w-0">
          <span className="block font-mono text-micro font-bold tracking-widest text-brand/70">
            {t.portfolioEyebrow}
          </span>
          <span className="mt-1 block text-note text-text-secondary">
            {t.portfolioBody}
          </span>
        </span>
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
      </Link>
    </section>
  )
}

/**
 * The wallet's WBNB, with a one-click unwrap.
 *
 * Shelf mints and LP adds wrap exactly the shortfall, but an LP removal and a
 * buy that the shelf partly filled both leave WBNB behind, and most wallets
 * show it as an unfamiliar token rather than as BNB. Hidden at zero.
 */
function UnwrapPanel({ address, wbnb }: { address: Address; wbnb: Address }) {
  const t = useT().wrap
  const d = useT().drawer
  const { data: balance, refetch } = useReadContract({
    address: wbnb, abi: ERC20_ABI, functionName: 'balanceOf',
    args: [address],
    query: { refetchInterval: 20_000 },
  })
  const unwrap = useTxAction({ action: fill(t.unwrapTx, WRAP_VARS), onConfirmed: () => { void refetch() } })
  const wad = (balance as bigint | undefined) ?? 0n
  if (wad === 0n) return null

  const amount = formatQuote(wad, WBNB_DECIMALS)
  return (
    <section className="px-4 pb-4 pt-2">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle/70
                      bg-surface-card/50 p-4">
        <span className="min-w-0">
          <span className="block font-mono text-micro font-bold tracking-widest text-brand/70">
            {fill(t.unwrapTitle, WRAP_VARS)}
          </span>
          <span className="mt-1 block text-note text-text-secondary">{fill(t.unwrapHint, WRAP_VARS)}</span>
        </span>
        <button
          type="button"
          onClick={() => unwrap.send({
            address: wbnb, abi: WRAPPED_NATIVE_ABI,
            functionName: 'withdraw', args: [wad],
          })}
          disabled={unwrap.isBusy}
          className="text-label tracking-[0.32em] uppercase px-3 py-1.5
                     border border-brand text-brand
                     hover:bg-brand hover:text-bg-base transition-colors
                     disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          {unwrap.isPending ? d.signing : unwrap.isConfirming ? d.mining : fill(t.unwrapCta, { ...WRAP_VARS, amount })}
        </button>
      </div>
    </section>
  )
}

function DrawerFooter() {
  const t = useT().drawer
  return (
    <footer className="px-5 py-3 border-t border-border-subtle
                       text-micro tracking-[0.32em] uppercase text-text-quiet
                       flex items-center justify-between gap-3">
      <span>v4.3 · {CHAIN_BYLINE}</span>
      <span>{t.footerHint}</span>
    </footer>
  )
}
