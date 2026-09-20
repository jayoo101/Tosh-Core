'use client'

/**
 * G2 · POG AUTHORITY — the oracle signer, plus the platform fee recipient.
 *
 * These used to be two instances of the same rotation panel.  They are not any
 * more: `setPlatformTreasury` was deleted from the factory when
 * `platformTreasury` went back onto a money path (it now receives 0.30 % of
 * every buy's native-coin input), because a mutable fee-routing target is audit finding
 * M-2.  The field is immutable, so the treasury half is now a readout.
 *
 * What remains rotatable is the PoG signer.  The refusals there are the
 * interesting part, and two of the three are ours rather than the contract's —
 * the factory would happily accept the zero address or the value it already
 * holds, and neither is ever what an operator meant.
 */

import { useState } from 'react'
import { useReadContract } from 'wagmi'
import { isAddress, getAddress, type Abi } from 'viem'
import { FACTORY_ABI, FACTORY_ADDRESS, ZERO_ADDRESS } from '@/lib/contracts'
import { QUOTE_SYMBOL } from '@/lib/contracts'
import { NATIVE_SYMBOL } from '@/lib/chain'
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
  readFn:      'pogSigner'
  writeFn:     'setPogSigner'
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

/**
 * Read-only by construction, not by permission.
 *
 * This panel used to offer a `setPlatformTreasury` rotation.  That function no
 * longer exists on the factory: the address is `immutable`, and the same value
 * is baked into the hook implementation as `platformFeeRecipient` at
 * construction.  There is nothing to gate and nothing to disable — there is no
 * transaction to send.
 */
export function PlatformTreasuryPanel() {
  const {
    data: treasury, isLoading, isFetching,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'platformTreasury',
  })

  return (
    <Section
      id="G2-B"
      title="PLATFORM FEE RECIPIENT (IMMUTABLE)"
      subtitle="platformTreasury · receives 0.30 % of every buy · no setter exists"
    >
      <Readout
        label="LIVE ON-CHAIN"
        value={isLoading && treasury === undefined
          ? 'reading…'
          : <AddressLink addr={treasury as string | undefined} />}
        hint={isFetching && !isLoading ? 'syncing' : null}
      />
      {/* ⚠ THIS SAID LAUNCH FEES ROUTE TO THE LADDER TREASURY, AND THAT STOPPED
          BEING TRUE WHEN THE FEE WENT BACK TO NATIVE. They arrive HERE — the
          address this panel is about — and the contracts make the old claim
          impossible rather than merely stale: `ladderTreasury` sizes itself from
          `quoteAsset.balanceOf` and has no `receive()`, so a BNB send there
          would revert every `createLaunch`.

          The companion error was the currency: "only ever receives the quote
          asset" is what made the wrong destination read as consistent, since a
          native fee could not have landed here if that were true. Both halves
          had to move together. The shelf-mint cut and the orphaned commission
          are unchanged, verified against the hook. */}
      <ScopeNote>
        Every buy pays a 1.00 % tax on its {QUOTE_SYMBOL} input. 0.70 % of that funds the
        ladder treasury&apos;s buyback-and-burn; the remaining 0.30 % is paid here
        as platform revenue. The sell leg is not split — the whole 1.00 % of a
        sell&apos;s token input is burned. This address also takes the launch fee, paid
        in {NATIVE_SYMBOL} rather than {QUOTE_SYMBOL} — the only amount the protocol
        settles in the chain&apos;s own coin — so it holds both. The 1 % shelf-mint cut
        and orphaned referral commission route entirely to the ladder treasury.
      </ScopeNote>
      <ScopeNote tone="warn">
        This address cannot be rotated. It is an immutable constructor argument
        on the factory and is baked into the hook implementation as
        <span className="text-text-secondary"> platformFeeRecipient</span>, so
        both would have to change together and neither has a setter. Redirecting
        platform revenue means deploying a new factory. The setter was removed
        deliberately: a mutable fee-routing target was audit finding M-2.
      </ScopeNote>
    </Section>
  )
}
