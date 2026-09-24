// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

import { mount } from '@/testing/renderClient'
import { toshToast } from '@/components/ui'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * ENGLISH GOLDEN MASTER · the creator's publish-listing panel.
 *
 * Taken before its copy moves into the dictionary. `LogoField` is stubbed: it
 * is the launch form's field as well and is pinned with that page, so here it
 * only has to be able to report an upload in flight.
 */

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, chainId: 97 }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  useSignMessage: () => ({ signMessageAsync: vi.fn(async () => '0xsig') }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

vi.mock('@/components/LogoField', () => ({
  LogoField: ({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) => (
    <button type="button" onClick={() => onBusyChange(true)}>logo-stub</button>
  ),
}))

import { PublishListingPanel } from './PublishListingPanel'

const HOOK = '0x0b959B545Da0Bdb4AedA4Ac61C14F280206F1409' as Address
const HASH = `0x${'ab'.repeat(32)}`

type LaunchTx = 'pending' | 'found' | 'missing'
let launchTx: LaunchTx = 'found'
let publishOk = true
let said: string[] = []

beforeEach(() => {
  launchTx = 'found'
  publishOk = true
  said = []
  vi.spyOn(toshToast, 'success').mockImplementation((m) => { said.push(`success: ${String(m)}`); return 'id' })
  vi.spyOn(toshToast, 'fromError').mockImplementation((e) => {
    said.push(`fromError: ${e instanceof Error ? e.message : String(e)}`)
  })
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (String(url).startsWith('/api/projects/launch-tx')) {
      if (launchTx === 'pending') return new Promise(() => {})
      if (launchTx === 'missing') return Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ txHash: HASH }) })
    }
    return Promise.resolve(publishOk
      ? { ok: true, status: 200, json: async () => ({}) }
      : { ok: false, status: 400, json: async () => ({ error: 'server says no' }) })
  }))
})

async function render() {
  const ui = mount(<PublishListingPanel hookAddress={HOOK} name="Test Agent" symbol="TEST" />)
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
  return ui
}

function pasteHash(ui: Awaited<ReturnType<typeof render>>, value: string) {
  const el = ui.container.querySelector('input[placeholder="0x…"]') as HTMLInputElement
  act(() => {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    desc!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** See `moneyBackCopy.golden.test.tsx` for why both halves, and why soft. */
function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

describe('PublishListingPanel · english copy golden master', () => {
  it('finding the launch', async () => {
    launchTx = 'pending'
    const ui = await render()
    try { pin(ui) } finally { ui.unmount() }
  })

  it('launch found, ready to publish', async () => {
    const ui = await render()
    try { pin(ui) } finally { ui.unmount() }
  })

  it('lookup failed, no hash pasted', async () => {
    launchTx = 'missing'
    const ui = await render()
    try { pin(ui) } finally { ui.unmount() }
  })

  it('lookup failed, hash pasted', async () => {
    launchTx = 'missing'
    const ui = await render()
    try {
      pasteHash(ui, HASH)
      pin(ui)
    } finally { ui.unmount() }
  })

  it('logo still uploading', async () => {
    const ui = await render()
    try {
      act(() => { ui.button('logo-stub').click() })
      pin(ui)
    } finally { ui.unmount() }
  })

  it('what publishing says', async () => {
    const ui = await render()
    try {
      await act(async () => { ui.button('Publish listing').click() })
      for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
      publishOk = false
      await act(async () => { ui.button('Publish listing').click() })
      for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
    } finally { ui.unmount() }
    expect(said).toMatchSnapshot()
  })
})
