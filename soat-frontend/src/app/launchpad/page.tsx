import type { Metadata } from 'next'

import { LaunchingList } from '@/components/x/lists/LaunchingList'
import { fill } from '@/i18n'
import { requestDictionary } from '@/i18n/server'
import { MAINNET_CHAIN_LABEL } from '@/lib/contracts'

export async function generateMetadata(): Promise<Metadata> {
  const t = (await requestDictionary()).dict.x
  return {
    title:       t.metaLaunchpadTitle,
    description: fill(t.metaLaunchpadDescription, { chain: MAINNET_CHAIN_LABEL }),
  }
}

export default function LaunchpadPage() {
  return (
    <main className="relative isolate">
      <div aria-hidden className="toshx-grid toshx-grid-dim" />
      <div className="relative z-10 mx-auto w-full max-w-[1600px] px-4 py-6 md:px-8 md:py-8">
        <LaunchingList />
      </div>
    </main>
  )
}
