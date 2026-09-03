'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { CHAIN_BYLINE } from '@/lib/contracts'

// ssr: false — WalletPip depends on wagmi account state which is only available
// on the client. Bypassing SSR prevents React from hydrating wallet-connected
// vs disconnected DOM trees, eliminating removeChild reconciliation errors.
const WalletPip = dynamic(
  () => import('./WalletPip').then(m => ({ default: m.WalletPip })),
  {
    ssr: false,
    loading: () => (
      <div className="h-8 w-[118px] sm:w-[130px]" aria-hidden />
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
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-3 md:px-6">
        <div className="flex items-center gap-4 min-w-0 sm:gap-8">
          <Link href="/" className="text-title text-text-primary tracking-tighter hover:opacity-90 transition-opacity shrink-0">
            Tosh<span className="text-brand">X</span>
          </Link>
          {/* Not `hidden sm:flex`: these are the only two routes in the app, and
              hiding them left phones with no way to reach /launch at all. */}
          <div className="flex items-center gap-1 min-w-0">
            {NAV.map(({ href, label }) => {
              const active = href === '/' ? pathname === '/' : pathname?.startsWith(href)
              return (
                <Link
                  key={href}
                  href={href}
                  className={`px-2 py-1.5 rounded-input text-note font-medium whitespace-nowrap transition-colors sm:px-3
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
            {CHAIN_BYLINE}
          </span>
          <WalletPip variant="navbar" />
        </div>
      </div>
    </nav>
  )
}
