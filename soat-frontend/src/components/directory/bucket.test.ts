import { describe, expect, it } from 'vitest'

import { bucket } from './useDirectoryProjects'

/**
 * The tab rule: the clock, `launched()` and whether anything sold. v2 has no
 * refund state; a closed genesis that sold nothing can never launch.
 */

const DEADLINE = 1_000_000n
const AFTER = Number(DEADLINE) + 1
const DURING = Number(DEADLINE) - 1
const SOLD = 1n

describe('bucket', () => {
  it('files a launched project as completed whatever the clock says', () => {
    expect(bucket(true, DEADLINE, AFTER, SOLD)).toBe('completed')
    expect(bucket(true, DEADLINE, DURING, SOLD)).toBe('completed')
  })

  it('is live while GENESIS is open, sold or not', () => {
    expect(bucket(false, DEADLINE, DURING, SOLD)).toBe('live')
    expect(bucket(false, DEADLINE, DURING, 0n)).toBe('live')
  })

  it('waits on launch once the deadline has passed with something sold', () => {
    expect(bucket(false, DEADLINE, AFTER, SOLD)).toBe('launching')
  })

  it('ends a closed GENESIS that sold nothing, since launch() reverts NothingRaised', () => {
    expect(bucket(false, DEADLINE, AFTER, 0n)).toBe('ended')
  })

  it('treats an unsynced clock as live rather than as expired', () => {
    expect(bucket(false, DEADLINE, 0, 0n)).toBe('live')
  })
})
