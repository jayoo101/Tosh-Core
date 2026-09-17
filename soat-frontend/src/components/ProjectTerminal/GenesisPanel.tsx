'use client'
import { useState, useCallback, useEffect } from 'react'
import { parseUnits, formatUnits, type Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, ZERO_ADDRESS,
} from '@/lib/contracts'
import { resolveReferrerNow } from '@/lib/useReferral'
import { NATIVE_SYMBOL } from '@/lib/chain'
import {
  classifyHorizon, formatHorizonLabel, formatHorizonUtc,
  Card, Readout, Field, FieldAffix,
  ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { fmt, fmtFull } from './format'
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
  softCap:            bigint
  ethBalance:         bigint
  pogQuota:           bigint
  /// Straight from `factory.eligibility(user, hook)`.  The quota is refilled
  /// once per `quotaWindowDuration`, and only the factory can tell whether a
  /// lapsed window has already been credited back, so this is never derived
  /// client-side from a cumulative deposit total.
  quotaRemaining:     bigint
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
    try { return parseUnits(t, 18) } catch { return -1n }
  })()
  const amountInvalid = amountWei === -1n

  // `factory.deposit` rejects in a fixed order — IsBlacklisted, then NoPogQuota,
  // then the cooldown, then the window budget — and `eligibility` collapses the
  // first two into the same zero the last one produces.  Mirror that order here
  // so a ban never reads as an allowance the user can simply wait out.
  const banned          = p.blacklistedUntil > 0n && BigInt(p.nowSec) < p.blacklistedUntil
  const unattested      = p.isConnected && !banned && p.pogQuota === 0n
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

  const quotaRemaining  = p.quotaRemaining
  const quotaBreached   = quotaBlock === null && amountWei > 0n && amountWei > quotaRemaining
  const insufficientBal = amountWei > 0n && amountWei > p.ethBalance

  // The soft cap is a progress target, not a ceiling: the hook keeps accepting
  // deposits right up to the deadline. Say so, so clearing the target reads as
  // momentum rather than as a closed door.
  const oversubscribed = p.softCap > 0n && p.totalNativeDeposited >= p.softCap

  // The hook rejects `deposit` outright once the window closes, and separately
  // once this wallet's total for THIS project passes the per-project cap.
  // Neither was mirrored here, so both surfaced only as a reverted transaction.
  const windowClosed  = p.genesisDeadline > 0n && BigInt(p.nowSec) >= p.genesisDeadline
  const walletHeadroom = p.perWalletCap > p.userDeposited
    ? p.perWalletCap - p.userDeposited
    : 0n
  const walletCapBreached = p.perWalletCap > 0n && amountWei > 0n && amountWei > walletHeadroom

  // The binding ceiling is whichever of the two runs out first.
  const spendable = (() => {
    let cap = quotaRemaining
    if (p.perWalletCap > 0n && walletHeadroom < cap) cap = walletHeadroom
    return cap < p.ethBalance ? cap : p.ethBalance
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
      args: [p.hookAddress, resolveReferrerNow(p.userAddress, p.hookAddress)],
      value: amountWei,
    })
  }, [p.hookAddress, p.userAddress, amountWei, sendDeposit])

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
  // `CooldownActive`: "you have none left" instead of "wait 24 hours".
  const gate = useActionGate({
    action: `Deposit ${NATIVE_SYMBOL}`,
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
        reason: `That is not a number this field can send as ${NATIVE_SYMBOL}.`,
        tone: 'warn',
      },
      {
        id: 'amount-zero',
        active: !amountInvalid && amountWei === 0n,
        label: 'Enter an amount',
        reason: `Enter the amount of ${NATIVE_SYMBOL} to deposit.`,
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
                  : 'Checking gas history…',
        reason: scanning
          ? 'Your wallet just connected — reading lifetime gas across five chains. No signature required for this step.'
          : pog.registering
            ? 'Writing the deposit quota on-chain.'
            : scanEligible
              ? 'Gas history qualifies. Click to sign once and register the quota; Deposit unlocks after that lands.'
              : pog.phase === 'failed'
                ? (pog.error ?? 'The gas lookup failed. Click to try again.')
                : pog.phase === 'ready'
                  ? `This wallet’s historical gas is below the floor of ${fmt(BigInt(pog.scan!.floorWei))} ETH, so no deposit quota can be sized.`
                  : 'Waiting for the automatic gas lookup to start.',
        tone: 'warn',
        resolve: scanning || pog.registering
          ? undefined
          : scanEligible
            ? () => { void pog.registerQuota() }
            : pog.phase === 'failed'
              ? () => { void pog.startLookup(true) }
              : pog.phase === 'ready' && pog.scan
                ? () => { pog.setDialogOpen(true) }
                : undefined,
      },
      {
        id: 'cooldown',
        active: onCooldown,
        label: `Cooldown · ${cooldownTxt}`,
        reason: `Deposits from this wallet to this project are on cooldown for another ${cooldownTxt}.`,
        tone: 'warn',
      },
      {
        id: 'quota-exceeded',
        active: quotaBreached,
        label: 'Over your limit',
        reason: `That is more than this wallet may deposit in the current window · ${fmt(quotaRemaining)} ${NATIVE_SYMBOL} left.`,
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
        label: `Over the wallet cap · ${fmt(walletHeadroom)} ${NATIVE_SYMBOL} left`,
        reason: `That is more than this project allows one wallet to hold · ${fmt(walletHeadroom)} ${NATIVE_SYMBOL} left for you.`,
      },
      {
        id: 'balance',
        active: insufficientBal,
        label: `Not enough ${NATIVE_SYMBOL}`,
        reason: `This wallet does not hold that much ${NATIVE_SYMBOL}.`,
        tone: 'warn',
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
      <Card
        title={`Deposit ${NATIVE_SYMBOL}`}
        subtitle="Into this project's genesis window. The raise stays open until the clock runs out."
        interactive={false}
      >
        {oversubscribed && !windowClosed && (
          <p className="font-mono text-label tracking-[0.32em] uppercase text-brand leading-relaxed">
            → OVERSUBSCRIBED · SOFT CAP CLEARED, DEPOSITS STAY OPEN UNTIL THE WINDOW ENDS
          </p>
        )}

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
                ? <>Connected — looking up this address&apos;s lifetime gas on Ethereum,
                  Arbitrum, Optimism, Base and Robinhood. No wallet signature is asked
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

        {p.isConnected && (
          <QuotaLedger
            quota={p.pogQuota}
            remaining={quotaRemaining}
            projected={amountWei > 0n ? amountWei : 0n}
            blocked={quotaBlock}
          />
        )}

        {p.isConnected && (
          <div className="grid grid-cols-1 @sm:grid-cols-2 gap-x-6">
            <Readout label={`${NATIVE_SYMBOL} BALANCE`}
                     value={`${fmt(p.ethBalance)} ${NATIVE_SYMBOL}`}
                     hint={fmtFull(p.ethBalance, 18)} />
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
          label={`DEPOSIT AMOUNT · ${NATIVE_SYMBOL}`}
          value={amount}
          onValueChange={setAmount}
          placeholder="e.g. 0.05"
          inputMode="decimal"
          disabled={txBusy || !p.isConnected || windowClosed || banned || unattested}
          error={amountError}
          armed={armed}
          hint={p.perWalletCap > 0n
            ? `THIS PROJECT ALLOWS ${fmt(p.perWalletCap)} ${NATIVE_SYMBOL} PER WALLET · ${fmt(walletHeadroom)} ${NATIVE_SYMBOL} LEFT FOR YOU`
            : undefined}
          affix={
            <FieldAffix
              onClick={() => setAmount(formatUnits(spendable, 18))}
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
