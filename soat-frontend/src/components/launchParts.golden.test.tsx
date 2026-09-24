// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'
import { LOGO_MAX_BYTES } from '@/lib/logoUpload'

import { LaunchPreview } from './LaunchPreview'
import { LogoField } from './LogoField'

/**
 * ENGLISH GOLDEN MASTER · the launch form's logo field and listing preview.
 *
 * Taken before their copy moves into the dictionary. `LogoField` is also the
 * publish-listing panel's, so each of its refusals is rendered on its own.
 */

/** See `moneyBackCopy.golden.test.tsx` for why both halves, and why soft. */
function pin(ui: { strings(): string[]; prose(): string }) {
  expect.soft(ui.strings()).toMatchSnapshot()
  expect.soft(ui.prose()).toMatchSnapshot()
}

function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  act(() => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}

async function flush() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() })
}

const png = (bytes: number) => new File([new Uint8Array(bytes)], 'logo.png', { type: 'image/png' })

describe('LogoField · english copy golden master', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

  it('empty', () => {
    const ui = mount(<LogoField value="" onValueChange={() => {}} name="Agent" />)
    try { pin(ui) } finally { ui.unmount() }
  })

  it('with an image', () => {
    const ui = mount(<LogoField value="https://cdn.test/logo.png" onValueChange={() => {}} name="Agent" />)
    try { pin(ui) } finally { ui.unmount() }
  })

  const refusals: [string, File, (() => Promise<unknown>) | null][] = [
    ['uploading', png(32), () => new Promise(() => {})],
    ['empty file', png(0), null],
    ['over the size limit', png(LOGO_MAX_BYTES + 1), null],
    ['svg', new File(['<svg/>'], 'mark.svg', { type: 'image/svg+xml' }), null],
    ['route refused with no message', png(32), async () => ({ ok: false, json: async () => ({}) })],
    ['route answered with no url', png(32), async () => ({ ok: true, json: async () => ({}) })],
    ['network failure', png(32), async () => { throw new Error('offline') }],
  ]

  for (const [name, file, respond] of refusals) {
    it(name, async () => {
      vi.stubGlobal('fetch', vi.fn(respond ?? (async () => { throw new Error('should not be called') })))
      const ui = mount(<LogoField value="" onValueChange={() => {}} name="Agent" />)
      try {
        pick(ui.container, file)
        await flush()
        pin(ui)
      } finally { ui.unmount() }
    })
  }
})

describe('LaunchPreview · english copy golden master', () => {
  it('nothing typed yet', () => {
    const ui = mount(
      <LaunchPreview name="" symbol="" description="" logoUrl="" windowLabel="24h" poolAddress="" />,
    )
    try { pin(ui) } finally { ui.unmount() }
  })

  it('filled in, pool address ground', () => {
    const ui = mount(
      <LaunchPreview
        name="Test Agent" symbol="TEST" description="An agent that does things."
        logoUrl="https://cdn.test/logo.png" windowLabel="72h"
        poolAddress="0x0b959B545Da0Bdb4AedA4Ac61C14F280206F1409"
      />,
    )
    try { pin(ui) } finally { ui.unmount() }
  })
})
