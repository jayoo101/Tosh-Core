import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * ENGLISH GOLDEN MASTER · page metadata.
 *
 * Taken while every route still exported a literal `metadata` object, so the
 * titles, descriptions and link-preview cards a single-language build ships
 * are pinned before they are read from the dictionary.
 */

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock('next/font/google', () => {
  const font = () => ({ variable: 'v', className: 'c', style: { fontFamily: 'f' } })
  return { JetBrains_Mono: font, Geist: font, Noto_Sans_SC: font }
})
vi.mock('./globals.css', () => ({}))
vi.mock('./providers', () => ({ Providers: () => null }))
vi.mock('@/components/ToshNavbar', () => ({ ToshNavbar: () => null }))
vi.mock('@/components/NetworkGuardClient', () => ({ NetworkGuardClient: () => null }))
vi.mock('@/components/FactoryGuardClient', () => ({ FactoryGuardClient: () => null }))
vi.mock('@/components/ReferralCapture', () => ({ ReferralCapture: () => null }))
vi.mock('@/components/SiteFooter', () => ({ SiteFooter: () => null }))
vi.mock('@/components/directory/InstantProjectSlot', () => ({ InstantProjectSlot: () => null }))
vi.mock('@/components/directory/AgentDirectoryPage', () => ({ default: () => null }))
vi.mock('@/components/referrals/ReferralLedger', () => ({ ReferralLedger: () => null }))
vi.mock('@/components/NotFoundBody', () => ({ NotFoundBody: () => null }))

type Route = { metadata?: unknown; generateMetadata?: () => Promise<unknown> }

async function metadataOf(route: Route) {
  return route.generateMetadata ? await route.generateMetadata() : route.metadata
}

describe('page metadata · english golden master', () => {
  it('root layout', async () => {
    expect(await metadataOf(await import('./layout'))).toMatchSnapshot()
  })

  it('/projects', async () => {
    expect(await metadataOf(await import('./projects/page'))).toMatchSnapshot()
  })

  it('/referrals', async () => {
    expect(await metadataOf(await import('./referrals/page'))).toMatchSnapshot()
  })

  it('404', async () => {
    expect(await metadataOf(await import('./not-found'))).toMatchSnapshot()
  })
})
