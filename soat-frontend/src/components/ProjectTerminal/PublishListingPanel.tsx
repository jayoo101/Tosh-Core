'use client'

/**
 * The creator's second chance at their own listing.
 *
 * ── What this panel is for ──────────────────────────────────────────────────
 *
 * A launch is two writes: the transaction, and a registry row carrying the
 * logo, the links and the description. Only the first is atomic. The second
 * needs a `personal_sign` from the creator, and anything that interrupts that
 * signature — a declined prompt, a closed tab, a wallet that never opened —
 * leaves a real, funded launch that `getProject` can only describe from chain
 * reads: correct name and symbol, and nothing else.
 *
 * That state used to be terminal. `POST /api/projects` is keyed on the launch's
 * txHash, and the only copy of it lived on the launch page that had already
 * navigated away, so the creator's own artwork was unrecoverable by design. It
 * is recoverable because the attestation carries no nonce and no expiry (see
 * `lib/projectAttestation.ts`) — the signature authorises one insert against a
 * hash that can only be inserted once, whenever it is offered.
 *
 * ── Why it is not an edit form ──────────────────────────────────────────────
 *
 * It only ever appears while `isUnlisted(project)` holds. Once the row exists
 * the panel is gone, because the route inserts and does not update: a second
 * POST for the same launch comes back `{ duplicate: true }` having changed
 * nothing. Offering these fields against an existing row would be a form whose
 * Save button silently does nothing.
 *
 * ── Why it is creator-only, and what that gate is worth ─────────────────────
 *
 * `hook.creator()` decides who sees it, which is the same authority the server
 * checks the recovered signer against. The client-side gate is therefore
 * cosmetic — hiding it from a stranger saves them a wasted signature, and
 * nothing more. The server is what makes it safe.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSignMessage } from 'wagmi'
import type { Address } from 'viem'

import { TARGET_CHAIN_ID } from '@/lib/contracts'
import { buildProjectAttestationMessage } from '@/lib/projectAttestation'
import type { ProjectPayload } from '@/app/api/projects/route'
import { LogoField } from '@/components/LogoField'
import {
  ActionButton, Card, Field, revertOrder, toshToast, useActionGate,
} from '@/components/ui'

/** Mirrors the launch form's own ceiling on the field it shares. */
const DESCRIPTION_MAX = 500

type TxState =
  | { status: 'resolving' }
  | { status: 'resolved'; txHash: string }
  | { status: 'manual' }

