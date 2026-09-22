'use client'
import { useState, useCallback, useEffect } from 'react'
import { parseUnits, formatUnits, type Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, ZERO_ADDRESS,
  QUOTE_DECIMALS, QUOTE_SYMBOL,
} from '@/lib/contracts'
import { resolveReferrerNow } from '@/lib/useReferral'
import { formatGasScanChainList } from '@/app/lib/gasScanCopy'
import {
  classifyHorizon, formatHorizonLabel, formatHorizonUtc,
  Card, Readout, Field, FieldAffix,
  ActionButton, useActionGate, revertOrder, useTxAction, useQuoteApproval,
} from '@/components/ui'
import { fmt, fmtQuote, fmtQuoteFull } from './format'
import { QuotaLedger, type QuotaBlock } from './QuotaLedger'
import { DepositSuccessDialog } from './DepositSuccessDialog'
import { usePogLookup } from './PogLookupProvider'

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
    const t = amount.trim()
    if (!t) return 0n
    try { return parseUnits(t, QUOTE_DECIMALS) } catch { return -1n }
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

  // One gateway from the raw stamp to anything that formats it, so a permanent
  // ban cannot reach `Date` and throw.  The horizon decides; the formatters
  // only ever see a value they have been told is representable.
  const banHorizon = classifyHorizon(p.blacklistedUntil, p.nowSec)
  const banTxt = formatHorizonLabel(banHorizon, {
    unbounded: 'PERMANENT · NO EXPIRY',
    elapsed:   'LAPSED',
    pending:   d => `LIFTS IN ${d}`,
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
    action: 'deposit',
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
    if (rem <= 0) return 'CLEAR'
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
  const gate = useActionGate({
    action: `Deposit ${QUOTE_SYMBOL}`,
    onAct: submitDeposit,
    tx: {
      isPending: isDepositing || pog.isPending,
      isConfirming: isDepositConfirming || pog.isConfirming,
      isBusy: txBusy || scanning || pog.registering,
    },
    blockersInRevertOrder: revertOrder(
      {
        id: 'amount-invalid',
        active: amountInvalid,
        label: 'Check the amount',
        reason: `That is not a number this field can send as ${QUOTE_SYMBOL}.`,
        tone: 'warn',
      },
      {
        id: 'amount-zero',
        active: !amountInvalid && amountWei === 0n,
        label: 'Enter an amount',
        reason: `Enter the amount of ${QUOTE_SYMBOL} to deposit.`,
        tone: 'neutral',
      },
      {
        id: 'blacklisted',
        active: banned,
        label: 'Wallet blocked',
        reason: `Deposits from this address are rejected while the ban stands · ${banTxt}.`,
      },
      {
        id: 'unattested',
        active: unattested,
        label: scanning
          ? 'Reading gas history…'
          : pog.registering
            ? 'Activating quota…'
            : scanEligible
              ? 'Activate deposit quota'
              : pog.phase === 'failed'
                ? 'Retry gas check'
                : pog.phase === 'ready'
                  ? 'Below gas floor'
                  : 'Check gas history',
        reason: scanning
          ? 'Reading lifetime gas across every supported chain. No signature required for this step.'
          : pog.registering
            ? 'Writing the deposit quota on-chain.'
            : scanEligible
              ? 'Gas history qualifies. Click to sign once and register the quota; Deposit unlocks after that lands.'
              : pog.phase === 'failed'
                ? (pog.error ?? 'The gas lookup failed. Click to try again.')
                : pog.phase === 'ready'
                  ? `This wallet’s historical gas is below the floor of ${fmt(BigInt(pog.scan!.floorWei))} ETH, so no deposit quota can be sized.`
                  : 'Proof-of-Gas sizes your deposit quota from lifetime gas spend. Click to read it — one request, no signature and no gas.',
        tone: 'warn',
        resolve: scanning || pog.registering
          ? undefined
          : scanEligible
            ? () => { void pog.registerQuota() }
            : pog.phase === 'failed'
              ? () => { void pog.startLookup(true) }
              : pog.phase === 'ready' && pog.scan
                ? () => { pog.setDialogOpen(true) }
                // Idle, i.e. nothing has been read for this wallet yet. This
                // used to be unreachable because connecting started the scan;
                // now it is the entry point, so it must offer the action rather
                // than describe a wait that will never end on its own.
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
        label: capSpentForThisRound ? 'Already deposited' : `Cooldown · ${cooldownTxt}`,
        reason: capSpentForThisRound
          ? `This project takes one deposit per wallet, and yours has landed · ${fmtQuote(p.userDeposited)} ${QUOTE_SYMBOL} committed. The cooldown outlasts the genesis window, so there is no second deposit to wait for.`
          : `Deposits from this wallet to this project are on cooldown for another ${cooldownTxt}.`,
        tone: 'warn',
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
        label: 'Reading your allowance…',
        reason: 'Waiting on this wallet’s attestation and deposit window from the factory.',
      },
      {
        id: 'quota-exceeded',
        active: quotaBreached,
        label: 'Over your limit',
        reason: `That is more than this wallet may deposit in the current window · ${fmtQuote(quotaRemaining)} ${QUOTE_SYMBOL} left.`,
      },
      {
        id: 'window-closed',
        active: windowClosed,
        label: 'Funding closed',
        reason: 'The genesis window has closed, and no further deposits are accepted.',
        tone: 'warn',
      },
      {
        id: 'wallet-cap',
        active: walletCapBreached,
        label: `Over the wallet cap · ${fmtQuote(walletHeadroom)} ${QUOTE_SYMBOL} left`,
        reason: `That is more than this project allows one wallet to hold · ${fmtQuote(walletHeadroom)} ${QUOTE_SYMBOL} left for you.`,
      },
      {
        id: 'balance',
        active: insufficientBal,
        label: `Not enough ${QUOTE_SYMBOL}`,
        reason: `This wallet does not hold that much ${QUOTE_SYMBOL}.`,
        tone: 'warn',
      },
      {
        // LAST, so it wins over everything above — and that ordering is the whole
        // point of putting it here rather than higher up. `revertOrder` surfaces
        // the last active blocker, and a depositor who is over their quota AND
        // unapproved should be told about the quota, because approving would not
        // help. Once the amount is actually depositable, this is the only thing
        // left in the way, and it is a click.
        id: 'approve',
        active:
          !amountInvalid && amountWei > 0n && !insufficientBal
          && !quotaBreached && !walletCapBreached && approval.needsApproval,
        label: approval.tx.isBusy
          ? 'Approving…'
          : `Approve ${fmtQuote(amountWei)} ${QUOTE_SYMBOL}`,
        reason: `${QUOTE_SYMBOL} is pulled rather than sent, so the factory needs your permission for this exact amount before it can take it. Approving authorises only this deposit — change the amount and it has to be approved again.`,
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
      amountInvalid     ? 'NOT A NUMBER'
    : quotaBreached     ? 'ABOVE YOUR REMAINING WINDOW'
    : walletCapBreached ? 'ABOVE THIS PROJECT’S WALLET CAP'
    : insufficientBal   ? 'ABOVE YOUR BALANCE'
    : null

  return (
    <div className="flex flex-col">
      {/* Anchored so the referral desk can point at it. Both of that panel's
          "your link pays nothing yet" fixes — register PoG, hold a deposit here
          — are actions on this card, and naming them without a way to reach
          them left the reader to scroll and guess. */}
      <Card
        id="DEPOSIT"
        title={`Deposit ${QUOTE_SYMBOL}`}
        subtitle="Into this project's genesis window. The raise stays open until the clock runs out."
        interactive={false}
      >
        {windowClosed && (
          <p className="font-mono text-label tracking-[0.32em] uppercase text-warning leading-relaxed">
            → WINDOW CLOSED · NO FURTHER DEPOSITS ACCEPTED
          </p>
        )}

        {banned && (
          <div className="border border-danger/40 px-4 py-3 flex flex-col gap-1">
            <p className="font-mono text-label tracking-[0.32em] uppercase text-danger">
              → WALLET BLACKLISTED · {banTxt}
            </p>
            <p className="font-mono text-note text-text-tertiary leading-relaxed">
              The factory rejects every <span className="text-text-primary">deposit</span> from this
              address while the ban stands, whatever quota it holds — so the zero here is a
              ban, not a spent allowance.{' '}
              {banLiftsAt
                ? <>The ban expires on its own at <span className="text-text-primary">{banLiftsAt}</span>, after
                   which the quota is spendable again with nothing to reset.</>
                : <>Only the protocol owner can clear a permanent ban.</>}
            </p>
          </div>
        )}

        {unattested && (
          <div className="border border-warning/40 px-4 py-3 flex flex-col gap-1">
            <p className="font-mono text-label tracking-[0.32em] uppercase text-warning">
              {scanning
                ? '→ READING GAS HISTORY'
                : scanEligible
                  ? '→ GAS HISTORY QUALIFIES'
                  : pog.phase === 'ready'
                    ? '→ BELOW GAS FLOOR'
                    : '→ NO POG ATTESTATION ON FILE'}
            </p>
            <p className="font-mono text-note text-text-tertiary leading-relaxed">
              {scanning
                ? <>Connected — looking up this address&apos;s lifetime gas on {formatGasScanChainList()}. No wallet signature is asked
                  for this read.</>
                : scanEligible
                  ? <>Eligible for a deposit quota. Activate it once (signature +
                    on-chain registration), then Deposit works normally — no separate
                    gas-scan click.</>
                  : pog.phase === 'ready' && pog.scan
                    ? <>Historical gas is {fmt(BigInt(pog.scan.totalGasWei))} ETH against
                      a floor of {fmt(BigInt(pog.scan.floorWei))} ETH. Open the breakdown
                      for per-chain figures.</>
                    : <>This wallet has never registered Proof-of-Gas, so it holds no
                      quota to spend. The gas lookup starts automatically when you
                      connect.</>}
            </p>
            {pog.scan && pog.phase === 'ready' && (
              <button
                type="button"
                onClick={() => pog.setDialogOpen(true)}
                className="mt-1 self-start font-mono text-label tracking-[0.2em] uppercase
                           text-brand hover:underline"
              >
                View per-chain breakdown
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
            <Readout label={`${QUOTE_SYMBOL} BALANCE`}
                     value={`${fmtQuote(p.quoteBalance)} ${QUOTE_SYMBOL}`}
                     hint={fmtQuoteFull(p.quoteBalance)} />
            <Readout label="COOLDOWN"
                     value={cooldownTxt}
                     tone={onCooldown ? 'mute' : 'ink'} />
          </div>
        )}

        {p.referrer !== ZERO_ADDRESS && (
          <Readout
            label="REFERRED BY"
            value={`${p.referrer.slice(0, 10)}…${p.referrer.slice(-6)}`}
            hint="bound platform-wide on your first deposit · 10% of it credits them"
            tone="ok"
          />
        )}

        <Field
          label={`DEPOSIT AMOUNT · ${QUOTE_SYMBOL}`}
          value={amount}
          onValueChange={setAmount}
          placeholder="e.g. 0.05"
          inputMode="decimal"
          disabled={txBusy || !p.isConnected || windowClosed || banned || unattested}
          error={amountError}
          armed={armed}
          hint={p.perWalletCap > 0n
            ? capSpentForThisRound
              ? `ONE DEPOSIT PER WALLET · YOU COMMITTED ${fmtQuote(p.userDeposited)} ${QUOTE_SYMBOL} AND THIS ROUND TAKES NO MORE FROM YOU`
              : `THIS PROJECT ALLOWS ${fmtQuote(p.perWalletCap)} ${QUOTE_SYMBOL} PER WALLET · ${fmtQuote(walletHeadroom)} ${QUOTE_SYMBOL} LEFT FOR YOU`
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
