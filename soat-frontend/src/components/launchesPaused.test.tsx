// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'

import { mount as mountBare } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * With `LAUNCHES_PAUSED` set, nothing on the site links to `/launch`, and
 * `/launch` itself explains why instead of showing the form. The open state is
 * what every golden master already pins.
 */

vi.mock('@/lib/launchGate', () => ({ LAUNCHES_PAUSED: true }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/projects',
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => {
    delete rest.prefetch
    return <a href={href} {...rest}>{children}</a>
  },
}))

vi.mock('next/dynamic', () => ({ default: () => () => null }))

vi.mock('@/lib/projectCache', () => ({
  rememberProject: vi.fn(),
  prefetchProject: vi.fn(),
}))

vi.mock('./directory/HeroFeedPanel', () => ({ HeroFeedPanel: () => null }))

vi.mock('./directory/useDirectoryProjects', async (orig) => ({
  ...(await orig<typeof import('./directory/useDirectoryProjects')>()),
  useDirectoryProjects: () => ({
    projects: [],
    counts: { live: 0, launching: 0, completed: 0, archived: 0 },
    loading: false,
    launchCount: 0,
  }),
}))

import { ToshNavbar } from './ToshNavbar'
import { NotFoundBody } from './NotFoundBody'
import { LaunchesPaused } from './LaunchesPaused'
import AgentDirectoryHome from './directory/AgentDirectoryHome'
import AgentDirectoryPage from './directory/AgentDirectoryPage'

function mount(node: ReactNode) {
  const ui = mountBare(node)
  act(() => { vi.advanceTimersByTime(0) })
  return ui
}

function launchLinks(container: HTMLElement) {
  return Array.from(container.querySelectorAll('a')).filter((a) => a.getAttribute('href') === '/launch')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_790_000_000_000)
})
afterEach(() => { vi.useRealTimers() })

describe('launches paused', () => {
  const surfaces: [string, () => ReactNode][] = [
    ['navbar', () => <ToshNavbar />],
    ['home', () => <AgentDirectoryHome />],
    ['directory', () => <AgentDirectoryPage />],
    ['404', () => <NotFoundBody />],
  ]
  for (const [name, render] of surfaces) {
    it(`${name} has no link to /launch`, () => {
      const ui = mount(render())
      try {
        expect(ui.prose()).not.toBe('')
        expect(launchLinks(ui.container)).toEqual([])
      } finally { ui.unmount() }
    })
  }

  it('/launch explains the pause and points at the directory', () => {
    const ui = mount(<LaunchesPaused />)
    try {
      expect(ui.prose()).toContain('New launches are paused.')
      expect(ui.prose()).toContain('deposits, refunds, claims and trading work as before')
      const links = Array.from(ui.container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
      expect(links).toEqual(['/projects'])
    } finally { ui.unmount() }
  })
})
