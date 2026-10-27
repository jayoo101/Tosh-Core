'use client'

import { useDirectoryProjects } from '@/components/directory/useDirectoryProjects'
import { useV2Summaries } from '../useV2Summaries'
import { BrowseSection } from './BrowseSection'
import { Features } from './Features'
import { Hero } from './Hero'

export default function XHome() {
  const { projects, counts, loading } = useDirectoryProjects()
  const summaries = useV2Summaries(projects)
  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-12 px-4 py-6 md:px-8 md:py-8">
      <Hero projects={projects} counts={counts} summaries={summaries} />
      <BrowseSection projects={projects} summaries={summaries} loading={loading} />
      <Features />
    </main>
  )
}
