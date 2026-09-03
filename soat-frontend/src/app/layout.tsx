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

export const metadata: Metadata = {
  title: 'TOSH // Cryptographic Console',
  description:
    'Tosh Protocol v5.0 — Ethereum-native fair-launch terminal with Uniswap V4 hooks. '
  + 'Proof-of-Gas gated genesis, 4000-rung shelf ladder, audit-cliff hardened. '
  + 'Currently staging on Base Sepolia testnet.',
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
