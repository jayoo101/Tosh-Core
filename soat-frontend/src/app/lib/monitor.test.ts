import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'

import { OWNER_SAFE, SAFE_OWNERS, runChecks, type Reader } from './monitor'

const FACTORY: Address = '0x091d0cBD1e3B7D8b2a6fd8e0795b784EdDFfb590'
const GATEWAY: Address = '0x790091e8965eCc1adfA40AA9b95515C6289dCE9d'
const LADDER: Address = '0x858aA8f83FCDbBdBc40eECbD2c2fC3D90aa3B632'
const BOOK: Address = '0x7FB867b51414cbB6C0EAc6E4e6b401dee1044d98'
const EVIL: Address = '0x000000000000000000000000000000000000bEEF'
const ZERO: Address = '0x0000000000000000000000000000000000000000'

/** The deployment as it stands, overridable per `address:function`. */
function chain(overrides: Record<string, unknown> = {}): Reader {
  const state: Record<string, unknown> = {
    [`${OWNER_SAFE}:getOwners`]: SAFE_OWNERS,
    [`${OWNER_SAFE}:getThreshold`]: 2n,
    [`${OWNER_SAFE}:nonce`]: 18n,
    [`${FACTORY}:owner`]: GATEWAY,
    [`${FACTORY}:pendingOwner`]: ZERO,
    [`${FACTORY}:paused`]: false,
    [`${FACTORY}:ladderTreasury`]: LADDER,
    [`${FACTORY}:platformTreasury`]: OWNER_SAFE,
    [`${FACTORY}:bidBook`]: BOOK,
    [`${GATEWAY}:safe`]: OWNER_SAFE,
    [`${LADDER}:owner`]: OWNER_SAFE,
    [`${BOOK}:feeRecipient`]: OWNER_SAFE,
    ...overrides,
  }
  return (async (address: Address, _abi: readonly unknown[], fn: string) => {
    const v = state[`${address}:${fn}`]
    if (v instanceof Error) throw v
    if (v === undefined) throw new Error(`execution reverted: ${fn}`)
    return v
  }) as Reader
}

const targets = { factories: [FACTORY], bidBook: BOOK }
const fresh = async (): Promise<string | null> => null
const ids = async (read: Reader, index = fresh) => (await runChecks(read, targets, index)).map(a => a.id)

describe('runChecks', () => {
  it('reports only the Safe nonce when the deployment matches SECURITY.md', async () => {
    expect(await ids(chain())).toEqual(['safe-nonce:18'])
  })

  it('a new Safe transaction is a new alert id, so it is announced once', async () => {
    expect(await ids(chain({ [`${OWNER_SAFE}:nonce`]: 19n }))).toEqual(['safe-nonce:19'])
  })

  it('flags a changed signer set or threshold', async () => {
    expect(await ids(chain({ [`${OWNER_SAFE}:getOwners`]: [...SAFE_OWNERS.slice(0, 2), EVIL] }))).toContain('safe-shape')
    expect(await ids(chain({ [`${OWNER_SAFE}:getThreshold`]: 1n }))).toContain('safe-shape')
  })

  it('flags a factory no longer owned through the Safe gateway, or one being handed over', async () => {
    expect(await ids(chain({ [`${FACTORY}:owner`]: EVIL }))).toContain(`owner:${FACTORY}`)
    expect(await ids(chain({ [`${FACTORY}:pendingOwner`]: EVIL }))).toContain(`pending:${FACTORY}`)
    expect(await ids(chain({ [`${FACTORY}:paused`]: true }))).toContain(`paused:${FACTORY}`)
  })

  it('flags money routed away from the Safe', async () => {
    expect(await ids(chain({ [`${LADDER}:owner`]: EVIL }))).toContain(`ladder:${LADDER}`)
    expect(await ids(chain({ [`${FACTORY}:platformTreasury`]: EVIL }))).toContain(`platform:${FACTORY}`)
    expect(await ids(chain({ [`${BOOK}:feeRecipient`]: EVIL }))).toContain('bidbook-fees')
    expect(await ids(chain({ [`${FACTORY}:bidBook`]: EVIL }))).toContain(`book:${FACTORY}`)
  })

  it('a chain it cannot read is an alert, not a pass', async () => {
    expect(await ids(chain({ [`${OWNER_SAFE}:nonce`]: new Error('timeout') }))).toEqual(['read:safe'])
  })

  it('flags a stale index', async () => {
    expect(await ids(chain(), async () => 'index is 900s old')).toContain('index')
  })
})
