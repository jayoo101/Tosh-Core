'use client'

import { useAccount } from 'wagmi'

import { Card, PageHeader } from '@/components/ui'
import { useT } from '@/i18n'
import { V2_ENABLED, V2_WBNB, v2Quote } from '@/lib/v2/config'
import { useBids } from '@/lib/v2/useV2'
import { MyBids } from './BidMarket'

export function Portfolio() {
  const t = useT().v2
  const { address } = useAccount()
  const book = useBids(undefined, address)
  const mine = book.bids.filter(b => b.escrow > 0n)

  let body
  if (!V2_ENABLED) body = <Card><p className="text-note text-text-secondary">{t.notDeployed}</p></Card>
  else if (!address) body = <Card><p className="text-note text-text-secondary">{t.connectFirst}</p></Card>
  else if (book.isLoading) body = <p className="text-note text-text-tertiary">…</p>
  else if (mine.length === 0) body = <Card><p className="text-note text-text-secondary">{t.noOpenBids}</p></Card>
  else {
    const quoteOf = (asset: string) => v2Quote(asset, V2_WBNB !== undefined && asset.toLowerCase() === V2_WBNB.toLowerCase())
    body = (
      <>
        {[...new Set(mine.map(b => b.quoteAsset))].map(asset => (
          <MyBids key={asset} bids={mine.filter(b => b.quoteAsset === asset)} quote={quoteOf(asset)} onDone={book.refetch} showHook />
        ))}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t.portfolioTitle} subtitle={t.portfolioBlurb} />
      {body}
    </div>
  )
}
