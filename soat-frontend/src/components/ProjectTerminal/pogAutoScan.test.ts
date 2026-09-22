import { describe, it, expect } from 'vitest'

import { shouldAutoScan } from './pogAutoScan'

const WALLET = '0xAbC0000000000000000000000000000000000001'

function base() {
  return {
    unattested: true,
    wallet: WALLET as string | undefined,
    phase: 'idle' as 'idle' | 'scanning' | 'ready' | 'failed',
    startedFor: null as string | null,
  }
}

describe('shouldAutoScan', () => {
  it('fires when quota is zero, a wallet is connected and nothing has been read', () => {
    expect(shouldAutoScan(base())).toBe(true)
  })

  it('does not fire before a wallet is connected', () => {
    expect(shouldAutoScan({ ...base(), wallet: undefined })).toBe(false)
  })

  it('does not fire when quota is not what blocks the deposit', () => {
    // A wallet that already has quota, is banned, or whose quota has not been
    // read yet: the gate is not showing, so there is nothing to size.
    expect(shouldAutoScan({ ...base(), unattested: false })).toBe(false)
  })

  it('does not fire a second time for the same wallet', () => {
    // The guard that makes this safe to put in an effect with `phase` as a
    // dependency: a re-render must not buy another 5-25 upstream calls.
    expect(shouldAutoScan({ ...base(), startedFor: WALLET.toLowerCase() })).toBe(false)
  })

  it('compares wallets case-insensitively, so a checksummed address is not a new one', () => {
    // `startedFor` is written lowercased; the wallet arrives checksummed. A
    // case-sensitive compare here would re-scan on every render, forever.
    expect(shouldAutoScan({ ...base(), startedFor: WALLET.toUpperCase() })).toBe(true)
    expect(shouldAutoScan({ ...base(), startedFor: WALLET.toLowerCase() })).toBe(false)
  })

  it('fires again when the reader switches to a wallet it has not read', () => {
    const other = '0x0000000000000000000000000000000000000002'
    expect(shouldAutoScan({ ...base(), wallet: other, startedFor: WALLET.toLowerCase() }))
      .toBe(true)
  })

  it('does not fire while a scan is already running', () => {
    expect(shouldAutoScan({ ...base(), phase: 'scanning' })).toBe(false)
  })

  it('does not fire once an answer is in hand, eligible or not', () => {
    // Below the floor is still an answer. Re-reading it would spend credits to
    // learn the same thing and would never terminate.
    expect(shouldAutoScan({ ...base(), phase: 'ready' })).toBe(false)
  })

  it('does not fire after a failure, which is what the Retry button is for', () => {
    // The property most worth pinning. `failed` returns to a state with no
    // answer, so a rule written as "fire when there is no answer" would retry a
    // dead upstream host on every render until the budget was gone.
    expect(shouldAutoScan({ ...base(), phase: 'failed' })).toBe(false)
    // And still not after a failure on a wallet it never managed to read.
    expect(shouldAutoScan({ ...base(), phase: 'failed', startedFor: null })).toBe(false)
  })
})
