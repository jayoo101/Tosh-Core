'use client'

import Link from 'next/link'
import { useEffect } from 'react'

import { reportError } from '@/lib/observability'

export default function ProjectSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[project page]', error)
    }
    reportError(error, {
      surface: 'project-error-boundary',
      digest: error.digest,
      extra: { pathname: window.location.pathname },
    })
  }, [error])

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-3xl flex-col items-start justify-center gap-4 px-4 py-16 font-mono md:px-6">
      <p className="text-note uppercase tracking-widest text-warning">This page failed to render</p>
      <p className="text-body text-text-secondary max-w-prose">
        {error.message || 'Unknown error'}. The on-chain project is unaffected.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="border border-brand px-4 py-2 text-label uppercase tracking-widest text-brand"
        >
          Retry
        </button>
        <Link
          href="/"
          className="border border-border-strong px-4 py-2 text-label uppercase tracking-widest text-text-secondary"
        >
          Directory
        </Link>
      </div>
    </div>
  )
}
