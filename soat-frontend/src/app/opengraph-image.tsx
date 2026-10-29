import { ImageResponse } from 'next/og'

import { CHAIN_STATUS_BADGE } from '@/lib/chain'
import { NATIVE_SYMBOL } from '@/lib/chain'
import { V2 } from '@/lib/v2/config'

/*
 * opengraph-image.tsx — the card a shared toshx.xyz link renders as
 * ───────────────────────────────────────────────────────────────────────────
 *  There was no card. Every link to this site posted to X, Telegram or Discord
 *  came out as a bare URL, which for a launchpad is the main distribution path
 *  carrying nothing at all.
 *
 *  `twitter-image.tsx` re-exports this file rather than drawing its own. Next
 *  treats the two conventions separately and emits `twitter:image` only from
 *  the latter, so without that re-export X would fall back to `og:image` on
 *  some surfaces and to nothing on others.
 *
 *  INLINE STYLES ONLY, and not by preference. ImageResponse renders through
 *  satori, which never sees a stylesheet: Tailwind class names arrive as
 *  unknown strings and are dropped silently, so a card written in the site's
 *  own utility classes would render as unstyled black text on white. The
 *  colours below are therefore duplicated from globals.css rather than read
 *  from it, which is a real cost — a brand change has to touch this file too.
 *
 *  The chain badge and the ticker are derived, for the reason everything about
 *  a chain or a denomination in this app is derived. A hard-coded chain name in
 *  `layout.tsx` metadata outlived a whole migration once, and an OG image is
 *  strictly worse than page metadata for that: cards are cached by every
 *  platform that scrapes them, so a wrong one survives the fix.
 */

// From globals.css. See the note above for why these are copies.
const BG = '#0B0E11'
const CARD = '#1E2329'
const BORDER = '#2B3139'
const BRAND = '#F0B90B'
const VIOLET = '#FCD535'
const TEXT = '#EAECEF'
const MUTED = '#848E9C'

export const alt = `ToshX — the fair-launch terminal of the ${NATIVE_SYMBOL} ecosystem`
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/* LogoMark's three bars, drawn here rather than read from a PNG. Next derives
 * the `og:image` query hash from this file's source, and platforms cache the
 * card by that URL: a mark kept in a separate image changed the picture without
 * changing the URL, so Telegram kept serving the previous card. A data URI also
 * keeps satori from fetching the deployment that is serving it. */
const MARK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="${BRAND}"/><stop offset="1" stop-color="${BRAND}" stop-opacity="0.78"/>` +
  `</linearGradient></defs>` +
  [[4, 0.45], [38, 0.72], [72, 1]]
    .map(([x, o]) => `<polygon points="${x},6 ${x + 24},22 ${x + 24},78 ${x},94" fill="url(#g)" opacity="${o}"/>`)
    .join('') +
  `</svg>`
const MARK = `data:image/svg+xml;base64,${Buffer.from(MARK_SVG).toString('base64')}`

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: BG,
          padding: '64px 72px',
          fontFamily: 'Geist',
        }}
      >
        {/* The brand glow, as a positioned block rather than a background on the
            root. satori supports radial gradients but composites them against
            the parent rather than over siblings, so painting it on the root
            washed the headline out. */}
        <div
          style={{
            position: 'absolute',
            top: -260,
            right: -160,
            width: 760,
            height: 760,
            borderRadius: 760,
            background: `radial-gradient(circle, ${BRAND}26 0%, ${BG}00 70%)`,
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={MARK} alt="" width={56} height={56} />
          {/* The wordmark is one word and satori will not render it as one.
              It lays out a text node and an adjacent element as separate
              segments joined at a word boundary, so `Tosh<span>X</span>` comes
              out "Tosh X" — visible in this very card's body copy, where every
              word space is wider than the font's own. `display: block` does not
              change it and neither does `letterSpacing`.
              The -11 is measured against the rendered PNG at this font size,
              not guessed, and it is checked the only way it can be: by looking.
              The navbar hits the same wall from the other side and solves it by
              never splitting the node at all — which is available there because
              a stylesheet is. */}
          <span style={{ display: 'flex', fontSize: 40, letterSpacing: -1, color: TEXT }}>
            <span>Tosh</span>
            <span style={{ color: BRAND, marginLeft: -11 }}>X</span>
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Two spans, not one with a gradient. satori does support
              background-clip on text, but it clips to the text's own box and
              the second line is shorter than the first, so the sweep restarted
              mid-phrase. A solid brand colour says the same thing and cannot
              render wrong. */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              fontSize: 78,
              lineHeight: 1.05,
              letterSpacing: -2.5,
              color: TEXT,
            }}
          >
            <span>Fair-launch terminal</span>
            {/* `gap` carries the word space, because the literal one does not
                survive. This row is a flex container, so `for <span>` puts the
                space at the boundary between two flex items where it is
                collapsed away — it rendered "foragent tokens." An explicit gap
                is the only version that cannot be silently dropped. */}
            <div style={{ display: 'flex', gap: 20 }}>
              <span>of the</span>
              <span style={{ color: BRAND }}>{NATIVE_SYMBOL} ecosystem.</span>
            </div>
          </div>

          <div style={{ display: 'flex', fontSize: 26, color: MUTED }}>
            {`Fair launch for verified agents · Binance Agent ID genesis · ${V2.TIER_COUNT.toLocaleString('en-US')}-rung ladder`}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 22px',
                borderRadius: 999,
                background: CARD,
                border: `1px solid ${BORDER}`,
                fontSize: 22,
                color: MUTED,
              }}
            >
              {CHAIN_STATUS_BADGE}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '12px 22px',
                borderRadius: 999,
                background: CARD,
                border: `1px solid ${BORDER}`,
                fontSize: 22,
                color: MUTED,
              }}
            >
              {/* The denomination, and the reason this card is worth deriving
                  rather than exporting once as a PNG. */}
              {NATIVE_SYMBOL} or USDT
            </div>
          </div>
          <div style={{ display: 'flex', fontSize: 24, color: VIOLET }}>toshx.xyz</div>
        </div>
      </div>
    ),
    { ...size },
  )
}
