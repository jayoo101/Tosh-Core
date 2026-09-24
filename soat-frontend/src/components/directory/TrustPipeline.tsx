'use client'

import { BarChart3, Fuel, Lock, Rocket, Timer, type LucideIcon } from 'lucide-react'

import { QUOTE_SYMBOL } from '@/lib/contracts'
import { NATIVE_SYMBOL } from '@/lib/chain'
import { fill, useT, type Dictionary } from '@/i18n'

/**
 * The five-step explainer under the directory.
 *
 * WHY THIS SECTION IS MONOCHROME. It used to give each step its own accent -
 * success, brand, warning, admin, success - which read as decoration but spent
 * the palette's meaning. `admin` purple is owner-only chrome everywhere else in
 * the app, and `warning` amber means a deadline or a price gate; borrowing them
 * to tint "CURVE" and "GENESIS" taught the eye that those hues mean nothing in
 * particular. The five LEDs had the same problem in the other direction: they
 * breathed like live status pips on cards that report no status at all, and
 * five of them at once blew the glow budget that exists so a genuinely live
 * pip can be noticed.
 *
 * So colour is spent in exactly one place: brand, on the step number and the
 * icon beside it, which are the only marks on screen actually saying "these
 * five are a sequence".
 *
 * WHY THE FIVE COLUMNS ARE BACK.
 * They were taken out in 50bc9a7 on an argument that still holds arithmetically:
 * at five columns inside this container each description gets about 130px of
 * measure, which is four or five words per line for paragraphs that run to
 * forty, and a numbered vertical list is ordered without needing anything drawn
 * between the items. Nothing has refuted that. What changed is the requirement
 * above it - the brief is now exact fidelity to the v0 mock, and the mock is a
 * five-column grid - so the trade is taken knowingly rather than won on the
 * merits. The narrow measure is the price of the layout, and these five
 * descriptions are what pays it.
 *
 * What did NOT come back with the columns is the animated connector rail that
 * used to join them. The rail existed because five side-by-side cards do not
 * read as an ordered sequence on their own, which it solved by drawing the
 * sequence; an `<ol>` of hairline-separated cells solves the same thing with
 * structure, so the rail, the `--rail-band` variable that aligned it and the
 * `cable-flow` keyframes it animated with stay deleted.
 *
 * `id="how-it-works"` is kept although nothing in the app links to it any more
 * — the navbar entry that needed it is gone. It stays because it is the only
 * address this explanation has: it is what a support reply or a forum post
 * pastes, and removing it breaks those silently from outside the codebase.
 */

/**
 * Local again. This was briefly exported so a `/docs` route could render the
 * same five steps in a different shape; that route is gone and the export went
 * with it, because an exported constant with no importer is an invitation to
 * grow a second presentation of these sentences somewhere else.
 *
 * They are a claim about what the contract does, so a second copy of them is a
 * second thing to keep true — and the one that goes stale is always the one
 * nobody remembers exists. If another surface needs them, export it again and
 * have that surface reformat this array rather than restate it.
 *
 * The sentences themselves live in the dictionary under `home.step*`; this
 * builds the array from them.
 */
function steps(h: Dictionary['home']) {
  return [
  {
    step: '01',
    tag: h.step1Tag,
    title: h.step1Title,
    description: h.step1Body,
  },
  {
    step: '02',
    tag: h.step2Tag,
    title: h.step2Title,
    description:
      // ⚠ THE FEE IS THE ONE AMOUNT ON THIS PAGE THAT IS NOT THE QUOTE ASSET,
      //   and this sentence said `${QUOTE_SYMBOL}` — so the first thing a
      //   creator read told them to fund the wrong coin. Deposits, refunds and
      //   shelf buys are all the quote asset; the launch fee is native, settles
      //   at `platformTreasury` rather than the buyback reservoir, and arrives
      //   as `msg.value`. Step 03 below is the QUOTE_SYMBOL one and stays that
      //   way: the two are adjacent on screen, which is exactly why one symbol
      //   got pasted over both. Rule 5 in `checkChainCopy.mjs` now fails the
      //   build on it.
      fill(h.step2Body, { native: NATIVE_SYMBOL }),
  },
  {
    step: '03',
    tag: h.step3Tag,
    title: h.step3Title,
    description: fill(h.step3Body, { quote: QUOTE_SYMBOL }),
  },
  {
    step: '04',
    tag: h.step4Tag,
    title: h.step4Title,
    description: h.step4Body,
  },
  {
    step: '05',
    tag: h.step5Tag,
    title: h.step5Title,
    description:
      // ⚠ "THE RAISE-TARGET DIAL" WAS STILL HERE, and there is no raise target
      //   to dial. It was the soft cap, which `launch()` does not read and which
      //   no longer appears anywhere in the UI. Naming it in the step that says
      //   "the contract enforces it" was the worst place for it to survive: it
      //   claimed on-chain authority for a number nothing on chain consults.
      //   What does gate a deposit is the per-wallet cap the PoG signature sets,
      //   which is the real dial and is genuinely enforced.
      h.step5Body,
  },
  ] as const
}

