'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { parseUnits, formatUnits, type Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, ZERO_ADDRESS,
  QUOTE_DECIMALS, QUOTE_SYMBOL,
} from '@/lib/contracts'
import { resolveReferrerNow } from '@/lib/useReferral'
import { Emph, fill, useT } from '@/i18n'
import { formatGasScanChainList } from '@/app/lib/gasScanCopy'
import {
  classifyHorizon, formatHorizonLabel, formatHorizonUtc,
  Card, Readout, Field, FieldAffix,
  ActionButton, useActionGate, revertOrder, useTxAction, useQuoteApproval,
} from '@/components/ui'
import { fmt, fmtQuote, fmtQuoteFull } from './format'
import { QuotaLedger, type QuotaBlock } from './QuotaLedger'
import { GenesisIneligible } from './GenesisIneligible'
import { DepositSuccessDialog } from './DepositSuccessDialog'
import { usePogLookup } from './PogLookupProvider'
import { shouldAutoScan } from './pogAutoScan'

// ─────────────────────────────────────────────────────────────────────────────
// GENESIS PANEL  ·  Phase 1
// ─────────────────────────────────────────────────────────────────────────────

export interface GenesisProps {
  hookAddress:        Address
  symbol:             string
  userAddress:        Address | undefined
  isConnected:        boolean
  totalNativeDeposited:  bigint
  quoteBalance:         bigint
  /// `undefined` while the read is in flight, and that is NOT the same as `0n`.
  /// Zero means "this wallet has no attestation" and is a definite refusal; the
  /// panel must not make that claim, nor lock the Deposit button, on a read that
  /// has not landed. See `quotaKnown` below.
  pogQuota:           bigint | undefined
  /// Straight from `factory.eligibility(user, hook)`.  The quota is refilled
  /// once per `quotaWindowDuration`, and only the factory can tell whether a
  /// lapsed window has already been credited back, so this is never derived
  /// client-side from a cumulative deposit total.
  ///
  /// `undefined` while pending, on the same reasoning: a zero here reads as
  /// "your window is spent" and would refuse an amount the factory would accept.
  quotaRemaining:     bigint | undefined
  /// `eligibility` short-circuits on a ban and on a missing attestation into the
  /// same `(false, 0, 0)` an exhausted window produces, so the ban stamp is read
  /// alongside `pogQuota` to tell the three apart.
  blacklistedUntil:   bigint
  cooldownEnd:        bigint
  nowSec:             number
  /// This project's own deposit ceiling per wallet, snapshotted into the hook
  /// at creation.  Distinct from the platform-wide PoG quota above: the hook
  /// rejects on whichever binds first.
  perWalletCap:       bigint
  userDeposited:      bigint
  genesisDeadline:    bigint
  /// Lifetime referrer bound to this visitor, or the zero sentinel.  Passed
  /// straight through to `factory.deposit`; the factory ignores it when the
  /// wallet is already bound, so a stale link can never brick a deposit.
  referrer:           Address
  refetch:            () => void
}

