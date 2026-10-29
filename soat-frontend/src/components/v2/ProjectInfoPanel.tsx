'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, useSignMessage } from 'wagmi'

import { Button, Card, Field, PageHeader, shortErrorMessage, toshToast } from '@/components/ui'
import { fill, useT } from '@/i18n'
import { TARGET_CHAIN_ID } from '@/lib/chain'
import { LOGO_ACCEPT, LOGO_ENDPOINT, LOGO_MAX_BYTES } from '@/lib/logoUpload'
import { buildProjectAttestationMessage } from '@/lib/projectAttestation'

const TX_RE = /^0x[0-9a-fA-F]{64}$/
/** The limits `POST /api/projects` enforces. */
const DESCRIPTION_MAX = 500
const LINK_MAX = 256

/** One image input that uploads on pick and previews what the server stored. */
function ImagePick({ label, hint, url, onUrl, wide }: {
  label: string; hint: string; url: string; onUrl: (u: string) => void; wide?: boolean
}) {
  const t = useT().v2
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const upload = async (file: File) => {
    if (file.size === 0 || file.size > LOGO_MAX_BYTES) {
      toshToast.error(fill(t.piImageSize, { kb: LOGO_MAX_BYTES / 1024 }))
      return
    }
    setBusy(true)
    try {
      const body = new FormData()
      body.set('file', file)
      const res = await fetch(LOGO_ENDPOINT, { method: 'POST', body })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || typeof data.url !== 'string') throw new Error(data.error ?? `HTTP ${res.status}`)
      onUrl(data.url)
    } catch (err) {
      toshToast.error(shortErrorMessage(err) ?? t.piUploadFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-label text-text-tertiary">{label}</span>
      <div className="flex items-center gap-3">
        <div className={`${wide ? 'aspect-video w-40' : 'size-16'} shrink-0 overflow-hidden rounded-card border border-border-subtle bg-surface-hover`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a bucket object, previewed as uploaded */}
          {url && <img src={url} alt="" className="size-full object-cover" />}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" label={busy ? t.piUploading : t.piPick} disabled={busy} onClick={() => input.current?.click()} />
          {url && <Button size="sm" variant="ghost" label={t.piRemove} disabled={busy} onClick={() => onUrl('')} />}
        </div>
        <input
          ref={input} type="file" accept={LOGO_ACCEPT} className="hidden"
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f) }}
        />
      </div>
      <p className="text-label text-text-quiet">{hint}</p>
    </div>
  )
}

/**
 * The project's listing: logo, cover, description and links, signed and sent
 * to `POST /api/projects` once the launch transaction exists. The launch form
 * hands over its own transaction hash; a launch executed from the Safe pastes
 * the execution hash instead. The listing is written once and cannot be edited.
 */
export function ProjectInfoPanel({ launchTx }: { launchTx?: Hex }) {
  const t = useT().v2
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [logoUrl, setLogoUrl] = useState('')
  const [coverUrl, setCoverUrl] = useState('')
  const [description, setDescription] = useState('')
  const [website, setWebsite] = useState('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  const [typedTx, setRawTx] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [published, setPublished] = useState<string | null>(null)

  const rawTx = typedTx ?? launchTx ?? ''
  const txHash = rawTx.trim()
  const txOk = TX_RE.test(txHash)
  const blocker = !address ? t.piNeedWallet : !txOk ? t.piNeedTx : null

  const publish = async () => {
    if (blocker) return
    setBusy(true)
    try {
      const fields = {
        logoUrl, coverUrl,
        website: website.trim(), twitter: twitter.trim(), telegram: telegram.trim(), description: description.trim(),
      }
      const message = buildProjectAttestationMessage({ chainId: TARGET_CHAIN_ID, txHash, ...fields })
      const signature = await signMessageAsync({ message })
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash, signature, ...fields }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      if (data.duplicate) {
        toshToast.error(t.piDuplicate)
        return
      }
      setPublished(typeof data.data?.token_address === 'string' ? data.data.token_address : '')
      toshToast.success(t.piDone)
    } catch (err) {
      toshToast.error(shortErrorMessage(err) ?? t.piFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <PageHeader title={t.piTitle} subtitle={t.piBlurb} />
      <Card>
        <ImagePick label={t.piLogo} hint={t.piLogoHint} url={logoUrl} onUrl={setLogoUrl} />
        <ImagePick label={t.piCover} hint={t.piCoverHint} url={coverUrl} onUrl={setCoverUrl} wide />
        <Field label={t.piDescription} value={description} onValueChange={v => setDescription(v.slice(0, DESCRIPTION_MAX))}
          multiline rows={4} hint={fill(t.piDescriptionHint, { n: description.length, max: DESCRIPTION_MAX })} />
        <Field label={t.piWebsite} value={website} onValueChange={v => setWebsite(v.slice(0, LINK_MAX))} placeholder="https://" />
        <Field label={t.piTwitter} value={twitter} onValueChange={v => setTwitter(v.slice(0, LINK_MAX))} placeholder="https://x.com/…" />
        <Field label={t.piTelegram} value={telegram} onValueChange={v => setTelegram(v.slice(0, LINK_MAX))} placeholder="https://t.me/…" />
        <Field label={t.piTx} value={rawTx} onValueChange={setRawTx} placeholder="0x…" hint={t.piTxHint} />
        <Button label={busy ? t.piPublishing : t.piPublish} disabled={busy || blocker !== null || published !== null} onClick={() => void publish()} />
        {blocker && <p className="text-label text-text-tertiary">→ {blocker}</p>}
        <p className="text-label text-text-tertiary">{t.piWho}</p>
        {published !== null && (
          <p className="text-note text-text-secondary">
            {t.piDone}{' '}
            {published && <Link className="text-brand hover:underline" href={`/projects/${published}`}>{t.piOpen} →</Link>}
          </p>
        )}
      </Card>
    </div>
  )
}
