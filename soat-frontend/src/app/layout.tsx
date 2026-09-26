import type { Metadata } from 'next'
import { Suspense } from 'react'
import { JetBrains_Mono, Geist, Noto_Sans_SC } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'
import { ToshNavbar } from '@/components/ToshNavbar'
import { NetworkGuardClient } from '@/components/NetworkGuardClient'
import { FactoryGuardClient } from '@/components/FactoryGuardClient'
import { ReferralCapture } from '@/components/ReferralCapture'
import { SiteFooter } from '@/components/SiteFooter'
import { InstantProjectSlot } from '@/components/directory/InstantProjectSlot'
import { CHAIN_POSITIONING } from '@/lib/chain'
import { QUOTE_POSITIONING, QUOTE_SYMBOL } from '@/lib/contracts'
import { I18nProvider, LOCALES_ENABLED, DEFAULT_LOCALE, fill, type Locale } from '@/i18n'
import { requestDictionary } from '@/i18n/server'

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

/*
 * ⚠ NEITHER FONT ABOVE HAS A SINGLE CJK GLYPH, and until this existed that was
 *   a silent hole rather than a visible one. Measured on the Chinese refund
 *   panel: `申领退款` computed to `Geist, "Geist Fallback"` and `你存入的金额`
 *   to `"JetBrains Mono", "JetBrains Mono Fallback"` — all four of those are
 *   Latin-only, so the browser fell through every declared family and let the
 *   OS pick. Nothing was broken and nothing was clipped; the page simply
 *   rendered in a different typeface on every platform, and the mono labels —
 *   which are the design's whole identity — rendered in whatever the system
 *   considered a UI sans.
 *
 * `preload: false` is not a tuning choice. Google serves CJK families as a
 * hundred-odd unicode-range subsets, and preloading them would fetch megabytes
 * on a page that may contain no CJK at all. Without the preload hint the
 * `@font-face` rules still ship, and the browser fetches only the subsets a
 * glyph on screen actually needs — which is the mechanism that makes a CJK
 * webfont affordable here.
 *
 * ⚠ ONLY SIMPLIFIED CHINESE IS DECLARED, because it is the only CJK locale with
 *   a dictionary. `next/font/google` downloads the files at BUILD time, so a
 *   family declared for an unenabled language is build output nobody can read —
 *   and four CJK families at three weights is a large amount of it. When
 *   `zh-TW`, `ja` or `ko` gets a translation, add `Noto_Sans_TC` / `_JP` / `_KR`
 *   here and an entry in `CJK_FONT` below. They are not interchangeable: Japanese
 *   and Chinese draw several common characters differently (今, 直, 令), so
 *   serving SC to a Japanese reader is the same class of error as serving them
 *   Chinese words.
 */
const notoSC = Noto_Sans_SC({
  variable: '--font-noto-sc',
  weight:   ['400', '500', '700'],
  display:  'swap',
  preload:  false,
})

/**
 * The CJK face to layer behind the Latin ones, per locale.
 *
 * Absent means "this locale needs no CJK coverage" — every Latin and Cyrillic
 * locale, since JetBrains Mono and Geist both cover those themselves. A locale
 * that needs a face and has not got one here falls back to the system CJK list
 * in `globals.css`, which is the behaviour this whole block replaces and is
 * still the right floor.
 */
const CJK_FONT: Partial<Record<Locale, { style: { fontFamily: string } }>> = {
  'zh-CN': notoSC,
}

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

/** `openGraph.locale` wants the underscore form. */
const OG_LOCALE: Partial<Record<Locale, string>> = { 'en': 'en_US', 'zh-CN': 'zh_CN' }

export async function generateMetadata(): Promise<Metadata> {
  const { locale, dict } = await requestDictionary()
  const t = dict.meta
  const siteDescription = fill(t.siteDescription, { quote: QUOTE_SYMBOL })
  const cardTitle = fill(t.cardTitle, { quote: QUOTE_SYMBOL })

  /*
   * One description, used three times.
   *
   * Both derived clauses are appended rather than written out: see
   * `CHAIN_POSITIONING` in lib/chain.ts and `QUOTE_POSITIONING` in
   * lib/contracts.ts for what each one is protecting against. Between them they
   * carry the two facts most likely to age — which chain this settles on, and
   * what the numbers are denominated in.
   *
   * ⚠ ENGLISH ONLY. Both clauses are English constants that
   *   `checkChainCopy.mjs` evaluates per chain; appending them to a translated
   *   sentence would ship a description in two languages.
   */
  const description = locale === DEFAULT_LOCALE
    ? `${siteDescription} ${QUOTE_POSITIONING} ${CHAIN_POSITIONING}`
    : siteDescription

  return {
    metadataBase: SITE_URL,
    // `ToshX`, matching the navbar wordmark and the domain. It read
    // `TOSH // Cryptographic Console`, which made the product answer to two names
    // across three surfaces: the tab said TOSH, the wordmark renders
    // `Tosh<span>X</span>`, and the site is served from toshx.xyz.
    title: 'ToshX',
    description,

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
      title:       cardTitle,
      description,
      locale:      OG_LOCALE[locale] ?? 'en_US',
    },
    twitter: {
      // `summary_large_image`, not `summary`: the small card crops to a square
      // thumbnail, and a 1200x630 image with a headline in it becomes unreadable
      // at that aspect. The card is only worth having at the size it was drawn.
      card:        'summary_large_image',
      title:       cardTitle,
      description,
    },
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const { locale, dict } = await requestDictionary()

  /*
   * The whole tree, so the provider can be wrapped around it or not.
   *
   * ⚠ A SINGLE-LANGUAGE BUILD MOUNTS NO PROVIDER. `useT()` defaults to the
   *   English dictionary with no provider above it (see `I18nProvider.tsx`), so
   *   the wrapper buys nothing there — and skipping it means the dark-launched
   *   build adds no context, no re-render and not one string to the RSC payload.
   *   "Shipped dark" is then a fact about the output rather than a claim about
   *   the code.
   */
  const tree = (
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
      <SiteFooter t={dict} />
    </Providers>
  )

  /*
   * `--font-cjk` is consumed inside both font stacks in `globals.css`, ahead of
   * the generic families. Set here rather than in a stylesheet because the value
   * depends on the request's locale, and left UNSET for locales with no CJK face
   * so the system list declared in `:root` stays in force.
   *
   * ⚠ THE FAMILY NAME, NOT THE `--font-noto-sc` VARIABLE. `next/font` scopes its
   *   variable to elements carrying the generated class, and the class would have
   *   to go on `<html>` for `body` to inherit it — at which point two mechanisms
   *   say the same thing. `style.fontFamily` is the resolved family list and
   *   needs neither.
   */
  const cjk = CJK_FONT[locale]
  const fontVars = cjk
    ? ({ '--font-cjk': cjk.style.fontFamily } as React.CSSProperties)
    : undefined

  /*
   * `translate="no"` because browser page translation rewrites text nodes React
   * still owns, and the next render that touches one throws `insertBefore` /
   * `removeChild` on a node that is no longer there. It reached users as the
   * root error boundary — itself machine-translated. The languages we serve
   * come from the dictionary instead.
   */
  return (
    <html
      lang={locale}
      translate="no"
      className={`${jbm.variable} ${geist.variable}`}
      style={fontVars}
      suppressHydrationWarning
    >
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
        {LOCALES_ENABLED
          ? <I18nProvider dict={dict} locale={locale}>{tree}</I18nProvider>
          : tree}
      </body>
    </html>
  )
}
