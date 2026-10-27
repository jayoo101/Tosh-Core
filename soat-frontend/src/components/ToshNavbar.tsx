'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { CHAIN_BYLINE } from '@/lib/contracts'
import { useT } from '@/i18n'
import { LocalePicker } from './LocalePicker'
import { LogoMark, Wordmark } from './x/LogoMark'
import { isActive, siteNav } from './x/siteNav'

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

/**
 * The ToshX header. Hidden on /admin.
 *
 * From `lg` up the routes live in `SideRail`, so the links here are the
 * phone and tablet navigation only: a scrolling row under the bar rather than
 * a squeeze beside the wallet, because seven labels do not fit at 390px.
 */
export function ToshNavbar() {
  const pathname = usePathname()
  const t = useT()
  if (pathname?.startsWith('/admin')) return null
  const items = siteNav(t)

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-border-subtle bg-bg-base" aria-label={t.x.topNav}>
      <div className="flex h-16 items-center justify-between gap-3 px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/" className="flex shrink-0 items-center gap-3 transition-opacity hover:opacity-90">
            <span className="flex size-9 items-center justify-center rounded-card border border-brand/30 bg-brand/10 shadow-[0_0_18px_-4px_var(--tosh-brand)]">
              <LogoMark className="size-6" />
            </span>
            <Wordmark className="text-section" />
          </Link>
          <span className="hidden items-center gap-1.5 rounded-pill border border-border-subtle bg-surface-card px-2.5 py-1 font-mono text-micro uppercase text-text-tertiary xl:inline-flex">
            <span className="dot-breathe h-1.5 w-1.5 rounded-pill bg-success text-success" />
            {CHAIN_BYLINE}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <LocalePicker />
          <WalletPip variant="navbar" />
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-t border-border-subtle px-3 py-1.5 [scrollbar-width:none] lg:hidden">
        {items.map(item => {
          const active = isActive(item, pathname)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`shrink-0 whitespace-nowrap rounded-pill px-3 py-1.5 text-note font-medium transition-colors ${
                active ? 'bg-brand/10 text-brand' : 'text-text-tertiary hover:bg-surface-hover hover:text-text-secondary'
              }`}
            >
              {item.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
