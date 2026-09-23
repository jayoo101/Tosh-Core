/**
 * The source of truth for every translatable string, and the shape every other
 * locale is checked against.
 *
 * ⚠ THE `Dictionary` TYPE IS DERIVED FROM THIS OBJECT, so adding a key here is
 *   what makes it referenceable, and deleting one here is what makes every
 *   remaining reference fail to compile. That is the whole reason this is hand
 *   rolled rather than JSON: `t.refund.noneReason` is checked, and a key that
 *   does not exist cannot be reached by a typo.
 *
 * ── RULES FOR EVERYTHING IN HERE ─────────────────────────────────────────────
 *
 *   1. WHOLE SENTENCES, NEVER FRAGMENTS THAT GET CONCATENATED. The two refund
 *      reasons below both end with "Take back the full amount, no penalty." and
 *      the component used to build them by joining that clause onto a stem.
 *      Sharing it here would force every language into English word order, and
 *      the languages this build offers do not have it — Japanese and Korean put
 *      the verb last. Each reason is one complete string, duplication included.
 *
 *   2. INTERPOLATION IS `{name}` AND IS FILLED BY `fill()`, never by a function
 *      stored in here. The merged dictionary crosses the server/client boundary
 *      as props, and React cannot serialise a function — a template literal in
 *      this file would fail at runtime in the one place it matters. The
 *      placeholder form also shows a translator that a value lands there, and
 *      `guard:i18n` fails the build when a locale drops one.
 *
 *   3. NO TICKER OR CONTRACT IDENTIFIER GOES IN A STRING. `BEM`, `QMT` and the
 *      like name real on-chain things and are interpolated, never translated.
 *
 *   4. PROTOCOL TERMS STAY ENGLISH IN EVERY LOCALE — GENESIS, PoG, the ladder,
 *      the shelf. They are the words the contracts, the docs and every other
 *      venue use; translating them would leave a reader unable to match what
 *      they see here against anything else. A locale may gloss one in
 *      parentheses on first use.
 */

