import type { Metadata } from 'next'

import { OuroborosApp } from '@/components/ouroboros/OuroborosApp'
import { MAINNET_CHAIN_LABEL } from '@/lib/chain'

export const metadata: Metadata = {
  title: 'Ouroboros · 衔尾蛇',
  description: `Agent ID fair mint on ${MAINNET_CHAIN_LABEL}: L1 seeding, L1.5 bid book, L2 ladder expansion.`,
}

export default function OuroborosPage() {
  return (
    <main className="relative isolate">
      <div aria-hidden className="toshx-grid toshx-grid-dim" />
      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 py-8 font-sans text-text-primary sm:px-6">
        <OuroborosApp />
      </div>
    </main>
  )
}
