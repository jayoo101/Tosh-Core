'use client'


import { useState, useCallback, useEffect } from 'react'
import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { isAddress, getAddress } from 'viem'
import { FACTORY_ABI, FACTORY_ADDRESS, TARGET_CHAIN_ID, ZERO_ADDRESS } from '@/lib/contracts'
import {
  Section,
  ScopeNote,
  Field,
  WriteButton,
  Readout,
  AlarmLine,
  TxLine,
  AddressLink,
  ConfirmDialog,
  shortErr,
} from './shared'

// ─────────────────────────────────────────────────────────────────────────────
// G2 · POG SIGNER
// ─────────────────────────────────────────────────────────────────────────────

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
  const [error, setError]           = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const {
    data: currentAddr, isLoading, isFetching, refetch,
  } = useReadContract({
    address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: readFn,
  })
  const { writeContract, isPending, data: txHash, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })
  useEffect(() => { if (isSuccess) void refetch() }, [isSuccess, refetch])

  const trimmed    = addrInput.trim()
  const validAddr  = !!trimmed && isAddress(trimmed)
  const sameAsLive = validAddr && typeof currentAddr === 'string'
                  && trimmed.toLowerCase() === (currentAddr as string).toLowerCase()
  const zeroAddr   = trimmed.toLowerCase() === ZERO_ADDRESS.toLowerCase()
  const locked     = !validAddr || sameAsLive || zeroAddr
  const txBusy     = isPending || isConfirming

  const submit = useCallback(() => {
    setConfirming(false)
    writeContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: writeFn,
      args: [getAddress(trimmed)],
      chainId: TARGET_CHAIN_ID,
    })
  }, [trimmed, writeFn, writeContract])

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
        onChange={v => { setAddrInput(v); setError(null) }}
        placeholder={placeholder}
        disabled={txBusy}
        errored={trimmed.length > 0 && !validAddr}
        fluo={!locked}
        hint={
          trimmed.length > 0 && !validAddr
            ? <span className="text-danger">→ NOT_A_VALID_ADDRESS</span>
            : sameAsLive
              ? <span className="text-text-tertiary">→ EQUALS_LIVE_VALUE (NO_OP)</span>
              : zeroAddr
                ? <span className="text-danger">→ ZERO_ADDRESS_REFUSED</span>
                : null
        }
      />
      <ScopeNote>{note}</ScopeNote>
      <div className="flex justify-start">
        <WriteButton
          label={`rotate ${txLabel.toLowerCase()}`}
          onClick={() => { setError(null); if (!locked) setConfirming(true) }}
          locked={locked}
          busy={txBusy}
        />
      </div>
      <AlarmLine msg={error ?? shortErr(writeError)} />
      <TxLine hash={txHash} label={writeFn} />

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
