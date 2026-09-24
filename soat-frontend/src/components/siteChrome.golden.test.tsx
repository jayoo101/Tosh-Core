// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * ENGLISH GOLDEN MASTER · the wrong-network strip, the address control and
 * the 404 page.
 *
 * Taken before their copy moves into the dictionary. The strip has an idle and
 * a switching label; the address control names its kind in the copy button
 * and changes its label once copied.
 */

let switching = false

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(async () => {}), isPending: switching }),
}))

vi.mock('@/lib/useWalletChainId', () => ({ useWalletChainId: () => 1 }))

vi.mock('@/components/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui')>()),
  useIsHydrated: () => true,
}))

import { NetworkGuard } from './NetworkGuard'
import { AddressLink } from './ui'
import NotFound from '@/app/not-found'

beforeEach(() => { switching = false })

/** See `moneyBackCopy.golden.test.tsx` for why both halves, and why soft. */
function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

describe('site chrome · english copy golden master', () => {
  it('wrong network', () => {
    const ui = mount(<NetworkGuard />)
    try { pin(ui) } finally { ui.unmount() }
  })

  it('wrong network, switching', () => {
    switching = true
    const ui = mount(<NetworkGuard />)
    try { pin(ui) } finally { ui.unmount() }
  })

  it('address and tx controls', () => {
    const ui = mount(
      <div>
        <AddressLink value="0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" />
        <AddressLink kind="tx" value={`0x${'ab'.repeat(32)}`} />
      </div>,
    )
    try { pin(ui) } finally { ui.unmount() }
  })

  it('address control after copying', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } })
    const ui = mount(<AddressLink value="0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" />)
    try {
      await act(async () => { ui.buttons()[0].click() })
      for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
      pin(ui)
    } finally {
      ui.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('404', () => {
    const ui = mount(<NotFound />)
    try { pin(ui) } finally { ui.unmount() }
  })
})
