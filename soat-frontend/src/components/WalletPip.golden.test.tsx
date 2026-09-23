// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
  process.env.NEXT_PUBLIC_CHAIN_ID = '97'
})

import { WalletPip } from './WalletPip'

/**
 * ENGLISH GOLDEN MASTER · the header wallet control.
 *
 * Taken before its copy moves into a dictionary, and the reason it gets a file
 * of its own is that this is the LAST English string on the money path. Every
 * panel behind it now renders Chinese, and a reader who cannot connect a wallet
 * never reaches any of them — so the three words on this button are the
 * gateway to deposit, claim and refund alike.
 *
 * ⚠ THE LABEL IS UPPERCASE IN THE SOURCE **AND** IN CSS, and that is the trap
 *   this file exists to hold still. `connectCls` carries Tailwind's `uppercase`,
 *   so the visible text would be CONNECT WALLET whichever case the string is
 *   written in — but `text-transform` does not touch `textContent`, so reusing
 *   the Smart CTA's `gate.connect` ("Connect Wallet") would leave the rendering
 *   identical and this snapshot red. That is the assertion doing its job: the
 *   two are different strings on different surfaces, and the header has a short
 *   form the gate has no concept of.
 *
 * ⚠ AND THE SHORT FORM IS NOT DEAD CODE. Both spans are always in the DOM;
 *   which one shows is a media query, so `strings()` sees CONNECT and CONNECT
 *   WALLET together. The component's own comment records why: measured at
 *   390px the navbar needs 424px of the 358px it has, and this button is 152px
 *   of that. Two spans rather than an `aria-label`, so a voice-control user
 *   saying "click connect wallet" is never naming something invisible.
 *
 * `sys_control` is not covered here — it needs `useProtocolOwner` to answer
 * true, and it is an operator link into `/admin`, which stays English.
 */

const ACCOUNT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

let connected = false
let connecting = false

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: connected ? ACCOUNT : undefined,
    isConnected: connected,
    chainId: connected ? 97 : undefined,
  }),
  useConnect: () => ({ connect: vi.fn(), isPending: connecting }),
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
}))

// `useProtocolOwner` reads a contract through wagmi; the mock above answers
// `undefined`, which is what a non-owner looks like. Stubbed explicitly so the
// hidden admin link cannot appear because of a change in that hook.
vi.mock('@/lib/useProtocolOwner', () => ({
  useProtocolOwner: () => ({ isOwner: false, owner: undefined }),
}))

// The drawer only mounts when connected, and its copy is a separate surface.
vi.mock('./UserDrawer', () => ({
  UserDrawer: () => null,
}))

function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

describe('WalletPip · english copy golden master', () => {
  for (const variant of ['navbar', 'default'] as const) {
    it(`${variant} · disconnected`, () => {
      connected = false
      connecting = false
      const ui = mount(<WalletPip variant={variant} />)
      try {
        pin(ui)
      } finally { ui.unmount() }
    })
  }

  it('navbar · connecting', () => {
    connected = false
    connecting = true
    const ui = mount(<WalletPip variant="navbar" />)
    try {
      pin(ui)
    } finally { ui.unmount() }
  })

  // Connected renders a truncated address and no prose, so there is nothing to
  // translate — pinned anyway, because "no copy here" is a claim worth holding.
  it('navbar · connected', () => {
    connected = true
    connecting = false
    const ui = mount(<WalletPip variant="navbar" />)
    try {
      pin(ui)
    } finally { ui.unmount() }
  })
})
