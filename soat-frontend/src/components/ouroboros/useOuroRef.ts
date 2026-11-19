'use client'

import { useEffect, useSyncExternalStore } from 'react'
import type { Hex } from 'viem'

import { encodeRefCode, isRefCode, readStoredRef, storeRef } from '@/lib/ouroboros/ref'

const EVENT = 'ouro:ref-changed'

function subscribe(cb: () => void) {
  window.addEventListener('storage', cb)
  window.addEventListener(EVENT, cb)
  return () => { window.removeEventListener('storage', cb); window.removeEventListener(EVENT, cb) }
}

/**
 * The partner link this browser arrived through. A `?ref=` code is kept once
 * the server confirms it is registered; the first one kept stays, so a later
 * link cannot take over. Mints pass it as their ef argument.
 */
export function useOuroRef(): { code: string | undefined; ref: Hex } {
  const code = useSyncExternalStore(subscribe, readStoredRef, () => undefined)

  useEffect(() => {
    if (readStoredRef()) return
    const fromUrl = new URLSearchParams(window.location.search).get('ref')?.trim().toLowerCase()
    if (!isRefCode(fromUrl)) return
    fetch(`/api/ouroboros/ref/check?code=${fromUrl}`)
      .then(r => (r.ok ? r.json() : null))
      .then((body: { registered?: boolean } | null) => {
        if (!body?.registered || readStoredRef()) return
        storeRef(fromUrl)
        window.dispatchEvent(new Event(EVENT))
      })
      .catch(() => { /* unverified codes are not stored */ })
  }, [])

  return { code, ref: encodeRefCode(code) }
}
