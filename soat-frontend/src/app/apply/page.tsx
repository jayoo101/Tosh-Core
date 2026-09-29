import type { Metadata } from 'next'

import { ApplyForm } from '@/components/apply/ApplyForm'
import { requestDictionary } from '@/i18n/server'

/**
 * `/apply` — the standing call for project teams. The form posts to
 * `/api/apply`, which relays each application into the private review group.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = (await requestDictionary()).dict.apply
  return { title: t.metaTitle, description: t.metaDescription }
}

export default function ApplyPage() {
  return <ApplyForm />
}
