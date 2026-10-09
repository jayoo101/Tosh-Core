// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'

import { mount, type Mounted } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * The homepage quota entry. What matters is what a click costs: a scan spends
 * the shared upstream budget, so it must start only from `idle`, and a wallet
 * with quota on file must not be offered a scan at all.
 */

const pog = {
  userAddress: '0x00000000000000000000000000000000000000a1' as `0x${string}` | undefined,
  phase: 'idle' as 'idle' | 'scanning' | 'ready' | 'failed',
  setDialogOpen: vi.fn(),
  startLookup: vi.fn(),
}
let quota: bigint | undefined
let connected = true

vi.mock('wagmi', () => ({
  useReadContract: () => ({ data: quota }),
}))

vi.mock('@/components/ProjectTerminal/PogLookupProvider', () => ({
  usePogLookup: () => pog,
}))

vi.mock('@/components/ui', () => ({
  useActionGate: ({ action, onAct }: { action: string; onAct: () => void }) => ({
    isConnected: connected,
    verdict: { kind: 'ready', label: action, disabled: false, act: onAct },
  }),
}))

import { QuotaCheckCta } from './QuotaCheckCta'

let m: Mounted | null = null

beforeEach(() => {
  pog.phase = 'idle'
  pog.setDialogOpen.mockReset()
  pog.startLookup.mockReset()
  quota = 0n
  connected = true
})

afterEach(() => {
  m?.unmount()
  m = null
})

function click(b: HTMLButtonElement) {
  act(() => { b.click() })
}

describe('QuotaCheckCta', () => {
  it('opens the dialog and starts a scan when none has run', () => {
    m = mount(<QuotaCheckCta />)

    click(m.button('Check / activate deposit quota'))

    expect(pog.setDialogOpen).toHaveBeenCalledWith(true)
    expect(pog.startLookup).toHaveBeenCalledTimes(1)
  })

  it('reopens a finished scan without spending another', () => {
    pog.phase = 'ready'
    m = mount(<QuotaCheckCta />)

    click(m.button('Check / activate deposit quota'))

    expect(pog.setDialogOpen).toHaveBeenCalledWith(true)
    expect(pog.startLookup).not.toHaveBeenCalled()
  })

  it('shows quota on file instead of offering a scan', () => {
    quota = 46_40000000n
    m = mount(<QuotaCheckCta />)

    expect(m.buttons()).toHaveLength(0)
    expect(m.text()).toContain('Deposit quota active · 46.4 ')
  })
})
