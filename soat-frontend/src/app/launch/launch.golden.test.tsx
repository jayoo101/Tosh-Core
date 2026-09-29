// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContractFunctionRevertedError, encodeErrorResult } from 'viem'

import { mount } from '@/testing/renderClient'
import { toshToast } from '@/components/ui'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

/**
 * ENGLISH GOLDEN MASTER · /launch.
 *
 * The page is the factory owner's `createLaunch` form. Every blocker on the
 * deploy button, every revert sentence and every post-confirm outcome is
 * rendered on its own. The salt is made deterministic so the held-salt panel
 * can be pinned.
 */

const USER  = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const SAFE  = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
const HOOK  = '0x0b959B545Da0Bdb4AedA4Ac61C14F280206F1409'
const SALT  = `0x${'5a'.repeat(32)}`
const HASH  = `0x${'ab'.repeat(32)}`
const E18   = 10n ** 18n
const Q     = 10n ** 8n
const MIN_CAP = 30n * Q
const MAX_CAP = 20_000n * Q
const POG     = 500n * Q

interface State {
  dials:       'loading' | 'failed' | 'ready'
  owner:       string
  ownerIsSafe: boolean
  paused:      boolean
  balance:     bigint
  revert:      string | null
  tosh:        { hash?: string; receipt?: { logs: [] }; isConfirmed: boolean }
  sign:        'ok' | 'hang'
  publish:     'ok' | 'fail'
  logoBusy:    boolean
}

let s: State
const said: string[] = []
const refetch = vi.fn()

function reverted(errorName: string) {
  const args = errorName === 'OwnableUnauthorizedAccount' ? [USER] : undefined
  return new ContractFunctionRevertedError({
    abi: FACTORY_ABI,
    functionName: 'createLaunch',
    data: encodeErrorResult({ abi: FACTORY_ABI, errorName, args } as never),
  })
}

const client = {
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case 'hookInitcodeHash': return `0x${'11'.repeat(32)}`
      case 'launchCount':      return 0n
      default: throw new Error(`unexpected read ${functionName}`)
    }
  }),
  getBytecode: vi.fn(async ({ address }: { address: string }) =>
    (address === s.owner && s.ownerIsSafe ? '0x60' : undefined) as never),
  simulateContract: vi.fn(async () => {
    if (s.revert) throw reverted(s.revert)
    return {}
  }),
}
const noOccupant = client.getBytecode.getMockImplementation()!

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: USER, isConnected: true, chainId: 97 }),
  useConnect: () => ({ connectAsync: vi.fn(), connectors: [{}], isPending: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn(), isPending: false }),
  useBalance: () => ({ data: { value: s.balance } }),
  useReadContracts: () => (s.dials === 'ready'
    ? {
        data: [s.owner, MIN_CAP, MAX_CAP, POG, s.paused].map(result => ({ status: 'success', result })),
        isError: false, refetch,
      }
    : { data: undefined, isError: s.dials === 'failed', refetch }),
  usePublicClient: () => client,
  useEstimateFeesPerGas: () => ({ data: { maxFeePerGas: 1_000_000_000n } }),
  useSignMessage: () => ({
    signMessageAsync: vi.fn(() => (s.sign === 'hang' ? new Promise(() => {}) : Promise.resolve('0xsig'))),
  }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}))

vi.mock('../lib/useTosh', () => ({
  useTosh: () => ({
    createLaunch: vi.fn(async () => {}),
    hash: s.tosh.hash, receipt: s.tosh.receipt,
    isPending: false, isConfirming: false, isConfirmed: s.tosh.isConfirmed,
    error: null, reset: vi.fn(),
  }),
}))

vi.mock('@/components/LogoField', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/LogoField')>()
  const { useEffect } = await import('react')
  return {
    ...real,
    LogoField: (props: Parameters<typeof real.LogoField>[0]) => {
      useEffect(() => { if (s.logoBusy) props.onBusyChange?.(true) }, [props])
      return <real.LogoField {...props} />
    },
  }
})

