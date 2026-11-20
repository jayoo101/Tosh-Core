import type { Metadata } from 'next'

import { PartnersApp } from '@/components/ouroboros/PartnersApp'

export const metadata: Metadata = {
  title: 'Ouroboros · 邀请奖励大赛',
  description: 'Apply for an Ouroboros reward code, or review applications as a treasury signer.',
  robots: { index: false },
}

export default function RewardsPage() {
  return (
    <main className="relative isolate">
      <div aria-hidden className="toshx-grid toshx-grid-dim" />
      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 py-8 font-sans text-text-primary sm:px-6">
        <PartnersApp />
      </div>
    </main>
  )
}
