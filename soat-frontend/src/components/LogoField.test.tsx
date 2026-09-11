// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mount } from '@/testing/renderClient'
import { LOGO_MAX_BYTES } from '@/lib/logoUpload'
import { LogoField } from './LogoField'

/**
 * The launch form used to expose artwork as a URL field inside a collapsed
 * optional block. That is a field, not a capability — a launcher still had to
 * host the bytes somewhere first. What is pinned here is that choosing a file
 * actually POSTs it, and that the two refusals a user is likely to hit on
 * purpose (too big, SVG) never leave the browser.
 */

function pngFile(name = 'logo.png', bytes = 32): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' })
}

function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function flush() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() })
}

describe('LogoField', () => {
  const onValueChange = vi.fn<(url: string) => void>()
  const onBusyChange = vi.fn<(busy: boolean) => void>()
  const fetchMock = vi.fn()

  beforeEach(() => {
    onValueChange.mockReset()
    onBusyChange.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs the chosen file and writes the returned URL', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://cdn.test/logo.png' }),
    })
    const ui = mount(
      <LogoField value="" onValueChange={onValueChange} onBusyChange={onBusyChange} />,
    )
    try {
      pick(ui.container, pngFile())
      await flush()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/projects/logo')
      expect(init.method).toBe('POST')
      expect(init.body).toBeInstanceOf(FormData)
      expect((init.body as FormData).get('file')).toBeInstanceOf(File)
      expect(onBusyChange.mock.calls.map((c) => c[0])).toEqual([true, false])
      expect(onValueChange).toHaveBeenCalledWith('https://cdn.test/logo.png')
    } finally {
      ui.unmount()
    }
  })

  it('refuses an oversize file without calling the route', async () => {
    const ui = mount(<LogoField value="" onValueChange={onValueChange} />)
    try {
      pick(ui.container, pngFile('big.png', LOGO_MAX_BYTES + 1))
      await flush()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(onValueChange).not.toHaveBeenCalled()
      expect(ui.text()).toMatch(/The limit is 1024 KB/)
    } finally {
      ui.unmount()
    }
  })

  it('refuses SVG without calling the route', async () => {
    const ui = mount(<LogoField value="" onValueChange={onValueChange} />)
    try {
      pick(ui.container, new File(['<svg/>'], 'mark.svg', { type: 'image/svg+xml' }))
      await flush()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(ui.text()).toMatch(/SVG is not accepted/)
    } finally {
      ui.unmount()
    }
  })

  it('surfaces the route error and does not write a URL', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Image upload is not configured on this deployment' }),
    })
    const ui = mount(<LogoField value="" onValueChange={onValueChange} />)
    try {
      pick(ui.container, pngFile())
      await flush()
      expect(onValueChange).not.toHaveBeenCalled()
      expect(ui.text()).toMatch(/not configured on this deployment/)
    } finally {
      ui.unmount()
    }
  })

  it('Remove clears the URL', () => {
    const ui = mount(
      <LogoField value="https://cdn.test/logo.png" onValueChange={onValueChange} />,
    )
    try {
      act(() => { ui.button('Remove').click() })
      expect(onValueChange).toHaveBeenCalledWith('')
    } finally {
      ui.unmount()
    }
  })
})
