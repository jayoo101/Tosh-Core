'use client'

import { erc20Abi, type Address } from 'viem'
import { useReadContract } from 'wagmi'

import { Card } from '@/components/ui'
import { useT } from '@/i18n'
import { TARGET_CHAIN_ID } from '@/lib/chain'
import { useIsV2Hook } from '@/lib/v2/useV2'
import { V2_HOOK_ABI } from '@/lib/v2/abis'
import { BidMarket } from './BidMarket'

export function V2MarketLoader({ hook }: { hook: Address }) {
  const t = useT().v2
  const isV2 = useIsV2Hook(hook)
  const { data: token } = useReadContract({
    address: hook, abi: V2_HOOK_ABI, functionName: 'projectToken', chainId: TARGET_CHAIN_ID,
    query: { enabled: isV2 === true, staleTime: Infinity },
  })
  const { data: symbol } = useReadContract({
    address: token as Address | undefined, abi: erc20Abi, functionName: 'symbol', chainId: TARGET_CHAIN_ID,
    query: { enabled: !!token, staleTime: Infinity },
  })

  if (isV2 === false) return <Card><p className="text-note text-text-secondary">{t.notV2}</p></Card>
  if (isV2 === undefined || symbol === undefined) return <p className="text-note text-text-tertiary">…</p>
  return <BidMarket hook={hook} symbol={symbol} />
}
