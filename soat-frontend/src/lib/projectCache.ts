'use client'

import type { ProjectRow } from '@/app/lib/supabase'

const PREFIX = 'tosh:project:'
const memory = new Map<string, ProjectRow>()
const listeners = new Set<() => void>()

/**
 * Addresses whose cached row came back from the registry itself.
 *
 * A directory card synthesises a row from what the grid happens to know, which
 * is enough to paint the page instantly but is missing whatever the card does
 * not render — telegram, the full description. Treating that as authoritative
 * would mean those fields never arrived, so a synthesised row still triggers
 * one background lookup; it just does not block the paint.
 */
const verified = new Set<string>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeProjects(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => { listeners.delete(onStoreChange) }
}

function keysOf(row: Pick<ProjectRow, 'token_address' | 'hook_address'>): string[] {
  return [row.token_address, row.hook_address]
    .filter((k): k is string => typeof k === 'string' && k.length > 0)
    .map(k => k.toLowerCase())
}

/**
 * In-memory first, sessionStorage second.
 *
 * `useState(() => recallProject())` is useless across an App Router navigation:
 * the server render has no `window`, hydration reuses that null, and the
 * click's sessionStorage write is only read after a 1s lookup. The module Map
 * survives the same JS session, so a directory click can paint the detail
 * page from what the card already knew.
 */
export function rememberProject(row: ProjectRow, isVerified = false): void {
  for (const key of keysOf(row)) {
    // A synthesised row must never clobber the registry's own copy.
    if (!isVerified && verified.has(key)) continue
    memory.set(key, row)
    if (isVerified) verified.add(key)
    if (typeof window === 'undefined') continue
    try {
      sessionStorage.setItem(PREFIX + key, JSON.stringify(row))
    } catch { /* quota / private mode */ }
  }
  emit()
}

export function recallProject(address: string): ProjectRow | null {
  const key = address.trim().toLowerCase()
  const hit = memory.get(key)
  if (hit) return hit
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(PREFIX + key)
    if (!raw) return null
    const row = JSON.parse(raw) as ProjectRow
    memory.set(key, row)
    return row
  } catch {
    return null
  }
}

/**
 * Why this is not `ProjectRow | null`.
 *
 * A 404, a 503, a CORS failure and a dropped connection all used to collapse
 * to `null`, and the detail loader renders `null` as "No launch at this
 * address" — so an RPC blip produced a confident denial that a real, funded
 * project exists. Only a 404 is that answer; everything else means the
 * question has not been answered yet.
 */
export type LookupOutcome =
  | { status: 'found'; row: ProjectRow }
  | { status: 'not-found' }
  | { status: 'unavailable' }

const inflight = new Map<string, Promise<LookupOutcome>>()

/**
 * One lookup per address per session, shared by every caller.
 *
 * Hover prefetch, the click itself and the detail page's own effect all want
 * the same row, and each used to open its own request — up to three round
 * trips for one navigation. A cache hit resolves without touching the network;
 * concurrent misses join the same promise.
 */
export function lookupProject(address: string): Promise<LookupOutcome> {
  const key = address.trim().toLowerCase()
  if (verified.has(key)) {
    const hit = recallProject(key)
    if (hit) return Promise.resolve({ status: 'found', row: hit })
  }

  const pending = inflight.get(key)
  if (pending) return pending

  const job = fetch(`/api/projects/lookup?address=${encodeURIComponent(address)}`)
    .then(async (res): Promise<LookupOutcome> => {
      if (res.ok) {
        const row = (await res.json()) as ProjectRow
        rememberProject(row, true)
        return { status: 'found', row }
      }
      // 404 is the server's verdict; 4xx-otherwise and 5xx are not. A malformed
      // address (400) is also a settled answer — retrying cannot change it.
      if (res.status === 404 || res.status === 400) return { status: 'not-found' }
      return { status: 'unavailable' }
    })
    // A throw here is the network, never the server's opinion.
    .catch((): LookupOutcome => ({ status: 'unavailable' }))
    .finally(() => { inflight.delete(key) })
  inflight.set(key, job)
  return job
}

/** Warm the cache on card hover so the click does not wait on lookup. */
export function prefetchProject(address: string): void {
  void lookupProject(address)
}
