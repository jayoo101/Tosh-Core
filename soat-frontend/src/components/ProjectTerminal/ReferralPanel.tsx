'use client'
import { useState, useEffect, useCallback } from 'react'
import { useReadContract } from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI,
  REFERRAL_BPS, PROJECT_REFERRAL_BPS, LIFETIME_REFERRAL_BPS,
} from '@/lib/contracts'
import { buildReferralLink, buildShortReferralLink, useReferralCode } from '@/lib/useReferral'
import {
  Card, Readout, ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { fmt, fmtFull } from './format'

/** Basis points, so 1e4 is 100%. All three are whole percents at these rates;
 *  `toFixed` would print "10.0%" and they are quoted as prose. */
const REFERRAL_PCT = REFERRAL_BPS / 100
const PROJECT_PCT = PROJECT_REFERRAL_BPS / 100
const LIFETIME_PCT = LIFETIME_REFERRAL_BPS / 100

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
//
// THAT 10 % ARRIVES IN TWO LEGS, and which one a sharer earns depends on
// something they can change, so the panel has to say so rather than quote a
// single headline number:
//
//   8 %  to whoever brought the depositor to THIS project — but the factory
//        will not bind a project referrer who holds no deposit here, so this
//        leg is dark until the sharer has staked the project themselves.
//   2 %  to whoever first brought that wallet to the platform at all, on every
//        project it ever deposits into.
//
// A sharer whose 8 % leg is dark is the case worth designing for: their link
// still works, deposits still succeed, and they still earn the 2 % — so
// nothing visibly breaks while four fifths of what they expected silently
// becomes buyback fuel.  `canBindProjectReferral` is read for exactly this,
// rather than reproducing the gate in TypeScript where it would go stale.

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

  // A referrer must hold their own PoG attestation for EITHER slot to bind —
  // the guard that stops the programme being a self-rebate for anyone with a
  // second wallet.  Rejection is silent on-chain (the depositor's transaction
  // still succeeds, the commission just becomes buyback fuel), so an
  // unattested sharer would otherwise watch their link earn nothing with no
  // explanation anywhere.
  const { data: ownQuotaRaw } = useReadContract({
    address:      FACTORY_ADDRESS,
    abi:          FACTORY_ABI,
    functionName: 'pogQuota',
    args:         userAddress ? [userAddress] : undefined,
    query:        { enabled: !!userAddress },
  })
  const hasAttestation = ((ownQuotaRaw as bigint | undefined) ?? 0n) > 0n

  // The project leg's own gate, asked of the factory rather than rebuilt here.
  // It folds in the attestation check as well, so it is the stricter of the
  // two and `hasAttestation` above is only needed to tell the two failure
  // states apart: nothing at all, versus the 2 % tail only.
  const { data: projectLegRaw } = useReadContract({
    address:      FACTORY_ADDRESS,
    abi:          FACTORY_ABI,
    functionName: 'canBindProjectReferral',
    args:         userAddress ? [userAddress, hookAddress] : undefined,
    query:        { enabled: !!userAddress, refetchInterval: 30_000 },
  })
  const projectLegIsLive = (projectLegRaw as boolean | undefined) ?? false

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
      subtitle={`${PROJECT_PCT}% of every genesis deposit made through your link on this project, plus ${LIFETIME_PCT}% for life on wallets you brought to Tosh · payable once the project launches`}
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
            {'// '}The first link a wallet arrives on through this project binds it to you
            here, for {PROJECT_PCT}%. If it is also the first Tosh link that wallet ever
            used, you keep {LIFETIME_PCT}% of everything it deposits anywhere, for life.
            Both bindings are permanent, and self-referral is ignored by the factory.
          </p>
          {!hasAttestation && (
            <p className="text-label text-danger tracking-wider leading-relaxed">
              {'// '}This link will not pay at all yet. A referrer needs their own PoG
              attestation, so register PoG before sharing — until then a deposit
              made through it still goes through, but the whole {REFERRAL_PCT}% falls
              through to the buyback reservoir instead of accruing to you, and
              neither binding is made.
            </p>
          )}
          {hasAttestation && !projectLegIsLive && (
            <p className="text-label text-warning tracking-wider leading-relaxed">
              {'// '}This link pays you {LIFETIME_PCT}% but not the {PROJECT_PCT}%. The
              project leg only binds to a referrer who already holds a deposit in this
              project, and you do not — so deposit here before sharing, or that
              {' '}{PROJECT_PCT}% goes to the buyback reservoir instead of to you. Deposits
              made through your link in the meantime still succeed, and the binding is
              retried on each one, so it starts paying as soon as you have staked.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}
