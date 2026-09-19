import type { Metadata } from 'next'
import { Suspense } from 'react'
import { JetBrains_Mono, Geist } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'
import { ToshNavbar } from '@/components/ToshNavbar'
import { NetworkGuardClient } from '@/components/NetworkGuardClient'
import { FactoryGuardClient } from '@/components/FactoryGuardClient'
import { ReferralCapture } from '@/components/ReferralCapture'
import { SiteFooter } from '@/components/SiteFooter'
import { InstantProjectSlot } from '@/components/directory/InstantProjectSlot'
import { CHAIN_POSITIONING } from '@/lib/chain'
import { QUOTE_POSITIONING } from '@/lib/contracts'

// JetBrains Mono — labels, numbers, addresses, audit-cliff IDs, code-style text.
const jbm = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jbm',
  weight:   ['200', '300', '400', '500', '700'],
  display:  'swap',
})

// Geist Sans — body copy, hero headlines, descriptions.  Adopted in v4.4 after
// the MeritX redesign review proved that full-mono pages cap readability for
// any sentence longer than ~6 words.  Mono is still primary for any token
// (numbers, hashes, addresses, status pills) so the cryptographic feel stays.
const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  weight:   ['300', '400', '500', '700', '900'],
  display:  'swap',
})

// The last clause is derived, not written. It used to read "Currently staging on
// Base Sepolia testnet." and stayed that way through the whole Robinhood Chain
// migration: `checkChainCopy.mjs` evaluates the chain constants on every chain,
// but a literal in a component is invisible to it, and page metadata is not one
// of the four surfaces that guard was built around. Search engines and link
// previews were quoting the wrong chain for as long as the string sat here.
/**
 * Where this build believes it lives, for the absolute URLs OG and Twitter need.
 *
 * Overridable so a preview deployment can describe itself instead of pointing
 * its card at production, and defaulted rather than required because a missing
 * `metadataBase` does not fail the build — it silently resolves relative image
 * URLs against `localhost`, which ships a card that renders for nobody.
 */
const SITE_URL = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://toshx.xyz')

/**
 * One description, used three times.
 *
 * Both derived clauses are here rather than written out: see `CHAIN_POSITIONING`
 * in lib/chain.ts and `QUOTE_POSITIONING` in lib/contracts.ts for what each one
 * is protecting against. Between them they carry the two facts most likely to
 * age — which chain this settles on, and what the numbers are denominated in.
 */
const DESCRIPTION =
  'Fair-launch terminal for agent tokens, built on PancakeSwap Infinity hooks. '
+ 'Proof-of-Gas gated genesis, 4000-rung shelf ladder, audit-cliff hardened. '
+ `${QUOTE_POSITIONING} ${CHAIN_POSITIONING}`

export const metadata: Metadata = {
  metadataBase: SITE_URL,
  // `ToshX`, matching the navbar wordmark and the domain. It read
  // `TOSH // Cryptographic Console`, which made the product answer to two names
  // across three surfaces: the tab said TOSH, the wordmark renders
  // `Tosh<span>X</span>`, and the site is served from toshx.xyz.
  title: 'ToshX',
  description: DESCRIPTION,

  /* Link previews. There were none: every `toshx.xyz` link shared anywhere
     rendered as a bare URL with no title, no description and no image, which
     for a launchpad is the main distribution path carrying nothing.
     `opengraph-image.tsx` and `twitter-image.tsx` supply the image itself; the
     `url`, `siteName` and `type` are what turn it into a card rather than a
     loose image. */
  openGraph: {
    type:        'website',
    url:         SITE_URL,
    siteName:    'ToshX',
    title:       'ToshX — fair-launch terminal for agent tokens',
    description: DESCRIPTION,
    locale:      'en_US',
  },
  twitter: {
    // `summary_large_image`, not `summary`: the small card crops to a square
    // thumbnail, and a 1200x630 image with a headline in it becomes unreadable
    // at that aspect. The card is only worth having at the size it was drawn.
    card:        'summary_large_image',
    title:       'ToshX — fair-launch terminal for agent tokens',
    description: DESCRIPTION,
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${jbm.variable} ${geist.variable}`} suppressHydrationWarning>
      {/* Colour, selection and numeral defaults all come from globals.css, so
          the body carries layout only. `bg-bg-base` used to sit here and
          quietly overrode the canvas token on every page. */}
      {/* A column so the footer can sit at the bottom of short pages via
          `mt-auto` instead of every page padding itself out to `min-h-screen`
          and leaving a blank viewport above it. */}
      <body
        className="terminal-grid-bg flex min-h-screen flex-col font-sans antialiased"
        suppressHydrationWarning
      >
        <Providers>
          {/* useSearchParams needs a boundary or it opts the whole tree out of
              static rendering. */}
          <Suspense fallback={null}>
            <ReferralCapture />
          </Suspense>
          <ToshNavbar />
          <NetworkGuardClient />
          <FactoryGuardClient />
          <div className="flex-1">
            <InstantProjectSlot>{children}</InstantProjectSlot>
          </div>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  )
}
