import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isStaleBuildError, reloadOnceForStaleBuild } from './staleBuild'

const chunkError = () =>
  new Error('Failed to load chunk /_next/static/immutable/chunks/0lnzch8jjgy_o.js from module 12345')

let store: Map<string, string>
let reload: ReturnType<typeof vi.fn>

beforeEach(() => {
  store = new Map()
  reload = vi.fn()
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    location: { reload },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('stale build recovery', () => {
  it('recognises chunk failures from webpack, Turbopack and native import()', () => {
    const named = new Error('Loading chunk 742 failed.')
    named.name = 'ChunkLoadError'
    expect(isStaleBuildError(named)).toBe(true)
    expect(isStaleBuildError(chunkError())).toBe(true)
    expect(isStaleBuildError(new TypeError('Failed to fetch dynamically imported module: https://toshx.xyz/x.js'))).toBe(true)
  })

  it('leaves ordinary crashes alone', () => {
    const plain = new TypeError("Cannot read properties of undefined (reading 'map')")
    expect(isStaleBuildError(plain)).toBe(false)
    expect(reloadOnceForStaleBuild(plain)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads once, and not again if the reloaded page fails the same way', () => {
    vi.useFakeTimers()
    expect(reloadOnceForStaleBuild(chunkError())).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5_000)
    expect(reloadOnceForStaleBuild(chunkError())).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60_000)
    expect(reloadOnceForStaleBuild(chunkError())).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