export function GenesisPanel(p: GenesisProps) {
  const t = useT()
  const [amount, setAmount] = useState('')

  /**
   * This wallet's stake once the confirmed deposit is counted, or `null` while
   * there is nothing to celebrate.
   *
   * Carried as the figure rather than as a boolean because `p.userDeposited`
   * cannot answer the question at the moment the dialog opens: it comes off the
   * terminal's 12s bulk poll, and the refetch that will update it has only just
   * been asked for. Adding the amount that was just sent is exact and needs no
   * round trip.
   */
  const [stakeAfterDeposit, setStakeAfterDeposit] = useState<bigint | null>(null)

  const amountWei = (() => {
    const raw = amount.trim()
    if (!raw) return 0n
    try { return parseUnits(raw, QUOTE_DECIMALS) } catch { return -1n }
  })()
  const amountInvalid = amountWei === -1n

  // `factory.deposit` rejects in a fixed order — IsBlacklisted, then NoPogQuota,
  // then the cooldown, then the window budget — and `eligibility` collapses the
  // first two into the same zero the last one produces.  Mirror that order here
  // so a ban never reads as an allowance the user can simply wait out.
  //
  // ⚠ EVERY ONE OF THESE IS A DEFINITE REFUSAL, so none may be asserted from a
  //   read that has not landed. `quotaKnown` is the gate: while either the
  //   attestation or the eligibility tuple is in flight the panel says it is
  //   still reading, rather than picking the pessimistic reading of a `0n` it
  //   invented. Both false negatives were live — an attested wallet was shown
  //   NO ATTESTATION with Deposit locked, and a wallet with a full window was
  //   told its amount was above the headroom it had not been told about yet.
  const quotaKnown      = p.pogQuota !== undefined && p.quotaRemaining !== undefined
  const banned          = p.blacklistedUntil > 0n && BigInt(p.nowSec) < p.blacklistedUntil
  const unattested      = p.isConnected && !banned && quotaKnown && p.pogQuota === 0n
  const onCooldown      = !banned && !unattested
                       && p.cooldownEnd > 0n && BigInt(p.nowSec) < p.cooldownEnd
  const quotaBlock: QuotaBlock = banned
    ? 'banned'
    : unattested ? 'unattested'
    : onCooldown ? 'cooldown'
    : null

  const pog = usePogLookup()
  const bindRefetch = pog.bindRefetch
  useEffect(() => bindRefetch(p.refetch), [bindRefetch, p.refetch])

  const scanEligible = Boolean(pog.scan?.eligible)
  const scanning = pog.phase === 'scanning'

  /**
   * Read the gas history as soon as quota is the thing standing between this
   * wallet and a deposit.
   *
   * Requiring a click for this was a reaction to the right problem in the wrong
   * place. The cost came from `PogLookupProvider` being mounted in
   * `app/providers.tsx`: connecting a wallet anywhere — to read the homepage, to
   * check a referral — started a scan nobody had asked for, and that is what
   * exhausted the budget. Starting it here instead fixes that at the source,
   * because this gate renders only on a project page and only once `pogQuota`
   * has been read as zero. Making the reader click was the wrong half of the fix:
   * it charged them for our accounting mistake, and it asked them to know they
   * needed a thing the page had not yet told them about.
   *
   * Keyed on the wallet so switching accounts reads the new one, and guarded by
   * it so a re-render cannot start a second scan for the same wallet. `phase` is
   * read but deliberately not the trigger: it leaves `idle` the moment a scan
   * starts, and re-firing when it returns there after a failure would turn one
   * dead upstream host into an unbounded retry loop. Retrying is the button's
   * job, and the button is the reader's.
   */
  const autoScanFor = useRef<string | null>(null)
  const startLookup = pog.startLookup
  useEffect(() => {
    if (!shouldAutoScan({
      unattested,
      wallet: pog.userAddress,
      phase: pog.phase,
      startedFor: autoScanFor.current,
    })) return
    autoScanFor.current = pog.userAddress!.toLowerCase()
    void startLookup(false)
  }, [unattested, pog.userAddress, pog.phase, startLookup])

  // One gateway from the raw stamp to anything that formats it, so a permanent
  // ban cannot reach `Date` and throw.  The horizon decides; the formatters
  // only ever see a value they have been told is representable.
  const banHorizon = classifyHorizon(p.blacklistedUntil, p.nowSec)
  const banTxt = formatHorizonLabel(banHorizon, {
    unbounded: t.deposit.banPermanentStamp,
    elapsed:   t.deposit.banLapsedStamp,
    pending:   d => fill(t.deposit.banLiftsInStamp, { d }),
  })
  const banLiftsAt = formatHorizonUtc(banHorizon)

  // Coalesced only AFTER `quotaKnown` has been decided, so the zero below can
  // never reach a refusal — it only feeds display and the `spendable` ceiling,
  // both of which read as "nothing offered yet" rather than as a verdict.
  const quotaRemaining  = p.quotaRemaining ?? 0n
  const quotaBreached   = quotaKnown && quotaBlock === null
                       && amountWei > 0n && amountWei > quotaRemaining
  const insufficientBal = amountWei > 0n && amountWei > p.quoteBalance

  // ⚠ THE "OVERSUBSCRIBED" BANNER IS GONE, along with the soft cap it was
  //   measured against. It fired when the raise passed `softCap` and said the
  //   target was cleared but deposits stayed open — true, and an answer to a
  //   question the product no longer poses. Nothing is subscribed to: the raise
  //   has no target, nothing happens at any particular figure, and a banner
  //   celebrating one implied a threshold the contract does not consult.
  //
  //   The panel keeps the two limits that are real and reachable — the window
  //   closing, and this wallet's per-project cap — because those stop a
  //   deposit. The soft cap never did.

  // The hook rejects `deposit` outright once the window closes, and separately
  // once this wallet's total for THIS project passes the per-project cap.
  // Neither was mirrored here, so both surfaced only as a reverted transaction.
  const windowClosed  = p.genesisDeadline > 0n && BigInt(p.nowSec) >= p.genesisDeadline
  const walletHeadroom = p.perWalletCap > p.userDeposited
    ? p.perWalletCap - p.userDeposited
    : 0n

  /**
   * Whether this wallet's deposit was its only one for this project.
   *
   * ⚠ HEADROOM STOPPED MEANING "AVAILABLE" WHEN THE COOLDOWN WENT TO 72 h. The
   *   cooldown is per-(wallet, hook) and now runs at least as long as the
   *   longest genesis, so a wallet's second deposit cannot land inside the
   *   window its first one was made in. `perWalletCap - userDeposited` is still
   *   arithmetically right and is no longer an offer: the field was telling a
   *   depositor "41.4 BEM LEFT FOR YOU" about a project that would reject every
   *   one of them.
   *
   *   Derived from the two timestamps rather than from the dial, so it stays
   *   true if an owner lowers `cooldownDuration` again — at which point the
   *   headroom really is spendable and the copy goes back to offering it, with
   *   no code change and nothing to remember.
   */
  const capSpentForThisRound = p.userDeposited > 0n
                            && p.cooldownEnd >= p.genesisDeadline
                            && p.genesisDeadline > 0n
  const walletCapBreached = p.perWalletCap > 0n && amountWei > 0n && amountWei > walletHeadroom

  /**
   * The floor has answered, and the answer is no.
   *
   * Kept as one named boolean because it is the only state on this panel that is
   * a REFUSAL rather than a step — every other blocker here is something the
   * reader can clear by typing less, waiting, approving or signing. This one
   * cannot be cleared from this page at all, and that difference is what the
   * panel got wrong: it rendered a refusal as a form with a missing field.
   *
   * `pog.scan` is required, not just the phase. `ready` without a payload would
   * make `scanEligible` false by coalescing, and refusing a wallet on a result
   * that never arrived is the same class of bug as the one this replaces.
   *
   * ⚠ YIELDS TO A CLOSED WINDOW, which is why this cannot be derived up beside
   *   `unattested` where it reads more naturally. A raise that has ended refuses
   *   every wallet, so it is both the more immediate fact and the one the reader
   *   needs first; taking over the whole panel to discuss a gas floor would
   *   answer a question about this project by talking only about the wallet, and
   *   leave the reader to work out from a missing button that the raise is over.
   *   Below the floor AND past the deadline therefore keeps the ordinary panel,
   *   where the closed-window banner and the gas callout can both be seen.
   */
  const belowFloor = unattested
                  && !windowClosed
                  && pog.phase === 'ready'
                  && pog.scan !== undefined
                  && !scanEligible

  /**
   * Whether `walletHeadroom` may be described as an OFFER, or is only arithmetic.
   *
   * The two are not the same sentence. `perWalletCap - userDeposited` is always
   * computable, and the field hint was always spending it: a wallet with no
   * attestation, a ban, or a closed window still read
   * `46.4 BEM LEFT FOR YOU` — a promise about a deposit that could not be made,
   * printed directly under an input that had been disabled for the same reason.
   *
   * ⚠ THE SUBJECT IS THE DIFFERENCE. "This project allows 46.4 per wallet" is a
   *   fact about the project and stays true for everyone, including visitors who
   *   have not connected. "46.4 left FOR YOU" is a claim about the reader, and
   *   it must not be made on a wallet the panel is simultaneously refusing.
   */
  const headroomIsOffered = p.isConnected && !banned && !unattested && !windowClosed

  // The binding ceiling is whichever of the two runs out first.
  const spendable = (() => {
    let cap = quotaRemaining
    if (p.perWalletCap > 0n && walletHeadroom < cap) cap = walletHeadroom
    return cap < p.quoteBalance ? cap : p.quoteBalance
  })()

  const {
    send: sendDeposit,
    isPending: isDepositing,
    isConfirming: isDepositConfirming,
    isBusy: txBusy,
  } = useTxAction({
    action: t.deposit.txAction,
    onConfirmed: () => {
      // Before `setAmount('')` clears the field this reads from.
      setStakeAfterDeposit(p.userDeposited + (amountWei > 0n ? amountWei : 0n))
      p.refetch()
      setAmount('')
    },
  })

  const submitDeposit = useCallback(() => {
    sendDeposit({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: 'deposit',
      // Resolved at send time, not at render time: the factory binds each slot
      // once and forever, and `p.referrer` is still the zero sentinel on the
      // first frame after mount. The hook address selects this project's slot,
      // which takes precedence over the lifetime one.
      // The amount is an ARGUMENT now, not `value`. `deposit` is no longer
      // payable: it pulls `amount` from the depositor with `transferFrom`, so the
      // figure that used to fund the call is the third parameter and the funding
      // comes from the allowance approved below.
      args: [p.hookAddress, resolveReferrerNow(p.userAddress, p.hookAddress), amountWei],
    })
  }, [p.hookAddress, p.userAddress, amountWei, sendDeposit])

  /*
   * The allowance in front of the deposit.
   *
   * Granted to the FACTORY rather than to the hook, which is not obvious and is
   * worth stating: a depositor interacts with a project, and the natural guess is
   * that the project's hook takes the money. It does not. `factory.deposit`
   * receives the transfer and forwards it, so the factory is the spender and an
   * allowance given to the hook would sit there unused while the deposit reverted.
   *
   * Exact, so nothing outlives the deposit. It also means the approve has to be
   * re-sent whenever the amount in the field changes, which is why it is keyed off
   * `amountWei` and not off some once-per-session ceiling.
   */
  const approval = useQuoteApproval(FACTORY_ADDRESS, amountWei > 0n ? amountWei : 0n)

  const cooldownTxt = (() => {
    if (p.cooldownEnd === 0n) return '—'
    const rem = Number(p.cooldownEnd) - p.nowSec
    if (rem <= 0) return t.deposit.cooldownClear
    const h = Math.floor(rem / 3600)
    const m = Math.floor((rem % 3600) / 60)
    const s = rem % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  })()

  // Ordered to match the chain, not the screen.  `factory.deposit` rejects in
  // exactly this sequence — blacklist, missing quota, cooldown, quota exceeded —
  // and then hands off to `hook.deposit`, which checks the window before the
  // per-wallet cap.  The cascade this replaces had `onCooldown` sitting after
  // `quotaBreached`, so a wallet that was both cooling down and over budget was
  // told its window was spent when the transaction would actually have reverted
  // `CooldownActive`: "you have none left" instead of "wait out the cooldown".
  //
  // ⚠ THE FIRST ACTIVE BLOCKER WINS — `useActionGate` does `.find(b => b.active)`.
  //   A comment here used to claim `revertOrder` surfaced the LAST one, which is
  //   false, and believing it is how the ordering below went wrong: `approve`
  //   sits at the bottom and works only because its own `active` excludes every
  //   case that should outrank it, not because of where it sits.
  //
  // ⚠ WITHIN the revert order, STATES THE READER CANNOT CLEAR BY TYPING COME
  //   FIRST. This is the fix for a contradiction that reached production: the
  //   amount nags used to head the list, so a wallet with a closed window, a
  //   ban, no attestation or a live cooldown — every one of which disables the
  //   field — was told to "Enter an amount" into the input it had just been
  //   locked out of. The button was asking for something the page had made
  //   impossible, and a reader resolves that by retrying, which is how repeated
  //   gas scans exhausted the shared PoG budget and took the funnel down.
  //
  //   So: window, ban, attestation and cooldown, THEN the amount, then the
  //   limits the amount is measured against. Any blocker that appears in the
  //   field's `disabled` expression belongs above `amount-zero`.
  const gate = useActionGate({
    action: fill(t.deposit.cta, { quote: QUOTE_SYMBOL }),
    onAct: submitDeposit,
    tx: {
      isPending: isDepositing || pog.isPending,
      isConfirming: isDepositConfirming || pog.isConfirming,
      isBusy: txBusy || scanning || pog.registering,
    },
    blockersInRevertOrder: revertOrder(
      {
        // First, because it outranks everything including the ban: once the
        // window shuts nothing else about this wallet can change the outcome.
        id: 'window-closed',
        active: windowClosed,
        label: t.deposit.windowClosedLabel,
        reason: t.deposit.windowClosedReason,
        tone: 'warn',
      },
      {
        id: 'blacklisted',
        active: banned,
        label: t.deposit.bannedLabel,
        reason: fill(t.deposit.bannedReason, { stamp: banTxt }),
      },
      {
        id: 'unattested',
        active: unattested,
        label: scanning
          ? t.deposit.pogScanningLabel
          : pog.registering
            ? t.deposit.pogRegisteringLabel
            : scanEligible
              ? t.deposit.pogActivateLabel
              : pog.phase === 'failed'
                ? t.deposit.pogRetryLabel
                : pog.phase === 'ready'
                  ? t.deposit.pogBelowFloorLabel
                  : t.deposit.pogCheckLabel,
        reason: scanning
          ? t.deposit.pogScanningReason
          : pog.registering
            ? t.deposit.pogRegisteringReason
            : scanEligible
              ? t.deposit.pogActivateReason
              // `pog.error` comes off the API and is not ours to translate; the
              // dictionary line is the fallback for when it arrives empty.
              : pog.phase === 'failed'
                ? (pog.error ?? t.deposit.pogRetryReason)
                : pog.phase === 'ready'
                  ? fill(t.deposit.pogBelowFloorReason, { floor: fmt(BigInt(pog.scan!.floorWei)) })
                  : t.deposit.pogCheckReason,
        tone: 'warn',
        resolve: scanning || pog.registering
          ? undefined
          : scanEligible
            ? () => { void pog.registerQuota() }
            : pog.phase === 'failed'
              ? () => { void pog.startLookup(true) }
              : pog.phase === 'ready' && pog.scan
                ? () => { pog.setDialogOpen(true) }
                // Idle, i.e. nothing has been read for this wallet yet. The
                // effect above normally starts that read on mount, so this is
                // the narrow fallback for when it cannot — no wallet yet, or a
                // scan already started once for this one — and it stays an
                // action rather than describing a wait that may never end.
                : () => { void pog.startLookup(false) },
      },
      {
        id: 'cooldown',
        active: onCooldown,
        // Two different facts wear the same countdown. While the cooldown ends
        // before the window does, it is a wait and saying "another 04:12:​09"
        // tells the reader what to do. Once it ends at or after the deadline it
        // is not a wait at all — nothing the reader can do will make it clear in
        // time — and a countdown there reads as an invitation to come back,
        // which is the one thing that will not work.
        label: capSpentForThisRound
          ? t.deposit.alreadyDepositedLabel
          : fill(t.deposit.cooldownLabelWaiting, { left: cooldownTxt }),
        reason: capSpentForThisRound
          ? fill(t.deposit.alreadyDepositedReason, {
              committed: fmtQuote(p.userDeposited), quote: QUOTE_SYMBOL,
            })
          : fill(t.deposit.cooldownReasonWaiting, { left: cooldownTxt }),
        tone: 'warn',
      },
      // ── Everything above is a state of the WALLET or the RAISE, and none of it
      //    is affected by what is in the field. Everything below is about the
      //    number, so it only makes sense once the wallet could deposit at all.
      {
        id: 'amount-invalid',
        active: amountInvalid,
        label: t.deposit.amountInvalidLabel,
        reason: fill(t.deposit.amountInvalidReason, { quote: QUOTE_SYMBOL }),
        tone: 'warn',
      },
      {
        id: 'amount-zero',
        active: !amountInvalid && amountWei === 0n,
        label: t.deposit.amountZeroLabel,
        reason: fill(t.deposit.amountZeroReason, { quote: QUOTE_SYMBOL }),
        tone: 'neutral',
      },
      {
        // Sits where the quota check sits in the factory's own order, because
        // that is the check it stands in for. Not arming is the point: with the
        // attestation or the window still in flight nothing here can tell a
        // depositable amount from one the factory will reject, and a Deposit
        // sent on that guess reverts `NoPogQuota` after the user has paid gas.
        //
        // `approve` below still outranks it, which is wanted — approving is
        // useful, harmless and unrelated to eligibility, so the first 12s offer
        // that rather than a spinner.
        id: 'quota-pending',
        active: p.isConnected && !banned && !quotaKnown && amountWei > 0n,
        label: t.deposit.quotaPendingLabel,
        reason: t.deposit.quotaPendingReason,
      },
      {
        id: 'quota-exceeded',
        active: quotaBreached,
        label: t.deposit.quotaExceededLabel,
        reason: fill(t.deposit.quotaExceededReason, {
          left: fmtQuote(quotaRemaining), quote: QUOTE_SYMBOL,
        }),
      },
      {
        id: 'wallet-cap',
        active: walletCapBreached,
        label: fill(t.deposit.walletCapLabel, {
          left: fmtQuote(walletHeadroom), quote: QUOTE_SYMBOL,
        }),
        reason: fill(t.deposit.walletCapReason, {
          left: fmtQuote(walletHeadroom), quote: QUOTE_SYMBOL,
        }),
      },
      {
        id: 'balance',
        active: insufficientBal,
        label: fill(t.deposit.notEnoughLabel, { quote: QUOTE_SYMBOL }),
        reason: fill(t.deposit.notEnoughReason, { quote: QUOTE_SYMBOL }),
        tone: 'warn',
      },
      {
        // LAST, and it is the `active` expression below — NOT this position —
        // that makes it yield to the limits above it. The first active blocker
        // wins, so sitting at the bottom would otherwise mean losing every
        // contest; the exclusions are there because a depositor who is over
        // their quota AND unapproved must be told about the quota, since
        // approving would not help. Once the amount is actually depositable
        // nothing above is active, this is the only thing left, and it is a click.
        id: 'approve',
        active:
          !amountInvalid && amountWei > 0n && !insufficientBal
          && !quotaBreached && !walletCapBreached && approval.needsApproval,
        label: approval.tx.isBusy
          ? t.deposit.approvingLabel
          : fill(t.deposit.approveLabel, {
              amount: fmtQuote(amountWei), quote: QUOTE_SYMBOL,
            }),
        reason: fill(t.deposit.approveReason, { quote: QUOTE_SYMBOL }),
        tone: 'info',
        resolve: approval.approve,
      },
    ),
  })

  const armed = gate.verdict.kind === 'ready'

  // Terse, and only about the number that was typed.  The gate states every
  // blocker in full under the button, and the three wallet-level states — ban,
  // missing attestation, closed window — each already have a bordered callout
  // above this input, so neither is repeated here.  What is left is the red
  // border and a short tag; the explanation and the remedy live with the button.
  const amountError =
      amountInvalid     ? t.deposit.errNotANumber
    : quotaBreached     ? t.deposit.errOverWindow
    : walletCapBreached ? t.deposit.errOverCap
    : insufficientBal   ? t.deposit.errOverBalance
    : null

  /**
   * A refusal REPLACES the form rather than greying it out. See
   * `GenesisIneligible` for why that distinction cost us an outage.
   *
   * Deliberately below every hook above, so both branches run the identical
   * hook sequence — this is a render switch, not an early exit from the
   * component's state. Moving it up would break the rules of hooks the moment
   * a scan lands and flips the branch mid-session, which is the normal case.
   *
   * `pog.scan` is re-tested only to narrow the type; `belowFloor` already
   * requires it.
   */
  if (belowFloor && pog.scan) {
    return (
      <GenesisIneligible
        totalGasWei={BigInt(pog.scan.totalGasWei)}
        floorWei={BigInt(pog.scan.floorWei)}
        onOpenBreakdown={() => pog.setDialogOpen(true)}
      />
    )
  }

  return (
    <div className="flex flex-col">
      {/* Anchored so the referral desk can point at it. Both of that panel's
          "your link pays nothing yet" fixes — register PoG, hold a deposit here
          — are actions on this card, and naming them without a way to reach
          them left the reader to scroll and guess. */}
      <Card
        id="DEPOSIT"
        title={fill(t.deposit.title, { quote: QUOTE_SYMBOL })}
        subtitle={t.deposit.subtitle}
        interactive={false}
      >
        {windowClosed && (
          <p className="font-mono text-label tracking-[0.32em] uppercase text-warning leading-relaxed">
            {t.deposit.bannerWindowClosed}
          </p>
        )}

        {banned && (
          <div className="border border-danger/40 px-4 py-3 flex flex-col gap-1">
            <p className="font-mono text-label tracking-[0.32em] uppercase text-danger">
              {fill(t.deposit.bannerBanned, { stamp: banTxt })}
            </p>
            <p className="font-mono text-note text-text-tertiary leading-relaxed">
              <Emph text={t.deposit.banBody} />{' '}
              {banLiftsAt
                ? <Emph text={fill(t.deposit.banExpires, { when: banLiftsAt })} />
                : t.deposit.banPermanent}
            </p>
          </div>
        )}

        {unattested && (
          <div className="border border-warning/40 px-4 py-3 flex flex-col gap-1">
            <p className="font-mono text-label tracking-[0.32em] uppercase text-warning">
              {scanning
                ? t.deposit.bannerScanning
                : scanEligible
                  ? t.deposit.bannerQualifies
                  : pog.phase === 'ready'
                    ? t.deposit.bannerBelowFloor
                    : t.deposit.bannerNoPog}
            </p>
            <p className="font-mono text-note text-text-tertiary leading-relaxed">
              {scanning
                ? fill(t.deposit.bodyScanning, { chains: formatGasScanChainList() })
                : scanEligible
                  ? t.deposit.bodyQualifies
                  : pog.phase === 'ready' && pog.scan
                    ? fill(t.deposit.bodyBelowFloor, {
                        gas: fmt(BigInt(pog.scan.totalGasWei)),
                        floor: fmt(BigInt(pog.scan.floorWei)),
                      })
                    : t.deposit.bodyNoPog}
            </p>
            {pog.scan && pog.phase === 'ready' && (
              <button
                type="button"
                onClick={() => pog.setDialogOpen(true)}
                className="mt-1 self-start font-mono text-label tracking-[0.2em] uppercase
                           text-brand hover:underline"
              >
                {t.ineligible.breakdown}
              </button>
            )}
          </div>
        )}

        {/* Gated on `quotaKnown` rather than drawn with the coalesced zero: a
            ledger reading 0 / 0 is a statement about this wallet, and it was
            being made before either figure had arrived. */}
        {p.isConnected && quotaKnown && (
          <QuotaLedger
            quota={p.pogQuota ?? 0n}
            remaining={quotaRemaining}
            projected={amountWei > 0n ? amountWei : 0n}
            blocked={quotaBlock}
          />
        )}

        {p.isConnected && (
          <div className="grid grid-cols-1 @sm:grid-cols-2 gap-x-6">
            <Readout label={fill(t.deposit.balanceReadout, { quote: QUOTE_SYMBOL })}
                     value={`${fmtQuote(p.quoteBalance)} ${QUOTE_SYMBOL}`}
                     hint={fmtQuoteFull(p.quoteBalance)} />
            <Readout label={t.deposit.cooldownLabel}
                     value={cooldownTxt}
                     tone={onCooldown ? 'mute' : 'ink'} />
          </div>
        )}

        {p.referrer !== ZERO_ADDRESS && (
          <Readout
            label={t.deposit.referredBy}
            value={`${p.referrer.slice(0, 10)}…${p.referrer.slice(-6)}`}
            hint={t.deposit.referredHint}
            tone="ok"
          />
        )}

        <Field
          label={fill(t.deposit.amountLabel, { quote: QUOTE_SYMBOL })}
          value={amount}
          onValueChange={setAmount}
          placeholder={t.deposit.amountPlaceholder}
          inputMode="decimal"
          disabled={txBusy || !p.isConnected || windowClosed || banned || unattested}
          error={amountError}
          armed={armed}
          hint={p.perWalletCap > 0n
            ? capSpentForThisRound
              ? fill(t.deposit.hintOneAndDone, {
                  committed: fmtQuote(p.userDeposited), quote: QUOTE_SYMBOL,
                })
              : headroomIsOffered
                ? fill(t.deposit.hintCapAndYours, {
                    cap: fmtQuote(p.perWalletCap), left: fmtQuote(walletHeadroom),
                    quote: QUOTE_SYMBOL,
                  })
                // The project's ceiling without the personal claim. Same figure,
                // and it is the only half of it this wallet has earned.
                : fill(t.deposit.hintCapOnly, {
                    cap: fmtQuote(p.perWalletCap), quote: QUOTE_SYMBOL,
                  })
            : undefined}
          affix={
            <FieldAffix
              onClick={() => setAmount(formatUnits(spendable, QUOTE_DECIMALS))}
              disabled={txBusy || !p.isConnected || windowClosed || spendable === 0n}
            />
          }
        />

        {/* A FOUR-CHIP ROW USED TO SIT HERE — 25 / 50 / 75 / MAX of
            `spendable`. MAX is already the affix on the field above, so the
            row's fourth chip was a second copy of the same click, and the
            other three were guesses at a fraction. The binding ceiling is
            whichever of quota, wallet headroom and balance runs out first;
            that number is what `max` writes, and a percentage of it is a
            number the user can type if they want less. */}

        <div className="flex gap-3 flex-wrap items-start">
          <ActionButton gate={gate} size="lg" />
        </div>
      </Card>

      <DepositSuccessDialog
        open={stakeAfterDeposit !== null}
        onClose={() => setStakeAfterDeposit(null)}
        userAddress={p.userAddress}
        symbol={p.symbol}
        deposited={stakeAfterDeposit ?? 0n}
      />
    </div>
  )
}
