/**
 * The source of truth for every translatable string, and the shape every other
 * locale is checked against.
 *
 * ⚠ THE `Dictionary` TYPE IS DERIVED FROM THIS OBJECT, so adding a key here is
 *   what makes it referenceable, and deleting one here is what makes every
 *   remaining reference fail to compile. That is the whole reason this is hand
 *   rolled rather than JSON: `t.v2.placeAction` is checked, and a key that
 *   does not exist cannot be reached by a typo.
 *
 * ── RULES FOR EVERYTHING IN HERE ─────────────────────────────────────────────
 *
 *   1. WHOLE SENTENCES, NEVER FRAGMENTS THAT GET CONCATENATED. Sharing a clause
 *      between two strings by joining it onto a stem would force every language
 *      into English word order, and the languages this build offers do not have
 *      it — Japanese and Korean put the verb last. Each string is one complete
 *      sentence, duplication included.
 *
 *   2. INTERPOLATION IS `{name}` AND IS FILLED BY `fill()`, never by a function
 *      stored in here. The merged dictionary crosses the server/client boundary
 *      as props, and React cannot serialise a function — a template literal in
 *      this file would fail at runtime in the one place it matters. The
 *      placeholder form also shows a translator that a value lands there, and
 *      `guard:i18n` fails the build when a locale drops one.
 *
 *   3. NO TICKER OR CONTRACT IDENTIFIER GOES IN A STRING. `USDT`, `WBNB` and the
 *      like name real on-chain things and are interpolated, never translated.
 *
 *   4. PROTOCOL TERMS STAY ENGLISH IN EVERY LOCALE — GENESIS, Agent ID, the ladder,
 *      the shelf. They are the words the contracts, the docs and every other
 *      venue use; translating them would leave a reader unable to match what
 *      they see here against anything else. A locale may gloss one in
 *      parentheses on first use.
 */

