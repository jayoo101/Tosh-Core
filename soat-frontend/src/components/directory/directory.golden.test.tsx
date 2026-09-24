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
 * ENGLISH GOLDEN MASTER · the chrome and the directory.
 *
 * Taken before the navbar, the footer, `/projects` and its cards move their
 * copy into the dictionary. Same contract as the money-path masters: the
 * extraction may merge text nodes (`prose()` catches that it did not change a
 * word) but may not change what an English reader sees.
 *
 * The clock is frozen, because every card on this page carries a countdown and
 * a snapshot that depends on when it ran pins nothing.
 */

const NOW_SEC = 1_790_000_000
const HOUR = 3_600n

let pathname = '/projects'
let directory: {
  projects: DirectoryProject[]
  counts: Record<DirectoryProject['tab'], number>
  loading: boolean
  launchCount: number | null
}

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => {
    delete rest.prefetch
    return <a href={href} {...rest}>{children}</a>
  },
}))

// The wallet control has its own master; the navbar test is about the links.
vi.mock('next/dynamic', () => ({ default: () => () => null }))

vi.mock('@/lib/projectCache', () => ({
  rememberProject: vi.fn(),
  prefetchProject: vi.fn(),
}))

vi.mock('./useDirectoryProjects', async (orig) => ({
  ...(await orig<typeof import('./useDirectoryProjects')>()),
  useDirectoryProjects: () => directory,
}))

import { ProjectCard, FeatureCard } from './ProjectCard'
import AgentDirectoryPage from './AgentDirectoryPage'
import { ToshNavbar } from '../ToshNavbar'
import { SiteFooter } from '../SiteFooter'

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

/**
 * Mounted, then one tick of the frozen clock. The clock store publishes its
 * first reading on a `setTimeout(0)`, so without the tick every countdown on the
 * page is still the unsynced `&nbsp;` placeholder and the copy around it is
 * never rendered at all.
 */
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
  pathname = '/projects'
})
afterEach(() => { vi.useRealTimers() })

describe('ProjectCard · english copy golden master', () => {
  for (const p of [LIVE, LAUNCHING, COMPLETED, ARCHIVED]) {
    it(`grid card · ${p.tab}`, () => {
      const ui = mount(<ProjectCard project={p} />)
      try { pin(ui) } finally { ui.unmount() }
    })
  }
  for (const p of [LIVE, LAUNCHING, COMPLETED]) {
    it(`feature card · ${p.tab}`, () => {
      const ui = mount(<FeatureCard project={p} />)
      try { pin(ui) } finally { ui.unmount() }
    })
  }
})

describe('AgentDirectoryPage · english copy golden master', () => {
  const all = [LIVE, LAUNCHING, COMPLETED, ARCHIVED]
  const counts = { live: 1, launching: 1, completed: 1, archived: 1 }

  it('populated', () => {
    directory = { projects: all, counts, loading: false, launchCount: 4 }
    const ui = mount(<AgentDirectoryPage />)
    try { pin(ui) } finally { ui.unmount() }
  })

  it('one launch on the factory', () => {
    directory = { projects: [LIVE], counts: { live: 1, launching: 0, completed: 0, archived: 0 }, loading: false, launchCount: 1 }
    const ui = mount(<AgentDirectoryPage />)
    try { pin(ui) } finally { ui.unmount() }
  })

  it('no launches yet', () => {
    directory = { projects: [], counts: { live: 0, launching: 0, completed: 0, archived: 0 }, loading: false, launchCount: 0 }
    const ui = mount(<AgentDirectoryPage />)
    try { pin(ui) } finally { ui.unmount() }
  })

  it('search matches nothing', () => {
    directory = { projects: all, counts, loading: false, launchCount: 4 }
    const ui = mount(<AgentDirectoryPage />)
    try {
      ui.type('zzz')
      pin(ui)
    } finally { ui.unmount() }
  })

  it('phase with nothing in it', () => {
    directory = { projects: [LIVE], counts: { live: 1, launching: 0, completed: 0, archived: 0 }, loading: false, launchCount: 1 }
    const ui = mount(<AgentDirectoryPage />)
    try {
      const trading = ui.buttons().find((b) => b.textContent?.startsWith('Trading'))!
      act(() => { trading.click() })
      pin(ui)
    } finally { ui.unmount() }
  })
})

describe('site chrome · english copy golden master', () => {
  it('navbar on /projects', () => {
    const ui = mount(<ToshNavbar />)
    try { pin(ui) } finally { ui.unmount() }
  })

  it('footer', () => {
    const ui = mount(<SiteFooter />)
    try { pin(ui) } finally { ui.unmount() }
  })
})
