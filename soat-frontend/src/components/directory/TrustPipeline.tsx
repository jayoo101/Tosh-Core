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
 * So colour is spent in exactly one place: the step numbers, which are the only
 * thing on screen actually saying "these five are a sequence".
 *
 * WHY IT IS A LIST AND NOT FIVE COLUMNS.
 * It was a `md:grid-cols-5` of cards joined by an animated connector rail, and
 * the rail existed precisely because five side-by-side cards do not read as an
 * ordered sequence on their own. That was solving a problem the layout had
 * created: at five columns inside a 1152px container each description got about
 * 130px of measure, which is four or five words per line for paragraphs that
 * run to forty. The v0 redesign stacks them, and a numbered vertical list is
 * ordered without needing anything drawn between the items - so the rail, the
 * `--rail-band` variable that aligned it, and the `cable-flow` keyframes it
 * animated with all went with the columns rather than being ported.
 *
 * `id="how-it-works"` because the navigation points at it. The section had no
 * anchor while the only way in was scrolling.
 */

const STEPS = [
  {
    step: '01',
    tag: 'Quota',
    title: 'Gas history sets your limit',
    description:
      'Tosh reads how much gas your wallet has genuinely burned and signs that into a deposit ceiling. A wallet minted this morning has no history to spend, so bot swarms have nothing to bring.',
  },
  {
    step: '02',
    tag: 'Launch',
    title: 'Anyone can open one',
    description:
      'Pay the launch fee in ETH and the token deploys together with its own Uniswap V4 pool. No pre-mine, no team allocation, no supply held back for insiders.',
  },
  {
    step: '03',
    tag: 'Genesis',
    title: 'A window that cannot close early',
    description:
      'Deposits run in ETH for 3, 24 or 72 hours — the creator chooses once, at launch, and cannot shorten it afterwards. If the raise misses its floor, every depositor takes back the full amount.',
  },
  {
    step: '04',
    tag: 'Ladder',
    title: 'Price climbs one shelf at a time',
    description:
      'After genesis the remaining supply is released across 4,000 fixed shelves spanning 2,000x from the opening price. A ceiling blocks spikes, and 99% of what the shelves earn goes to the project itself.',
  },
  {
    step: '05',
    tag: 'Hardened',
    title: 'The contract enforces it, not this page',
    description:
      'Deposit accounting, the 0.01 ETH minimum raise and the dust-deposit floor all live in the contract. This interface only mirrors them, so it cannot loosen them.',
  },
] as const

export function TrustPipeline() {
  return (
    <section id="how-it-works" className="relative z-10 pt-24 pb-12 md:pt-32 md:pb-16">
      <div className="mb-10 md:mb-12">
        <h3 className="mb-4 font-mono text-label uppercase text-text-quiet">
          {`// HOW IT WORKS`}
        </h3>
        <h2 className="text-section text-text-primary md:text-hero">How a Tosh launch works.</h2>
        <p className="mt-gap max-w-2xl text-body text-text-secondary">
          Five steps, all of them settled on chain. Nothing below is enforced by this interface.
        </p>
      </div>

      <ol className="divide-y divide-border-subtle overflow-hidden rounded-panel border border-border-subtle bg-surface-card shadow-panel">
        {STEPS.map(s => (
          <li
            key={s.step}
            className="flex gap-card px-card py-card transition-colors hover:bg-surface-hover md:px-card-lg"
          >
            <span className="w-6 shrink-0 pt-0.5 font-mono text-note font-bold tabular-nums text-brand">
              {s.step}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-gap-tight">
                <span className="font-mono text-micro uppercase text-text-tertiary">{s.tag}</span>
                <h4 className="font-mono text-title text-text-primary">{s.title}</h4>
              </div>
              {/* `max-w-3xl`, so the measure stops at something readable on a
                  wide monitor instead of running the full container width. */}
              <p className="mt-gap-tight max-w-3xl text-note leading-relaxed text-text-secondary">
                {s.description}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
