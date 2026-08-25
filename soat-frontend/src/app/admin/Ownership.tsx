'use client'


import { useState, useCallback, useEffect } from 'react'
import { useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { isAddress, getAddress, type Abi, type Address } from 'viem'
import {
  FACTORY_ABI,
  FACTORY_ADDRESS,
  TREASURY_ABI,
  LADDER_TREASURY_ADDRESS,
  hasLadderTreasury,
  TARGET_CHAIN_ID,
  ZERO_ADDRESS,
} from '@/lib/contracts'
import {
  Section,
  ScopeNote,
  Field,
  WriteButton,
  Readout,
  AlarmLine,
  TxLine,
  AddressLink,
  StatusBadge,
  ConfirmDialog,
  shortErr,
} from './shared'

// ─────────────────────────────────────────────────────────────────────────────
// G5 · TWO-STEP OWNERSHIP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ownable2Step board for one contract.
 *
 * The ABI is taken as a plain `Abi` rather than the two `as const` literals.
 * Both contracts expose an identical `owner / pendingOwner / transferOwnership
 * / acceptOwnership` surface, and widening here is what lets one component
 * serve both without a union that wagmi's inference cannot narrow.
 */
export function OwnershipCard({
  label, contractAddress, abi, connected,
}: {
  label:           string
  contractAddress: Address
  abi:             Abi
  connected:       Address | undefined
}) {
  const [target, setTarget]         = useState('')
  const [error, setError]           = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: contractAddress, abi, functionName: 'owner' },
      { address: contractAddress, abi, functionName: 'pendingOwner' },
    ],
    query: { refetchInterval: 12_000 },
  })

  const owner        = data?.[0]?.result as Address | undefined
  const pendingOwner = data?.[1]?.result as Address | undefined

  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const txBusy = isPending || isConfirming

  const hasPending = !!pendingOwner && pendingOwner !== ZERO_ADDRESS
  const iAmPending = hasPending && !!connected
                  && pendingOwner.toLowerCase() === connected.toLowerCase()
  const iAmOwner   = !!owner && !!connected
                  && owner.toLowerCase() === connected.toLowerCase()

  const trimmed  = target.trim()
  const valid    = !!trimmed && isAddress(trimmed)
  const zeroAddr = trimmed.toLowerCase() === ZERO_ADDRESS.toLowerCase()
  const sameAsOwner = valid && !!owner && trimmed.toLowerCase() === owner.toLowerCase()
  const transferLocked = !valid || zeroAddr || sameAsOwner || !iAmOwner

  const submitTransfer = useCallback(() => {
    setConfirming(false)
    writeContract({
      address: contractAddress, abi, functionName: 'transferOwnership',
      args: [getAddress(trimmed)],
      chainId: TARGET_CHAIN_ID,
    })
  }, [contractAddress, abi, trimmed, writeContract])

  const submitAccept = useCallback(() => {
    setError(null)
    writeContract({
      address: contractAddress, abi, functionName: 'acceptOwnership',
      args: [],
      chainId: TARGET_CHAIN_ID,
    })
  }, [contractAddress, abi, writeContract])

  return (
    <div className="flex flex-col gap-3 border border-border-subtle rounded-xl p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h4 className="text-sm font-black text-text-primary tracking-tight">{label}</h4>
        <StatusBadge
          ok={!hasPending}
          okLabel="settled"
          badLabel="transfer pending"
        />
      </div>

      <Readout label="OWNER" value={<AddressLink addr={owner} />}
               tone={iAmOwner ? 'fluo' : 'ink'}
               hint={iAmOwner ? 'this is your wallet' : null} />
      <Readout label="PENDING OWNER"
               value={hasPending ? <AddressLink addr={pendingOwner} /> : 'none'}
               tone={hasPending ? 'fluo' : 'mute'} />

      {iAmPending && (
        <div className="flex flex-col gap-2 border border-brand/40 rounded-lg p-3">
          <p className="text-note font-mono text-brand leading-relaxed">
            You are the pending owner of this contract. Ownership does not move
            until you accept it.
          </p>
          <div className="flex justify-start">
            <WriteButton
              label="accept ownership"
              onClick={submitAccept}
              locked={!iAmPending}
              busy={txBusy}
              bypassOwnerGate
              small
            />
          </div>
        </div>
      )}

      <Field
        label="TRANSFER TO · SAFE MULTISIG"
        value={target}
        onChange={v => { setTarget(v); setError(null) }}
        placeholder="0x… receiving Gnosis Safe"
        disabled={txBusy}
        errored={trimmed.length > 0 && (!valid || zeroAddr || sameAsOwner)}
        fluo={!transferLocked}
        hint={
          trimmed.length > 0 && !valid
            ? <span className="text-danger">→ NOT_A_VALID_ADDRESS</span>
            : zeroAddr
              ? <span className="text-danger">→ ZERO_ADDRESS_REFUSED</span>
              : sameAsOwner
                ? <span className="text-text-tertiary">→ EQUALS_CURRENT_OWNER (NO_OP)</span>
                : !iAmOwner
                  ? <span className="text-text-tertiary">→ ONLY THE CURRENT OWNER MAY INITIATE</span>
                  : null
        }
      />
      <div className="flex justify-start">
        <WriteButton
          label="initiate transfer"
          onClick={() => { setError(null); if (!transferLocked) setConfirming(true) }}
          locked={transferLocked}
          busy={txBusy}
          bypassOwnerGate
          danger
        />
      </div>

      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label={`${label} ownership`} />

      <ConfirmDialog
        open={confirming}
        title={`Hand over ${label}?`}
        body={
          <>
            <p className="break-all text-text-secondary">{owner ?? '—'}</p>
            <p className="break-all text-brand mt-1">↓ {trimmed}</p>
            <p className="mt-3 text-text-tertiary">
              Two-step: you keep full control until the recipient calls
              acceptOwnership(). Verify the recipient can actually transact —
              a Safe that never accepts leaves ownership with you, but an EOA you
              have lost the key to would strand this contract permanently.
            </p>
          </>
        }
        confirmLabel="initiate transfer"
        onConfirm={submitTransfer}
        onCancel={() => setConfirming(false)}
        danger
      />
    </div>
  )
}

export function OwnershipPanel({ connected }: { connected: Address | undefined }) {
  return (
    <Section
      id="G5-A" title="OWNERSHIP · TWO-STEP"
      subtitle="Ownable2Step on both the factory and the ladder treasury · ownership only moves once the recipient accepts"
    >
      <ScopeNote>
        The factory and the treasury are owned independently. A production
        handoff has to transfer BOTH and have the Safe accept BOTH — transferring
        only the factory leaves buyback curation behind on the old key.
      </ScopeNote>

      <OwnershipCard
        label="ToshFactory"
        contractAddress={FACTORY_ADDRESS}
        abi={FACTORY_ABI as unknown as Abi}
        connected={connected}
      />

      {hasLadderTreasury ? (
        <OwnershipCard
          label="ToshLadderTreasury"
          contractAddress={LADDER_TREASURY_ADDRESS as Address}
          abi={TREASURY_ABI as unknown as Abi}
          connected={connected}
        />
      ) : (
        <ScopeNote tone="warn">
          Treasury address unset — its ownership card cannot be rendered. Set
          NEXT_PUBLIC_TREASURY_ADDRESS in .env.local.
        </ScopeNote>
      )}
    </Section>
  )
}
