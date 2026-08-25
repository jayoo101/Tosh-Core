'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { MAINNET_CHAIN_LABEL, TESTNET_CHAIN_LABEL } from '@/lib/contracts'

// ssr: false — WalletPip depends on wagmi account state which is only available
// on the client. Bypassing SSR prevents React from hydrating wallet-connected
// vs disconnected DOM trees, eliminating removeChild reconciliation errors.
const WalletPip = dynamic(
  () => import('./WalletPip').then(m => ({ default: m.WalletPip })),
  {
    ssr: false,
    loading: () => (
      <div className="w-[130px] h-8" aria-hidden />
    ),
  },
)

const NAV = [
  { href: '/',       label: 'Agent Directory' },
  { href: '/launch', label: 'Launch' },
] as const

/** MeritX Navbar — sticky, 2 links, wallet drawer via WalletPip. Hidden on /admin. */
export function ToshNavbar() {
  const pathname = usePathname()
  if (pathname?.startsWith('/admin')) return null

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-border-subtle bg-bg-base">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/" className="text-lg font-black text-text-primary tracking-tighter hover:opacity-90 transition-opacity">
            Tosh<span className="text-brand">X</span>
          </Link>
          <div className="hidden sm:flex items-center gap-1">
            {NAV.map(({ href, label }) => {
              const active = href === '/' ? pathname === '/' : pathname?.startsWith(href)
              return (
                <Link
                  key={href}
                  href={href}
                  className={`px-3 py-1.5 rounded-input text-note font-medium transition-colors
                    ${active
                      ? 'text-brand bg-brand/10'
                      : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover'}`}
                >
                  {label}
                </Link>
              )
            })}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden md:inline font-mono text-label text-text-quiet uppercase">
            {MAINNET_CHAIN_LABEL} · testnet {TESTNET_CHAIN_LABEL}
          </span>
          <WalletPip variant="navbar" />
        </div>
      </div>
    </nav>
  )
}
