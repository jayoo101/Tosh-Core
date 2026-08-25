'use client'
import { useState, useEffect, useCallback } from 'react'
import {
  useReadContract, useWriteContract, useWaitForTransactionReceipt,
} from 'wagmi'
import type { Address } from 'viem'

import {
  FACTORY_ABI, FACTORY_ADDRESS, HOOK_ABI, TARGET_CHAIN_ID,
} from '@/lib/contracts'
import { buildReferralLink } from '@/lib/useReferral'
import {
  Card, Readout, ActionButton, useActionGate, revertOrder,
} from '@/components/ui'
import { fmt, fmtFull } from './format'
import { AlarmLine, TxLine } from './primitives'

// ─────────────────────────────────────────────────────────────────────────────
// REFERRAL PANEL  ·  share a link, claim the commission it earned
// ─────────────────────────────────────────────────────────────────────────────
//
// The hook carves 10 % off every genesis deposit at deposit time and parks it
// in `referralAccrued`.  It only becomes withdrawable once the project has
// launched — a failed genesis refunds depositors in full and simply never pays
// the commission out — which is exactly what `claimableReferral` encodes, so
// the panel reads that rather than deriving eligibility itself.

// `isConnected` is gone from the props: the gate resolves wallet state itself,
// so threading it in only gave this panel a second, staler copy of it.
export function ReferralPanel({
  hookAddress, userAddress, refetch,
}: {
  hookAddress: Address
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

  const {
    writeContract, isPending, data: txHash, error: writeError,
  } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } =
    useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => {
    if (!isSuccess) return
    refetch(); void refetchClaimable()
  }, [isSuccess, refetch, refetchClaimable])

  const handleClaim = useCallback(() => {
    writeContract({
      address: hookAddress, abi: HOOK_ABI,
      functionName: 'claimReferralReward', args: [],
      chainId: TARGET_CHAIN_ID,
    })
  }, [hookAddress, writeContract])

  const link = userAddress ? buildReferralLink(userAddress) : ''

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
      label: '[nothing_to_claim]',
      reason: 'No commission has accrued to this wallet yet — it builds as deposits arrive through your link and unlocks at launch.',
      tone: 'neutral',
    }),
  })

  return (
    <Card
      id="REF"
      title="REFERRAL DESK"
      subtitle="10% of every genesis deposit made through your link · payable once the project launches"
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
        <div className="border border-[#1F1F2E] flex flex-col gap-2 px-4 py-3">
          <span className="font-mono text-label text-tosh-mute">YOUR REFERRAL LINK</span>
          <p className="font-mono text-[11px] text-[#CCC] break-all leading-relaxed">{link}</p>
          <button
            type="button"
            onClick={handleCopy}
            className="self-start px-3 py-1.5 border border-[#1F1F2E] text-[#888] text-[10px]
                       tracking-[0.32em] uppercase font-bold
                       hover:border-tosh-fluo hover:text-tosh-fluo
                       transition-colors duration-150"
          >
            {copied ? 'copied' : 'copy'}
          </button>
          <p className="text-[10px] text-[#555] tracking-wider leading-relaxed">
            {'// '}The first link a wallet arrives on binds it to you permanently, across every
            project on the platform. Self-referral is ignored by the factory.
          </p>
          {!linkIsLive && (
            <p className="text-[10px] text-tosh-rust tracking-wider leading-relaxed">
              {'// '}This link will not pay yet. A referrer needs their own PoG
              attestation, so register PoG before sharing — until then a deposit
              made through it still goes through, but the 10 % falls through to
              the buyback reservoir instead of accruing to you, and the binding
              is not made.
            </p>
          )}
        </div>
      )}

      <AlarmLine msg={writeError?.message?.slice(0, 200) ?? null} />
      <TxLine hash={txHash} label="claimReferralReward" />
    </Card>
  )
}
