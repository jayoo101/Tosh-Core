import type { Metadata } from 'next'

import { ReferralLedger } from '@/components/referrals/ReferralLedger'
import { MAINNET_CHAIN_LABEL } from '@/lib/contracts'

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
export const metadata: Metadata = {
  title: 'Referral Ledger // TOSH',
  description:
    'Commission earned across every Tosh Protocol launch — claimable balances, '
    + `amounts still locked until launch, and wallets bound to you on ${MAINNET_CHAIN_LABEL}.`,
}

export default function ReferralsPage() {
  return <ReferralLedger />
}
