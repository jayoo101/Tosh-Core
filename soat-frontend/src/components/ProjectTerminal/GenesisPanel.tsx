'use client'
import { useState, useCallback } from 'react'
import { parseUnits, formatUnits, type Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, ZERO_ADDRESS,
} from '@/lib/contracts'
import {
  classifyHorizon, formatHorizonLabel, formatHorizonUtc,
  Card, Readout, Progress, Field, FieldAffix,
  ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { fmt, fmtFull } from './format'
import { QuotaLedger, type QuotaBlock } from './QuotaLedger'
import { PogScanButton } from './PogScanButton'

// ─────────────────────────────────────────────────────────────────────────────
// GENESIS PANEL  ·  Phase 1
// ─────────────────────────────────────────────────────────────────────────────

export interface GenesisProps {
  hookAddress:        Address
  symbol:             string
  userAddress:        Address | undefined
  isConnected:        boolean
  totalEthDeposited:  bigint
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
  const unattested      = !banned && p.pogQuota === 0n
  const onCooldown      = !banned && !unattested
                       && p.cooldownEnd > 0n && BigInt(p.nowSec) < p.cooldownEnd
  const quotaBlock: QuotaBlock = banned
    ? 'banned'
    : unattested ? 'unattested'
    : onCooldown ? 'cooldown'
    : null

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
  const pctGenesis      = p.softCap > 0n
    ? Number((p.totalEthDeposited * 10_000n) / p.softCap) / 100
    : 0

  // The soft cap is a floor, not a ceiling: the hook keeps accepting deposits
  // right up to the deadline.  Say so, so clearing the cap reads as momentum
  // rather than as a closed door.
  const oversubscribed = p.softCap > 0n && p.totalEthDeposited >= p.softCap

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
    onConfirmed: () => { p.refetch(); setAmount('') },
  })

  const submitDeposit = useCallback(() => {
    sendDeposit({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: 'deposit',
      args: [p.hookAddress, p.referrer],
      value: amountWei,
    })
  }, [p.hookAddress, p.referrer, amountWei, sendDeposit])

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
    action: 'Deposit ETH',
    onAct: submitDeposit,
    tx: { isPending: isDepositing, isConfirming: isDepositConfirming },
    blockersInRevertOrder: revertOrder(
      {
        id: 'amount-invalid',
        active: amountInvalid,
        label: '[invalid_amount]',
        reason: 'That is not a number this field can send as ETH.',
        tone: 'warn',
      },
      {
        id: 'amount-zero',
        active: !amountInvalid && amountWei === 0n,
        label: '[enter_amount]',
        reason: 'Enter the amount of ETH to deposit.',
        tone: 'neutral',
      },
      {
        id: 'blacklisted',
        active: banned,
        label: '[wallet_blacklisted]',
        reason: `The factory rejects every deposit from this address while the ban stands · ${banTxt}.`,
      },
      {
        id: 'unattested',
        active: unattested,
        label: '[pog_attestation_required]',
        reason: 'This wallet holds no Proof-of-Gas quota — run the gas-proof scan beside this button to have one written on-chain.',
        tone: 'warn',
      },
      {
        id: 'cooldown',
        active: onCooldown,
        label: `[cooldown ${cooldownTxt}]`,
        reason: `Deposits from this wallet to this project are on cooldown for another ${cooldownTxt}.`,
        tone: 'warn',
      },
      {
        id: 'quota-exceeded',
        active: quotaBreached,
        label: '[revert: quota_exceeded]',
        reason: `That is more than this wallet's remaining PoG window · ${fmt(quotaRemaining)} ETH left.`,
      },
      {
        id: 'window-closed',
        active: windowClosed,
        label: '[genesis_window_closed]',
        reason: 'The genesis window has closed — the hook accepts no further deposits.',
        tone: 'warn',
      },
      {
        id: 'wallet-cap',
        active: walletCapBreached,
        label: `[per_wallet_cap · ${fmt(walletHeadroom)} eth left]`,
        reason: `That is more than this project allows one wallet to hold · ${fmt(walletHeadroom)} ETH left for you.`,
      },
      {
        id: 'balance',
        active: insufficientBal,
        label: '[insufficient_balance]',
        reason: 'This wallet does not hold that much ETH.',
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
        id="P-1"
        title={`GENESIS PULSE · ${p.symbol}`}
        subtitle="factory.deposit{value}(hook, referrer) — collecting genesis ETH until the window closes"
      >
        <Progress
          pct={pctGenesis}
          label={`GENESIS PROGRESS · ${p.symbol}`}
          caption={`${fmt(p.totalEthDeposited)} / ${fmt(p.softCap)} ETH`}
          tone="ink"
          ascii
        />

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
              → NO POG ATTESTATION ON FILE
            </p>
            <p className="font-mono text-note text-text-tertiary leading-relaxed">
              This wallet has never registered Proof-of-Gas, so it holds no quota to spend —
              nothing has been consumed here. Run{' '}
              <span className="text-text-primary">EXECUTE_GAS_PROOF_SCAN</span> below to have the
              oracle size an allocation from this address&apos;s gas history and write it
              on-chain; deposits open the moment that lands.
            </p>
          </div>
        )}

        <QuotaLedger
          quota={p.pogQuota}
          remaining={quotaRemaining}
          projected={amountWei > 0n ? amountWei : 0n}
          blocked={quotaBlock}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
          <Readout label="ETH BALANCE"
                   value={`${fmt(p.ethBalance)} ETH`}
                   hint={fmtFull(p.ethBalance, 18)} />
          <Readout label="COOLDOWN"
                   value={cooldownTxt}
                   tone={onCooldown ? 'mute' : 'ink'} />
        </div>

        {p.referrer !== ZERO_ADDRESS && (
          <Readout
            label="REFERRED BY"
            value={`${p.referrer.slice(0, 10)}…${p.referrer.slice(-6)}`}
            hint="bound platform-wide on your first deposit · 10% of it credits them"
            tone="ok"
          />
        )}

        <Field
          label="DEPOSIT AMOUNT · ETH"
          value={amount}
          onValueChange={setAmount}
          placeholder="e.g. 0.05"
          inputMode="decimal"
          disabled={txBusy || !p.isConnected || windowClosed || banned || unattested}
          error={amountError}
          armed={armed}
          hint={p.perWalletCap > 0n
            ? `THIS PROJECT ALLOWS ${fmt(p.perWalletCap)} ETH PER WALLET · ${fmt(walletHeadroom)} ETH LEFT FOR YOU`
            : undefined}
          affix={
            <FieldAffix
              onClick={() => setAmount(formatUnits(spendable, 18))}
              disabled={txBusy || !p.isConnected || windowClosed || spendable === 0n}
            />
          }
        />

        {spendable > 0n && !windowClosed && !banned && !unattested && (
          <div className="flex flex-wrap gap-gap-tight">
            {([25n, 50n, 75n, 100n] as const).map(pct => (
              <button
                key={pct.toString()}
                type="button"
                disabled={txBusy}
                onClick={() => setAmount(formatUnits((spendable * pct) / 100n, 18))}
                className="rounded-input border border-border-subtle px-3 py-1 font-mono text-label text-text-tertiary hover:border-brand hover:text-brand disabled:opacity-40"
              >
                {pct === 100n ? 'MAX' : `${pct}%`}
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-3 flex-wrap items-start">
          <ActionButton gate={gate} />
          <PogScanButton
            userAddress={p.userAddress}
            hookAddress={p.hookAddress}
            refetch={p.refetch}
          />
        </div>
      </Card>
    </div>
  )
}
