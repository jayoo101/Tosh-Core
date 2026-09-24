// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

import { WalletPickerProvider, WithoutWalletPicker, useWalletPicker } from './WalletPicker'

/**
 * The wallet picker, and specifically what the Binance row promises on each
 * kind of device — the listing review checks that row on web, iOS and Android,
 * and each of those reaches Binance a different way.
 */

type FakeConnector = { id: string; uid: string; name: string; type: string; icon?: string }

const binance: FakeConnector = { id: 'wallet.binance.com', uid: 'b', name: 'Binance Wallet', type: 'injected' }
const browser: FakeConnector = { id: 'injected', uid: 'i', name: 'Injected', type: 'injected' }
const walletConnect: FakeConnector = { id: 'walletConnect', uid: 'w', name: 'WalletConnect', type: 'walletConnect' }
const metaMask: FakeConnector = { id: 'io.metamask', uid: 'm', name: 'MetaMask', type: 'injected', icon: 'data:image/svg+xml,x' }

let connectors: FakeConnector[] = []
let connectedChain = 97
const connectAsync = vi.fn(async () => ({ accounts: ['0x1'], chainId: connectedChain }))
const switchChainAsync = vi.fn(async () => ({ id: 97 }))

vi.mock('wagmi', () => ({
  useConnectors: () => connectors,
  useConnect: () => ({ connectAsync, isPending: false }),
  useSwitchChain: () => ({ switchChainAsync }),
}))

vi.mock('@/components/ui/toast', () => ({
  toshToast: { fromError: vi.fn() },
}))

type Win = Window & { ethereum?: unknown; binancew3w?: unknown }

function Opener() {
  const picker = useWalletPicker()
  return <button type="button" onClick={() => picker?.open()}>open</button>
}

function openPicker() {
  const ui = mount(<WalletPickerProvider><Opener /></WalletPickerProvider>)
  act(() => { ui.button('open').click() })
  return ui
}

function rowTexts(ui: ReturnType<typeof mount>): string[] {
  return [...ui.container.querySelectorAll('li button')].map((b) => b.textContent ?? '')
}

beforeEach(() => {
  connectors = [binance, browser]
  connectedChain = 97
  connectAsync.mockClear()
  switchChainAsync.mockClear()
})

afterEach(() => {
  delete (window as Win).ethereum
  delete (window as Win).binancew3w
  vi.restoreAllMocks()
})

describe('WalletPicker · the Binance row', () => {
  it('is always first, even with no Binance wallet anywhere', () => {
    const ui = openPicker()
    try {
      expect(rowTexts(ui)[0]).toBe('Binance WalletGet the Binance app')
    } finally { ui.unmount() }
  })

  it('connects the extension when one is injected', async () => {
    ;(window as Win).binancew3w = { ethereum: { request: vi.fn() } }
    const ui = openPicker()
    try {
      expect(rowTexts(ui)[0]).toBe('Binance WalletDetected in this browser')
      await act(async () => { (ui.container.querySelector('li button') as HTMLButtonElement).click() })
      expect(connectAsync).toHaveBeenCalledWith({ connector: binance })
    } finally { ui.unmount() }
  })

  it('offers to reopen the page in the app on a phone without it', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')
    const ui = openPicker()
    try {
      expect(rowTexts(ui)[0]).toBe('Binance WalletOpens this page in the Binance app')
    } finally { ui.unmount() }
  })

  it('falls back to a QR code on a desktop when WalletConnect is configured', async () => {
    connectors = [binance, browser, walletConnect]
    const ui = openPicker()
    try {
      expect(rowTexts(ui)[0]).toBe('Binance WalletScan a QR code with the Binance app')
      await act(async () => { (ui.container.querySelector('li button') as HTMLButtonElement).click() })
      expect(connectAsync).toHaveBeenCalledWith({ connector: walletConnect })
    } finally { ui.unmount() }
  })

  it('skips the list inside the Binance app and connects straight away', async () => {
    ;(window as Win).ethereum = { isBinance: true, request: vi.fn() }
    const ui = mount(<WalletPickerProvider><Opener /></WalletPickerProvider>)
    try {
      await act(async () => { ui.button('open').click() })
      expect(ui.container.querySelector('[role="dialog"]')).toBeNull()
      expect(connectAsync).toHaveBeenCalledWith({ connector: binance })
    } finally { ui.unmount() }
  })
})

describe('WalletPicker · everything else', () => {
  it('lists announced extensions by name and drops the generic row', () => {
    ;(window as Win).ethereum = { request: vi.fn() }
    connectors = [binance, browser, metaMask]
    const ui = openPicker()
    try {
      expect(rowTexts(ui)).toEqual([
        'Binance WalletGet the Binance app',
        'MetaMaskDetected',
      ])
    } finally { ui.unmount() }
  })

  it('shows the generic browser wallet when nothing announced itself', () => {
    ;(window as Win).ethereum = { request: vi.fn() }
    const ui = openPicker()
    try {
      expect(rowTexts(ui)[1]).toBe('Browser walletMetaMask, Rabby, OKX and other extensions')
    } finally { ui.unmount() }
  })

  it('asks a wallet that lands on another chain to switch', async () => {
    ;(window as Win).binancew3w = { ethereum: { request: vi.fn() } }
    connectedChain = 1
    const ui = openPicker()
    try {
      await act(async () => { (ui.container.querySelector('li button') as HTMLButtonElement).click() })
      expect(switchChainAsync).toHaveBeenCalledWith({ chainId: 97 })
    } finally { ui.unmount() }
  })

  it('is switched off under WithoutWalletPicker', () => {
    function Probe() { return <span>{useWalletPicker() === null ? 'off' : 'on'}</span> }
    const ui = mount(
      <WalletPickerProvider><WithoutWalletPicker><Probe /></WithoutWalletPicker></WalletPickerProvider>,
    )
    try {
      expect(ui.text()).toBe('off')
    } finally { ui.unmount() }
  })
})
