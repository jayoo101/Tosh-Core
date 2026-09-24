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
   * The header wallet control, on every page.
   *
   * ⚠ NOT THE SAME STRINGS AS `gate.connect`, and reusing them would be a real
   *   change rather than a tidy-up. These are uppercase in the source as well as
   *   in CSS, so the visible result is identical either way — but `textContent`
   *   is not, and the header has a short form the gate has no concept of: the
   *   navbar does not fit at 390px, so the label sheds its second word there.
   *   Both spans are always in the DOM and a media query picks one, which is why
   *   there are two strings rather than an `aria-label` a voice-control user
   *   could not see.
   *
   * ⚠ KEEP THEM THE SAME LENGTH ORDER. `connectShort` must be shorter than
   *   `connect` or the phone case gets wider than the case it exists to escape.
   *   In Chinese both fit, and the pair is kept anyway so the two locales take
   *   the same code path rather than one of them relying on a string that is
   *   never measured.
   */
  nav: {
    connect:      'CONNECT WALLET',
    connectShort: 'CONNECT',
    connecting:   'CONNECTING…',
  },

  /**
   * The deposit form — the widest surface in the app and the one with the most
   * ways to say no.
   *
   * ⚠ THE BLOCKER ORDER IS THE CONTRACT'S, NOT THE SCREEN'S, and the component
   *   carries the argument at length. Two things about it bind a translator:
   *
   *   · A BAN IS NOT AN ALLOWANCE THAT RAN OUT. `eligibility()` collapses a ban,
   *     a missing attestation and a spent window into the same `(false, 0, 0)`,
   *     so the three refusals have to be told apart in words. Rendering any of
   *     them as "you have none left" tells a permanently banned wallet to wait.
   *
   *   · A REFUSAL IS NOT A MISSING FIELD. The list used to lead with "Enter an
   *     amount", shown to wallets whose input had just been disabled for a
   *     reason the button never mentioned. Readers resolved the contradiction by
   *     retrying, the shared Proof-of-Gas scan budget ran out, and the raise
   *     funnel was down for 26 minutes. Each label here has to name the thing
   *     that is actually in the way.
   */
  deposit: {
    title:    'Deposit {quote}',
    subtitle: 'Into this project\'s genesis window. The raise stays open until '
            + 'the clock runs out.',
    cta:      'Deposit {quote}',
    txAction: 'deposit',

    /* ── The field ──────────────────────────────────────────────────────── */
    amountLabel:       'DEPOSIT AMOUNT · {quote}',
    amountPlaceholder: 'e.g. 0.05',

    /*
     * Terse, and only about the number typed. The gate states every blocker in
     * full under the button and the wallet-level states each have a callout
     * above the input, so nothing is repeated here.
     */
    errNotANumber: 'NOT A NUMBER',
    errOverWindow: 'ABOVE YOUR REMAINING WINDOW',
    errOverCap:    'ABOVE THIS PROJECT’S WALLET CAP',
    errOverBalance: 'ABOVE YOUR BALANCE',

    /*
     * ⚠ THE SUBJECT OF THE HINT IS THE WHOLE POINT. "This project allows X per
     *   wallet" is a fact about the project and stays true for a visitor who has
     *   not connected. "X LEFT FOR YOU" is a claim about the reader, and it must
     *   not be made to a wallet the panel is simultaneously refusing — it was,
     *   printed directly under an input disabled for the same reason.
     */
    hintCapOnly:     'THIS PROJECT ALLOWS {cap} {quote} PER WALLET',
    hintCapAndYours: 'THIS PROJECT ALLOWS {cap} {quote} PER WALLET · {left} {quote} LEFT FOR YOU',
    hintOneAndDone:  'ONE DEPOSIT PER WALLET · YOU COMMITTED {committed} {quote} '
                   + 'AND THIS ROUND TAKES NO MORE FROM YOU',

    /* ── Readouts ───────────────────────────────────────────────────────── */
    balanceReadout: '{quote} BALANCE',
    cooldownLabel: 'COOLDOWN',
    cooldownClear: 'CLEAR',
    referredBy:    'REFERRED BY',
    referredHint:  'bound platform-wide on your first deposit · 10% of it credits them',

    /* ── How a ban's expiry is stated. `LIFTS IN {d}` gets the countdown. ── */
    banPermanentStamp: 'PERMANENT · NO EXPIRY',
    banLapsedStamp:    'LAPSED',
    banLiftsInStamp:   'LIFTS IN {d}',

    /* ── Callouts above the field ───────────────────────────────────────── */
    bannerWindowClosed: '→ WINDOW CLOSED · NO FURTHER DEPOSITS ACCEPTED',

    bannerBanned: '→ WALLET BLACKLISTED · {stamp}',
    banBody: 'The factory rejects every *deposit* from this address while the ban '
           + 'stands, whatever quota it holds — so the zero here is a ban, not a '
           + 'spent allowance.',
    banExpires: 'The ban expires on its own at *{when}*, after which the quota is '
              + 'spendable again with nothing to reset.',
    banPermanent: 'Only the protocol owner can clear a permanent ban.',

    bannerScanning:   '→ READING GAS HISTORY',
    bannerQualifies:  '→ GAS HISTORY QUALIFIES',
    bannerBelowFloor: '→ BELOW GAS FLOOR',
    bannerNoPog:      '→ NO POG ATTESTATION ON FILE',

    bodyScanning:  'Connected — looking up this address\'s lifetime gas on {chains}. '
                 + 'No wallet signature is asked for this read.',
    bodyQualifies: 'Eligible for a deposit quota. Activate it once (signature + '
                 + 'on-chain registration), then Deposit works normally — no '
                 + 'separate gas-scan click.',
    bodyBelowFloor: 'Historical gas is {gas} ETH against a floor of {floor} ETH. '
                  + 'Open the breakdown for per-chain figures.',
    bodyNoPog: 'This wallet has never registered Proof-of-Gas, so it holds no quota '
             + 'to spend. The gas lookup starts automatically when you connect.',

    /* ── Blockers, in the factory's own revert order ────────────────────── */
    windowClosedLabel:  'Funding closed',
    windowClosedReason: 'The genesis window has closed, and no further deposits '
                      + 'are accepted.',

    bannedLabel:  'Wallet blocked',
    bannedReason: 'Deposits from this address are rejected while the ban stands · {stamp}.',

    /*
     * One blocker, six faces. It is the same fact — no attestation — moving
     * through a scan, a signature and two dead ends, and each face has to say
     * which one the reader is looking at: a failed lookup is worth another
     * click, a gas history below the floor is not, and offering "try again" for
     * the second is what rebuilt the retry loop that took the funnel down.
     */
    pogScanningLabel:    'Reading gas history…',
    pogRegisteringLabel: 'Activating quota…',
    pogActivateLabel:    'Activate deposit quota',
    pogRetryLabel:       'Retry gas check',
    pogBelowFloorLabel:  'Below gas floor',
    pogCheckLabel:       'Check gas history',

    pogScanningReason:    'Reading lifetime gas across every supported chain. No '
                        + 'signature required for this step.',
    pogRegisteringReason: 'Writing the deposit quota on-chain.',
    pogActivateReason:    'Gas history qualifies. Click to sign once and register '
                        + 'the quota; Deposit unlocks after that lands.',
    /* Fallback only — a failed lookup usually carries its own server message. */
    pogRetryReason:       'The gas lookup failed. Click to try again.',
    pogBelowFloorReason:  'This wallet’s historical gas is below the floor of {floor} '
                        + 'ETH, so no deposit quota can be sized.',
    pogCheckReason:       'Proof-of-Gas sizes your deposit quota from lifetime gas '
                        + 'spend. Click to read it — one request, no signature and '
                        + 'no gas.',

    /*
     * ⚠ TWO DIFFERENT FACTS WEAR THE SAME COUNTDOWN. While the cooldown ends
     *   before the genesis window does it is a wait, and stating the remaining
     *   time tells the reader what to do. Once it ends at or after the deadline
     *   nothing the reader can do will clear it in time, and a countdown there
     *   reads as an invitation to come back — the one thing that will not work.
     */
    cooldownLabelWaiting: 'Cooldown · {left}',
    cooldownReasonWaiting: 'Deposits from this wallet to this project are on '
                         + 'cooldown for another {left}.',
    alreadyDepositedLabel:  'Already deposited',
    alreadyDepositedReason: 'This project takes one deposit per wallet, and yours '
                          + 'has landed · {committed} {quote} committed. The cooldown '
                          + 'outlasts the genesis window, so there is no second '
                          + 'deposit to wait for.',

    amountInvalidLabel:  'Check the amount',
    amountInvalidReason: 'That is not a number this field can send as {quote}.',
    amountZeroLabel:     'Enter an amount',
    amountZeroReason:    'Enter the amount of {quote} to deposit.',

    quotaPendingLabel:  'Reading your allowance…',
    quotaPendingReason: 'Waiting on this wallet’s attestation and deposit window '
                      + 'from the factory.',

    quotaExceededLabel:  'Over your limit',
    quotaExceededReason: 'That is more than this wallet may deposit in the current '
                       + 'window · {left} {quote} left.',

    walletCapLabel:  'Over the wallet cap · {left} {quote} left',
    walletCapReason: 'That is more than this project allows one wallet to hold · '
                   + '{left} {quote} left for you.',

    notEnoughLabel:  'Not enough {quote}',
    notEnoughReason: 'This wallet does not hold that much {quote}.',

    approvingLabel: 'Approving…',
    approveLabel:   'Approve {amount} {quote}',
    approveReason:  '{quote} is pulled rather than sent, so the factory needs your '
                  + 'permission for this exact amount before it can take it. '
                  + 'Approving authorises only this deposit — change the amount and '
                  + 'it has to be approved again.',
  },

  /**
   * The Proof-of-Gas quota ledger under the deposit form.
   *
   * ⚠ THE THREE "UNREADABLE" LINES ARE NOT A SOFTER VERSION OF "WITHIN YOUR
   *   LIMIT", and the component's own header explains what happened when they
   *   were: a cooldown, a ban and a missing attestation all short-circuit
   *   `eligibility()` to zero, every figure rendered as an em-dash, and the
   *   footer printed the panel's most reassuring sentence underneath them. A
   *   permanently ineligible wallet was told it was one keystroke from
   *   depositing. "I cannot read this" and "you are fine" must not converge in
   *   any language.
   */
  ledger: {
    /* `[H-01]` is a diagnostic id shared with the docs; only the words move. */
    heading: '// [H-01] QUOTA LEDGER',

    quotaPerWindow: 'POG QUOTA · PER WINDOW',
    spentThisWindow: 'SPENT THIS WINDOW',
    remaining: 'REMAINING',
    projected: 'PROJECTED (THIS TX)',

    /* The status chip, top right. One of four, and three of them are refusals. */
    statusConsumed:   '{pct}% CONSUMED',
    statusCooldown:   'WINDOW UNREADABLE',
    statusBanned:     'BLACKLISTED',
    statusUnattested: 'NO ATTESTATION',

    /* The footer verdict. Each refusal names the fact standing in for the
     * figures, so the dashes above have an explanation under them. */
    within:   '→ WITHIN YOUR LIMIT',
    over:     '→ OVER YOUR LIMIT FOR THIS WINDOW',
    staleCooldown:   '→ NOT READABLE UNTIL THE COOLDOWN CLEARS',
    staleBanned:     '→ THE BAN DECIDES THIS · THE LIMIT IS NOT WHAT STOPS YOU',
    staleUnattested: '→ NO QUOTA REGISTERED · THERE IS NO LIMIT TO MEASURE YET',
  },

  /** Genesis is closed, the creator has not opened the pool, the clock is on. */
  awaitingLaunch: {
    title:    'Launch the pool',
    subtitle: 'Opening seeds the Infinity pool, locks the genesis liquidity in '
            + 'place, and starts the shelf ladder. It cannot be undone.',

    raised:          'Raised',
    status:          'Status',
    statusValue:     'Time up · launchable',
    windowRemaining: 'Window remaining',

    /* The creator's half: a button, and the argument for pressing it. */
    creatorBody: 'You created {symbol}. Triggering launch pairs the raised {quote} '
               + 'with the genesis LP allocation and starts the ladder. Depositors '
               + 'can claim their pro-rata share the moment it confirms.',
    /* `launch()` is the contract function, and stays spelled that way. */
    creatorDeadline: '{countdown} left. After that, launch() dies permanently and '
                   + 'every depositor reclaims 100% of their {quote}.',
    cta:      'Trigger Launch',
    txAction: 'open the pool',
    txConfirmed: 'Pool open — the ladder is live',

    /*
     * Everyone else gets the same wait with none of the agency, so the copy has
     * to carry the reassurance the button would otherwise carry: nothing here
     * can strand the deposit.
     */
    waitingTitle: 'Waiting on the creator',
    waitingBody:  'The genesis window has closed. If the pool is not opened within '
                + '{countdown}, the refund terminal unlocks automatically and '
                + 'returns 100% of your deposit. Your {quote} is not at risk.',

    /* Strictly later than the deadline, matching the hook — see the component. */
    expiredLabel:  'Launch window closed',
    expiredReason: 'The window to open trading has closed, so the only thing this '
                 + 'project can still do is issue refunds.',
  },

  /** Collecting a genesis allocation after the pool opens. */
  claim: {
    title:    'Genesis allocation · {symbol}',
    subtitle: 'Your share of the genesis supply, in proportion to what you '
            + 'deposited. One claim per wallet.',

    yourDeposit: 'Your genesis deposit',
    cta:         'Claim {symbol}',
    /** Lower case: the toast reads "Confirmed — claim QMT". */
    txAction:    'claim {symbol}',

    /*
     * Two separate reads, two separate waits, and they are not interchangeable:
     * one is "how big is your share", the other is "have you already taken it".
     * Both hold the button rather than letting it offer a transaction that the
     * contract would reject.
     */
    depositPendingLabel:  'Reading your deposit…',
    depositPendingReason: 'Fetching this wallet’s genesis deposit, which is what '
                        + 'the allocation is proportional to.',

    claimedUnknownLabel:  'Checking your claim…',
    claimedUnknownReason: 'Reading whether this wallet has already claimed. There '
                        + 'is one claim per wallet, so the button waits for the '
                        + 'answer rather than offering a transaction that would fail.',
  },

  /**
   * What the deposit form becomes for a wallet the Proof-of-Gas floor refused.
   *
   * ⚠ EVERY SENTENCE HERE IS LOAD-BEARING, and the file it lives in says why at
   *   length: the screen this replaced showed a disabled form saying the only
   *   missing thing was a number, readers did the reasonable thing and retried,
   *   the shared scan budget ran out, and the raise funnel was down for 26
   *   minutes. The copy's whole job is to say "this is not a wait" clearly
   *   enough that nobody tries again. A translation that softens that into
   *   "temporarily unavailable" rebuilds the outage in another language.
   */
  ineligible: {
    title:    'This wallet cannot deposit',
    subtitle: 'Proof-of-Gas sizes every deposit quota from gas already spent '
            + 'on-chain. This address has not spent enough for a quota to exist.',

    banner: '→ BELOW THE GAS FLOOR',
    /* Row labels for the two figures and the multiple between them. */
    thisWallet: 'THIS WALLET',
    floor:      'FLOOR',
    shortBy:    'SHORT BY',

    /* `*already spent*` is emphasised in place — see `Emphasis.tsx`. */
    notAWait: 'This is not a queue and not a cooldown — there is nothing here to '
            + 'wait for. The floor is measured against gas this address has '
            + '*already spent*, across {chains}, so it only moves as that history grows.',

    whatWouldWork: '// WHAT WOULD WORK',
    switchWallet:  'Connect an address you have actually used — a main wallet with '
                 + 'a real transaction history will usually clear the floor on its '
                 + 'own. Switching wallets re-reads the history automatically; '
                 + 'there is nothing to press here.',
    fundingWontHelp: 'A fresh address cannot be made eligible by funding it with '
                   + '{symbol}. The quota comes from gas spent, which is the whole '
                   + 'point of the mechanism.',

    breakdown: 'View per-chain breakdown',
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

  /**
   * The dialog that fires the instant a deposit confirms.
   *
   * ⚠ `title` OPENS WITH A LITERAL DOLLAR SIGN, and it is not a typo or a stray
   *   template literal. The JSX reads `You are in ${symbol}`, where `$` is text
   *   and `{symbol}` is the expression — so it renders "You are in $QMT", the
   *   ticker with the sigil every other surface gives it. A locale that drops the
   *   `$` is losing the sigil, not a currency.
   *
   * ⚠ `{pct}` APPEARS TWICE IN `body` ON PURPOSE. `fill()` replaces every
   *   occurrence, and both slots are the same project commission — the sentence
   *   names it, then names it again as what the reader now earns. Splitting them
   *   into `{pct1}`/`{pct2}` would invite a translator to think they can differ.
   *
   * `linkBoxLabel` and `copy` are `ReferralLinkBox`'s defaults, which this dialog
   * does not pass. They are on screen inside it, so they are translated from
   * here rather than left as the one English run in a Chinese dialog.
   */
  success: {
    dialogLabel: 'Deposit confirmed',
    close:       'Close',

    title:  'You are in ${symbol}',
    staked: '{amount} {quote} staked in this genesis',

    /*
     * Why the dialog exists at all: `canBindProjectReferral` requires the
     * referrer to already hold a deposit here, so this transaction is the moment
     * the reader's own link started paying the project leg. Said as one sentence
     * because the two halves are cause and effect, and a translator handed them
     * separately cannot keep that relationship.
     */
    body: 'Your referral link just became worth more: the {pct}% project '
        + 'commission only binds to a referrer who already holds a deposit here, '
        + 'and you now do. Share it and you earn {pct}% of every genesis deposit '
        + 'made through it on {symbol}, plus {lifetime}% for life on any wallet '
        + 'whose first Tosh link was yours.',

    linkBoxLabel: 'YOUR REFERRAL LINK',
    copy:         'copy',

    /*
     * ⚠ THE `[…]` RUN IS A LINK, rendered by `Linked`. The anchor sits mid-
     *   sentence in English and Chinese puts it elsewhere, so its position
     *   belongs to the translator for the same reason `Emph`'s stars do — see
     *   `Emphasis.tsx` for the argument. The brackets must survive translation
     *   and `guard:i18n` fails the build when they do not.
     */
    footer: 'Commission accrues as deposits arrive and unlocks when the project '
          + 'launches. Claim it from the referral desk further down this page, or '
          + 'from [your referral ledger] for every project at once. Nothing expires.',
  },

  /**
   * The navbar links and the footer, on every page but `/admin`.
   *
   * ⚠ `navDirectory` IS THE PHONE FORM OF `navDirectoryFull`, not a synonym.
   *   Below `sm` the bar does not fit at 390px and the directory link sheds a
   *   word; both are always in the DOM and a media query picks one. A locale
   *   whose full form is already short may make the two identical, but the short
   *   one must never be the longer of the pair.
   *
   * `navLaunch` and `navReferrals` have no short form because they were never
   * the ones that overflowed.
   *
   * GitHub, X and "Tosh Protocol" are names, not copy, and stay in the JSX.
   */
  site: {
    navDirectory:     'Directory',
    navDirectoryFull: 'Agent Directory',
    navLaunch:        'Launch',
    navReferrals:     'Referrals',
    footerSecurity:   'Security',
  },

  /**
   * `/projects` and the cards it shares with the home page.
   *
   * ⚠ THE PHASE BLURBS MAKE CLAIMS THE CONTRACTS HAVE TO BACK, and each one was
   *   rewritten away from a mock that described something false. `launching` is
   *   "waiting on creator" because nothing deploys on its own — `launch()` is
   *   creator-only. `archived` names the refund and not an expired window,
   *   because a raise too small to open a pool is archived at genesis close with
   *   most of the window unspent. A translation must keep each claim, not
   *   smooth it back toward the mock.
   *
   * ⚠ ONE / MANY ARE SEPARATE STRINGS rather than a suffix bolted onto one,
   *   because a language without plural inflection needs to write the same
   *   thing twice and a language with more than two forms needs to be able to
   *   say so. The count itself is a styled span in front of `results*`, which is
   *   why those four strings start after the number.
   *
   * `nothingMatches` carries the reader's own query in `*{query}*`, rendered by
   * `Emph` with the query passed as `vars` so a typed `*` cannot re-cut it.
   */
  directory: {
    title: 'Agent Directory',
    lede:  'Every agent token on Tosh Protocol — from open funding windows to '
         + 'shelf-ladder trading, all settled on {chain}.',

    searchPlaceholder: 'Search…',
    searchLabel:       'Search launches by name, ticker or address',

    phaseHeading:        'Phase',
    phaseAll:            'All launches',
    phaseAllBlurb:       'Every agent on the protocol',
    phaseLive:           'Funding',
    phaseLiveBlurb:      'Proof-of-Gas {quote} deposits open',
    phaseLaunching:      'Awaiting launch',
    phaseLaunchingBlurb: 'Window closed · waiting on creator',
    phaseCompleted:      'Trading',
    phaseCompletedBlurb: 'Live on the 4,000-shelf ladder',
    phaseArchived:       'Archived',
    phaseArchivedBlurb:  'Refunds open · full deposit reclaimable',

    factoryCountOne:  '{n} launch on the factory · {chain}',
    factoryCountMany: '{n} launches on the factory · {chain}',

    resultsOne:          'launch',
    resultsMany:         'launches',
    resultsOneFiltered:  'launch shown',
    resultsManyFiltered: 'launches shown',

    sortNewest:  'Newest',
    sortRaised:  'Most raised',
    sortClosing: 'Closing soon',
    sortOldest:  'Oldest',

    nothingMatches:  'Nothing matches *{query}*',
    emptyTitle:      'No launches yet',
    emptyPhaseTitle: 'No launches in this phase',
    emptyBody:       'The first one appears here the moment its factory event lands.',
    emptyPhaseBody:  'Try a different phase or search term.',
    clearFilters:    'Clear filters',

    clockNote:   'Countdowns update every second; phases re-bucket every ten.',
    launchCta:   'Launch an agent →',

    // The card's phase pill. Uppercase in the source because the pill is.
    pillLive:      'FUNDING',
    pillLaunching: 'AWAITING LAUNCH',
    pillCompleted: 'TRADING',
    pillArchived:  'ARCHIVED',

    noDescription: 'No description provided.',

    /*
     * The grid card's two-unit countdown. Units are copy — `d`/`h`/`m` are
     * English abbreviations — so the shape of the whole reading belongs here.
     */
    endsIn:       'ends in {left}',
    closed:       'closed',
    durationDays: '{d}d {h}h',
    durationHours: '{h}h {m}m',

    raised:          'Raised',
    raisedAtGenesis: 'Raised at genesis',
    noPriceFeed:     'no price feed',
    waitingOnCreator: 'Waiting on creator',
    refundsOpen:     'Refunds open · full deposit reclaimable',
    viewAgent:       'View agent →',

    // The feature card writes these lowercase and lets CSS uppercase them; the
    // ticker is `*{quote}*` so it can be exempted from that — `mBEM` is not `MBEM`.
    featureWaiting: 'waiting on creator',
    featureRaised:  'raised at genesis *{quote}*',
  },

  /**
   * The landing page: hero, on-chain feed, teaser, and the five-step explainer.
   */
  home: {
    settlesOn: 'Settles on {chain}',

    // `|` is a line break at `sm` and up, where the headline is set in three
    // hard lines; below `sm` the browser wraps it. `*…*` is the gradient run.
    // Both are the translator's to place: the break points and which phrase
    // carries the gradient depend on word order.
    headline: 'Fair-launch|terminal for|*agent tokens.*',
    lede: 'Fund a launch in {quote} through a window your gas history unlocks, then trade it on a 4,000-shelf price ladder. Every launch deploys its own PancakeSwap Infinity pool.',
    ctaLaunch:    'Launch a token',
    ctaDirectory: 'Agent directory',

    feedTitle: 'On-chain feed',
    feedLive:  'factory events',
    feedEmpty: 'No launches yet. The first one appears here the moment its factory event lands.',

    // Shorter than the card pills on purpose: a feed row also has to fit a
    // sigil, a ticker, a name and a figure.
    badgeLive:      'FUNDING',
    badgeLaunching: 'AWAITING',
    badgeCompleted: 'TRADING',
    badgeArchived:  'REFUND',

    // What the figure beside it is. Facts about the clock, never about a cap:
    // nothing on chain has one to meet.
    subLive:      'in progress',
    subLaunching: 'window closed',
    subCompleted: 'at genesis',
    subArchived:  'refundable',

    teaserKicker:     'Trending now',
    teaserTitle:      'Active markets',
    viewAll:          'View all',
    teaserEmptyTitle: 'Nothing is trading or raising yet',
    teaserEmptyBody:  'The first launch appears here the moment its factory event lands. Until then, {chain} has nothing open.',
    teaserEmptyCta:   'Open the first launch',

    howKicker: '// How it works',
    howTitle:  'How a Tosh launch works.',
    howLede:   'Five steps, all settled on chain. Nothing here is enforced by this interface — the contract is the source of truth.',

    step1Tag:   'Quota',
    step1Title: 'Gas history sets your limit',
    step1Body:  'Tosh reads how much gas your wallet has genuinely burned and signs that into a deposit ceiling. A wallet minted this morning has no history to spend, so bot swarms have nothing to bring.',

    // The launch fee is paid in the chain's native coin (NATIVE_SYMBOL), not
    // the quote asset. `{native}` is filled with NATIVE_SYMBOL only; step 3
    // beside it is the one that takes `{quote}`.
    step2Tag:   'Launch',
    step2Title: 'Anyone can open one',
    step2Body:  'Pay the launch fee in {native} and the token deploys together with its own PancakeSwap Infinity pool. No pre-mine, no team allocation, no supply held back for insiders.',

    step3Tag:   'Genesis',
    step3Title: 'A window that cannot close early',
    step3Body:  'Deposits run in {quote} for 3, 24 or 72 hours — the creator chooses once, at launch, and cannot shorten it afterwards. Every depositor takes back the full amount if the raise closes too small to open a pool, or if the creator never calls launch() inside the 7-day window after that.',

    step4Tag:   'Ladder',
    step4Title: 'Price climbs one shelf at a time',
    step4Body:  'After genesis the remaining supply is released across 4,000 fixed shelves spanning 2,000x from the opening price. A ceiling blocks spikes, and 99% of what the shelves earn goes to the project itself.',

    step5Tag:   'Hardened',
    step5Title: 'The contract enforces it, not this page',
    step5Body:  'Deposit accounting, the per-wallet deposit ceiling and the dust-deposit floor all live in the contract. This interface only mirrors them, so it cannot loosen them.',
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
export const TIER0_SURFACES = [
  'tx', 'gate', 'nav', 'deposit', 'refund', 'claim', 'ineligible', 'ledger',
  'awaitingLaunch', 'success',
] as const

/** Where a Tier-0 gap fails the build rather than falling back. */
export const TIER0_REQUIRED_LOCALES = ['en', 'zh-CN'] as const
