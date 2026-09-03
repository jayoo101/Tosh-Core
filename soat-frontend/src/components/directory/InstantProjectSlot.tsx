'use client'

/**
 * Paint a project from the directory cache the instant the URL changes.
 *
 * App Router still fetches the `/projects/[address]` RSC before swapping
 * `children`, which is why a card click sat on a skeleton even after the
 * row was already in memory. This slot lives in the root layout, so it
 * re-renders on `usePathname()` without waiting for that payload. Cold
 * visits (no cache) fall through to the page loader as before.
 */

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { ProjectDetailLoader } from './ProjectDetailLoader'

const PROJECT_PATH = /^\/projects\/(0x[a-fA-F0-9]{40})$/i

export function InstantProjectSlot({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const match = pathname.match(PROJECT_PATH)
  const address = match?.[1]

  useEffect(() => {
    if (!address) return
    window.scrollTo(0, 0)
  }, [address])

  if (address) return <ProjectDetailLoader address={address} />
  return children
}
