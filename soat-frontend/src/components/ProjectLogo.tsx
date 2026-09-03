'use client'

import { useState } from 'react'
import { cn } from '@/components/ui/cn'

/**
 * Project mark with a letter fallback.
 *
 * A dead, blocked or CORS-poisoned `logo_url` previously left a broken-image
 * icon in the card and the header, which is what "the image problem" looked
 * like on every visit to a project whose URL 404'd. `onError` swaps to the
 * sigil.
 *
 * The failure is remembered AS A URL, not as a boolean. It used to be a
 * boolean, and the comment here claimed a later good URL would still win
 * "because the key is the src" — but no call site passed `key={src}`, so
 * nothing ever remounted and the flag was latched for the life of the mount.
 * The concrete symptom: hovering a directory card caches a synthesised row, so
 * the detail page paints with a possibly stale `logo_url`; if that one 404s
 * the sigil sticks even after the verified lookup lands with a good URL.
 *
 * Keying on the URL makes the resync intrinsic — a new `src` has not failed
 * yet, whatever the caller does or forgets to do.
 */
export function ProjectLogo({
  src, name, className,
}: {
  src: string | null | undefined
  name: string
  className?: string
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const initial = (name || '?').charAt(0).toUpperCase()
  const showImage = Boolean(src) && failedSrc !== src

  return (
    <div
      className={cn(
        'flex items-center justify-center overflow-hidden shrink-0 rounded-card',
        'bg-bg-base border border-border-subtle',
        className,
      )}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src!}
          alt={name}
          className="w-full h-full object-cover"
          onError={() => setFailedSrc(src ?? null)}
        />
      ) : (
        <span className="text-figure text-brand select-none">{initial}</span>
      )}
    </div>
  )
}
