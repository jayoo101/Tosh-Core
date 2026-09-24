import type { Metadata } from 'next'

import { ReferralLedger } from '@/components/referrals/ReferralLedger'
import { MAINNET_CHAIN_LABEL } from '@/lib/contracts'
import { fill } from '@/i18n'
import { requestDictionary } from '@/i18n/server'

/**
 * `/referrals` — every project that owes this wallet commission, in one place.
 *
 * Commission is held and claimed per project, so before this route existed a
 * referrer had to remember which projects they had promoted and open each one
 * to find out whether it owed them anything. The ledger is the enumeration; it
 * adds no contract and holds no funds.
 *
 * A server component so it can carry its own metadata; the ledger underneath
 * is a client component because it reads the factory and every hook on it.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = (await requestDictionary()).dict.meta
  return {
    title:       t.referralsTitle,
    description: fill(t.referralsDescription, { chain: MAINNET_CHAIN_LABEL }),
  }
}

export default function ReferralsPage() {
  return <ReferralLedger />
}
