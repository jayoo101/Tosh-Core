'use client'

import { useEffect } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { captureReferrerFromUrl } from '@/lib/useReferral'

/**
 * Parks `?ref=` into localStorage on every route.
 *
 * Mounted in the root layout rather than in the deposit UI, because a referral
 * link is a marketing artifact: it gets pasted into a bio or a group chat
 * pointing at whatever page the sharer happened to be on.  Capturing only
 * where the deposit panel renders would silently drop every link that lands
 * anywhere else.
 */
export function ReferralCapture() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  useEffect(() => {
    captureReferrerFromUrl()
  }, [pathname, searchParams])

  return null
}
