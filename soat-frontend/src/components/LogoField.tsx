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
 * actually calls it, and it leads the Identity section rather than sitting
 * behind a disclosure, so choosing a picture is the same kind of act as naming
 * the token.
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
import { Upload, X } from 'lucide-react'
import { ProjectLogo } from '@/components/ProjectLogo'
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
    <div className="flex flex-col gap-gap-tight">
      <span className="font-mono text-label text-text-tertiary">Logo</span>

      {/* THE REFERENCE'S SHAPE: an 80px preview square with the control and
          the format hint stacked beside it. This was one bordered label with
          the tile and the words inside it, which made the preview itself the
          button; the reference separates them, and the separation is what lets
          the hint sit next to the control it constrains instead of under the
          whole block.

          The square keeps the drop handlers. It is inert in the reference — a
          preview only — but a picture dropped on a picture-shaped hole is the
          one gesture worth having here, and it costs no layout. */}
      <div className="flex items-center gap-4">
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={LOGO_ACCEPT}
          disabled={busy}
          // `hidden`, not `sr-only`: the button below is the accessible
          // control, and an `sr-only` input stays focusable, so a keyboard
          // user would hit an unlabelled file input before reaching it.
          className="hidden"
          onChange={(e) => takeFile(e.target.files)}
        />

        <div
          onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            takeFile(e.dataTransfer.files)
          }}
          className={cn(
            'relative flex h-20 w-20 shrink-0 items-center justify-center',
            'overflow-hidden rounded-panel border bg-bg-base transition-colors',
            error
              ? 'border-danger/60'
              : dragging || value
                ? 'border-brand'
                : 'border-border-subtle',
            busy && 'opacity-60',
          )}
        >
          <ProjectLogo src={value || null} name={name} className="h-full w-full" />

          {value && !busy ? (
            <button
              type="button"
              aria-label="Remove image"
              onClick={() => {
                setError(null)
                onValueChange('')
              }}
              className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-pill bg-bg-base/80 text-text-primary backdrop-blur transition-colors hover:bg-danger hover:text-bg-base"
            >
              <X aria-hidden className="h-3 w-3" />
            </button>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="inline-flex w-fit items-center gap-1.5 rounded-input border border-border-subtle bg-bg-base px-3 py-2 text-note font-medium text-text-primary transition-colors hover:border-brand/50 disabled:cursor-wait disabled:opacity-60"
          >
            <Upload aria-hidden className="h-3.5 w-3.5" />
            {busy ? 'Uploading…' : value ? 'Replace token logo' : 'Upload token logo'}
          </button>

          {error ? (
            <span className="font-mono text-micro text-danger">{error}</span>
          ) : (
            // The reference's hint reads "PNG, JPG or SVG · square · max 1MB".
            // Two thirds of that is wrong for this route: SVG is refused
            // because it is a document that can carry script, and nothing
            // crops or checks the aspect ratio, so promising "square" would be
            // an instruction the server does not enforce.
            <span className="font-mono text-micro text-text-quiet">
              PNG, JPEG, GIF or WebP · up to 1 MB
            </span>
          )}
        </div>
      </div>

      {/* Behind a disclosure now. It is the fallback for a creator who already
          hosts the image or who hit the 503 on a deployment with no storage
          key, and as a permanently visible second row it looked like the other
          half of a two-part control. */}
      <details className="group mt-gap-tight">
        <summary className="cursor-pointer list-none font-mono text-label text-text-quiet hover:text-text-tertiary">
          Or paste a URL
          <span className="ml-2 group-open:hidden">+</span>
          <span className="ml-2 hidden group-open:inline">−</span>
        </summary>
        <div className="mt-gap-tight">
          <Field
            label="Image URL"
            value={value}
            onValueChange={(next) => {
              setError(null)
              onValueChange(next)
            }}
            placeholder="https://…/logo.png"
            disabled={busy}
          />
        </div>
      </details>
    </div>
  )
}
