'use client'

/**
 * The five-step explainer under the directory.
 *
 * WHY THIS SECTION IS MONOCHROME. It used to give each step its own accent —
 * success, brand, warning, admin, success — which read as decoration but spent
 * the palette's meaning. `admin` purple is owner-only chrome everywhere else in
 * the app, and `warning` amber means a deadline or a price gate; borrowing them
 * to tint "CURVE" and "GENESIS" taught the eye that those hues mean nothing in
 * particular. The five LEDs had the same problem in the other direction: they
 * breathed like live status pips on cards that report no status at all, and
 * five of them at once blew the glow budget that exists so a genuinely live
 * pip can be noticed.
 *
 * So colour is spent in exactly one place here: the connector rail, which is
 * the only thing on screen actually saying "these five are a sequence". The
 * cards themselves are the standard panel surface.
 *
 * The rail's offset and the header band's height are the same number, hence
 * `--rail-band`. They were two hand-tuned literals before (`top-[130px]`
 * against a `min-h-[320px]` card) and drifted apart whenever a title wrapped
 * to a second line.
 */

const RAIL_BAND = '3rem'

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
    <section
      className="relative z-10 overflow-hidden pt-28 pb-12 md:pt-36 md:pb-16"
      style={{ ['--rail-band' as string]: RAIL_BAND }}
    >
      <div className="mb-16 md:mb-20">
        <h3 className="mb-4 font-mono text-label text-text-quiet uppercase">
          {`// HOW IT WORKS`}
        </h3>
        <h2 className="text-section text-text-primary md:text-hero">How a Tosh launch works.</h2>
        <p className="mt-gap max-w-2xl text-body text-text-secondary">
          Five steps, all of them settled on chain. Nothing below is enforced by this interface.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-gap md:grid-cols-5">
        {STEPS.map((s, i) => (
          <div key={s.step} className="group relative flex">
            {/* The rail lives in the gutter between two cards, centred on the
                header band so it meets each card at its step number. */}
            {i < STEPS.length - 1 && (
              <div
                aria-hidden
                className="cable-flow pointer-events-none absolute right-[calc(-1*var(--spacing-gap))] z-0 hidden h-px w-gap bg-gradient-to-r from-border-strong via-brand/25 to-border-strong md:block"
                style={{ top: `calc(var(--rail-band) / 2)` }}
              />
            )}

            <div className="relative z-10 flex w-full flex-col rounded-panel border border-border-subtle bg-surface-card shadow-panel transition-colors group-hover:border-border-strong">
              <div
                className="flex shrink-0 items-center gap-gap-tight border-b border-border-subtle px-card"
                style={{ height: 'var(--rail-band)' }}
              >
                <span className="font-mono text-micro text-text-quiet">{s.step}</span>
                <span className="font-mono text-micro text-text-tertiary uppercase">{s.tag}</span>
              </div>

              <div className="flex flex-1 flex-col gap-gap-tight px-card py-card">
                <h4 className="text-title text-text-primary">{s.title}</h4>
                <p className="text-note leading-relaxed text-text-secondary">{s.description}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
