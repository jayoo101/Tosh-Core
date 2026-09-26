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
   * The wallet picker every Connect button opens.
   *
   * Wallet names are not here — they are brand names and come from the
   * connector or the wallet's own EIP-6963 announcement. Each `binance*` hint
   * describes what pressing the row will actually do on this device, so it
   * changes with it: connect, reopen in the app, show a QR code, or download.
   */
  wallet: {
    title: 'Connect a wallet',
    close: 'Close',

    binanceDetected: 'Detected in this browser',
    binanceOpenApp:  'Opens this page in the Binance app',
    binanceScan:     'Scan a QR code with the Binance app',
    binanceInstall:  'Get the Binance app',

    detected:          'Detected',
    browserWallet:     'Browser wallet',
    browserWalletHint: 'MetaMask, Rabby, OKX and other extensions',
    walletConnectHint: 'Scan a QR code with any mobile wallet',

    footer: 'Tosh settles on {chain}. A wallet on another network is asked to switch once it connects.',
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

  /**
   * The project page's rails: the four-figure header strip and the lifecycle
   * tracker. Neither takes money; both are read before anything that does.
   */
  project: {
    // One set for the header pill and the strip's badge, so they cannot disagree.
    badgeGenesis:  'Genesis',
    badgeAwaiting: 'Awaiting launch',
    badgeLadder:   'Ladder',
    badgeRefund:   'Refund open',

    priceLabel:      'Price',
    priceHintShelf:  'active shelf',
    priceHintP0:     'genesis P₀',
    priceHintClosed: 'opens at launch',
    phaseLabel:      'Phase',
    ladderLabel:     'Ladder',

    // "Raised at genesis" once refunds open: the figure is a peak, not a balance.
    raised:          'Raised',
    raisedAtGenesis: 'Raised at genesis',

    // `undefined` (still reading) and zero (all paid out) are different
    // verdicts and must never share a string.
    outstandingReading: '→ reading what is left…',
    outstandingNone:    '→ every refund paid out · nothing left here',
    outstandingSome:    '→ {amount} {quote} still waiting to be claimed',
    windowCaption:      '{quote} · {hours}h window',
    windowLeft:         '{clock} left',
    windowClosed:       'window closed',

    stakeLabel: 'Your stake',
    // Zero means refunded, never deposited, or still reading, so the zero
    // line claims no history.
    stakeClaimable: 'claimable in full',
    stakeNone:      'nothing to claim here',
    stakeBonding:   'genesis allocation unlocked at launch',
    stakeGenesis:   'in this raise',

    lifecycleTitle:   'Launch lifecycle',
    stepFunding:      'Funding',
    stepFundingBody:  'Proof-of-Gas gated {quote} deposits',
    // Not "deploying": `launch()` is creator-only and may never be called.
    stepAwaiting:     'Awaiting launch',
    stepAwaitingBody: 'Window closed · waiting on the creator',
    stepTrading:      'Trading',
    stepTradingBody:  '4,000-shelf ladder live on Infinity',
    stepCurrent:      'current',
    archivedBanner:   'Refundable in full — the creator did not open the pool inside the launch window. No penalty, no haircut.',

    // The identity header above the terminal.
    backToAll:     'All projects',
    tokenLabel:    'token',
    creatorLabel:  'by',
    socialX:       'X / Twitter',
    socialTg:      'Telegram',
    socialWeb:     'Website',
    headerPriceUnit: '{quote} · active shelf',
    shelfPosition: 'shelf #{n} / {total}',
    about:         'About',
  },

  /**
   * The shelf ladder and the buy form. A money path: each blocker's label and
   * reason are a pair, listed here in the hook's revert order.
   */
  bonding: {
    // The noun phrase the transaction toasts slot into `tx.*`.
    buyAction:    'buy {symbol}',
    haltPending:  'PENDING RESUME',

    amountInvalidLabel:  'Check the amount',
    amountInvalidReason: 'That is not a number this field can send as a token amount.',
    amountZeroLabel:     'Enter an amount',
    amountZeroReason:    'Enter how many {symbol} to buy.',
    // `{time}` is either a countdown (01:02:05) or `haltPending`.
    haltedLabel:         'Paused · resumes {time}',
    haltedReasonGlobal:  'Shelf minting is suspended by the protocol circuit breaker platform-wide — it lifts on its own in {time}, and the pool keeps trading meanwhile.',
    haltedReasonHook:    'Shelf minting is suspended by the protocol circuit breaker for this project — it lifts on its own in {time}, and the pool keeps trading meanwhile.',
    sameBlockLabel:      'Paused for this block',
    sameBlockReason:     'A swap landed in this block, and the contract will not sell from the shelves alongside one. It reopens on the next block.',
    exceedsLabel:        'Amount too large',
    exceedsReason:       'A single purchase can take at most {max} right now — send the rest as a second transaction.',
    awaitingLabel:       'Waiting for the market',
    awaitingReason:      'The first shelf sits 5% above the pool by design, so it opens only once the market price reaches it.',
    lockedLabel:         'Above the price ceiling',
    lockedReason:        'The next shelf is more than 5% above the current pool price, so it stays shut until the market catches up.',
    noCapacityLabel:     'No supply available',
    noCapacityReason:    'No shelf can serve any amount right now — the ladder is either sold out or priced out at the margin.',
    quotePendingLabel:   'Checking the price…',
    quotePendingReason:  'Working out what {symbol} costs at the current shelf. The button arms as soon as the price comes back.',
    quoteUnavailableLabel:  'Price unavailable',
    quoteUnavailableReason: 'No price came back for that amount, so there is nothing to attach to the transaction. This is usually a network hiccup — it retries every few seconds.',
    dustLabel:           'Amount too small',
    dustReason:          'That amount costs less than the smallest unit of {quote} the shelf can charge for. Raise it until the order is worth at least 0.00000001 {quote}.',
    balanceLabel:        'Not enough {quote}',
    balanceReason:       'This wallet does not hold the quoted cost plus its slippage headroom — {amount} {quote} in total.',
    approvingLabel:      'Approving…',
    approveLabel:        'Approve {amount} {quote}',
    // A pull, not a payment: the headroom is allowance, never charged.
    approveReason:       'The shelf pulls {quote} from your wallet rather than being sent it, so it needs permission for up to {amount} {quote} — the quoted cost plus slippage headroom. It only ever takes the real cost; the difference stays yours.',

    // Terse tags on the amount field; the button carries the full sentence.
    errNotNumber: 'NOT A NUMBER',
    errTooBig:    'TOO BIG FOR ONE ORDER',
    errDust:      'COSTS LESS THAN A UNIT',
    errBalance:   'ABOVE YOUR BALANCE',
    hintSameBlock: 'THE LADDER IS SHUT FOR THIS BLOCK — IT REOPENS ON THE NEXT ONE',
    hintAwaiting:  'THE LADDER OPENS ONCE THE MARKET REACHES THE FIRST SHELF',
    hintMax:       'UP TO {max} IN ONE ORDER · SWEEPS SHELVES',

    ladderTitle:     'SHELF LADDER · {symbol}',
    ladderSubtitle:  'Every buy lands on the live shelf. Cleared shelves stay filled below; queued shelves open once the live one clears.',
    suspendedGlobal: '→ LADDER SUSPENDED · PLATFORM-WIDE · LIFTS IN {time}',
    suspendedHook:   '→ LADDER SUSPENDED · THIS PROJECT · LIFTS IN {time}',
    suspendedBody:   'The protocol owner has tripped the circuit breaker, so the contract turns away every shelf purchase until it expires. The pool itself is untouched — the token still trades on PancakeSwap, existing balances are unaffected, and the halt lapses on its own without any further action.',

    // `$` is the ticker sigil, not a currency sign.
    buyTitle:          'Buy ${symbol}',
    buyEyebrow:        'shelf ladder',
    amountLabel:       'AMOUNT TO BUY',
    amountPlaceholder: 'e.g. 1000',
    quotedCost:        'QUOTED COST',
    unavailable:       'Unavailable',
    mostYouPay:        'MOST YOU CAN PAY',
    mostYouPayHint:    '0.5% over the quote; you are only charged the true cost',
    orderSize:         'ORDER SIZE',
    belowMinimum:      'Below minimum',
    accepted:          'Accepted',
    orderSizeHint:     'Raise the amount until it costs at least 0.00000001 {quote}',
    buyFooter:         'One order sweeps as many shelves as it needs, and a 105% ceiling stops it clearing far above the market price.',

    gateHalted:    'LADDER HALTED · BREAKER',
    gateSameBlock: '105% GATE · SAME-BLOCK LOCK',
    gateAwaiting:  '105% GATE · AWAITING MARKET',
    gateOpen:      '105% GATE · OPEN',
    gateLocked:    '105% GATE · LOCKED',
    shelfPrice:    'SHELF PRICE',
    perToken:      'per whole token',
    remaining:     'REMAINING',
    tokensOnRung:  'tokens on this rung',
    ceiling:       '105% CEILING',
    ceilingTracks: 'tracks the pool and its average',
    ceilingHeld:   'held at the opening price',
    fillLabel:     'SHELF #{n} FILL',
    rowLive:       'LIVE',
    rowCleared:    'CLEARED',
    rowQueued:     'QUEUED',
    // `*…*` is the figure, set brighter than its label.
    footOpening:  'opening = *{price} {quote}*',
    footNow:      'now = *{price}*',
    footAverage:  'average = *{price}*',
    // A zero average is "no full window yet", not a price of zero.
    footAverageSettling: 'average = *SETTLING · {window} WINDOW · CEILING HELD AT OPENING*',
  },

  /**
   * The liquidity panel: five signatures in a fixed order, then a deposit.
   *
   * ⚠ THE STEP NUMBERS ARE THE PANEL'S TRAVERSAL, NOT A LIST. `revertOrder`
   *   names the last active blocker, so the token's two approvals come up
   *   first and the quote's two after — which is why the quote steps carry 3
   *   and 4. A translation must keep each number on the step it is on now.
   *
   * ⚠ `action` STILL SAYS "Step 3 of 3", and it is step 5 of 5. It predates the
   *   quote leg becoming an ERC-20, and is left alone here because this
   *   extraction may not change an English word. Other locales must not copy
   *   it; `zh-CN` numbers it correctly.
   */
  liquidity: {
    txAction:     'liquidity',
    connectFirst: 'Connect a wallet first',

    title:            'YOUR LIQUIDITY · {symbol}/{quote}',
    subtitle:         'Infinity PositionManager · full range · 0.30% pool fee accrues to LPs',
    poolDepth:        'POOL DEPTH · {asset}',
    poolDepthHint:    'all LPs incl. genesis',
    myPosition:       'MY POSITION · {asset}',
    positionsOne:     '{n} position',
    positionsMany:    '{n} positions',
    withdrawableHint: 'withdrawable any time',

    depositLabel:       '{quote} TO DEPOSIT',
    depositPlaceholder: 'e.g. 5',
    hintPairs:          'PAIRS WITH {amount} {symbol} AT THE CURRENT PRICE',
    hintIdle:           'FULL RANGE · BOTH LEGS REQUIRED · WITHDRAW ANY TIME',
    errNotNumber:       'NOT A NUMBER',
    errAboveBalance:    'ABOVE YOUR {quote} BALANCE',
    errNeedsMore:       'NEEDS MORE {symbol}',

    slippage:      'Slippage',
    slippageGroup: 'LP slippage tolerance',

    stepToPermit2:   '{asset} →P2',
    stepFromPermit2: 'P2 →{asset}',
    stepDeposit:     'Deposit',

    action: 'Step 3 of 3 — deposit into the pool',

    clockLabel:     'Syncing the clock…',
    clockReason:    'Every signature below carries a deadline derived from the wall clock. Until it syncs, that deadline would land in 1970 and Permit2 would reject the position.',
    tokenLabel:     'Loading the token…',
    tokenReason:    'Still reading this project’s token address.',
    invalidLabel:   'Check the amount',
    invalidReason:  'That is not a number this field can send as {quote}.',
    zeroLabel:      'Enter an amount',
    zeroReason:     'Enter the amount of {quote} to put into the pool.',
    priceLabel:     'Pool price unavailable',
    priceReason:    'The pool price has not come back yet, and a full-range position cannot be sized without it.',
    bitmapLabel:    'Reading the pool key…',
    bitmapReason:   'The hook’s permission bitmap has not come back yet, and a PoolKey cannot be encoded without it.',
    readsLabel:     'Reading your wallet…',
    readsReason:    'Still reading this wallet’s {symbol} balance and Permit2 allowances. The next step depends on both, so it is named once they land rather than guessed now.',
    quoteLowLabel:  'Not enough {quote}',
    quoteLowReason: 'This wallet does not hold the deposit plus its {pct}% headroom.',
    tokenLowLabel:  'Not enough {symbol}',
    tokenLowReason: 'A full-range position funds both legs — this one needs {needed} {symbol} and the wallet holds {held}.',
    dustLabel:      'Amount too small',
    dustReason:     'That deposit is too small to add any liquidity at the current price. Raise it.',

    step1Label:  'Step 1 of 5 — approve {symbol} for Permit2',
    step1Reason: 'Permit2 needs a one-time allowance on {symbol} before it can move the token leg of the position.',
    step2Label:  'Step 2 of 5 — let Permit2 spend your {symbol}',
    step2Reason: 'Permit2 holds the {symbol} allowance but has not been told the position manager may draw on it.',
    step3Label:  'Step 3 of 5 — approve {quote} for Permit2',
    step3Reason: 'The other leg is {quote} now rather than the chain\'s own coin, so it is pulled like the token instead of being sent with the transaction. Permit2 needs its own one-time allowance on it.',
    step4Label:  'Step 4 of 5 — let Permit2 spend your {quote}',
    step4Reason: 'Same as step 2, for the {quote} leg: Permit2 grants the position manager a spending window per token, and this one has either expired or was never opened.',

    openPositions: 'OPEN POSITIONS',
    withdraw:      'Withdraw',
    degraded:      'This RPC would not serve position logs, so only positions minted from this browser are listed. Your other positions are safe on-chain and remain withdrawable through any PancakeSwap Infinity interface.',
    coverage:      'Position discovery scans the last {window} of transfers. Anything older, minted from another browser, is not listed here — it remains yours on-chain and withdrawable through any PancakeSwap Infinity interface.',
    coverageHours: '{n} hours',
    coverageDays:  '{n} days',
  },

  /**
   * The gas lookup: the dialog `PogLookupProvider` mounts on every page, and
   * the toasts and `error` that `usePogFlow` raises around it.
   *
   * `listSeries` and `listLast` join chain names wherever a sentence lists them,
   * including `deposit.bodyScanning` and `ineligible.notAWait`: every pair but
   * the last is joined by `listSeries`, the last by `listLast`. English puts no
   * comma before the last name. `listEvery` joins the chains a scan could not
   * read, which English has always run together with "and".
   *
   * The attestation-signer mismatch is deliberately not here. It is a
   * deployment fault quoting two addresses, read by whoever runs the site.
   */
  gas: {
    txAction:          'register Proof-of-Gas',
    connectFirst:      'Connect a wallet first',
    unsupportedChain:  'Unsupported chain (got {chain})',
    noChain:           'none',
    notEligible:       'This wallet is not eligible for a deposit quota yet.',
    quotaToast:        'Quota sized · {amount} {quote}',
    lowerBoundMissing: '{chains} could not be read; this total is a lower bound.',
    lowerBoundPaged:   'Some history was too large to page through; this is a lower bound.',
    listSeries:        '{a}, {b}',
    listLast:          '{a} and {b}',
    listEvery:         '{a} and {b}',

    title:           'Gas history',
    close:           'Close',
    noteUnavailable: 'unavailable',
    noteSkipped:     'skipped (cap reached)',
    noteLowerBound:  'lower bound',
    txCount:         '{n} tx',
    scanning:        'Reading lifetime gas on {chains}. This takes a few seconds and does not ask for a signature.',
    failed:          'The gas lookup failed.',
    retry:           'Retry',
    intro:           'Lifetime gas spent sending transactions, read from public explorers. No wallet signature was required for this lookup.',
    total:           'Total',
    floor:           'Floor',
    quotaSized:      'Quota sized',
    unitsNote:       'Gas is measured in ETH because the scanned chains are ETH-settled; the quota is in {quote} because that is what you deposit.',
    missing:         '{chains} could not be read, so this total may be a lower bound.',
    activateBody:    'Eligible. Activating writes the quota on-chain (one signature and one transaction). After that, Deposit works with no further gas check.',
    activate:        'Activate deposit quota',
    activating:      'Activating quota…',
    onFile:          'Eligible — deposit quota is already on file for this wallet.',
    belowFloor:      'Below the floor — {total} ETH of historical gas against a floor of {floor} ETH. Deposits stay locked for this wallet until that changes.',
  },

  /**
   * The referral desk on a project page.
   *
   * `{total}`, `{project}` and `{lifetime}` are the commission rates in whole
   * percent, read from the contract mirrors rather than typed in here.
   *
   * The `[…]` run in `noneDetail` and `partDetail` is the link to the deposit
   * card, rendered by `Linked`.
   *
   * `copied` is `ReferralLinkBox`'s own word after a click, so it also shows in
   * the deposit-confirmed dialog.
   */
  referral: {
    txAction:      'claim commission',
    action:        'claim commission',
    nothingLabel:  'Nothing to claim',
    nothingReason: 'No commission has accrued to this wallet yet — it builds as deposits arrive through your link and unlocks at launch.',

    title:    'REFERRAL DESK',
    subtitle: '{project}% on deposits made through your link here, plus {lifetime}% for life on wallets you bring to Tosh · paid out when the project launches',

    noneHeadline: 'This link pays nothing yet',
    noneDetail:   'Both legs need your own PoG attestation. Register it, and the same link starts paying {total}%. [Register PoG].',
    partHeadline: 'This link pays {lifetime}%, not {total}%',
    partDetail:   'The {project}% leg binds only to a referrer already holding a deposit here. It starts paying on the next deposit after you stake. [Deposit first].',
    fullHeadline: 'This link pays the full {total}%',
    fullDetail:   '{project}% on deposits here, {lifetime}% for life on wallets new to Tosh.',

    linkLabel:  'YOUR REFERRAL LINK',
    copy:       'copy',
    copyAnyway: 'copy anyway',
    copied:     'copied',
    bindSummary: 'How the two legs bind',
    bindHow:    'The first link a wallet arrives on through this project binds it to you here, for {project}%. If it is also the first Tosh link that wallet ever used, you keep {lifetime}% of everything it deposits anywhere, for life. Both bindings are permanent, and self-referral is ignored by the factory.',
    bindSilent: 'A leg that does not bind is not an error anyone sees: the deposit still succeeds and that share of the carve goes to the buyback reservoir instead of to you. The factory retries the binding on every deposit, so a link already in circulation starts paying as soon as its condition is met.',

    claimLabel:  'CLAIMABLE COMMISSION',
    earnedHint:  '{amount} {quote} earned · unlocks at launch()',
    ledgerLink:  'Commission across every project',
  },

  /**
   * The creator's publish-listing panel, shown while a launched project has no
   * registry row. "X / Twitter" and "Telegram" are names and stay in the JSX,
   * as do the URL-shaped placeholders.
   */
  publish: {
    action: 'Publish listing',
    toast:  'Listing published',

    resolvingLabel:  'Finding your launch',
    resolvingReason: 'Reading the transaction that created this launch off the chain.',
    noHashLabel:     'Creating transaction needed',
    noHashReason:    'Paste the createLaunch transaction that brought this project on chain — the signature has to name it.',
    logoLabel:       'Waiting for the image',
    logoReason:      'The upload has to finish first: the logo URL is inside what you sign.',

    title:    'This project is not listed',
    subtitle: 'Its launch is on chain, but the logo, links and description never reached the directory — publishing costs one signature and no gas',
    body:     'Until this is done, {symbol} appears in the directory with a letter sigil and no description, because everything below is held off chain and the registry has no row for it yet.',
    notAGate: 'This is a directory listing and nothing more. Deposits, refunds and triggering the launch all read the chain directly — none of them wait on this, and none of them change if you never publish it.',

    description:            'Description',
    descriptionPlaceholder: 'What this project is for.',
    website:                'Website',
    hashLabel:              'Creating transaction',
    hashHint:               'We could not look this up just now — reloading the page may find it. Otherwise copy the createLaunch transaction hash — the one that brought this project on chain — from your wallet history or the explorer.',

    footer: 'The signature proves you are this launch\'s creator and nothing else — it sends no transaction and grants no spending permission. Only the wallet that created this project can publish its listing.',
  },

  /**
   * The token-artwork field, on `/launch` and in the publish-listing panel.
   * The URL placeholder stays in the JSX. `hint` names the size in MB while
   * `tooBig` is in KB; that is how English has always read.
   */
  logoField: {
    label:         'Logo',
    remove:        'Remove image',
    uploading:     'Uploading…',
    replace:       'Replace token logo',
    upload:        'Upload token logo',
    empty:         'That file is empty',
    tooBig:        'That image is {kb} KB. The limit is {limit} KB.',
    svg:           'SVG is not accepted — it is a document rather than an image and can carry script. Export it as PNG.',
    failed:        'Could not store that image',
    hint:          'PNG, JPEG, GIF or WebP · up to 1 MB',
    pasteSummary:  'Or paste a URL',
    urlLabel:      'Image URL',
  },

  /** The listing mock-up beside the `/launch` form. */
  launchPreview: {
    eyebrow:                'Preview',
    notDeployed:            'not yet deployed',
    symbolPlaceholder:      'SYMBOL',
    namePlaceholder:        'Agent name',
    descriptionPlaceholder: 'Your description appears here as you type.',
    window:                 'Window',
    pool:                   'Pool address',
    poolPending:            'ground at deploy',
    footer:                 'This is how your launch appears in the directory once it confirms.',
  },

  /**
   * `/launch`. `revert*` are the factory's custom errors decoded in the
   * pre-flight; `revertOther` names one this page has no sentence for. The
   * blocker pairs are the Deploy button's, in the order they are listed.
   */
  launch: {
    txAction: 'create launch',

    revertFeeChanged:      'The launch fee was raised above your quote. Reload to see the new terms.',
    revertNameTaken:       'That name and ticker pair is already claimed. Pick another.',
    revertCapsChanged:     'The factory dials moved while you were reading. Deploy again to quote the new ones.',
    revertInsufficientFee: 'The value sent does not cover the launch fee.',
    revertInvalidAdmin:    'The Phase-2 admin cannot be the zero address.',
    revertDeployFailed:    'The hook clone failed to deploy. Deploy again for a fresh salt.',
    revertPaused:          'The factory is paused and is not taking new projects.',
    revertOther:           'The factory rejected this launch: {name}.',

    noFreeSalt: 'Could not find an unused hook address in 8 attempts — please retry.',
    capsMoved:  'Factory soft cap / wallet cap changed — the next deploy will use a fresh salt.',
    feeMoved:   'Launch fee is now {now}, not {was}. Review the terms and tick the pact again.',

    noTokenAddress: 'Launch confirmed, but the token address was not in the receipt.',
    notListed:      'Launch confirmed, but the listing was not published. Open your project and use Publish listing to finish it.',
    opening:        'Launch confirmed — opening your project',

    deploy: 'Deploy — {fee} {symbol}',

    identityLabel:     'Name the token first',
    identityReason:    'The name, ticker and a valid admin address are fixed into the token the moment it deploys, so they have to be settled before you sign.',
    logoLabel:         'Uploading logo…',
    logoReason:        'The picture has to finish landing before you sign: its URL is inside the directory attestation, and a snapshot taken now would list the token without it.',
    dialsLabel:        'Reading the terms…',
    dialsReason:       'Fetching the launch fee and the factory dials your hook address is derived from, before quoting what you owe.',
    unreachableLabel:  'Factory unreachable',
    unreachableReason: 'The factory at {factory} did not answer on chain {chain}. Signing against an unknown fee would either fail or overpay, so this stays locked until it responds.',
    ackLabel:          'Acknowledge the pact',
    ackReason:         'The rules on the right are immutable once this transaction lands. Tick the box to proceed.',
    fundsLabel:        'Need {due}',
    fundsReason:       'Deploying costs {fee} in launch fee plus about {gas} in gas, both in {symbol}. This wallet does not hold the {due} that comes to.',
    saltLabel:         'Reserving your pool address…',
    saltReason:        'Reserving an address for a {hours}h window and checking it is free. Takes a moment.',
    confirmedLabel:    'Launch confirmed',
    confirmedReason:   'Your token is on chain. Listing it in the directory runs in the background.',

    settlesOn:              'Settles on {chain}',
    title:                  'Launch an agent',
    lede:                   'One signature deploys your token with its own PancakeSwap Infinity pool and opens a gas-gated funding round that cannot close early.',
    optional:               'optional',
    identity:               'Identity',
    name:                   'Name',
    ticker:                 'Ticker',
    description:            'Description',
    descriptionPlaceholder: 'What does this agent do on-chain?',
    admin:                  'Project admin',
    adminHint:              'Receives 99% of shelf ladder earnings. Defaults to your wallet.',
    invalidAddress:         'NOT A VALID ADDRESS',
    customAdmin:            'Custom admin — this address, not yours, receives the 99% shelf cut.',
    links:                  'Links',
    website:                'Website',
    twitter:                'Twitter / X',
    telegram:               'Telegram',
    window:                 'Genesis window',
    windowNote:             'Immutable. The window runs to completion; time-up opens launch regardless of how much was raised.',
    duration:               'Duration',
    windowHours:            '{hours} hours',
    saltTitle:              'Hook salt',
    saltHeld:               'salt held',
    poolAddress:            'Your pool address',

    pactTitle:          'Immutable rules',
    genesisSupply:      'Genesis supply',
    ladderSupply:       'Ladder supply',
    ladderShelves:      'Ladder shelves',
    ladderShelvesValue: '{count} · {span}× span',
    openingPrice:       'Opening price',
    openingPriceValue:  '1.10× genesis',
    deadline:           'Your deadline to launch',
    deadlineValue:      '{days} days',
    pactFootnote:       'Fixed at deploy, and unsold supply is never re-mintable. Genesis splits {share} to depositor claims and the rest to pool liquidity, which is what opens the market above what they paid. The clock starts when genesis closes: open the pool inside it, or every depositor can take back 100% of their {quote} — with no deadline of their own to beat. A raise that finishes too small to open a pool skips the clock entirely and refunds the moment genesis closes; there is nothing you could have done with the week, so you do not get one.',

    costTitle:    'What this costs you',
    costSubtitle: 'Two transactions, and only the first is due now.',
    dueNow:       'Due now',
    costFee:      '└ launch fee',
    costGasNow:   '└ gas, deploy now',
    costGasLater: 'Gas, open pool later',
    costFootnote: '{native} only, and one signature — the fee is sent with the transaction, not approved first. Send more than the fee and the difference comes straight back. Gas is estimated at the current rate, which moves before you sign. Opening the pool is a later transaction only you can send.',

    noUpgrade:    "No upgrade path and no admin key over your token: the terms above are fixed in the contract's own bytecode at deploy, and only this project's contract can ever mint. The platform keeps one bounded brake — it can pause shelf minting for up to 7 days at a time, on the record, and it can never reach a deposit, a refund or a claim.",
    factoryLabel: 'Factory {address}',

    pactAccept:  'I accept the immutable pact: {fee} {symbol} launch fee, a genesis window that cannot close early, and a *full refund* to every depositor if I let the {days}-day window to open trading expire — or, whatever I do, if the raise finishes too small to open a pool.',
    pactFailed:  'The factory did not answer on chain {chain}, so the launch fee is unknown. There are no terms to accept yet.',
    pactLoading: 'Reading the launch fee off the factory — the pact appears here with its real numbers in it.',
    deployNote:  'Deploy reserves your pool address before the wallet opens, so expect a moment before the prompt.',

    confirmed:   'Confirmed.',
    syncSigning: 'sign to list in the directory',
    syncDone:    'directory synced',
    syncError:   'not listed — finish from the project page',
    cancel:      'Cancel',

    windowShort: '{hours}h',

    dialsTitle:    'Live factory dials',
    dialsSubtitle: 'Read from the factory now — these move between launches.',
    dialFee:       'Launch fee',
    dialCap:       'Per-wallet cap',
    dialNetwork:   'Network',

    // Shown in place of the form while `LAUNCHES_PAUSED` is set.
    pausedEyebrow: 'LAUNCHES PAUSED',
    pausedTitle:   'New launches are paused.',
    pausedBody:    'The launch factory is being upgraded, and new launches reopen once the new version is live. Projects that have already launched or are raising now are unaffected — deposits, refunds, claims and trading work as before.',
    pausedBrowse:  'Browse the agent directory',
  },

  /**
   * `/referrals`, every project that owes this wallet commission. The `//`
   * prefixes on the footnotes stay in the JSX.
   */
  referralLedger: {
    txAction:      'claim commission',
    action:        'claim',
    lockedLabel:   'Locked until launch',
    lockedReason:  'Commission unlocks when the project calls launch(). A raise that is never launched refunds depositors in full and never pays commission, so this is the contract holding the money until the outcome is known.',
    nothingLabel:  'Nothing to claim',
    nothingReason: 'This project has launched and everything it owed this wallet is already withdrawn.',
    launched:      'launched',
    inGenesis:     'in genesis',
    claimable:     'CLAIMABLE',
    claimableHint: 'unlocks at launch()',
    earned:        'EARNED',
    earnedHint:    'no deposits through your link yet',
    brought:       'WALLETS BROUGHT',
    broughtHint:   'bound to you on this project',
    degraded:      'At least one read for this project failed, so the figures above may be low. Claiming is still safe — the contract pays what it owes regardless of what this page managed to read. Refresh to get the real numbers.',

    eyebrow:  '// referral ledger',
    title:    'Your',
    accent:   'commission',
    subtitle: "{project}% of every genesis deposit made through your link on a project you have staked, plus {lifetime}% for life on every wallet you first brought to Tosh. {total}% in total, carved from the raise and not from anyone's allocation.",

    connectTitle:    'Connect a wallet',
    connectSubtitle: 'The ledger is keyed to an address',
    connectBody:     'Commission accrues to whichever address a referral link named, so there is nothing to show until one is connected. Nothing here is a transaction — connecting only reads what the projects already owe.',

    totalClaimable:     'CLAIMABLE NOW',
    totalClaimableHint: 'across every launched project',
    totalLocked:        'LOCKED UNTIL LAUNCH',
    totalLockedHint:    'earned on raises still in genesis',
    totalBrought:       'WALLETS BROUGHT TO TOSH',
    totalBroughtHint:   'each pays you {lifetime}% for life',

    emptyTitle:      'No commission yet',
    emptySubtitle:   'What earns it',
    emptyEarns:      'Nothing has accrued to this wallet. A referral link earns on the deposits made through it, so the ledger fills in as the people you shared with arrive — not when the link is created.',
    emptyConditions: 'Two conditions decide what a link pays, and both are worth checking before sharing. You need your own PoG attestation, or neither leg binds. And the {project}% project leg only binds on a project you already hold a deposit in — so deposit first, then share, or that share of the carve goes to the buyback reservoir instead of to you. The {lifetime}% lifetime leg has no such condition.',
    emptyDesks:      'Any project still in genesis carries its own referral desk, with the link and a live read on whether it will pay there. Once a raise closes the desk goes too, since a link cannot earn on one that has — except on a project that still owes this wallet, which keeps its claim. This page is the same claim for all of them at once: one row per project that owes you, each with its own button. There is none to press yet because nothing owes you. [Browse projects].',

    perProject: 'Claims are per project, because each project holds its own commission reserve. There is no single button that drains them all, and there deliberately is not: a platform-wide pot would have to stay solvent across every raise at once.',
    truncated:  'This ledger covers the most recent {depth} launches, and there are now {count}. Commission on an older project is still yours and still claimable — open that project and use the referral desk on its own page, which stays for as long as it owes you anything.',
  },

  /**
   * The wallet drawer off the navbar pip. The `//`, `/` and `///` prefixes
   * stay in the JSX; `bannedNote`'s `{ban}` is one of the three `ban*` values,
   * lower-cased by the caller.
   */
  drawer: {
    closeDrawer:     'close drawer',
    title:           'My Profile',
    close:           'close',
    switchTitle:     'Re-open wallet account picker (EIP-2255)',
    switch:          'Switch',
    disconnectTitle: 'Terminate wagmi session for this address',
    disconnect:      'Disconnect',
    ledgerEyebrow:   'REFERRAL LEDGER',
    ledgerBody:      'Commission from every project, and the claims',
    footerHint:      'esc · click_outside',

    quotaEyebrow:   'POG REMAINING · THIS WINDOW',
    banned:         'BLACKLISTED',
    unattested:     'NO ATTESTATION',
    allocation:     'Per-window Allocation',
    spent:          'Spent This Window',
    bannedNote:     'every deposit is rejected while the ban stands · {ban}',
    unattestedNote: 'no quota was ever issued to this wallet · register proof-of-gas to receive one',
    refillNote:     'refills every 24h · refunds never credit it back',
    banPermanent:   'PERMANENT · NO EXPIRY',
    banLapsed:      'LAPSED',
    banLifts:       'LIFTS {date}',

    cooldownTitle:  'Cooldown Matrix',
    readyToDeposit: 'READY TO DEPOSIT',
    activeReady:    'ACTIVE READY',
    onCooldown:     'ON COOLDOWN',

    assetsTitle:  'Participated Assets',
    scanning:     'scanning on-chain registry…',
    emptyLead:    'no genesis deposits detected ·',
    emptyHow:     'deposit {quote} in any live genesis window, then claim after launch()',
    claimTx:      'claim {symbol}',
    unread:       'UNREAD',
    curve:        'CURVE',
    genesis:      'GENESIS',
    deposited:    'DEPOSITED',
    unreadNote:   'COULD NOT READ THIS LAUNCH — RETRYING. NOTHING BELOW IS A STATEMENT ABOUT YOUR BALANCE.',
    raiseTotal:   'RAISE_TOTAL',
    claimable:    'CLAIMABLE',
    claimed:      '[ TRANSFERRED_CLOSED ]',
    signing:      '[ SIGN… ]',
    mining:       '[ MINING… ]',
    claim:        '[ CLAIM_TOKENS ]',
    noAllocation: '[ NO_ALLOCATION ]',
  },

  /**
   * Site-wide pieces outside any one page: the wrong-network strip, the copy
   * control on every address, and the 404 page. The 404's `→` arrows stay in
   * the JSX.
   */
  chrome: {
    wrongNetwork:        'Wrong network — Tosh settles on {chain}. Switch to continue.',
    wrongNetworkStaging: 'Wrong network — Tosh settles on {chain}; staging runs on {staging}. Switch to continue.',
    switchNetwork:       'Switch network',
    switching:           'Switching…',

    copyAddress: 'copy address',
    copyTx:      'copy tx',
    copied:      'copied',

    notFoundEyebrow:  '// ROUTE // 404 · UNMAPPED_PATH',
    notFoundTitle:    'That endpoint is not on the registry.',
    notFoundBody:     'You either followed a stale link or mistyped a path. The protocol surfaces only the routes shipped in the current build — nothing dynamic gets resolved client-side, so this is a hard miss.',
    notFoundNav:      'Common destinations',
    notFoundHome:     'CONSOLE_HOME',
    notFoundProjects: 'PROJECTS_RADAR',
    notFoundLaunch:   'LAUNCH_TERMINAL',
    notFoundAdmin:    'ADMIN_PANEL',
    notFoundFooter:   '// PROTOCOL_STATE_IS_FINE · ONLY_THIS_URL_IS_NOT_REGISTERED',
  },

  /**
   * Page metadata: tab titles, search descriptions, link-preview cards. The
   * bare `ToshX` brand title and the 404's title stay in code.
   * `siteDescription` is followed by two derived English clauses on the English
   * build only — see `generateMetadata` in `app/layout.tsx`.
   */
  meta: {
    siteDescription:      'Fair-launch terminal for agent tokens, built on PancakeSwap Infinity hooks. Proof-of-Gas gated genesis, 4000-rung shelf ladder, audit-cliff hardened.',
    cardTitle:            'ToshX — fair-launch terminal for agent tokens',
    projectsTitle:        'Agent Directory // ToshX',
    projectsDescription:  'Every agent token on Tosh Protocol — open funding windows, launches awaiting their pool, and live shelf-ladder trading on {chain}.',
    referralsTitle:       'Referral Ledger // ToshX',
    referralsDescription: 'Commission earned across every Tosh Protocol launch — claimable balances, amounts still locked until launch, and wallets bound to you on {chain}.',
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
  'tx', 'gate', 'nav', 'wallet', 'deposit', 'refund', 'claim', 'ineligible', 'ledger',
  'awaitingLaunch', 'success', 'gas', 'referral',
] as const

/** Where a Tier-0 gap fails the build rather than falling back. */
export const TIER0_REQUIRED_LOCALES = ['en', 'zh-CN'] as const
