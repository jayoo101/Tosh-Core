'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BarChart3 } from 'lucide-react'

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

/**
 * `howItWorks` is a hash, not a route.
 *
 * The redesign gives this a page of its own at `/docs`. We do not have one and
 * do not need one to answer the question: the same five steps are already the
 * last section of the home page, so the link goes there. A `/docs` route that
 * duplicated `TrustPipeline` would be a second copy of the copy to keep true.
 */
const NAV = [
  { href: '/',                label: 'Agent Directory', exact: true  },
  { href: '/launch',          label: 'Launch',          exact: false },
  { href: '/#how-it-works',   label: 'How it works',    exact: false, hash: true },
] as const

/** MeritX Navbar — sticky, wallet drawer via WalletPip. Hidden on /admin. */
export function ToshNavbar() {
  const pathname = usePathname()
  if (pathname?.startsWith('/admin')) return null

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-border-subtle bg-bg-base">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-3 md:px-6">
        <div className="flex items-center gap-3 min-w-0 sm:gap-5">
          <Link href="/" className="flex items-center gap-2 text-title text-text-primary tracking-tighter hover:opacity-90 transition-opacity shrink-0">
            <BarChart3 size={16} className="text-brand shrink-0" />
            {/* One element, not `Tosh<span>X</span>`. A bare text node inside a
                flex container becomes its own anonymous flex item, so the
                `gap-2` that spaces the icon was also spacing the wordmark and
                the mark rendered as "Tosh X".

                `sr-only sm:not-sr-only` and not `hidden sm:inline`: the bar
                does not fit at 390px (see the width arithmetic on the row
                below), and the mark is the cheapest 52px to give back because
                the icon still reads as home. `sr-only` takes it out of the
                layout while leaving it in the accessibility tree, so the
                link's name stays "ToshX" at every width instead of becoming
                an unnamed icon or an `aria-label` that disagrees with what a
                voice-control user can see. */}
            <span className="sr-only sm:not-sr-only">Tosh<span className="text-brand">X</span></span>
          </Link>

          {/* The chain indicator sits beside the mark, per the redesign. It was
              on the far right, where it read as a second status widget next to
              the wallet pip rather than as part of the product's identity.
              Still `CHAIN_BYLINE` and still derived — see lib/chain.ts for why
              nothing here may spell a chain's name out. */}
          <span className="hidden lg:inline-flex items-center gap-1.5 rounded-pill border border-border-subtle bg-surface-card px-2.5 py-1 font-mono text-micro uppercase text-text-tertiary shrink-0">
            <span className="dot-breathe h-1.5 w-1.5 rounded-pill bg-success text-success" />
            {CHAIN_BYLINE}
          </span>

          {/* Not `hidden sm:flex` as a block: /launch is a route with no other
              way in, so it must survive to 390px. "How it works" is a hash into
              a section of this page, which a phone reaches by scrolling, so it
              is the one item that may drop. */}
          <div className="flex items-center gap-1 min-w-0">
            {NAV.map(({ href, label, exact, ...rest }) => {
              const hash = 'hash' in rest && rest.hash
              const active = hash
                ? false
                : exact ? pathname === href : pathname?.startsWith(href)
              return (
                <Link
                  key={href}
                  href={href}
                  className={`px-2 py-1.5 rounded-input text-note font-medium whitespace-nowrap transition-colors sm:px-3
                    ${hash ? 'hidden sm:inline-flex ' : ''}${active
                      ? 'text-brand bg-brand/10'
                      : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover'}`}
                >
                  {label}
                </Link>
              )
            })}
          </div>
        </div>

        <WalletPip variant="navbar" />
      </div>
    </nav>
  )
}