export const EN = {
  /**
   * The lifecycle toast, shared by every write in the app.
   *
   * `{action}` is supplied by the calling surface — see `refund.txAction`.
   *
   * ⚠ ENGLISH STILL PUTS A VERB PHRASE IN THAT SLOT, and it reads badly:
   *   `refund.txAction` is "claim your refund", so `confirming` renders as
   *   "Submitted · confirming claim your refund". English tolerates it; the slot
   *   wants a noun.
   *
   *   It is left alone here because this extraction is not allowed to change a
   *   single English word — that premise is what lets the golden-master
   *   snapshots prove it safe. Fixing the phrasing is a copy change, and belongs
   *   in its own commit where the snapshot moves deliberately.
   *
   *   Other locales must NOT copy the flaw. `zh-CN` puts a noun in the slot,
   *   which is why its `txAction` is not a literal translation of English's.
   */
  tx: {
    signing:    'Awaiting signature — {action}',
    confirming: 'Submitted · confirming {action}',
    confirmed:  'Confirmed — {action}',
  },

  /**
   * The Smart CTA's own verdicts — the button face before any surface's own
   * blockers get a say.
   *
   * ⚠ TIER 0, AND THE HIGHEST-LEVERAGE COPY IN THE APP. Every action card in
   *   every panel renders these first: `connect` and `switch` outrank every
   *   domain blocker by design, so one wrong string here is wrong everywhere at
   *   once, where a wrong string in `refund` is wrong on one panel.
   *
   *   That is also why they were the last thing pinned — both panel golden
   *   masters mock a wallet already connected and on the right chain, because a
   *   domain blocker cannot be rendered otherwise. See the golden master in
   *   `actionGate.test.tsx`.
   *
   * The ambient-gate defaults (`[read_only]` and its reason) are deliberately
   * NOT here. That branch only fires under an `ActionGateProvider` carrying a
   * closed gate, and the only one in the app is `/admin` — an operator console
   * that stays English on purpose.
   */
  gate: {
    connect:       'Connect Wallet',
    connecting:    'Connecting…',
    connectReason: 'No wallet is connected to this session.',

    switchTo:  'Switch to {chain}',
    switching: 'Switching…',

    /*
     * Two arms, because the number the user needs is different in each. Naming
     * the chain they are actually on is the only way they can tell a wallet on
     * the wrong network from a build pointed at the wrong one — reporting the
     * target in both would tell a misconfigured wallet it was already correct.
     */
    switchReasonUnknownChain:
      'This wallet has not reported a chain. Tosh settles on chain {target}; '
      + 'every write is pinned to it and would be rejected from anywhere else.',
    switchReasonWrongChain:
      'This wallet is on chain {current}. Tosh settles on chain {target}; '
      + 'every write is pinned to it and would be rejected from here.',

    /*
     * The BUTTON FACE while a write is in flight, which is not the toast copy in
     * `tx` above. Same moment, two surfaces, and they read differently on
     * purpose: the toast names the action ("Awaiting signature — deposit")
     * because it outlives the panel it came from, and the button does not
     * because it is sitting inside the panel that says so.
     */
    signing:    'Awaiting signature…',
    confirming: 'Confirming…',
  },

  /**
   * The panel that hands a failed round's money back.
   *
   * ⚠ TIER 0. Every string here is read by someone trying to recover funds, and
   *   two of them are the blocker reasons that state WHY the button is not
   *   armed. Swapping those two is the failure the golden-master snapshots in
   *   `moneyBackCopy.golden.test.tsx` exist to catch.
   */
  refund: {
    title: 'Claim refund',

    /*
     * Two failures arrive at this panel and a depositor is owed the one that
     * happened. The subtitle used to state the lapsed-window case as fact
     * because it was the only way in; a raise too small to carry a ladder now
     * refunds the moment genesis closes, so that sentence would be shown up to
     * a week before it became true, about a creator who had not run out of time
     * and in most cases never will.
     */
    reasonTooSmall:
      'This raise finished too small to open a pool, so it closed instead of launching. '
      + 'Take back the full amount, no penalty.',
    reasonLapsed:
      'The 7-day window to open trading lapsed without a launch. '
      + 'Take back the full amount, no penalty.',

    yourDeposit: 'Your deposit',
    cta:         'Claim 100% Refund',

    /** Fills `{action}` in the three `tx` lines above. */
    txAction:    'claim your refund',
    txConfirmed: 'Refund received — 100% returned',

    /*
     * Separate from "nothing to refund", because the two used to share a `?? 0n`
     * and this is the screen where a depositor comes to get their money back.
     * Told "this wallet has nothing deposited" while their own balance was still
     * loading, the reasonable reaction is to leave — and the round has already
     * failed, so the window to act is finite.
     */
    pendingLabel:  'Reading your deposit…',
    pendingReason: 'Fetching this wallet’s balance in the project. The button arms as soon as it lands.',

    noneLabel:  'Nothing to refund',
    noneReason: 'This wallet has nothing deposited in this project, so there is nothing to refund.',
  },
} as const

/**
 * The surfaces a user cannot operate without, by top-level key.
 *
 * `guard:i18n` requires these to be COMPLETE in every locale listed in
 * `TIER0_REQUIRED_LOCALES`, and merely consistent elsewhere. The split exists
 * because six languages times the money copy is a lot of review, and a rule
 * that blocks the build until all six are finished would stop the first one
 * from ever shipping. A locale part-way through falls back to English per key:
 * mixed language is ugly and safe, whereas a missing key rendering as
 * `refund.noneReason` is neither.
 */
export const TIER0_SURFACES = ['tx', 'gate', 'refund'] as const

/** Where a Tier-0 gap fails the build rather than falling back. */
export const TIER0_REQUIRED_LOCALES = ['en', 'zh-CN'] as const
