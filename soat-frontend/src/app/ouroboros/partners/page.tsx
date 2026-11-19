import type { Metadata } from 'next'

import { PartnersApp } from '@/components/ouroboros/PartnersApp'

export const metadata: Metadata = {
  title: 'Ouroboros · Partners',
  robots: { index: false },
}

export default function OuroborosPartnersPage() {
  return (
    <main className="relative isolate">
      <div aria-hidden className="toshx-grid toshx-grid-dim" />
      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 py-8 font-sans text-text-primary sm:px-6">
        <PartnersApp />
      </div>
    </main>
  )
}