vi.mock('../lib/hookAddress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/hookAddress')>()),
  pickHookSalt: () => ({ rawSalt: SALT, hookAddress: HOOK }),
}))

import { FACTORY_ABI } from '@/lib/contracts'
import GenesisConsole from './page'

beforeEach(() => {
  s = {
    dials: 'ready', owner: USER, ownerIsSafe: false, paused: false,
    balance: E18, revert: null,
    tosh: { isConfirmed: false }, sign: 'ok', publish: 'ok',
    logoBusy: false,
  }
  said.length = 0
  sessionStorage.clear()
  client.getBytecode.mockImplementation(noOccupant)
  vi.spyOn(toshToast, 'error').mockImplementation((m) => { said.push(`error: ${String(m)}`); return 'id' })
  vi.spyOn(toshToast, 'success').mockImplementation((m) => { said.push(`success: ${String(m)}`); return 'id' })
  vi.stubGlobal('fetch', vi.fn(async () => (s.publish === 'ok'
    ? { ok: true, status: 200, json: async () => ({}) }
    : { ok: false, status: 500, json: async () => ({}) })))
})

type UI = ReturnType<typeof mount>

async function flush() {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() })
}

function typeInto(ui: UI, selector: string, value: string) {
  const el = ui.container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement
  if (!el) throw new Error(`no field ${selector}`)
  act(() => {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    desc!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function named(ui: UI) {
  typeInto(ui, 'input[placeholder="QuantMind"]', 'Test Agent')
  typeInto(ui, 'input[placeholder="QMT"]', 'test')
}

function developer(ui: UI, value: string = OTHER) {
  typeInto(ui, 'input[placeholder="0x…"]', value)
}

/** Name, ticker and developer: everything the terms need but the tick. */
function filled(ui: UI) {
  named(ui)
  developer(ui)
}

function hardCap(ui: UI, value: string) {
  typeInto(ui, 'input[placeholder="1000"]', value)
}

function walletCap(ui: UI, value: string) {
  typeInto(ui, 'input[placeholder="500"]', value)
}

function checkboxes(ui: UI): HTMLInputElement[] {
  return [...ui.container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
}

/** The "no hard cap" toggle, the first checkbox on the page. */
function uncap(ui: UI) {
  act(() => { checkboxes(ui)[0].click() })
}

/** The terms tick, the last checkbox on the page. */
function tick(ui: UI) {
  act(() => { checkboxes(ui).at(-1)!.click() })
}

function deployButton(ui: UI): HTMLButtonElement {
  const b = ui.buttons().find(x => (x.textContent ?? '').trim().startsWith('Create launch'))
  if (!b) throw new Error(`no create-launch button: ${JSON.stringify(ui.buttons().map(x => x.textContent))}`)
  return b
}

async function deploy(ui: UI) {
  await act(async () => { deployButton(ui).click() })
  await flush()
}

async function render() {
  const ui = mount(<GenesisConsole />)
  await flush()
  return ui
}

/** See `moneyBackCopy.golden.test.tsx` for why both halves, and why soft. */
function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

describe('/launch · english copy golden master', () => {
  it('reading the factory dials', async () => {
    s.dials = 'loading'
    const ui = await render()
    try { pin(ui) } finally { ui.unmount() }
  })

  it('named while the dials are still loading', async () => {
    s.dials = 'loading'
    const ui = await render()
    try { filled(ui); pin(ui) } finally { ui.unmount() }
  })

  it('factory unreachable', async () => {
    s.dials = 'failed'
    const ui = await render()
    try { filled(ui); pin(ui) } finally { ui.unmount() }
  })

  it('empty form', async () => {
    const ui = await render()
    try { pin(ui) } finally { ui.unmount() }
  })

  it('named, no developer yet', async () => {
    const ui = await render()
    try { named(ui); pin(ui) } finally { ui.unmount() }
  })

  it('invalid developer', async () => {
    const ui = await render()
    try { named(ui); developer(ui, '0x123'); pin(ui) } finally { ui.unmount() }
  })

  it('developer is the owner', async () => {
    const ui = await render()
    try { named(ui); developer(ui, USER); pin(ui) } finally { ui.unmount() }
  })

  it('connected wallet is not the owner', async () => {
    s.owner = SAFE
    const ui = await render()
    try { filled(ui); pin(ui) } finally { ui.unmount() }
  })

  it('owner is a Safe', async () => {
    s.owner = SAFE
    s.ownerIsSafe = true
    const ui = await render()
    try { await flush(); filled(ui); pin(ui) } finally { ui.unmount() }
  })

  it('factory paused', async () => {
    s.paused = true
    const ui = await render()
    try { filled(ui); pin(ui) } finally { ui.unmount() }
  })

  it('logo still uploading', async () => {
    s.logoBusy = true
    const ui = await render()
    try { filled(ui); pin(ui) } finally { ui.unmount() }
  })

  it('hard cap below the factory minimum', async () => {
    const ui = await render()
    try { filled(ui); hardCap(ui, '10'); pin(ui) } finally { ui.unmount() }
  })

  it('wallet cap above the hard cap', async () => {
    const ui = await render()
    try { filled(ui); walletCap(ui, '2000'); pin(ui) } finally { ui.unmount() }
  })

  it('no hard cap, wallet cap above the ceiling', async () => {
    const ui = await render()
    try { filled(ui); uncap(ui); walletCap(ui, '30000'); pin(ui) } finally { ui.unmount() }
  })

  it('ticked, not enough to cover gas', async () => {
    s.balance = 1n
    const ui = await render()
    try { filled(ui); tick(ui); pin(ui) } finally { ui.unmount() }
  })

  it('ticked, ready to deploy, 72-hour window', async () => {
    const ui = await render()
    try {
      filled(ui)
      typeInto(ui, 'textarea', 'An agent that does things.')
      act(() => { ui.button('72 hours').click() })
      tick(ui)
      pin(ui)
    } finally { ui.unmount() }
  })

  it('ticked, ready to deploy, no hard cap', async () => {
    const ui = await render()
    try { filled(ui); uncap(ui); tick(ui); pin(ui) } finally { ui.unmount() }
  })

  it('reserving the pool address', async () => {
    client.getBytecode.mockImplementation(() => new Promise(() => {}) as never)
    const ui = await render()
    try { filled(ui); tick(ui); await deploy(ui); pin(ui) } finally { ui.unmount() }
  })

  it('the caps moved while a salt was held', async () => {
    s.revert = 'NameTaken'
    const ui = await render()
    try {
      filled(ui); tick(ui); await deploy(ui)
      hardCap(ui, '2000')
      await flush()
      pin(ui)
    } finally { ui.unmount() }
  })

  for (const errorName of [
    'NameTaken', 'InvalidDeveloper', 'HardCapTooLow', 'HardCapTooHigh', 'InvalidWalletCap',
    'OwnableUnauthorizedAccount', 'DeployFailed', 'EnforcedPause', 'CloneDeployFailed',
  ]) {
    it(`pre-flight revert · ${errorName}`, async () => {
      s.revert = errorName
      const ui = await render()
      try { filled(ui); tick(ui); await deploy(ui); pin(ui) } finally { ui.unmount() }
    })
  }

  it('no free hook address', async () => {
    client.getBytecode.mockImplementation(async () => '0x60' as never)
    const ui = await render()
    try { filled(ui); tick(ui); await deploy(ui); pin(ui) } finally { ui.unmount() }
  })

  for (const [name, sign, publish] of [
    ['confirmed, waiting on the listing signature', 'hang', 'ok'],
    ['confirmed, listing published', 'ok', 'ok'],
    ['confirmed, listing failed', 'ok', 'fail'],
  ] as const) {
    it(name, async () => {
      s.sign = sign
      s.publish = publish
      const ui = await render()
      try {
        filled(ui); tick(ui); await deploy(ui)
        s.tosh = { hash: HASH, receipt: { logs: [] }, isConfirmed: true }
        typeInto(ui, 'textarea', 'x')
        await flush()
        pin(ui)
        expect(said).toMatchSnapshot()
      } finally { ui.unmount() }
    })
  }
})
