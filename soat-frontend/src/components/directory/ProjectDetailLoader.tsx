'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ProjectRow } from '@/app/lib/supabase'
import { lookupProject, recallProject, subscribeProjects } from '@/lib/projectCache'
import { ProjectDetail } from './ProjectDetail'
import { Skeleton } from '@/components/ui/Skeleton'

/**
 * Stands in for `ProjectDetail`, so it is measured off it: same `max-w-7xl`
 * container and the same two-column grid. It used to be `max-w-3xl`, which was
 * right when the page was, and would now resolve into a page 512px wider —
 * every element on screen shifting once the row lands.
 */
function DetailSkeleton() {
  return (
    <div className="font-sans text-text-primary">
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <Skeleton className="h-10 w-64" />
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Skeleton className="h-80" radius="card" />
          <Skeleton className="h-64" radius="card" />
        </div>
      </main>
    </div>
  )
}

function useCachedProject(address: string): ProjectRow | null {
  return useSyncExternalStore(
    subscribeProjects,
    () => recallProject(address),
    () => null,
  )
}

/**
 * Directory clicks write the row into an in-memory store. `useSyncExternalStore`
 * reads it on the client without a layout-effect setState, so a card click
 * paints from what the card already knew. A cold visit waits on lookup.
 */
export function ProjectDetailLoader({ address }: { address: string }) {
  const project = useCachedProject(address)
  // Which address settled and how, not a boolean: navigating to another
  // project has to clear the outcome without a setState in the effect body.
  // `unreachable` is kept apart from `missing` because telling someone their
  // project does not exist when the truth is that we could not reach the chain
  // is the more damaging of the two errors.
  const [settled, setSettled] = useState<{ address: string; status: 'missing' | 'unreachable' } | null>(null)
  const outcome = settled?.address === address ? settled.status : null

  // `lookupProject` short-circuits on a verified cache hit and joins the hover
  // prefetch's promise otherwise, so arriving from a card costs no extra
  // request and a cold visit costs exactly one.
  useEffect(() => {
    let cancelled = false
    void lookupProject(address).then(result => {
      if (cancelled || result.status === 'found') return
      if (recallProject(address) !== null) return
      setSettled({
        address,
        status: result.status === 'not-found' ? 'missing' : 'unreachable',
      })
    })
    return () => { cancelled = true }
  }, [address])

  if (outcome && !project) {
    return (
      <div className="text-text-primary font-sans">
        <main className="max-w-3xl mx-auto py-16 px-4 md:px-6">
          <p className="font-mono text-note text-text-tertiary">
            {outcome === 'missing'
              ? 'No launch at this address.'
              : 'Could not reach the registry or the chain — this says nothing about whether the launch exists. Reload to try again.'}
          </p>
        </main>
      </div>
    )
  }

  if (!project) return <DetailSkeleton />
  return <ProjectDetail project={project} />
}
