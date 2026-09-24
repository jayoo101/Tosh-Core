'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { CHAIN_BYLINE } from '@/lib/contracts'
import { useT, type Dictionary } from '@/i18n'
import { LocalePicker } from './LocalePicker'

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
 * Three routes. The reference design's fourth ("How it works") is still not one.
 *
 * THERE IS NO "HOW IT WORKS" ENTRY. It was `/#how-it-works`, then briefly a
 * `/docs` page, and it is now neither. A documentation route has to describe
 * mechanics that are still moving — fee split, ladder geometry, the refund
 * window — and every sentence of it is a second place those numbers can go
 * stale against the contracts. `TrustPipeline` on the home page is the one
 * description, it sits next to the thing it describes, and the reader who
 * needs it is already scrolling. When the mechanics settle, a real route can
 * come back; a page that restates them today is a liability, not a feature.
 *
 * `/referrals` is a different kind of third. It is not documentation: it is
 * the only place a wallet can see every project's commission and claim it.
 * Leaving it in the footer (and, later, only in the connected-wallet drawer)
 * meant a depositor who had just earned the 8 % project leg could not find
 * the desk. The drawer stays, because commission is keyed to an address; the
 * navbar is how an unconnected visitor learns the desk exists.
 *
 * "AGENT DIRECTORY" WAS `/`. The directory used to live inline on the landing
 * page, so the landing page was the directory. It has its own route now, with
 * the filtering and sorting that do not belong on a landing page, and the home
 * page keeps a teaser that links here. The wordmark is the way home.
 *
 * Three labels do not fit at 390px next to CONNECT. `Agent Directory` sheds
 * its first word below `sm`, which is the 52px the bar actually needed; the
 * other two labels stay in full because they are the short ones.
 */
function navItems(t: Dictionary) {
  return [
    { href: '/projects',  label: t.site.navDirectory, full: t.site.navDirectoryFull, exact: false },
    { href: '/launch',    label: t.site.navLaunch,    full: t.site.navLaunch,        exact: false },
    { href: '/referrals', label: t.site.navReferrals, full: t.site.navReferrals,     exact: false },
  ] as const
}

/** MeritX Navbar — sticky, wallet drawer via WalletPip. Hidden on /admin. */
export function ToshNavbar() {
  const pathname = usePathname()
  const t = useT()
  if (pathname?.startsWith('/admin')) return null

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-border-subtle bg-bg-base">
      {/* `max-w-7xl` and `sm:px-6`, matching the reference shell. Every content
          column in the app is measured against this one; while the navbar was
          1152px and the directory page was 1280px, the wordmark sat 64px inside
          the grid it was supposed to be aligned with. */}
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3 sm:px-6">
        <div className="flex items-center gap-3 min-w-0 sm:gap-5">
          <Link href="/" className="flex items-center gap-2 text-title text-text-primary tracking-tighter hover:opacity-90 transition-opacity shrink-0">
            {/* `alt` is empty on purpose. The span below already gives this
                link its accessible name, so naming the image as well would
                have a screen reader announce "ToshX" twice. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand-mark.png" alt="" width={16} height={16} className="shrink-0" />
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

          {/* Not `hidden sm:flex` as a block: /launch has no other way in, and
              /referrals was invisible for exactly as long as it lived only
              below the fold. All three survive to 390px; Directory is the one
              that shortens (see navItems). */}
          <div className="flex items-center gap-1 min-w-0">
            {navItems(t).map(({ href, label, full, exact }) => {
              const active = exact ? pathname === href : pathname?.startsWith(href)
              return (
                <Link
                  key={href}
                  href={href}
                  className={`px-2 py-1.5 rounded-input text-note font-medium whitespace-nowrap transition-colors sm:px-3
                    ${active
                      ? 'text-brand bg-brand/10'
                      : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover'}`}
                >
                  {full === label ? label : (
                    <>
                      <span className="sm:hidden">{label}</span>
                      <span className="hidden sm:inline">{full}</span>
                    </>
                  )}
                </Link>
              )
            })}
          </div>
        </div>

        {/* Wrapped so the picker can sit beside the pip. `LocalePicker` renders
            nothing when this build serves one language, and a flex row with one
            child is indistinguishable from the bare pip that used to be here —
            so the dark-launched navbar is unchanged to the pixel. */}
        <div className="flex shrink-0 items-center gap-2">
          <LocalePicker />
          <WalletPip variant="navbar" />
        </div>
      </div>
    </nav>
  )
}
