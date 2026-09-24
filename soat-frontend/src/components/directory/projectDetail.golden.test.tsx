// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { mount } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

import type { ProjectRow } from '@/app/lib/supabase'
import type { TerminalHeaderState } from '@/components/ProjectTerminal'

/**
 * ENGLISH GOLDEN MASTER · the project page's identity header and About card.
 *
 * The terminal below them has its own masters, panel by panel, and reads the
 * chain; it is replaced here by a stand-in that does only what the real one
 * does for this file — calls `header` with the chain state and renders `about`.
 */

let live: TerminalHeaderState | null = null

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

vi.mock('@/components/ProjectTerminal', () => ({
  default: ({ about, header }: { about?: ReactNode; header: (s: TerminalHeaderState | null) => ReactNode }) => (
    <>{header(live)}{about}</>
  ),
}))

import { ProjectDetail } from './ProjectDetail'

const ROW: ProjectRow = {
  id: '0x7074B785D1b27e4f0cB93bE1461B9FC60D5d8df2',
  chain_id: 97,
  tx_hash: '',
  token_address: '0x7074B785D1b27e4f0cB93bE1461B9FC60D5d8df2',
  hook_address: '0x94335Bc7BcF3b63C4deffA6Dd4bb5e09689384fe',
  name: 'Tosh',
  symbol: 'TO',
  logo_url: null,
  website: 'tosh.example',
  twitter: 'https://x.com/tosh',
  telegram: 'https://t.me/tosh',
  description: 'An agent that trades its own ladder.',
  created_at: '2026-09-01T00:00:00.000Z',
}

const CREATOR = '0x2869207e99DC19CB89A68196eFa82E52e493D814' as const

function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

describe('ProjectDetail · english copy golden master', () => {
  it('before the chain state is printable', () => {
    live = null
    const ui = mount(<ProjectDetail project={ROW} />)
    try { pin(ui) } finally { ui.unmount() }
  })

  for (const phase of ['genesis', 'awaiting_launch', 'refund'] as const) {
    it(phase, () => {
      live = { phase, currentPrice: 0n, shelfIndex: 0, creator: CREATOR }
      const ui = mount(<ProjectDetail project={ROW} />)
      try { pin(ui) } finally { ui.unmount() }
    })
  }

  it('bonding, with the live shelf price', () => {
    live = { phase: 'bonding', currentPrice: 2_5000n, shelfIndex: 1_204, creator: CREATOR }
    const ui = mount(<ProjectDetail project={ROW} />)
    try { pin(ui) } finally { ui.unmount() }
  })

  it('no description, so no About card', () => {
    live = null
    const ui = mount(<ProjectDetail project={{ ...ROW, description: null }} />)
    try { pin(ui) } finally { ui.unmount() }
  })
})
