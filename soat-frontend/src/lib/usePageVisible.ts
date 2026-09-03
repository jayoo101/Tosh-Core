'use client'

import { useSyncExternalStore } from 'react'

/**
 * Whether this tab is in the foreground.
 *
 * TanStack Query already pauses `refetchInterval` on a hidden tab, but raw
 * viem event watchers keep their log filters polling in a background tab
 * forever. Gate their `enabled` on this instead.
 */
function subscribe(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => { document.removeEventListener('visibilitychange', onChange) }
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState !== 'hidden',
    // Assume visible on the server so the first paint matches a foreground tab.
    () => true,
  )
}
