'use client'

/**
 * G2 · POG AUTHORITY — the oracle signer, plus the legacy treasury pointer.
 *
 * Both are the same write: swap one address for another.  The refusals are the
 * interesting part, and two of the three are ours rather than the contract's —
 * the factory would happily accept the zero address or the value it already
 * holds, and neither is ever what an operator meant.
 */

import { useState } from 'react'
import { useReadContract } from 'wagmi'
import { isAddress, getAddress, type Abi } from 'viem'
import { FACTORY_ABI, FACTORY_ADDRESS, ZERO_ADDRESS } from '@/lib/contracts'
import { ActionButton, useActionGate, useTxAction, revertOrder } from '@/components/ui'
import {
  Section,
  ScopeNote,
  Field,
  Readout,
  AddressLink,
  ConfirmDialog,
} from './shared'

export function AddressRotationPanel({
  id, title, subtitle, readFn, writeFn, txLabel, placeholder, note, confirmBody,
}: {
  id:          string
  title:       string
  subtitle:    string
  readFn:      'platformTreasury' | 'pogSigner'
  writeFn:     'setPlatformTreasury' | 'setPogSigner'
  txLabel:     string
  placeholder: string
  note:        React.ReactNode
  confirmBody: React.ReactNode
}) {
  const [addrInput, setAddrInput]   = useState('')
  const [confirming, setConfirming] = useState(false)

  const {
    data: currentAddr, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: readFn,
  })

  const tx = useTxAction({
    action: `rotate the ${txLabel.toLowerCase()}`,
    onConfirmed: () => { void refetch() },
  })

  const trimmed    = addrInput.trim()
  const validAddr  = trimmed !== '' && isAddress(trimmed)
  const sameAsLive = validAddr && typeof currentAddr === 'string'
                  && trimmed.toLowerCase() === (currentAddr as string).toLowerCase()
  const zeroAddr   = trimmed.toLowerCase() === ZERO_ADDRESS.toLowerCase()

  const submit = () => {
    setConfirming(false)
    tx.send({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI as unknown as Abi,
      functionName: writeFn,
      args: [getAddress(trimmed)],
    })
  }

  const gate = useActionGate({
    action: `Rotate ${txLabel.toLowerCase()}`,
    onAct: () => setConfirming(true),
    tx,
    blockersInRevertOrder: revertOrder(
      {
        id: 'address-missing',
        active: trimmed === '',
        label: 'Enter an address',
        reason: `Paste the new ${txLabel.toLowerCase()} address above.`,
        tone: 'neutral',
      },
      {
        id: 'address-invalid',
        active: trimmed !== '' && !validAddr,
        label: '[not_an_address]',
        reason: 'That is not a well-formed 20-byte address.',
      },
      {
        id: 'address-zero',
        active: zeroAddr,
        label: '[zero_address]',
        reason: 'Rotating to the zero address would strand this authority with no way to recover it.',
      },
      {
        id: 'address-unchanged',
        active: sameAsLive,
        label: '[already_live]',
        reason: 'This is the address already on-chain — the rotation would spend gas to change nothing.',
        tone: 'neutral',
      },
    ),
  })

  return (
    <Section id={id} title={title} subtitle={subtitle}>
      <Readout
        label="LIVE ON-CHAIN"
        value={isLoading && currentAddr === undefined
          ? 'reading…'
          : <AddressLink addr={currentAddr as string | undefined} />}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      <Field
        label="NEW ADDRESS"
        value={addrInput}
        onChange={setAddrInput}
        placeholder={placeholder}
        disabled={tx.isBusy}
        errored={trimmed.length > 0 && !validAddr}
        fluo={validAddr && !sameAsLive && !zeroAddr}
      />
      <ScopeNote>{note}</ScopeNote>

      <ActionButton gate={gate} full={false} intent="danger" />

      <ConfirmDialog
        open={confirming}
        title={`Confirm ${txLabel.toLowerCase()} rotation`}
        body={
          <>
            <p className="break-all text-text-secondary">{String(currentAddr ?? '—')}</p>
            <p className="break-all text-brand mt-1">↓ {trimmed}</p>
            <p className="mt-3 text-text-tertiary">{confirmBody}</p>
          </>
        }
        confirmLabel="commit rotation"
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
        danger
      />
    </Section>
  )
}

export function PogSignerPanel() {
  return (
    <AddressRotationPanel
      id="G2-A"
      title="POG SIGNER ROTATION"
      subtitle="setPogSigner · the EOA whose ECDSA signatures registerPoG() will accept"
      readFn="pogSigner" writeFn="setPogSigner"
      txLabel="SIGNER"
      placeholder="0x… new oracle signer EOA"
      note={
        <>
          Rotation is immediate and retroactive against anything unspent: every
          attestation the previous signer issued but that has not yet landed
          on-chain stops verifying the moment this transaction confirms. Drain the
          signing queue before rotating, or re-issue afterwards.
        </>
      }
      confirmBody="Unmined signatures from the old signer are invalidated the instant this confirms."
    />
  )
}

export function PlatformTreasuryPanel() {
  return (
    <AddressRotationPanel
      id="G2-B"
      title="PLATFORM TREASURY (LEGACY · NO FUNDS)"
      subtitle="setPlatformTreasury · v4.x leftover kept for metadata compatibility"
      readFn="platformTreasury" writeFn="setPlatformTreasury"
      txLabel="TREASURY"
      placeholder="0x… metadata only, not a payout address"
      note={
        <>
          This address receives nothing in v5.0. All platform revenue — the 1 %
          shelf-mint cut, the 0.7 % buy tax, launch fees and orphaned referral
          commission — routes to the ladder treasury, which is an immutable
          constructor argument on every hook and cannot be retargeted from here.
        </>
      }
      confirmBody="Metadata only — this rotation moves no funds and changes no revenue routing."
    />
  )
}
