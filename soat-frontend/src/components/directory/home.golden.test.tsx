// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'

import { mount as mountBare } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

import type { DirectoryProject } from './useDirectoryProjects'

/**
 * ENGLISH GOLDEN MASTER · the landing page.
 *
 * Taken before the hero, the on-chain feed, the teaser and the five-step
 * explainer move their copy into the dictionary. Same contract as the other
 * masters: `strings()` may change where text nodes merge, `prose()` may not.
 *
 * The feed renders every phase's badge and sub-figure, so the populated case
 * carries one launch per phase.
 */

const NOW_SEC = 1_790_000_000
const HOUR = 3_600n

let directory: {
  projects: DirectoryProject[]
  counts: Record<DirectoryProject['tab'], number>
  loading: boolean
  launchCount: number | null
}

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => {
    delete rest.prefetch
    return <a href={href} {...rest}>{children}</a>
  },
}))

vi.mock('@/lib/projectCache', () => ({
  rememberProject: vi.fn(),
  prefetchProject: vi.fn(),
}))

vi.mock('./useDirectoryProjects', async (orig) => ({
  ...(await orig<typeof import('./useDirectoryProjects')>()),
  useDirectoryProjects: () => directory,
}))

import AgentDirectoryHome from './AgentDirectoryHome'

function project(over: Partial<DirectoryProject>): DirectoryProject {
  return {
    token: '0x7074B785D1b27e4f0cB93bE1461B9FC60D5d8df2',
    hook: '0x94335Bc7BcF3b63C4deffA6Dd4bb5e09689384fe',
    creator: '0x2869207e99DC19CB89A68196eFa82E52e493D814',
    createdAt: BigInt(NOW_SEC) - 24n * HOUR,
    launched: false,
    genesisDeadline: BigInt(NOW_SEC) + 9n * HOUR,
    genesisDuration: 72n * HOUR,
    totalNative: 1_862_4523_0000n,
    canRefund: false,
    symbol: 'TO',
    name: 'Tosh',
    logoUrl: null,
    website: null,
    twitter: null,
    description: 'An agent that trades its own ladder.',
    featuredUntilMs: null,
    tab: 'live',
    ...over,
  }
}

const LIVE = project({ tab: 'live' })
const LAUNCHING = project({
  tab: 'launching', symbol: 'QMT', name: 'Quant',
  hook: '0x1111111111111111111111111111111111111111',
  genesisDeadline: BigInt(NOW_SEC) - 2n * HOUR,
})
const COMPLETED = project({
  tab: 'completed', launched: true, symbol: 'BEMCAT', name: 'Bem Cat', description: null,
  hook: '0x2222222222222222222222222222222222222222',
})
const ARCHIVED = project({
  tab: 'archived', canRefund: true, symbol: 'TAP', name: 'Tap',
  hook: '0x3333333333333333333333333333333333333333',
  genesisDeadline: BigInt(NOW_SEC) - 30n * HOUR,
})

const NO_COUNTS = { live: 0, launching: 0, completed: 0, archived: 0 }

/** Mounted, then one tick so the clock store publishes its first reading. */
function mount(node: ReactNode) {
  const ui = mountBare(node)
  act(() => { vi.advanceTimersByTime(0) })
  return ui
}

function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_SEC * 1_000)
})
afterEach(() => { vi.useRealTimers() })

describe('AgentDirectoryHome · english copy golden master', () => {
  it('populated, one launch per phase', () => {
    directory = {
      projects: [LIVE, LAUNCHING, COMPLETED, ARCHIVED],
      counts: { live: 1, launching: 1, completed: 1, archived: 1 },
      loading: false,
      launchCount: 4,
    }
    const ui = mount(<AgentDirectoryHome />)
    try { pin(ui) } finally { ui.unmount() }
  })

  it('only an archived launch: the feed has a row, the teaser has nothing', () => {
    directory = { projects: [ARCHIVED], counts: { ...NO_COUNTS, archived: 1 }, loading: false, launchCount: 1 }
    const ui = mount(<AgentDirectoryHome />)
    try { pin(ui) } finally { ui.unmount() }
  })

  it('no launches yet', () => {
    directory = { projects: [], counts: NO_COUNTS, loading: false, launchCount: 0 }
    const ui = mount(<AgentDirectoryHome />)
    try { pin(ui) } finally { ui.unmount() }
  })
})
