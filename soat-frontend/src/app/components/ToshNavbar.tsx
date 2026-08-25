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
    <nav className="sticky top-0 z-50 w-full border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/" className="text-lg font-black text-white tracking-tighter hover:opacity-90 transition-opacity">
            Tosh<span className="text-tosh-fluo">X</span>
          </Link>
          <div className="hidden sm:flex items-center gap-1">
            {NAV.map(({ href, label }) => {
              const active = href === '/' ? pathname === '/' : pathname?.startsWith(href)
              return (
                <Link
                  key={href}
                  href={href}
                  className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors
                    ${active ? 'text-tosh-fluo bg-tosh-fluo/10' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                  {label}
                </Link>
              )
            })}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden md:inline text-[9px] text-zinc-600 font-mono tracking-wider uppercase">
            {MAINNET_CHAIN_LABEL} · testnet {TESTNET_CHAIN_LABEL}
          </span>
          <WalletPip variant="navbar" />
        </div>
      </div>
    </nav>
  )
}
