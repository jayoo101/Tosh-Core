import { notFound } from 'next/navigation'
import { V2MarketLoader } from '@/components/v2/V2MarketLoader'

type Props = { params: Promise<{ address: string }> }

export default async function MarketPage({ params }: Props) {
  const { address } = await params
  const raw = address.trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) notFound()
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 font-sans text-text-primary sm:px-6">
      <V2MarketLoader hook={raw as `0x${string}`} />
    </main>
  )
}
