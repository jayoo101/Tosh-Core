// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'
import { toshToast } from '@/components/ui'

import { usePogFlow, type PogFlow } from './usePogFlow'
import type { PogScanResult } from './pogScanClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * ENGLISH GOLDEN MASTER · what the gas lookup says outside the dialog.
 *
 * Taken before its copy moves into the dictionary. None of this is markup: it
 * is toasts, plus the `error` the dialog and the deposit gate print when a
 * lookup fails. Each case records every toast in the order it fired, with the
 * `error` last.
 */

const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const

let address: string | undefined = USER
let chainId: number | undefined = 97
let result: PogScanResult

vi.mock('wagmi', () => ({
  useAccount: () => ({ address, chainId, isConnected: Boolean(address) }),
  usePublicClient: () => undefined,
  useSignMessage: () => ({ signMessageAsync: vi.fn(async () => '0xsig') }),
  useWriteContract: () => ({
    writeContract: vi.fn(), writeContractAsync: vi.fn(),
    data: undefined, isPending: false, error: null, reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: undefined, isLoading: false, isSuccess: false, error: null,
  }),
}))

vi.mock('./pogScanClient', () => ({
  runUnsignedPogScan: vi.fn(async () => result),
}))

let said: string[]

beforeEach(() => {
  address = USER
  chainId = 97
  result = {
    status: 'done', eligible: true, totalGasWei: '500000000000000000',
    floorWei: '25000000000000000', truncated: false, chains: [],
  }
  said = []
  sessionStorage.clear()
  vi.spyOn(toshToast, 'error').mockImplementation((m) => { said.push(`error: ${String(m)}`); return 'id' })
  vi.spyOn(toshToast, 'info').mockImplementation((m) => { said.push(`info: ${String(m)}`); return 'id' })
  vi.spyOn(toshToast, 'fromError').mockImplementation((e) => {
    said.push(`fromError: ${e instanceof Error ? e.message : String(e)}`)
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ maxAlloc: '116000000', nonce: '0', deadline: '9999999999', signature: '0xatt' }),
  })))
})

async function drive(steps: (flow: PogFlow) => Promise<void> | void): Promise<string[]> {
  const ref: { flow: PogFlow | null } = { flow: null }
  function Probe() {
    ref.flow = usePogFlow()
    return null
  }
  const ui = mount(<Probe />)
  try {
    await act(async () => { await steps(ref.flow!) })
    for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve() })
    return [...said, `error field: ${ref.flow!.error}`]
  } finally {
    ui.unmount()
  }
}

describe('usePogFlow · english copy golden master', () => {
  it('lookup on an unsupported chain', async () => {
    chainId = 4663
    expect(await drive(f => f.startLookup())).toMatchSnapshot()
  })

  it('lookup on no chain', async () => {
    chainId = undefined
    expect(await drive(f => f.startLookup())).toMatchSnapshot()
  })

  it('lookup truncated, chains missing', async () => {
    result = { ...result, truncated: true, unavailableChains: ['BSC', 'Robinhood'] }
    expect(await drive(f => f.startLookup())).toMatchSnapshot()
  })

  it('lookup truncated, nothing missing', async () => {
    result = { ...result, truncated: true }
    expect(await drive(f => f.startLookup())).toMatchSnapshot()
  })

  it('register with no wallet', async () => {
    address = undefined
    expect(await drive(f => f.registerQuota())).toMatchSnapshot()
  })

  it('register on an unsupported chain', async () => {
    chainId = 4663
    expect(await drive(f => f.registerQuota())).toMatchSnapshot()
  })

  it('register before any eligible scan', async () => {
    expect(await drive(f => f.registerQuota())).toMatchSnapshot()
  })

  it('register after an eligible scan', async () => {
    const ref: { flow: PogFlow | null } = { flow: null }
    function Probe() {
      ref.flow = usePogFlow()
      return null
    }
    const ui = mount(<Probe />)
    try {
      await act(async () => { await ref.flow!.startLookup() })
      await act(async () => { await ref.flow!.registerQuota() })
      for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve() })
    } finally {
      ui.unmount()
    }
    expect(said).toMatchSnapshot()
  })
})
