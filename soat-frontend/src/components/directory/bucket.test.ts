import { describe, expect, it } from 'vitest'

import { bucket } from './useDirectoryProjects'

/**
 * The tab rule. It once bucketed on the soft cap, which decides nothing; the
 * clock and `launched()` are the whole of it, and v2 has no refund state.
 */

const DEADLINE = 1_000_000n
const AFTER = Number(DEADLINE) + 1
const DURING = Number(DEADLINE) - 1

describe('bucket', () => {
  it('files a launched project as completed whatever the clock says', () => {
    expect(bucket(true, DEADLINE, AFTER)).toBe('completed')
    expect(bucket(true, DEADLINE, DURING)).toBe('completed')
  })

  it('is live while deposits are open', () => {
    expect(bucket(false, DEADLINE, DURING)).toBe('live')
  })

  it('waits on launch once the deadline has passed', () => {
    expect(bucket(false, DEADLINE, AFTER)).toBe('launching')
  })

  it('treats an unsynced clock as live rather than as expired', () => {
    expect(bucket(false, DEADLINE, 0)).toBe('live')
  })
})
