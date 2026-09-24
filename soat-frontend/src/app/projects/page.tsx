import type { Metadata } from 'next'

import AgentDirectoryPage from '@/components/directory/AgentDirectoryPage'
import { MAINNET_CHAIN_LABEL } from '@/lib/contracts'
import { fill } from '@/i18n'
import { requestDictionary } from '@/i18n/server'

/**
 * This route used to be `redirect('/#directory')`.
 *
 * The redirect was right while there was one directory and it lived on the
 * landing page. The v0 redesign gives the directory its own page with a phase
 * sidebar, a search box and a sort toolbar, and keeps a three-card teaser on
 * the home page pointing here — so the anchor and this route are now two
 * different things rather than two names for one.
 *
 * A server component so it can carry its own metadata; the grid underneath is
 * a client component because it polls the factory.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = (await requestDictionary()).dict.meta
  return {
    title:       t.projectsTitle,
    description: fill(t.projectsDescription, { chain: MAINNET_CHAIN_LABEL }),
  }
}

export default function ProjectsPage() {
  return <AgentDirectoryPage />
}
