import type { Metadata } from 'next'

import XHome from '@/components/x/home/XHome'

export const metadata: Metadata = {
  title: 'Ouroboros · 机制介绍',
  description: 'Ouroboros fair mint mechanism: L1 seeding, L1.5 bid market, L2 tiered minting with 80% LP addition and equal pool burn.',
}

export default function MechanismPage() {
  return <XHome />
}
