/**
 * /projects/[address]
 *
 * The route itself does not wait on the registry or the chain. It validates
 * the URL and hands the address to a client loader, which paints from the
 * directory cache on the same click and refreshes in the background. The
 * previous server `await getProject()` is what made a card click feel dead:
 * the click was registered, then nothing happened until Supabase timed out.
 */

import { notFound } from 'next/navigation'
import { ProjectDetailLoader } from '@/components/directory/ProjectDetailLoader'

type Props = { params: Promise<{ address: string }> }

export default async function ProjectDetailPage({ params }: Props) {
  const { address } = await params
  const raw = address.trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) notFound()
  return <ProjectDetailLoader address={raw} />
}
