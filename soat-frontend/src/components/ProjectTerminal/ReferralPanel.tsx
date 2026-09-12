'use client'
import { useState, useEffect, useCallback } from 'react'
import { useReadContract } from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI, REFERRAL_BPS,
} from '@/lib/contracts'
import { buildReferralLink, buildShortReferralLink, useReferralCode } from '@/lib/useReferral'
import {
  Card, Readout, ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { fmt, fmtFull } from './format'

/** Basis points, so 1e4 is 100%. Whole percent at 1000 bps; `toFixed` would
 *  print "10.0%" and this rate is quoted in the subtitle as prose. */
const REFERRAL_PCT = REFERRAL_BPS / 100

// ─────────────────────────────────────────────────────────────────────────────
// REFERRAL PANEL  ·  share a link, claim the commission it earned
// ─────────────────────────────────────────────────────────────────────────────
//
// The hook carves `REFERRAL_BPS` off every genesis deposit at deposit time and
// parks it in `referralAccrued`.  It only becomes withdrawable once the project
// has launched — a failed genesis refunds depositors in full and simply never
// pays the commission out — which is exactly what `claimableReferral` encodes,
// so the panel reads that rather than deriving eligibility itself.
//
// THE RATE IS NO LONGER TYPED IN.  It appeared as the literal "10 %" in three
// places here, which is three claims about what a referrer will be paid with
// nothing holding them to the hook.  `REFERRAL_BPS` is now mirrored in
// `lib/contracts.ts` and pinned to `src/ToshLaunchpadHook.sol` by
// `scripts/checkContractConstants.ts`, so a change to the rate on chain fails
// that guard instead of quietly making this panel promise the old one.

// `isConnected` is gone from the props: the gate resolves wallet state itself,
// so threading it in only gave this panel a second, staler copy of it.
export function ReferralPanel({
  hookAddress, symbol, userAddress, refetch,
}: {
  hookAddress: Address
  /** Goes into `?p=` so the link lands on this project. Advisory — `/r/[code]`
   *  falls back to the directory when it cannot resolve a ticker, so the
   *  placeholder symbol the terminal substitutes when the registry has no name
   *  costs a landing page and never the referral. */
  symbol:      string
  userAddress: Address | undefined
  refetch:     () => void
}) {
  const [copied, setCopied] = useState(false)

  const { data: claimableRaw, refetch: refetchClaimable } = useReadContract({
    address:      hookAddress,
    abi:          HOOK_ABI,
    functionName: 'claimableReferral',
    args:         userAddress ? [userAddress] : undefined,
    query:        { enabled: !!userAddress, refetchInterval: 15_000 },
  })
  const claimable = (claimableRaw as bigint | undefined) ?? 0n

  // A referrer must hold their own PoG attestation for `_recordReferral` to
  // bind — the guard that stops the programme being a self-rebate for anyone
  // with a second wallet.  Rejection is silent on-chain (the depositor's
  // transaction still succeeds, the commission just becomes buyback fuel), so
  // an unattested sharer would otherwise watch their link earn nothing with no
  // explanation anywhere.
  const { data: ownQuotaRaw } = useReadContract({
    address:      FACTORY_ADDRESS,
    abi:          FACTORY_ABI,
    functionName: 'pogQuota',
    args:         userAddress ? [userAddress] : undefined,
    query:        { enabled: !!userAddress },
  })
  const linkIsLive = ((ownQuotaRaw as bigint | undefined) ?? 0n) > 0n

  const { send, isPending, isConfirming } = useTxAction({
    action: 'claim commission',
    onConfirmed: () => { refetch(); void refetchClaimable() },
  })

  const handleClaim = useCallback(() => {
    send({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'claimReferralReward', args: [],
    })
  }, [hookAddress, send])

  // The short code when there is one, the long `?ref=<address>` URL otherwise.
  // Both bind identically — `/r/<code>` redirects to exactly the long form —
  // so this is a choice about how the link READS, and there is no state in
  // which the panel has nothing to offer. While the code is in flight the long
  // link is shown rather than a spinner: a link that is present and ugly is
  // more useful than a box that might become a link.
  const { code } = useReferralCode(userAddress)
  const link = code
    ? buildShortReferralLink(code, symbol)
    : userAddress ? buildReferralLink(userAddress) : ''

  const handleCopy = useCallback(() => {
    if (!link) return
    void navigator.clipboard?.writeText(link).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }, [link])

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2_000)
    return () => clearTimeout(id)
  }, [copied])

  const gate = useActionGate({
    action: 'claim commission',
    onAct: handleClaim,
    tx: { isPending, isConfirming },
    blockersInRevertOrder: revertOrder({
      id: 'nothing-to-claim',
      active: claimable === 0n,
      label: 'Nothing to claim',
      reason: 'No commission has accrued to this wallet yet — it builds as deposits arrive through your link and unlocks at launch.',
      tone: 'neutral',
    }),
  })

  return (
    <Card
      id="REF"
      title="REFERRAL DESK"
      subtitle={`${REFERRAL_PCT}% of every genesis deposit made through your link · payable once the project launches`}
    >
      <Readout
        label="CLAIMABLE COMMISSION"
        value={`${fmt(claimable)} ETH`}
        hint={claimable === 0n
          ? 'accrues on deposit · unlocks at launch()'
          : fmtFull(claimable, 18)}
        tone={claimable > 0n ? 'ok' : 'mute'}
      />

      <ActionButton gate={gate} />

      {link && (
        <div className="border border-border-subtle flex flex-col gap-2 px-4 py-3">
          <span className="font-mono text-label text-text-tertiary">YOUR REFERRAL LINK</span>
          <p className="font-mono text-note text-text-secondary break-all leading-relaxed">{link}</p>
          <button
            type="button"
            onClick={handleCopy}
            className="self-start px-3 py-1.5 border border-border-subtle text-text-tertiary text-label
                       tracking-[0.32em] uppercase font-bold
                       hover:border-brand hover:text-brand
                       transition-colors duration-150"
          >
            {copied ? 'copied' : 'copy'}
          </button>
          <p className="text-label text-text-quiet tracking-wider leading-relaxed">
            {'// '}The first link a wallet arrives on binds it to you permanently, across every
            project on the platform. Self-referral is ignored by the factory.
          </p>
          {!linkIsLive && (
            <p className="text-label text-danger tracking-wider leading-relaxed">
              {'// '}This link will not pay yet. A referrer needs their own PoG
              attestation, so register PoG before sharing — until then a deposit
              made through it still goes through, but the {REFERRAL_PCT}% falls
              through to the buyback reservoir instead of accruing to you, and
              the binding is not made.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}