/**
 * Iconography, kept out of `STEPS` on purpose.
 *
 * The glyphs are this grid's decoration, not part of what the steps say.
 * Putting them in the array would make a copy edit to a description read as a
 * change to the layout, and would force any future consumer of `STEPS` to
 * carry an icon rail it may have no room to draw. Keyed by `step` rather than
 * ordered alongside it
 * so that adding a sixth step is a type error here instead of an icon silently
 * falling off the end.
 */
const ICONS: Record<ReturnType<typeof steps>[number]['step'], LucideIcon> = {
  '01': Fuel,
  '02': Rocket,
  '03': Timer,
  '04': BarChart3,
  '05': Lock,
}

export function TrustPipeline() {
  const h = useT().home
  return (
    <section id="how-it-works" className="border-t border-border-subtle">
      {/* The gutter is back. It was dropped because this section rendered
          inside the landing page's own `max-w-6xl mx-auto px-4` main, where
          repeating it would have inset the grid twice. That main no longer
          constrains anything — the landing page now spans the viewport and
          each section carries its own column, the way the reference project
          arranges it — so this block owns its gutter and its `border-t`
          finally reaches both edges. */}
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <div className="flex flex-col gap-4 border-b border-border-subtle pb-section md:flex-row md:items-end md:justify-between">
          <div className="flex flex-col gap-gap">
            <span className="font-mono text-label uppercase text-brand">
              {h.howKicker}
            </span>
            <h2 className="text-balance font-mono text-section text-text-primary md:text-hero">
              {h.howTitle}
            </h2>
          </div>
          <p className="max-w-sm text-pretty text-body leading-relaxed text-text-secondary md:text-right">
            {h.howLede}
          </p>
        </div>

        {/* THE DIVIDERS ARE THE BACKGROUND. There is no border on the cells:
            the `<ol>` is painted `bg-border-subtle`, `gap-px` leaves a 1px seam
            between items, and each `<li>` paints itself back to the canvas
            colour - so what reads as a hairline rule is the list showing
            through. It is the only way to get a single-pixel grid with no
            doubling where two cells meet, and it is why a background colour on
            the `<li>` is load-bearing rather than cosmetic.

            `mt-px` for the same reason: it lets the first row's seam sit
            against the header's `border-b` without the two stacking into 2px. */}
        <ol className="mt-px grid gap-px bg-border-subtle md:grid-cols-2 lg:grid-cols-5">
          {steps(h).map(s => {
            const Icon = ICONS[s.step]
            return (
              <li key={s.step} className="group flex flex-col bg-bg-base p-card-lg">
                <div className="flex items-center justify-between">
                  {/* Dim until the column is hovered, because five numerals at
                      full brand weight would out-shout the titles they are
                      supposed to be counting. */}
                  <span className="font-mono text-figure tabular-nums text-brand/25 transition-colors group-hover:text-brand/60">
                    {s.step}
                  </span>
                  <Icon className="h-5 w-5 text-brand" aria-hidden />
                </div>

                <span className="mt-card-lg font-mono text-note font-semibold uppercase tracking-widest text-text-secondary">
                  {s.tag}
                </span>
                <h3 className="mt-gap-tight font-mono text-title leading-snug text-text-primary">
                  {s.title}
                </h3>
                <p className="mt-gap-tight text-body leading-relaxed text-text-secondary">
                  {s.description}
                </p>
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}
