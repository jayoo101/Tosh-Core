import { V2_ENABLED } from '@/lib/v2/config'

/**
 * Whether the v1 (Proof-of-Gas) surfaces are shown.
 *
 * v1 is the factory at `NEXT_PUBLIC_FACTORY_ADDRESS`: PoG quotas, deposits,
 * refunds, claims and referrals. Its copy is accurate for its contracts, so it
 * stays while v1 is the only thing deployed. Once v2 is configured
 * (`NEXT_PUBLIC_V2_BIDBOOK` and `NEXT_PUBLIC_V2_LENS`), every v1 entry point
 * goes dark: v1 launches leave the directory, `/launch`, `/projects` and
 * `/referrals` redirect, the wallet drawer drops its PoG panels, and `/admin`
 * keeps only the homepage feature pin. The contracts stay callable on-chain.
 */
export const LEGACY_V1 = !V2_ENABLED
