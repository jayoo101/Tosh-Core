'use client'


import { useState } from 'react'
import { useReadContracts } from 'wagmi'
import { isAddress, getAddress, type Abi, type Address } from 'viem'
import {
  FACTORY_ABI,
  FACTORY_ADDRESS,
  TREASURY_ABI,
  LADDER_TREASURY_ADDRESS,
  hasLadderTreasury,
  ZERO_ADDRESS,
} from '@/lib/contracts'
import { ActionButton, useActionGate, useTxAction, revertOrder } from '@/components/ui'
import {
  Section,
  ScopeNote,
  Field,
  Readout,
  AddressLink,
  StatusBadge,
  ConfirmDialog,
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
 *
 * NON-OBVIOUS CONSTRAINT — both levers here set `bypassAmbientGate`, because
 * neither is authorised against `factory.owner()`.  `acceptOwnership` is called
 * by definition by a wallet that is NOT the owner yet, and `transferOwnership`
 * is authorised against whichever contract this card is bound to, which for the
 * treasury card is not the factory.  Each therefore carries its own blocker in
 * exchange, and `transferOwnership` puts `not-owner` first because Ownable2Step
 * runs `onlyOwner` before it ever looks at the argument.
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

  const tx = useTxAction({
    action: `move ${label} ownership`,
    onConfirmed: () => { void refetch() },
  })

  const hasPending = !!pendingOwner && pendingOwner !== ZERO_ADDRESS
  const iAmPending = hasPending && !!connected
                  && pendingOwner.toLowerCase() === connected.toLowerCase()
  const iAmOwner   = !!owner && !!connected
                  && owner.toLowerCase() === connected.toLowerCase()

  const trimmed  = target.trim()
  const valid    = trimmed !== '' && isAddress(trimmed)
  const zeroAddr = trimmed.toLowerCase() === ZERO_ADDRESS.toLowerCase()
  const sameAsOwner = valid && !!owner && trimmed.toLowerCase() === owner.toLowerCase()

  const submitTransfer = () => {
    setConfirming(false)
    tx.send({
      address: contractAddress, abi, functionName: 'transferOwnership',
      args: [getAddress(trimmed)],
    })
  }

  const acceptGate = useActionGate({
    action: 'Accept ownership',
    onAct: () => {
      tx.send({ address: contractAddress, abi, functionName: 'acceptOwnership', args: [] })
    },
    tx,
    bypassAmbientGate: true,
    blockersInRevertOrder: revertOrder({
      id: 'not-pending-owner',
      active: !iAmPending,
      label: '[not_pending_owner]',
      reason: `Only the address ${label} has named as pending owner can accept.`,
    }),
  })

  const transferGate = useActionGate({
    action: 'Initiate transfer',
    onAct: () => setConfirming(true),
    tx,
    bypassAmbientGate: true,
    blockersInRevertOrder: revertOrder(
      {
        id: 'not-owner',
        active: !iAmOwner,
        label: '[not_the_owner]',
        reason: `Only ${label}'s current owner may start a handoff, and this wallet is not it.`,
        tone: 'neutral',
      },
      {
        id: 'target-missing',
        active: trimmed === '',
        label: 'Enter a recipient',
        reason: 'Paste the address that should receive ownership.',
        tone: 'neutral',
      },
      {
        id: 'target-invalid',
        active: trimmed !== '' && !valid,
        label: '[not_an_address]',
        reason: 'That is not a well-formed 20-byte address.',
      },
      {
        id: 'target-zero',
        active: zeroAddr,
        label: '[zero_address]',
        reason: 'Transferring to the zero address would strand this contract with no owner and no way back.',
      },
      {
        id: 'target-is-owner',
        active: sameAsOwner,
        label: '[already_the_owner]',
        reason: 'That is the current owner — the handoff would change nothing.',
        tone: 'neutral',
      },
    ),
  })

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
          <ActionButton gate={acceptGate} size="sm" full={false} />
        </div>
      )}

      <Field
        label="TRANSFER TO · SAFE MULTISIG"
        value={target}
        onChange={setTarget}
        placeholder="0x… receiving Gnosis Safe"
        disabled={tx.isBusy}
        errored={trimmed.length > 0 && (!valid || zeroAddr || sameAsOwner)}
        fluo={transferGate.verdict.kind === 'ready'}
      />

      <ActionButton gate={transferGate} full={false} intent="danger" />

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
