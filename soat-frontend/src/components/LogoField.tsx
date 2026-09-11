'use client'

/**
 * Token artwork on the launch form.
 *
 * ── Why this is here and the URL field is not enough ───────────────────────
 *
 * `projects.logo_url` has always accepted a URL, and `/launch` exposed it as
 * "Image URL" inside a collapsed optional block. That is a field, not a
 * capability: a launcher had to already have somewhere to host an image, and
 * most do not, which is why the directory is mostly letter sigils.
 *
 * `POST /api/projects/logo` is the capability. This is the control that
 * actually calls it, placed on the Token card rather than behind a details
 * summary so choosing a picture is the same kind of act as naming the token.
 *
 * ── Timing, which is load bearing ──────────────────────────────────────────
 *
 * The upload has to finish before the launch is signed. `logoUrl` is inside
 * the `personal_sign` attestation, so a URL that arrives after the snapshot
 * is taken is a URL the listing will not carry. The parent therefore treats
 * `busy` as a deploy blocker, not as a spinner next to an armed button.
 *
 * ── The pasted-URL path stays ──────────────────────────────────────────────
 *
 * The route is unauthenticated on purpose (no launch exists yet to recover a
 * creator from), and a deployment without the service-role key answers 503.
 * A creator who already hosts the image, or who hits that 503, still needs a
 * way to name a URL. The paste field is that way, not a competing upload.
 */

import { useId, useRef, useState } from 'react'
import { ProjectLogo } from '@/components/ProjectLogo'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { cn } from '@/components/ui/cn'
import { LOGO_ACCEPT, LOGO_ENDPOINT, LOGO_MAX_BYTES } from '@/lib/logoUpload'

export function LogoField({
  value,
  onValueChange,
  onBusyChange,
  name = '',
}: {
  value: string
  onValueChange: (url: string) => void
  /** True while a POST is in flight — the parent must not snapshot yet. */
  onBusyChange?: (busy: boolean) => void
  /** Letter fallback while there is no image. */
  name?: string
}) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const setBusyBoth = (next: boolean) => {
    setBusy(next)
    onBusyChange?.(next)
  }

  const refuse = (message: string) => {
    setError(message)
    if (inputRef.current) inputRef.current.value = ''
  }

  const upload = async (file: File) => {
    if (busy) return

    if (file.size === 0) {
      refuse('That file is empty')
      return
    }
    if (file.size > LOGO_MAX_BYTES) {
      refuse(
        `That image is ${Math.ceil(file.size / 1024)} KB. The limit is ` +
          `${LOGO_MAX_BYTES / 1024} KB.`,
      )
      return
    }
    const type = file.type.toLowerCase()
    const filename = file.name.toLowerCase()
    if (type === 'image/svg+xml' || type === 'image/svg' || filename.endsWith('.svg')) {
      refuse(
        'SVG is not accepted — it is a document rather than an image ' +
          'and can carry script. Export it as PNG.',
      )
      return
    }

    setError(null)
    setBusyBoth(true)
    try {
      const body = new FormData()
      body.set('file', file)
      const res = await fetch(LOGO_ENDPOINT, { method: 'POST', body })
      const json: unknown = await res.json().catch(() => null)
      const message =
        json !== null && typeof json === 'object' && 'error' in json &&
        typeof (json as { error: unknown }).error === 'string'
          ? (json as { error: string }).error
          : null
      if (!res.ok) {
        refuse(message ?? 'Could not store that image')
        return
      }
      const url =
        json !== null && typeof json === 'object' && 'url' in json &&
        typeof (json as { url: unknown }).url === 'string'
          ? (json as { url: string }).url
          : ''
      if (!url) {
        refuse('Could not store that image')
        return
      }
      onValueChange(url)
    } catch {
      refuse('Could not store that image')
    } finally {
      setBusyBoth(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const takeFile = (list: FileList | null) => {
    const file = list?.[0]
    if (file) void upload(file)
  }

  return (
    <div className="flex flex-col gap-gap">
      <div className="flex flex-col gap-gap-tight">
        <span className="font-mono text-label text-text-tertiary">Logo</span>

        <div className="flex items-stretch gap-gap-tight">
          <label
            htmlFor={id}
            onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              takeFile(e.dataTransfer.files)
            }}
            className={cn(
              'flex flex-1 cursor-pointer items-center gap-gap rounded-input border px-3 py-2.5',
              'transition-colors',
              error
                ? 'border-danger/60'
                : dragging || value
                  ? 'border-brand'
                  : 'border-border-subtle hover:border-border-strong',
              busy && 'cursor-wait opacity-60',
            )}
          >
            <input
              ref={inputRef}
              id={id}
              type="file"
              accept={LOGO_ACCEPT}
              disabled={busy}
              className="hidden"
              onChange={(e) => takeFile(e.target.files)}
            />
            <ProjectLogo src={value || null} name={name} className="h-12 w-12" />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="font-mono text-label uppercase text-text-primary">
                {busy ? 'Uploading…' : value ? 'Replace image' : 'Choose image'}
              </span>
              <span className="font-mono text-label text-text-quiet">
                PNG, JPEG, GIF or WebP · up to 1 MB
              </span>
            </span>
          </label>

          {value ? (
            <Button
              label="Remove"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setError(null)
                onValueChange('')
              }}
            />
          ) : null}
        </div>

        {error ? (
          <span className="font-mono text-label tracking-[0.12em] text-danger">
            {error}
          </span>
        ) : null}
      </div>

      <Field
        label="Or paste a URL"
        value={value}
        onValueChange={(next) => {
          setError(null)
          onValueChange(next)
        }}
        placeholder="https://…/logo.png"
        disabled={busy}
      />
    </div>
  )
}
