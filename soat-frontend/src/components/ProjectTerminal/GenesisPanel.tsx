'use client'
import { useState, useEffect, useCallback } from 'react'
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseUnits, formatUnits, type Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, TARGET_CHAIN_ID, ZERO_ADDRESS,
} from '@/lib/contracts'
import {
  classifyHorizon, formatHorizonLabel, formatHorizonUtc,
  Card, Readout, Progress, Field, FieldAffix,
} from '@/components/ui'
import { fmt, fmtFull } from './format'
import { WriteButton, AlarmLine, TxLine } from './primitives'
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
  const [error,  setError]  = useState<string | null>(null)

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
    writeContract: writeDeposit,
    isPending:     isDepositing,
    data:          depositHash,
    error:         depositError,
  } = useWriteContract()
  const { isLoading: isDepositConfirming, isSuccess: depositedNow } =
    useWaitForTransactionReceipt({ hash: depositHash })
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (depositedNow) { p.refetch(); setAmount('') } }, [depositedNow, p])

  const txBusy = isDepositing || isDepositConfirming

  const handleDeposit = useCallback(() => {
    setError(null)
    if (!p.userAddress)  { setError('Connect wallet'); return }
    if (banned)          { setError(`This wallet is blacklisted — the factory rejects every deposit from it (${banTxt.toLowerCase()})`); return }
    if (unattested)      { setError('No PoG attestation on file — run the gas-proof scan to receive a quota'); return }
    if (windowClosed)    { setError('Genesis window has closed'); return }
    if (amountWei <= 0n) { setError('Enter a positive ETH amount'); return }
    if (insufficientBal) { setError('Insufficient ETH balance'); return }
    if (quotaBreached)   { return }
    if (walletCapBreached) {
      setError(`Exceeds this project's per-wallet cap — ${fmt(walletHeadroom)} ETH left`)
      return
    }
    if (onCooldown)      { setError('Cooldown — wait before re-depositing'); return }
    writeDeposit({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI,
      functionName: 'deposit',
      args: [p.hookAddress, p.referrer],
      value: amountWei,
      chainId: TARGET_CHAIN_ID,
    })
  }, [
    p.userAddress, amountWei, insufficientBal, quotaBreached, onCooldown,
    p.hookAddress, p.referrer, writeDeposit, windowClosed, walletCapBreached,
    walletHeadroom, banned, banTxt, unattested,
  ])

  const cooldownTxt = (() => {
    if (p.cooldownEnd === 0n) return '—'
    const rem = Number(p.cooldownEnd) - p.nowSec
    if (rem <= 0) return 'CLEAR'
    const h = Math.floor(rem / 3600)
    const m = Math.floor((rem % 3600) / 60)
    const s = rem % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  })()

  const armed = !quotaBreached
             && amountWei > 0n
             && !amountInvalid
             && !insufficientBal
             && !banned
             && !unattested
             && !onCooldown
             && !windowClosed
             && !walletCapBreached
             && p.isConnected

  // The design-system Field carries one message and shows an error in place of
  // the hint, so this is ordered to match `factory.deposit`'s own revert order —
  // the field never names a second-order problem while a more fundamental one
  // stands.  Ban, missing attestation and closed window are deliberately absent:
  // each already has a callout of its own directly above this input, and saying
  // it twice reads as two separate problems.
  const amountError =
      amountInvalid     ? 'NOT A VALID ETH AMOUNT'
    : quotaBreached     ? `EXCEEDS YOUR REMAINING POG WINDOW · ${fmt(quotaRemaining)} ETH LEFT`
    : walletCapBreached ? `EXCEEDS THIS PROJECT'S PER-WALLET CAP · ${fmt(walletHeadroom)} ETH LEFT`
    : insufficientBal   ? 'INSUFFICIENT ETH BALANCE'
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
          <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-tosh-fluo leading-relaxed">
            → OVERSUBSCRIBED · SOFT CAP CLEARED, DEPOSITS STAY OPEN UNTIL THE WINDOW ENDS
          </p>
        )}

        {windowClosed && (
          <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-tosh-amber leading-relaxed">
            → WINDOW CLOSED · NO FURTHER DEPOSITS ACCEPTED
          </p>
        )}

        {banned && (
          <div className="border border-tosh-rust/40 px-4 py-3 flex flex-col gap-1">
            <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-tosh-rust">
              → WALLET BLACKLISTED · {banTxt}
            </p>
            <p className="font-mono text-[11px] text-[#888] leading-relaxed">
              The factory rejects every <span className="text-white">deposit</span> from this
              address while the ban stands, whatever quota it holds — so the zero here is a
              ban, not a spent allowance.{' '}
              {banLiftsAt
                ? <>The ban expires on its own at <span className="text-white">{banLiftsAt}</span>, after
                   which the quota is spendable again with nothing to reset.</>
                : <>Only the protocol owner can clear a permanent ban.</>}
            </p>
          </div>
        )}

        {unattested && (
          <div className="border border-tosh-amber/40 px-4 py-3 flex flex-col gap-1">
            <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-tosh-amber">
              → NO POG ATTESTATION ON FILE
            </p>
            <p className="font-mono text-[11px] text-[#888] leading-relaxed">
              This wallet has never registered Proof-of-Gas, so it holds no quota to spend —
              nothing has been consumed here. Run{' '}
              <span className="text-white">EXECUTE_GAS_PROOF_SCAN</span> below to have the
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
          onValueChange={v => { setAmount(v); setError(null) }}
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

        <div className="flex gap-3 flex-wrap items-center">
          <WriteButton
            label="deposit"
            lockedLabel={
              banned
                ? '[wallet_blacklisted]'
                : unattested
                ? '[pog_attestation_required]'
                : windowClosed
                ? '[genesis_window_closed]'
                : quotaBreached
                  ? '[revert: quota_exceeded]'
                  : walletCapBreached
                    ? `[per_wallet_cap · ${fmt(walletHeadroom)} eth left]`
                    : onCooldown
                      ? `[cooldown ${cooldownTxt}]`
                      : insufficientBal
                        ? '[insufficient_balance]'
                        : '[deposit]'
            }
            locked={!armed}
            busy={isDepositing || isDepositConfirming}
            onClick={handleDeposit}
          />
          <PogScanButton
            userAddress={p.userAddress}
            hookAddress={p.hookAddress}
            refetch={p.refetch}
          />
        </div>

        <AlarmLine msg={error ?? (depositError?.message?.slice(0, 200) ?? null)} />
        <TxLine hash={depositHash} label="deposit" />
      </Card>
    </div>
  )
}
