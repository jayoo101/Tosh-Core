// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '56'
})

/**
 * ENGLISH GOLDEN MASTER · the wrong-network strip on a mainnet build, which
 * drops the "staging runs on" clause. Its own file because the chain is read
 * from the environment at import time.
 */

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(async () => {}), isPending: false }),
}))

vi.mock('@/lib/useWalletChainId', () => ({ useWalletChainId: () => 1 }))

vi.mock('@/components/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui')>()),
  useIsHydrated: () => true,
}))

import { NetworkGuard } from './NetworkGuard'

describe('NetworkGuard on mainnet · english copy golden master', () => {
  it('wrong network', () => {
    const ui = mount(<NetworkGuard />)
    try {
      expect.soft(ui.strings()).toMatchSnapshot()
      expect.soft(ui.prose()).toMatchSnapshot()
    } finally { ui.unmount() }
  })
})
