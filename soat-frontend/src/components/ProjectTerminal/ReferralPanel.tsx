'use client'
import { useCallback } from 'react'
import Link from 'next/link'
import { useReadContract } from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI,
  REFERRAL_BPS, PROJECT_REFERRAL_BPS, LIFETIME_REFERRAL_BPS,
} from '@/lib/contracts'
import {
  Card, Readout, ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { fmt, fmtFull } from './format'
import { ReferralLinkBox, useReferralLink } from './referralLink'

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

  // Short code when there is one, long `?ref=<address>` URL otherwise — see
  // `referralLink.tsx`, which also owns the copy button, because the
  // deposit-confirmed dialog shows the same link and must not derive it twice.
  const link = useReferralLink(userAddress, symbol)

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

      {/* The claim above is this project's only. `/referrals` is the same call
          against every project at once, which is what a sharer with more than
          one actually needs — and it had no entry point outside the site
          footer. */}
      <Link
        href="/referrals"
        className="font-mono text-label tracking-wider text-text-tertiary
                   underline decoration-dotted underline-offset-2
                   transition-colors hover:text-brand"
      >
        {'→ '}Commission across every project
      </Link>

      <ReferralLinkBox link={link}>
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
      </ReferralLinkBox>
    </Card>
  )
}