export const EN = {
  /**
   * The lifecycle toast, shared by every write in the app.
   *
   * `{action}` is supplied by the calling surface — see `v2.placeAction`.
   *
   * ⚠ THE SLOT WANTS A NOUN: `confirming` renders as "Submitted · confirming
   *   bid". A verb phrase there reads badly in every locale, and `zh-CN` relies
   *   on the noun form to leave no space after 「正在确认」.
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
   *   once, where a wrong string in `v2` is wrong on one panel.
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
     * purpose: the toast names the action ("Awaiting signature — bid")
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
   * The navbar links and the footer, on every page but `/admin`.
   *
   * ⚠ `navDirectory` IS THE PHONE FORM OF `navDirectoryFull`, not a synonym.
   *   Below `sm` the bar does not fit at 390px and the directory link sheds a
   *   word; both are always in the DOM and a media query picks one. A locale
   *   whose full form is already short may make the two identical, but the short
   *   one must never be the longer of the pair.
   *
   * GitHub, X and "Tosh Protocol" are names, not copy, and stay in the JSX.
   */
  site: {
    navApply:         'Apply',
    footerSecurity:   'Security',
  },

  /**
   * `/apply` — the standing call for project teams.
   *
   * ⚠ THE FOUR RULES ARE CONTRACT BEHAVIOUR, not marketing. An applicant ticks
   *   the box on the strength of them, so a translation must keep every claim:
   *   no team allocation, liquidity nobody can withdraw, 99 % of shelf revenue
   *   to the Circuit NFT holder, and GENESIS being Agent-ID-only and final.
   *
   * `ecosystemHint` carries `{count}` / `{max}`, counted in characters.
   */
  apply: {
    metaTitle:       'Apply to launch // ToshX',
    metaDescription: 'Project teams: apply to launch on ToshX, the fair launch for verified agents. Reviewed in Telegram.',
    eyebrow:         '// project applications · always open',
    title:           'Launch on',
    accent:          'ToshX',
    subtitle:        'For teams with a product or verifiable work already shipped. Applications go straight to the review group, and we reply on Telegram.',

    formTitle:       'Application',
    formSubtitle:    'Four fields. Nothing is stored on this site.',
    projectName:            'Project name',
    projectNamePlaceholder: 'e.g. Orbit',
    projectNameHint:        'Short name, as it would appear in the directory.',
    demoOrRepo:             'Verifiable output',
    demoOrRepoPlaceholder:  'https://github.com/… or 0x… or https://demo…',
    demoOrRepoHint:         'GitHub repository, testnet contract address or a live demo — up to 3, separated by spaces. Applications with nothing to verify are filtered out.',
    ecosystem:              'Project and token use',
    ecosystemPlaceholder:   'What the project does, and what the token is for in it.',
    ecosystemHint:          '{count} / {max} characters',
    telegram:               'Telegram',
    telegramPlaceholder:    '@username',
    telegramHint:           'The review team opens a group with you here.',
    honeypot:               'Company',

    rulesTitle: 'Launch rules',
    rule1:      'Ownerless launch: once the pool opens, the genesis liquidity is locked permanently and no one — not your team, not the platform — can withdraw it.',
    rule2:      'No team allocation: tokens only go to GENESIS buyers, shelf buyers or the locked opening pool; unsold GENESIS tokens are burned at launch. Your team buys like anyone else.',
    rule3:      'Shelf mechanism: 60 % of supply sits on 4,000 fixed-price shelves above the opening price, and a shelf only opens once the pool price has risen to it. No price rise, no shelf sales, and no revenue for the project from them. 99 % of shelf revenue goes to the vault of the Circuit NFT your team holds, 1 % funds buyback-and-burn: your ongoing income comes only from the price going up, the same thing holders want.',
    rule4:      'GENESIS: Binance Agent ID holders only; on {native} launches a share is 0.01 {native} and each ID may buy up to 10; every buy is final, with no refunds. After sell-out or the deadline the pool opens at 2P, launched by the Circuit NFT holder within 48 hours, then by anyone.',
    rulesAccept: 'I have read and accept the launch rules above.',

    errRequired:        'Required.',
    errTooLong:         'At most {max} characters.',
    errTooShort:        'Say what the project and the token are for — at least {min} characters.',
    errDemoInvalid:     'Each item must be an http(s) link or a 0x contract address, at most 3.',
    errTelegramInvalid: 'A Telegram username: 5–32 letters, digits or underscores, starting with a letter.',
    errRules:           'Accept the launch rules to apply.',

    submit:          'Submit application',
    submitting:      'Sending…',
    fixFields:       'Fix the highlighted fields.',
    errRateLimited:  'Too many submissions from this network. Try again in a while.',
    errUnavailable:  'Applications cannot be delivered right now. Nothing was sent — please try again shortly.',
    errGeneric:      'Something went wrong and nothing was sent. Please try again.',
    successTitle:    'Application received',
    successBody:     'It is in the review group now. If it moves forward, the team will contact {handle} on Telegram.',
    another:         'Submit another',
  },

  /**
   * The project page's rails: the four-figure header strip and the lifecycle
   * tracker. Neither takes money; both are read before anything that does.
   */
  project: {
    legacyRetired: 'This is a legacy v1 launch. The site no longer offers its trading screen; its contracts remain callable on-chain.',

    // The identity header above the terminal.
    backToAll:     'All projects',
    tokenLabel:    'token',
    socialX:       'X / Twitter',
    socialTg:      'Telegram',
    socialWeb:     'Website',
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
    switchTitle:     'Disconnect, then choose a wallet or account',
    switch:          'Switch',
    disconnectTitle: 'Terminate wagmi session for this address',
    disconnect:      'Disconnect',
    portfolioEyebrow: 'MY PORTFOLIO',
    portfolioBody:    'Your open bids across projects',
    footerHint:      'esc · click_outside',
    signing:      '[ SIGN… ]',
    mining:       '[ MINING… ]',
  },

  /**
   * BNB ⇄ WBNB on a WBNB project. A GENESIS buy takes BNB directly; a shelf
   * buy and an LP add pull WBNB, so a short wrapped balance is topped up by
   * wrapping first. `{amount}` is already formatted.
   */
  wrap: {
    txAction:      'Wrap {native}',
    wrapLabel:     'Wrap {amount} {native} first',
    wrapReason:    'This step pays in {wrapped}, the token form of {native}. Wrapping turns {amount} of your {native} '
                 + 'into {wrapped} 1:1 so the contract can take it; unwrap any leftover from your profile.',
    unwrapTx:      'Unwrap {wrapped}',
    unwrapTitle:   'Wrapped {native}',
    unwrapHint:    'Left over from a shelf buy. Unwrap to get {native} back 1:1.',
    unwrapCta:     'Unwrap {amount} {wrapped}',
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
    siteDescription:      'The fair launch for verified agents, built on PancakeSwap Infinity hooks. Binance Agent ID gated GENESIS curve, 2P open, 4,000-rung shelf ladder.',
    cardTitle:            'ToshX — the fair-launch terminal of the {ecosystem} ecosystem',
  },

  /** ToshX v2: Agent ID genesis, the pre-launch bid market, receiver registration. */
  v2: {
    notDeployed:       'ToshX v2 is not deployed on this network yet.',
    notV2:             'This project runs on ToshX v1, which has no bid market.',

    genesisTitle:      'GENESIS',
    sold:              'Sold',
    raised:            'Raised',
    price:             'Current price',
    hardCap:           'Hard cap',
    perAgentCap:       'Per Agent ID',
    endsIn:            'Ends in',
    closed:            'Closed',

    agentTitle:        'Binance Agent ID',
    agentNone:         'This wallet has no Binance Agent ID. GENESIS is open to Agent ID holders only: buy from your Agentic Wallet with Agent mode below. Anyone can still bid in the market.',
    agentWalletSettings: 'In the Binance app, Agentic Wallet settings: the Developer mode daily limit must exceed this amount; set abnormal transaction handling to "Need confirmation"; set tradable tokens to "All". Developer mode cannot be enabled while the wallet balance is above its limit.',
    agentOk:           'Agent ID verified · {remaining} {quote} left of your {cap} {quote} allowance.',
    agentOkShares:     'Agent ID verified · {left} of your {count} shares left.',
    sharesLabel:       'Shares ({size} {quote} each)',
    sharesHint:        '{pay} {quote} in total · up to {count} shares per Agent ID',
    agentUsedUp:       'This Agent ID has used its whole allowance for this project.',
    agentRegistryDown: 'The Agent ID registry did not answer. Try again shortly.',
    agentCodeWallet:   'This address is a contract (such as a smart contract wallet), so it cannot buy GENESIS. Plain wallets and EIP-7702 accounts can.',

    payLabel:          'You pay',
    receiveLabel:      'You receive (estimate)',
    buy:               'Buy',
    buyAction:         'GENESIS buy',
    minBuy:            'Minimum {min} {quote}.',
    approve:           'Approve {quote}',

    launchTitle:       'Launch',
    launchExplain:     'Opens the pool at 2× the first GENESIS price with 80 % of the raise, burns the unsold supply and lifts the transfer limits.',
    launchWaiting:     'Launch opens when GENESIS sells out or ends.',
    launchAbandoned:   'GENESIS ended with nothing sold, so this project can never launch.',
    launchAdminWindow: 'Only the Circuit NFT holder can launch until {time}. After that, anyone can.',
    launchPublic:      'Anyone can launch now.',
    launchBtn:         'Launch pool',
    launchAction:      'launch',
    launched:          'Live — the pool opened at {p0} {quote}.',

    fundTitle:         'Project fund',
    fundBlurb:         '20 % of every GENESIS payment, withdrawable at any time by the Circuit NFT holder.',
    fundAvailable:     'Withdrawable',
    fundTo:            'Pays to',
    withdraw:          'Withdraw',
    withdrawAction:    'project fund withdrawal',
    setFund:           'Change address',
    setFundAction:     'project fund change',
    fundAddrLabel:     'New fund address',
    controllerOnly:    'Circuit NFT holder only.',
    vaultTitle:        'Project revenue vault',
    vaultBlurb:        'After launch, 0.60 % of every buy and 19 % of shelf revenue land here. Only the Circuit NFT holder can withdraw.',
    vaultAddr:         'Vault',
    vaultHolder:       'NFT holder',
    vaultWithdraw:     'Withdraw to holder',
    vaultWithdrawAction: 'vault withdrawal',

    registerLink:      'Register to receive',

    marketTitle:       'Bid market',
    marketBlurb:       'A buy-only order book. Bidders lock {quote}; holders sell into their bids. 1 % from each side, only when a bid fills. It closes at launch, after which bids can only be cancelled.',
    depth:             'Open bids',
    colPrice:          'Price ({quote} per token)',
    colQty:            'Tokens',
    colTotal:          'Total ({quote})',
    colOrders:         'Orders',
    noBids:            'No open bids yet.',
    placeTitle:        'Place a bid',
    placePrice:        'Price per token ({quote})',
    placeQty:          'You get',
    placeAmount:       'Amount ({quote})',
    placeBest:         'Best',
    placeBestHint:     'Best bid {p} {quote}.',
    placeQtyMin:       'A bid must be for at least 1 token.',
    placeEscrow:       'Locks {amount} {quote}, including the 1 % fee.',
    placeMin:          'The price must be at least the latest GENESIS price, {p} {quote}.',
    placeMinTotal:     'The bid must be worth at least {min} {quote}.',
    placeBtn:          'Place bid',
    placeAction:       'bid',
    sellTitle:         'Sell into bids',
    sellAmount:        'Tokens to sell',
    sellBalance:       'Balance: {amount}',
    sellReceive:       'You receive about {amount} {quote} after the 1 % fee.',
    sellFloor:         'Bids under {floor} {quote} (90 % of the latest GENESIS price) cannot fill.',
    sellNothing:       'No open bid can take this amount.',
    sellBtn:           'Sell',
    sellAction:        'sale',
    approveToken:      'Approve {symbol}',
    myBids:            'My bids',
    myBidsConnect:     'Connect a wallet to see and cancel your bids.',
    myBidsAgentLink:   'Bid through an agent? Look up its wallet',
    myBidsAddr:        'Agent wallet address',
    myBidsNone:        'This address has no open bids here.',
    filledOf:          '{filled} of {qty} filled',
    cancel:            'Cancel',
    cancelAction:      'bid cancellation',
    marketClosed:      'Launched — the bid market is closed. Open bids can still be cancelled.',
    tradesTitle:       'Recent trades',
    colSeller:         'Seller',
    registerTitle:     'Register to receive',
    registerBlurb:     'Until a project launches, its token can only be sent to wallets that registered. Buying GENESIS or placing a bid registers you automatically.',
    registerToken:     'Token address',
    registerBtn:       'Register',
    registerAction:    'receiver registration',
    registered:        'This wallet can receive {symbol}.',
    notRegistered:     'This wallet is not registered for {symbol} yet.',
    tradingOpen:       '{symbol} has launched; registration is no longer needed.',

    portfolioTitle:    'Portfolio',
    portfolioBlurb:    'Your open bids across ToshX v2 projects.',
    connectFirst:      'Connect a wallet to see your bids.',
    noOpenBids:        'You have no open bids.',

    agentOpen:         'Run with Agent',
    agentClose:        'Close',
    agentHowTo:        'Paste it to your agent and let it run. Developer mode must be on (Agentic Wallet → Settings); copy again if the price moves.',
    agentShow:         'Show the instructions',
    agentCopyTemplate: 'Copy reusable instructions for your agent',
    agentTemplateHint: 'Send it to your agent once, then just say how much, e.g. "buy 100U". Developer mode must be on (Agentic Wallet → Settings).',
    agentTplGenesis:   'ToshX GENESIS buy of {symbol}. When I say "buy X {quote}", use this wallet (it holds the Agent ID) on {chain} (chainId {id}) to run, in order:\n1. On the {quote} contract {asset}: approve(spender = {hook}, amount = X × 10^{dec})\n2. On contract {hook}: buyGenesis(uint256 maxPay = X × 10^{dec}, uint256 minTokens = 0), value = 0\nNote: the GENESIS price only rises with sales and tops out at 1.5P; anything above this Agent ID\'s remaining allowance is not charged.',
    agentTplGenesisNative: 'ToshX GENESIS buy of {symbol}. When I say "buy X {quote}", use this wallet (it holds the Agent ID) on {chain} (chainId {id}) to run:\nOn contract {hook}: buyGenesis(uint256 maxPay = X × 10^{dec}, uint256 minTokens = 0), value = X × 10^{dec} wei\nNote: the GENESIS price only rises with sales and tops out at 1.5P; anything above this Agent ID\'s remaining allowance is not charged.',
    agentCopy:         'Copy instructions for your agent',
    agentCopyData:     'Copy calldata',
    agentCopied:       'Copied',
    agentAddrLabel:    'Agent wallet address (optional, refreshes when it lands)',
    agentWatching:     'Waiting for a new transaction from this address…',
    agentSeen:         'New transaction seen — the page has refreshed.',
    agentFillFirst:    'Fill in the form above to generate the instructions.',
    agentInstrHead:    'Use binance-agentic-wallet to make these contract calls in order (chain: {chain}, chainId {id}).',
    agentInstrStep:    'Step {n}: {note}',
    agentInstrContract: 'Contract',
    agentInstrFn:      'Function',
    agentInstrArgs:    'Arguments',
    agentInstrValue:   'value (wei)',
    agentNoteWrap:     'Wrap {amount} {native} into {wrapped} (skip if the wallet already holds enough {wrapped})',
    agentNoteApprove:  'Approve {amount} {symbol} for {spender}',
    agentNoteBuy:      'GENESIS buy',
    agentNoteBid:      'Place the bid',
    agentNoteSell:     'Sell into bids',
    agentNoteCancel:   'Cancel bid #{id}',
    agentNoteRegister: 'Register as a receiver of {symbol}',
    agentNoteTransfer: 'Send {amount} {symbol} to {to}',
    agentNoteLaunch:   'Launch the pool',
    agentNoteWithdraw: 'Withdraw the project fund',
    agentNoteVaultWithdraw: 'Withdraw all {symbol} in the vault to {to}',
    agentNoteMint:     'Buy {amount} {symbol} from the shelf',
    agentNoteCapClamp: 'The hook spends at most the remaining allowance of the Agent ID that signs; anything above it is refunded.',
    agentAddressBook:  'Add the recipient to the Binance app address book first.',

    holdTitle:         'My holdings',
    holdBalance:       'Balance',
    transferTo:        'Recipient',
    transferAmount:    'Amount',
    transferBtn:       'Send',
    transferAction:    'token transfer',
    transferBadAddr:   'Enter a valid recipient address.',
    transferContract:  'Before launch, tokens cannot be sent to a contract (EIP-7702 accounts are fine).',
    transferUnregistered: 'The recipient has to register on ToshX first. Send them this link:',
    transferSelfCode:  'Before launch, this wallet cannot send tokens: it is a contract wallet.',
    transferAmountReason: 'Enter an amount no larger than your balance.',
    copyLink:          'Copy link',

    lfTitle:           'New v2 launch',
    lfBlurb:           'Platform Safe signers only. Sends createLaunch from a connected signer wallet, or exports a Safe Transaction Builder file for the Safe to sign.',
    lfName:            'Token name',
    lfSymbol:          'Ticker',
    lfDeveloper:       'Developer',
    lfDeveloperHint:   'Receives the Circuit NFT: launches during the 48 h window and controls the project fund.',
    lfFund:            'Project fund address',
    lfFundHint:        'Where the 20 % fund share is withdrawn to. The NFT holder can change it later.',
    lfDuration:        'GENESIS window',
    lfOwner:           'Factory owner',
    lfSend:            'Send createLaunch',
    lfAction:          'launch creation',
    lfExport:          'Export Safe batch (JSON)',
    lfAfter:           'After it confirms, sign and publish the project info below.',
    lfAgentFixed:      'Set by the factory for every launch on this market. The platform Safe can change it.',
    piTitle:           'Project info',
    piBlurb:           'Logo, cover, description and links for the project page and cards. Fill them in any time; publishing needs the launch transaction and is final, so check before you sign.',
    piLogo:            'Logo',
    piLogoHint:        'Square, PNG, JPEG, GIF or WebP, up to 1 MB.',
    piCover:           'Cover image',
    piCoverHint:       '16:9, shown on the project card and the homepage feature. Up to 1 MB.',
    piPick:            'Choose image',
    piRemove:          'Remove',
    piUploading:       'Uploading…',
    piUploadFailed:    'The image could not be uploaded.',
    piImageSize:       'Images must be under {kb} KB.',
    piDescription:     'Description',
    piDescriptionHint: '{n} / {max}',
    piWebsite:         'Website',
    piTwitter:         'X (Twitter)',
    piTelegram:        'Telegram',
    piTx:              'Launch transaction hash',
    piTxHint:          'Filled in after a launch from this page. For a launch executed in the Safe, paste the execution transaction hash.',
    piPublish:         'Sign and publish',
    piPublishing:      'Publishing…',
    piNeedWallet:      'Connect the wallet that will sign.',
    piNeedTx:          'Enter the launch transaction hash.',
    piWho:             'Signed by the platform signer who sent the launch, or by the project address. Signing sends no transaction.',
    piDone:            'Published.',
    piOpen:            'Open the project page',
    piDuplicate:       'This launch is already published. A listing cannot be changed after publishing.',
    piFailed:          'Publishing failed.',
    lfNeedName:        'Enter a name and a ticker.',
    lfNeedDeveloper:   'Enter the developer address.',
    lfNeedFund:        'Enter the project fund address.',
    lfCapRange:        'Hard cap must be between {min} and {max} {unit}.',
    lfAgentRange:      'Per-Agent-ID cap must be between {min} and {max} {unit}, and no more than the hard cap.',
    lfNotOwner:        'Only the factory owner can send this ({owner}). Export the Safe batch instead.',
    lfNotSigner:       'Only the platform Safe ({safe}) and its signers can list a project. Connect a signer wallet, or export the Safe batch.',
    lfGatewaySafe:     'Platform Safe',

    shelfTitle:        'Shelf ladder',
    shelfBlurb:        'Fixed-price supply that starts at 2× the first GENESIS price, each shelf about 0.19 % above the last. A shelf opens only while the pool trades near or above it. No Agent ID needed: any wallet can buy.',
    shelfPrice:        'Shelf price',
    shelfLeft:         'Left on this shelf',
    shelfLocked:       'Locked: the pool is trading below this shelf.',
    mintAmount:        'Tokens',
    mintBtn:           'Mint from shelf',
    mintAction:        'shelf mint',
    shelfAllowance:    'Shelf allowance left',
    shelfAgentMissing: 'No Agent ID',
    shelfAgentNone:    'Shelf mints need a Binance Agent ID. Mint from the wallet that holds one.',
    shelfAgentOver:    'This mint costs more than the {remaining} {quote} this Agent ID has left on this project’s shelves.',
  },

  /** The ToshX black-gold shell: home, list pages and the v2 project page. */
  x: {
    navHome:           'Home',
    navMarket:         'Market',
    navWhitepaper:     'Whitepaper (中文)',
    whitepaperSource:  'Source and history on GitHub',
    whitepaperUnavailable: 'The whitepaper could not be loaded. Refresh in a moment, or read it on GitHub.',
    navLaunching:      'Launching',
    navLaunched:       'Launched',
    sideNav:           'Sections',
    topNav:            'Main',
    footerRisk:        'Tokens launched here are high-risk and can lose all their value. Nothing on this site is investment advice.',

    statusLive:        'Live',
    statusPending:     'Awaiting launch',
    statusTrading:     'Trading',
    statusEnded:       'Ended',
    raisedOfCap:       '{raised} / {cap} {quote}',
    raisedOnly:        '{raised} {quote} raised',
    raisedVsCap:       'Raised against the hard cap',
    noDescription:     'No description yet.',
    endsIn:            'Ends in',

    heroBadge:         '{chain} fair launch',
    heroTitleLead:     'Fair launches for',
    heroTitleEmph:     'verified agents',
    heroLede:          'One Binance Agent ID, one allowance. Buy on a public curve from P to 1.5P; the pool opens at 2P with its liquidity locked for good.',
    heroStatLaunches:  'Launches',
    heroStatLive:      'Live now',
    heroStatLaunched:  'Launched',
    heroCta:           'Buy the live raise',
    heroAll:           'All launches',
    heroNoLiveLink:    'See launched projects →',
    heroStepsLabel:    'How it works',
    heroStep1:         'Get an Agent ID',
    heroStep1Body:     'Claim one in the Binance Agentic Wallet. One verified identity, one allowance.',
    heroStep2:         'Buy on the curve',
    heroStep2Body:     'Your agent buys up to the allowance. Earlier buys pay less.',
    heroStep3:         'Launch at 2P',
    heroStep3Body:     'At sell-out or the deadline, the pool opens at twice the first price.',

    featTitle:         'How ToshX works',
    featCurveStep:     'Step 01',
    featCurveTitle:    'GENESIS curve',
    featCurveBody:     'The price rises linearly from P to 1.5P across 5.6M tokens. 20% of every buy goes to the project fund and 80% to the launch pool.',
    featBookStep:      'Step 02',
    featBookTitle:     'Bid market',
    featBookBody:      'Before launch, holders sell into standing bids, never below 90% of the curve price. Each side pays 1% on fill.',
    featShelfStep:     'Step 03',
    featShelfTitle:    'Shelf ladder',
    featShelfBody:     '4,000 fixed-price steps unlock from 2P as the pool price rises. Of the pool’s buy tax, 0.7% funds a reservoir that only buys back and burns and 0.3% goes to the platform; the sell tax is burned outright.',


    launchingTitle:    'Launching now',
    launchingSub:      'GENESIS raises in progress',
    launchingEmpty:    'Nothing is raising right now.',
    browseMore:        '{n} more raising now, see all',
    priceTo2P:         '{price} {quote} → 2P',
    launchedTitle:     'Launched projects',
    launchedEmpty:     'No project has launched yet.',
    shelfStep:         'Shelf #{step} / {total}',

    metaLaunchpadTitle:       'Launching now · ToshX',
    metaLaunchpadDescription: 'GENESIS raises in progress on ToshX, the Agent ID fair launchpad on {chain}.',
    metaLaunchedTitle:        'Launched · ToshX',
    metaLaunchedDescription:  'ToshX projects whose pool is open on {chain}.',
    metaWhitepaperTitle:      'Whitepaper · ToshX',
    metaWhitepaperDescription: 'The ToshX whitepaper (Chinese): fair launch, the continuous ladder and permanently locked liquidity.',

    phaseGenesis:      'GENESIS',
    phasePending:      'Awaiting launch',
    phaseTrading:      'Trading',
    phaseEnded:        'Ended',

    curveTitle:        'GENESIS curve',
    curveAria:         'GENESIS curve from {p} to {p15} {quote}, launching at {p2}. {sold} of {total} tokens sold.',
    launchAt2P:        'Launch 2P · {p}',
    curveSoldAxis:     '{total} sold',
    curveSold:         'Sold',
    curveRemaining:    'Remaining',
    curveLaunch:       'Launch 2P',
    ladderNow:         'Now',

    genesisNeed:       'Binance Agent ID holders only, up to {cap} {quote} each.',
    genesisNeedShares: 'Binance Agent ID holders only: {size} {quote} a share, up to {count} shares per ID.',
    genesisGetId:      'No Agent ID? Get one in Binance Wallet',
    quoteDetails:      'Price details',

    quoteAvg:          'Average price',
    quoteAfter:        'Price after',
    quoteVs2P:         'Of the launch price (2P)',
    quoteSlippage:     'Slippage',
    quoteMin:          'Minimum received',
    buyMarketLink:     'Or place a bid in the bid market →',
    holdHint:          'Connect a wallet, or enter your Agent wallet address in Agent mode, to see your holdings and transfer.',

    currentPrice:      'Current price',
    statSold:          'Sold',
    statRaised:        'Raised',
    statRaisedSub:     'of {cap} {quote}',
    statPerAgent:      'Per Agent ID',
    statEndsIn:        'Ends in',
    statStage:         'Stage',

    tabMarket:         'Bid market',
    tabTokenomics:     'Tokenomics',
    tabRules:          'Rules',
    tabFund:           'Fund',

    mktBest:           'Best bid',
    mktCurve:          'Curve price',
    mktFloor:          'Fill floor (90%)',
    mktEscrow:         'In escrow',
    mktVolume:         'Total volume',
    mktFills:          'Fills',
    mktSideLabel:      'Order side',
    mktSell:           'Sell',
    mktBid:            'Bid',
    mktBuyOnlyWarn:    'A bid must be at or above the latest GENESIS price. If the price then rises until the bid is below 90% of it, the bid goes stale: it cannot fill and can only be cancelled for a full refund.',

    marketTitle:       'Market',
    marketLede:        'The only official pre-launch order market. Buy orders only: the funds sit in escrow in the contract and can be cancelled for a full refund at any time.',
    marketPrice:       'GENESIS price',
    marketDetails:     'Project details',
    marketEmpty:       'No project is taking bids right now.',
    marketPick:        'Choose a project',
    marketSearch:      'Search by name or ticker',
    marketNoMatch:     'No project matches.',
    marketLaunchedTag: 'Launched',
    metaMarketTitle:       'Market · ToshX',
    metaMarketDescription: 'The ToshX pre-launch bid market on {chain}. Buy orders only.',

    tokGenesis:        'GENESIS sale',
    tokPool:           'Launch pool',
    tokShelf:          'Shelf ladder',
    tokNote1:          'Total supply {total}, of which {genesis} is GENESIS. Unsold GENESIS tokens are burned at launch.',
    tokNote2:          'Each buy sends {fund}% to the project fund and reserves {lp}% for the launch pool, whose liquidity is locked for good.',
    tokNote3:          'At sell-out, {amount} {quote} and up to {lp} tokens seed the pool at 2P.',

    ruleCurve:         'Curve',
    ruleCurveBody:     'The price rises linearly with sales, from P to 1.5P. Earlier is cheaper.',
    ruleCap:           'Allowance',
    ruleCapBody:       'One Binance Agent ID, one allowance: up to {cap} {quote}, across any number of buys.',
    ruleCapBodyShares: '{size} {quote} a share, up to {count} shares per Binance Agent ID, across any number of buys.',
    ruleFinal:         'No refunds',
    ruleFinalBody:     'Buying is final. The tokens land in the buying wallet immediately.',
    rulePrelaunch:     'Before launch',
    rulePrelaunchBody: 'Tokens move only to wallets registered to receive. There is no pool and no DEX trading; wallets with an EIP-7702 delegation are allowed.',
    ruleLaunch:        'Launch',
    ruleLaunchBody:    'The Circuit NFT holder may launch for 48 hours after sell-out or the deadline; after that anyone can. The pool opens at 2P.',
    ruleBook:          'Bid market',
    ruleBookBody:      'Bids only. 1% from each side, charged on fill. Fills at most 10% below the latest GENESIS price. Cancel-only after launch.',
    ruleShelf:         'Shelf ladder',
    ruleShelfBody:     '4,000 steps from 2P, 3,150 tokens each on a full raise and scaled down with a partial one, unlocking as the pool price rises. 99% to the project for marketing, operations and promotion; 1% to the buyback reservoir.',
    ruleAgentNote:     'An Agent ID stands for one Binance KYC identity, not one unique person.',

    ladderTitle:       'Price ladder',
    ladderBody:        'Buys fill the current step. Once it is full, the next step opens.',
    ladderCap:         '100% · min(spot, 30m TWAP)',
    ladderCapSpot:     '100% · spot · ~5U per ID',
    ladderStep:        'Step #{n}',
    ladderPrice:       'Step price',
    ladderLeft:        'Left in step',
    ladderSpot:        'Pool price',
    ladderCaption:     'Nearby price steps',
    ladderFilled:      'Filled',
    ladderActive:      'Active',
    ladderQueued:      'Queued',

  },

  /** v3.1 projects: the L2 curve, its mint, and the vesting lock. */
  v31: {
    curveTitle:        'L2 curve',
    curveBody:         'One continuous curve. Every mint lifts the price; every idle minute takes 0.1% off it, and every idle 10 minutes burns 1/1008 of the L2 supply.',
    price:             'Current price',
    vsOpen:            '{x}× the opening price',
    lastPrice:         'Price at last mint',
    nextDecay:         'Next price step',
    nextDecaySub:      '−0.1%, no floor',
    nextBurn:          'Next idle burn',
    burnSize:          '{amount} per burn',
    minted:            'Minted',
    burned:            'Burned',
    remaining:         'Remaining',
    halted:            'Minting is halted. The price step and the idle burn wait until it resumes.',
    soldOut:           'The curve is empty: everything was minted or burned.',
    mintTitle:         'L2 mint',
    mintBlurb:         'Once per Agent ID and per wallet. Tokens vest over 8 hours, 1/480 each minute.',
    mintable:          'You may pay',
    payLabel:          'Pay',
    youGet:            'Tokens locked',
    minOut:            'At least (1% slippage)',
    cost:              'Charged',
    priceAfter:        'Price after',
    mintBtn:           'Mint',
    mintAction:        'L2 mint',
    belowMin:          'Pay at least {min} {quote}',
    aboveCap:          'At most {max} {quote} for this Agent ID',
    already:           'This Agent ID or wallet has already minted on this project',
    alreadyShort:      'Already minted',
    noAgent:           'Needs an Agent ID. Mint from the wallet that holds it, or use Agent mode.',
    noAgentShort:      'No Agent ID',
    agentNoteMint:     'L2 mint: pay up to {pay} {quote} for at least {min} {symbol}',
    vestTitle:         'Vesting',
    vestBlurb:         'Your L2 mint unlocks linearly over 8 hours, a step each minute.',
    vestLocked:        'Locked',
    vestClaimed:       'Claimed',
    vestClaimable:     'Claimable now',
    vestFullAt:        'Fully unlocked in',
    vestDone:          'Done',
    claimBtn:          'Claim',
    claimAction:       'Vesting claim',
    nothingToClaim:    'Nothing unlocked to claim yet',
    agentNoteClaim:    'Claim {amount} {symbol} unlocked from the L2 mint',
    tokL1:             'Genesis sold',
    tokPool:           'Opening pool',
    tokL2:             'L2 curve',
    tokNever:          'Never minted',
    tokNote1:          'Total supply {total}. The opening pool and the L2 curve scale with raised / hard cap ({ratio}% now); what that leaves is never minted.',
    tokNote2:          'Each L2 mint: {lp}% deepens the pool, {project}% goes to the project, {platform}% to the TOSH buyback-and-burn.',
    ruleGenesis:       'Genesis',
    ruleGenesisBody:   '{min} to {cap} {quote} per Agent ID. 20% to the project fund, 80% seeds the pool at launch.',
    ruleCurve:         'L2 curve',
    ruleCurveBody:     'After launch, one continuous curve sells the L2 supply. The price climbs 247× from the opening price to the last token.',
    ruleDecay:         'Price decay',
    ruleDecayBody:     'Every minute without a mint takes 0.1% off the price, with no floor. Halted time does not count.',
    ruleBurn:          'Idle burn',
    ruleBurnBody:      'Every 10 minutes without a mint burns 1/1008 of the L2 supply. A mint resets the clock; anyone may settle a due burn.',
    ruleOnce:          'One mint',
    ruleOnceBody:      'One L2 mint per Agent ID and per wallet: {min} {quote} up to the smaller of the cap and {quota}% of the raise.',
    ruleVest:          'Vesting',
    ruleVestBody:      'L2 tokens unlock linearly over 8 hours, 1/480 each minute. Claim any time.',
    ruleTax:           'Swap tax',
    ruleTaxBody:       'Buys pay 1%: 0.6% to the project, 0.4% to the TOSH buyback. Sells pay 1%, burned.',
    ruleBuyback:       'TOSH buyback',
    ruleBuybackBody:   'All platform revenue buys TOSH on the open market and burns it.',
    noBook:            'v3.1 projects have no pre-launch bid book. Buy in genesis, then mint on the L2 curve.',
  },

  /** `/admin`: the operator console. v1-only panels stay English; this is the chrome and the v2 panels. */
  admin: {
    eyebrow:           'Operator Console',
    titleLead:         'Protocol',
    titleBrand:        'Control',
    connect:           'connect wallet',
    disconnect:        'disc',
    jumpAria:          'Console sections',
    footerV2:          'buyback roster is owner-only · feature pin is off-chain',
    footerChain:       'chain {id}',

    rosterChip:        'Roster',
    rosterIndex:       'BUYBACK · TREASURY ROSTER',
    rosterGroupTitle:  'Buyback roster',
    rosterGroupBlurb:  'Which launched projects each reservoir buys back and burns. A project is never listed automatically: until the treasury owner adds it, its buy tax only fills the reservoir. Curation cannot move funds, and the treasury has no withdraw.',
    rosterNoneTitle:   'BUYBACK ROSTER',
    rosterNotConfigured: 'No v2 factory is configured for this build (NEXT_PUBLIC_V2_FACTORY_BNB / _USDT), so there is no treasury to read.',
    rosterStackTitle:  '{quote} RESERVOIR',
    rosterListedBadge: '{n} listed',
    rosterEmptyBadge:  'nothing listed',
    rosterTreasury:    'Treasury',
    rosterBoundFactory: 'Bound factory',
    rosterFactoryMismatch: 'Does not match the configured factory. Check the deployment before listing anything.',
    rosterOwner:       'Owner',
    rosterYouOwn:      'the connected wallet',
    rosterBalance:     'Reservoir balance',
    rosterUntilNext:   'Until the next buyback',
    rosterArmed:       'armed, the next trade fires it',
    rosterNextSpend:   'Next buyback spends',
    rosterCursor:      'Rotation cursor',
    rosterValve:       'Once the reservoir holds the trigger amount, a buyback spends the larger of that amount and half the balance, a third of it per pool. Each trade runs one leg on the next listed token in rotation, capped at 0.5% of that pool’s depth and never above its 30-minute TWAP. The bought tokens are burned.',
    rosterNotOwner:    'This wallet is not the treasury owner, so writes are off. Export a Safe file and submit it from the owner Safe instead.',
    rosterSafeOnly:    '[safe_only]',
    rosterTxAction:    'update the buyback roster',
    rosterListedTitle: 'LISTED · IN ROTATION',
    rosterListedEmpty: 'Nothing listed yet. The reservoir is filling but cannot buy anything back.',
    rosterReading:     'reading…',
    rosterNext:        'NEXT',
    rosterPendingTitle: 'LAUNCHED · NOT YET LISTED',
    rosterPendingEmpty: 'Every launched project on this stack is listed.',
    rosterStatusReady: 'ready',
    rosterStatusTwap:  'TWAP not ready (first 30 min after launch)',
    rosterAdd:         'Add',
    rosterRemove:      'Remove',
    rosterExportSafe:  'Safe file',
    rosterExportAll:   'Export all {n} ready as one Safe batch',
    rosterSafeHint:    'Safe files are Transaction Builder JSON: import them in the owner Safe, sign, execute.',
    rosterRemoveTitle: 'Remove from the buyback roster?',
    rosterRemoveBody:  'Its reservoir share stops buying this token. Tokens already burned stay burned, and the project can be added back later.',

    featChip:          'Front page',
    featIndex:         'PRESENTATION',
    featGroupTitle:    'Homepage feature pin',
    featGroupBlurb:    'Not a protocol power. It decides which of the launches the homepage already shows gets the double-width card. The authorisation is a content credential, not the owner Safe, because nothing in it can reach a contract.',
    featTitle:         'HOMEPAGE FEATURE',
    featSubtitle:      'POST /api/admin/featured · off-chain, no transaction · expires on its own',
    featPinned:        'Pinned',
    featReading:       'reading…',
    featPinnedNone:    'nothing, computed order',
    featExpiresIn:     'Expires in',
    featNow:           'now',
    featFeaturedNow:   'Featured now',
    featNothingEligible: 'nothing eligible',
    featEligible:      'Eligible',
    featEligibleOne:   '1 launch',
    featEligibleMany:  '{n} launches',
    featPinnedHidden:  '${symbol} is pinned but is no longer one of the launches this block shows, so the pin is doing nothing. Its GENESIS has closed: it is awaiting launch, has launched, or ended with nothing sold. Clearing the pin costs nothing and removes the confusion.',
    featLaunchLabel:   'LAUNCH TO FEATURE',
    featSelectNone:    'nothing eligible to feature',
    featSelectPrompt:  'select a launch…',
    featOptionRaised:  '{raised} raised · funding',
    featPublishedHint: 'Launches appear once their creator has published metadata.',
    featCoverLabel:    'CARD COVER (OPTIONAL)',
    featCoverNone:     'none, built from the logo',
    featCoverSelectFirst: 'select a launch first',
    featUploading:     'Uploading…',
    featReplace:       'Replace',
    featUpload:        'Upload',
    featRemove:        'Remove',
    featSaveCover:     'Save cover only',
    featCoverHint:     '16:9, PNG / JPEG / WebP / GIF, up to {kb} KB. Saved with the pin, or on its own without touching the pin. Without one the card builds a cover from the logo.',
    featDurationLabel: 'FOR HOW LONG',
    featHours:         '{n}H',
    featDays:          '{n}D',
    featCredential:    'CONTENT ADMIN CREDENTIAL',
    featCredentialHint: 'Held for this tab only, never stored. Not the factory owner’s key: this credential cannot reach a contract.',
    featWorking:       'Working…',
    featPinFor:        'Pin for {h}h',
    featClearPin:      'Clear pin',
    featScope:         'This decides WHICH raise the homepage features, not eligibility. A pinned launch still has to be funding, so pinning cannot put a closed raise on the homepage. Setting a pin clears any other, and every pin lapses on its own, so a forgotten promotion returns the card to the newest v2 raise.',
    featCoverSize:     'The cover must be between 1 byte and {kb} KB.',
    featCoverFailed:   'Could not upload the cover.',
    featCoverSaved:    '{symbol} cover saved.',
    featCoverRemoved:  '{symbol} cover removed.',
    featPinCleared:    'Pin cleared. The homepage is back on its computed order.',
    featPinnedFor:     '{symbol} pinned for {h}h.',
    featPinnedForCover: '{symbol} pinned for {h}h, cover saved.',
    featPinFailed:     'Could not update the feature pin.',
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
 * `gate.connectReason` is neither.
 */
export const TIER0_SURFACES = ['tx', 'gate', 'nav', 'wallet', 'wrap'] as const

/** Where a Tier-0 gap fails the build rather than falling back. */
export const TIER0_REQUIRED_LOCALES = ['en', 'zh-CN'] as const
