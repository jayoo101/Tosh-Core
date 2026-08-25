import type { Metadata } from 'next'
import { Suspense } from 'react'
import { JetBrains_Mono, Geist } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'
import { ToshNavbar } from './components/ToshNavbar'
import { NetworkGuardClient } from './components/NetworkGuardClient'
import { ReferralCapture } from './components/ReferralCapture'

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
      <body
        className="terminal-grid-bg bg-zinc-950 text-zinc-100 font-sans antialiased
                   selection:bg-tosh-fluo/30 min-h-screen"
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
          {children}
        </Providers>
      </body>
    </html>
  )
}
