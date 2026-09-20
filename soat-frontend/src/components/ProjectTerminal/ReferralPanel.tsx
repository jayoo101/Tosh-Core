'use client'
import { useCallback } from 'react'
import Link from 'next/link'
import { useReadContract } from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI,
  REFERRAL_BPS, PROJECT_REFERRAL_BPS, LIFETIME_REFERRAL_BPS,
} from '@/lib/contracts'
import type { Phase } from './phase'
import {
  Card, Readout, ActionButton, useActionGate, revertOrder, useTxAction,
} from '@/components/ui'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { fmtQuote, fmtQuoteFull } from './format'
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
  hookAddress, symbol, userAddress, refetch, phase,
}: {
  hookAddress: Address
  /** Which half of this panel's job is live. See the early return below. */
  phase:       Phase
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
  // Split for the same reason as `quotaKnown` below, and with a sharper
  // consequence: this figure decides whether the whole card unmounts after
  // launch. A pending or failed read coalesced to `0n` therefore removed the
  // claim button from the project page of a launched project that owed the
  // wallet money, leaving `/referrals` as the only route to it — the exact
  // outcome the comment at the early return was written to prevent.
  const claimableKnown = typeof claimableRaw === 'bigint'
  const claimable = (claimableRaw as bigint | undefined) ?? 0n

  // What the link has EARNED, which is not what it can withdraw: commission
  // accrues on deposit and unlocks at `launch()`. Read so the claim readout can
  // be withheld entirely while both are zero — during genesis that block was a
  // guaranteed "0 · Nothing to claim", and it was the tallest thing on a card
  // whose actual job at that point is handing over a link.
  const { data: accruedRaw } = useReadContract({
    address:      hookAddress,
    abi:          HOOK_ABI,
    functionName: 'referralAccrued',
    args:         userAddress ? [userAddress] : undefined,
    query:        { enabled: !!userAddress, refetchInterval: 15_000 },
  })
  const accrued = (accruedRaw as bigint | undefined) ?? 0n

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
  // `quotaKnown` separates "the read has not landed" from "the quota is zero",
  // the way `PogLookupProvider` already does. Collapsing `undefined` into `0n`
  // made the panel assert "this link will not pay at all" on first paint for
  // every attested wallet — a definite accusation derived from missing data,
  // shown in the loudest style on the card and then silently withdrawn.
  const quotaKnown = typeof ownQuotaRaw === 'bigint'
  const hasAttestation = quotaKnown && (ownQuotaRaw as bigint) > 0n

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
  // Third read, third instance of the same distinction. `false` here is a
  // definite "the 8% leg will not bind for you", and while the read was in
  // flight every attested sharer was told the link pays 2% instead of 10% — a
  // number that then changed under them with no explanation. `pays` treats
  // unknown as unknown and draws no strip at all.
  const projectLegKnown = typeof projectLegRaw === 'boolean'
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

  // This panel does two jobs and they belong to different phases. Sharing a link
  // only means something while deposits are open, so outside genesis the card is
  // an explanation of a programme that can no longer be entered on this project
  // — which is what it was doing on a launched page, three cards tall, reading
  // "0 ETH · Nothing to claim".
  //
  // The exception is not cosmetic. Commission accrues at deposit and unlocks at
  // `launch()`, so `bonding` is the FIRST phase in which it can be withdrawn.
  // Hiding unconditionally would remove the claim button from the project page at
  // the exact moment the money became claimable, leaving `/referrals` as the only
  // route to it. So it hides when there is nothing to collect, and stays for a
  // wallet that is owed something.
  //
  // Placed after every hook rather than at the top: the reads decide the answer,
  // and returning before them would change the hook order between phases.
  // `claimableKnown` is what makes "there is nothing to collect" an answer
  // rather than an assumption. Unmounting on an unresolved read is the one
  // failure this guard must not have.
  if (phase !== 'genesis' && claimableKnown && claimable === 0n) return null

  // ── What this link is worth right now, as one line ─────────────────────────
  //
  // This was two paragraphs of small print at the bottom of the card, which is
  // the wrong end: whether the link pays 10%, 2% or nothing at all is the first
  // thing a sharer needs and the last thing they were told. Worse, the copy
  // button sat fully enabled above it, so the default path was to copy a dead
  // link and read why afterwards.
  //
  // `null` while EITHER read is in flight — see `quotaKnown` and
  // `projectLegKnown`. An unknown state draws no strip rather than guessing at
  // the pessimistic one, and both legs have to be known before the difference
  // between "nothing", "2%" and "the full 10%" can be stated.
  const pays = !quotaKnown || !projectLegKnown ? null
    : !hasAttestation ? {
      tone: 'text-danger' as const,
      headline: 'This link pays nothing yet',
      detail: `Both legs need your own PoG attestation. Register it, and the same link starts paying ${REFERRAL_PCT}%.`,
      fix: 'Register PoG',
    }
    : !projectLegIsLive ? {
      tone: 'text-warning' as const,
      headline: `This link pays ${LIFETIME_PCT}%, not ${REFERRAL_PCT}%`,
      detail: `The ${PROJECT_PCT}% leg binds only to a referrer already holding a deposit here. It starts paying on the next deposit after you stake.`,
      fix: 'Deposit first',
    }
    : {
      tone: 'text-success' as const,
      headline: `This link pays the full ${REFERRAL_PCT}%`,
      detail: `${PROJECT_PCT}% on deposits here, ${LIFETIME_PCT}% for life on wallets new to Tosh.`,
      fix: null,
    }

  // Withheld entirely during genesis with nothing earned, when it could only
  // ever read "0 · Nothing to claim" — and, because the gate ranks the network
  // blocker first, put a full-width "switch network" button on a card offering
  // no action worth switching for.
  const showClaim = claimable > 0n || accrued > 0n

  return (
    <Card
      id="REF"
      title="REFERRAL DESK"
      subtitle={`${PROJECT_PCT}% on deposits made through your link here, plus ${LIFETIME_PCT}% for life on wallets you bring to Tosh · paid out when the project launches`}
    >
      {pays && (
        <div className="flex flex-col gap-1">
          <p className={`font-mono text-label tracking-[0.32em] uppercase ${pays.tone}`}>
            {'→ '}{pays.headline}
          </p>
          <p className="font-mono text-note text-text-tertiary leading-relaxed">
            {pays.detail}
            {pays.fix && (
              <>
                {' '}
                <Link href="#DEPOSIT" className="text-brand underline decoration-dotted underline-offset-2">
                  {pays.fix}
                </Link>
                .
              </>
            )}
          </p>
        </div>
      )}

      <ReferralLinkBox link={link} copyLabel={pays && pays.fix ? 'copy anyway' : 'copy'}>
        {/* Collapsed, because the binding rules are reference material: correct,
            worth having, and read once. Left expanded they tripled the height of
            the card and buried the link they were describing. */}
        <details className="group">
          <summary className="cursor-pointer list-none font-mono text-label tracking-wider
                              text-text-quiet transition-colors hover:text-brand">
            {'// '}How the two legs bind
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-label text-text-quiet tracking-wider leading-relaxed">
              The first link a wallet arrives on through this project binds it to you
              here, for {PROJECT_PCT}%. If it is also the first Tosh link that wallet ever
              used, you keep {LIFETIME_PCT}% of everything it deposits anywhere, for life.
              Both bindings are permanent, and self-referral is ignored by the factory.
            </p>
            <p className="text-label text-text-quiet tracking-wider leading-relaxed">
              A leg that does not bind is not an error anyone sees: the deposit still
              succeeds and that share of the carve goes to the buyback reservoir instead
              of to you. The factory retries the binding on every deposit, so a link
              already in circulation starts paying as soon as its condition is met.
            </p>
          </div>
        </details>
      </ReferralLinkBox>

      {showClaim && (
        <Readout
          label="CLAIMABLE COMMISSION"
          value={`${fmtQuote(claimable)} ${QUOTE_SYMBOL}`}
          hint={claimable === 0n
            ? `${fmtQuote(accrued)} ${QUOTE_SYMBOL} earned · unlocks at launch()`
            : fmtQuoteFull(claimable)}
          tone={claimable > 0n ? 'ok' : 'mute'}
        />
      )}

      {showClaim && <ActionButton gate={gate} />}

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
    </Card>
  )
}