export function PublishListingPanel({
  hookAddress, name, symbol,
}: {
  hookAddress: Address
  /** Both come from the chain-only row, so both are the token's real values. */
  name:   string
  symbol: string
}) {
  const router = useRouter()
  const { signMessageAsync } = useSignMessage()

  const [tx, setTx] = useState<TxState>({ status: 'resolving' })
  const [manualHash, setManualHash] = useState('')

  const [logoUrl, setLogoUrl] = useState('')
  const [logoUploading, setLogoUploading] = useState(false)
  const [website, setWebsite] = useState('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  /**
   * The creating transaction, asked of the chain rather than of the creator.
   *
   * `/api/projects/launch-tx` finds it from the `LaunchCreated` log, which is
   * why this panel can work in a browser that has never seen this launch — the
   * session cache that held the original snapshot is long gone by the time
   * anyone needs this. A failure here is not fatal: it falls through to the
   * paste field, because an explorer can always answer the same question.
   */
  useEffect(() => {
    let live = true
    const ask = async () => {
      try {
        const res = await fetch(`/api/projects/launch-tx?hook=${hookAddress}`)
        if (!live) return
        if (!res.ok) { setTx({ status: 'manual' }); return }
        const json = await res.json() as { txHash?: string }
        if (!live) return
        if (typeof json.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(json.txHash)) {
          setTx({ status: 'resolved', txHash: json.txHash })
        } else {
          setTx({ status: 'manual' })
        }
      } catch {
        if (live) setTx({ status: 'manual' })
      }
    }
    void ask()
    return () => { live = false }
  }, [hookAddress])

  const txHash = tx.status === 'resolved' ? tx.txHash : manualHash.trim()
  const hashUsable = /^0x[0-9a-fA-F]{64}$/.test(txHash)

  const publish = useCallback(async () => {
    if (!hashUsable) return
    setBusy(true)
    try {
      // Both halves build the message from the same module, and the server
      // rebuilds it from the body it received — so every field below is bound
      // by the signature, and a proxy that rewrites one invalidates it.
      const signature = await signMessageAsync({
        message: buildProjectAttestationMessage({
          chainId: TARGET_CHAIN_ID,
          txHash,
          logoUrl,
          website,
          twitter,
          telegram,
          description,
        }),
      })

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash, logoUrl, website, twitter, telegram, description, signature,
        } satisfies ProjectPayload),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(json?.error ?? `HTTP ${res.status}`)
      }

      toshToast.success('Listing published')
      // The page is server-rendered from `getProject`, so the row it was built
      // from is stale the moment the insert lands. `refresh` re-runs that read
      // rather than patching a client cache the server render does not consult.
      router.refresh()
    } catch (err) {
      toshToast.fromError(err)
    } finally {
      setBusy(false)
    }
  }, [
    hashUsable, txHash, logoUrl, website, twitter, telegram, description,
    signMessageAsync, router,
  ])

  const gate = useActionGate({
    action: 'Publish listing',
    onAct: () => { void publish() },
    // A signed API call, not a transaction: there is nothing to send, so the
    // wallet's current network does not decide whether this can succeed. The
    // chain id is bound INSIDE the signed message instead.
    requiresNetwork: false,
    tx: { isBusy: busy },
    blockersInRevertOrder: revertOrder(
      {
        id: 'resolving-tx',
        active: tx.status === 'resolving',
        label: 'Finding your launch',
        reason: 'Reading the transaction that created this launch off the chain.',
        tone: 'neutral',
      },
      {
        id: 'no-tx-hash',
        active: !hashUsable,
        // Not "launch transaction". This panel can sit directly above the
        // sidebar's own launch panel, where `launch()` is a real pending action
        // — and a creator reading "launch transaction needed" next to a
        // "Trigger launch" button reads it as a precondition on that, which it
        // is not. The word has to name the transaction that ALREADY happened.
        label: 'Creating transaction needed',
        reason: 'Paste the createLaunch transaction that brought this project on chain — the signature has to name it.',
        tone: 'neutral',
      },
      {
        id: 'logo-uploading',
        active: logoUploading,
        label: 'Waiting for the image',
        reason: 'The upload has to finish first: the logo URL is inside what you sign.',
        tone: 'neutral',
      },
    ),
  })

  return (
    <Card
      id="PUB"
      tone="warn"
      title="This project is not listed"
      subtitle="Its launch is on chain, but the logo, links and description never reached the directory — publishing costs one signature and no gas"
    >
      <p className="text-note leading-relaxed text-text-secondary">
        Until this is done, {symbol} appears in the directory with a letter
        sigil and no description, because everything below is held off chain and
        the registry has no row for it yet.
      </p>

      {/* This panel renders on any phase, including one where `launch()` is
          waiting on this same creator a column away. Its heading is about the
          directory and its button used to say "launch transaction needed", so
          the pair read as a checklist — finish the form, then you may launch.
          Nothing here gates anything on chain, and the only place to say so is
          next to the form itself. */}
      <p className="mt-gap-tight text-note leading-relaxed text-text-tertiary">
        This is a directory listing and nothing more. Deposits, refunds and
        triggering the launch all read the chain directly — none of them wait on
        this, and none of them change if you never publish it.
      </p>

      <div className="mt-gap flex flex-col gap-gap">
        <LogoField
          value={logoUrl}
          onValueChange={setLogoUrl}
          onBusyChange={setLogoUploading}
          name={name || symbol}
        />

        <Field
          label="Description"
          value={description}
          onValueChange={(next) => setDescription(next.slice(0, DESCRIPTION_MAX))}
          placeholder="What this project is for."
        />

        <div className="grid grid-cols-1 gap-gap sm:grid-cols-2">
          <Field label="Website"  value={website}  onValueChange={setWebsite}  placeholder="https://…" />
          <Field label="X / Twitter" value={twitter} onValueChange={setTwitter} placeholder="https://x.com/…" />
          <Field label="Telegram" value={telegram} onValueChange={setTelegram} placeholder="https://t.me/…" />
        </div>

        {/* Only when the chain could not be asked. A creator who can see this
            field is a creator whose RPC will not serve the log — pointing them
            at an explorer is the honest fallback, and it is the same question
            answered from a different index. */}
        {tx.status === 'manual' && (
          <Field
            label="Creating transaction"
            value={manualHash}
            onValueChange={setManualHash}
            placeholder="0x…"
            hint="We could not find it from the chain. Copy the createLaunch transaction hash — the one that brought this project on chain — from your wallet history or the explorer."
          />
        )}
      </div>

      <div className="mt-gap">
        <ActionButton gate={gate} />
      </div>

      <p className="mt-gap-tight text-label leading-relaxed tracking-wider text-text-quiet">
        {'// '}The signature proves you are this launch&apos;s creator and nothing
        else — it sends no transaction and grants no spending permission. Only
        the wallet that created this project can publish its listing.
      </p>
    </Card>
  )
}
