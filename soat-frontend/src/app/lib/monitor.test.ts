import { describe, expect, it } from 'vitest'
import { getAddress, type Address } from 'viem'

import { OWNER_SAFE, SAFE_OWNERS, gatewaysToRenew, permanentHalts, runChecks, v31Upkeep, type Reader } from './monitor'

const FACTORY: Address = '0x091d0cBD1e3B7D8b2a6fd8e0795b784EdDFfb590'
const GATEWAY: Address = '0x790091e8965eCc1adfA40AA9b95515C6289dCE9d'
const LADDER: Address = '0x858aA8f83FCDbBdBc40eECbD2c2fC3D90aa3B632'
const BOOK: Address = '0x7FB867b51414cbB6C0EAc6E4e6b401dee1044d98'
const EVIL: Address = '0x000000000000000000000000000000000000bEEF'
const ZERO: Address = '0x0000000000000000000000000000000000000000'
const GATEWAY_V3: Address = '0x00000000000000000000000000000000000A11CE'
const HOOK: Address = '0x45F29984B980f3D076CD05e7BE72E3b357856bC8'

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
  return (async (address: Address, _abi: readonly unknown[], fn: string, args?: readonly unknown[]) => {
    const v = state[args?.length ? `${address}:${fn}:${String(args[0])}` : `${address}:${fn}`]
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

describe('permanent shelf halts', () => {
  const NOW = 1_800_000_000n
  const DAY = 86_400n
  const halted = (until: bigint) => chain({
    [`${FACTORY}:owner`]: GATEWAY_V3,
    [`${GATEWAY_V3}:safe`]: OWNER_SAFE,
    [`${GATEWAY_V3}:haltedHooks`]: [HOOK],
    [`${FACTORY}:hookLadderHaltedUntil:${HOOK}`]: until,
  })
  const at = async (read: Reader) => (await runChecks(read, targets, fresh, NOW)).map(a => a.id)

  it('the older gateway has none, and that is not an alert', async () => {
    expect(await permanentHalts(chain(), [FACTORY])).toEqual([])
  })

  it('a halt with days left is quiet; under two days or lapsed it alerts', async () => {
    expect(await at(halted(NOW + 6n * DAY))).toEqual(['safe-nonce:18'])
    expect(await at(halted(NOW + DAY))).toContain(`halt-expiring:${HOOK}`)
    expect(await at(halted(NOW - 1n))).toContain(`halt-lapsed:${HOOK}`)
  })

  it('renews once a day, not on every run', async () => {
    const fresh6d = await permanentHalts(halted(NOW + 7n * DAY - 3_600n), [FACTORY])
    expect(gatewaysToRenew(fresh6d, NOW)).toEqual([])
    const armedYesterday = await permanentHalts(halted(NOW + 6n * DAY - 1n), [FACTORY])
    expect(gatewaysToRenew(armedYesterday, NOW)).toEqual([getAddress(GATEWAY_V3)])
  })
})

describe('v3.1', () => {
  const V31: Address = '0x00000000000000000000000000000000000031F1'
  const BUYBACK: Address = '0x000000000000000000000000000000000000B0B0'
  const BOOK31: Address = '0x000000000000000000000000000000000000B00C'
  const IMPL: Address = '0x0000000000000000000000000000000000001A11'
  const AUTOLP: Address = '0x000000000000000000000000000000000000A170'
  const HOOK_A: Address = '0x000000000000000000000000000000000000AAAA'
  const HOOK_B: Address = '0x000000000000000000000000000000000000BBBB'

  const chain31 = (overrides: Record<string, unknown> = {}) => chain({
    [`${V31}:owner`]: GATEWAY,
    [`${V31}:pendingOwner`]: ZERO,
    [`${V31}:paused`]: false,
    [`${V31}:ladderTreasury`]: BUYBACK,
    [`${V31}:platformTreasury`]: BUYBACK,
    [`${V31}:bidBook`]: BOOK31,
    [`${V31}:hookImplementation`]: IMPL,
    [`${V31}:launchCount`]: 2n,
    [`${V31}:launches:0`]: [ZERO, HOOK_A, ZERO, 0n],
    [`${V31}:launches:1`]: [ZERO, HOOK_B, ZERO, 0n],
    [`${IMPL}:autoLp`]: AUTOLP,
    [`${AUTOLP}:pendingQuote:${HOOK_A}`]: 0n,
    [`${AUTOLP}:pendingQuote:${HOOK_B}`]: 64n * 10n ** 18n,
    [`${BUYBACK}:rescuer`]: OWNER_SAFE,
    [`${BUYBACK}:pendingRescue`]: [ZERO, ZERO, 0n],
    [`${BUYBACK}:nextLeg`]: [false, 0n],
    [`${BOOK31}:feeRecipient`]: OWNER_SAFE,
    ...overrides,
  })
  const ids31 = async (read: Reader) =>
    (await runChecks(read, { ...targets, v31Factory: V31 }, fresh)).map(a => a.id)

  it('a buyback treasury and its own BidBook are the expected v3.1 shape, not alerts', async () => {
    expect(await ids31(chain31())).toEqual(['safe-nonce:18'])
  })

  it('a rescue request is alerted, once per request', async () => {
    const asked = chain31({ [`${BUYBACK}:pendingRescue`]: [BOOK31, EVIL, 1_900_000_000n] })
    expect(await ids31(asked)).toContain(`rescue:${BUYBACK}:1900000000`)
  })

  it('flags a rescuer, fee recipient or book that is not the Safe', async () => {
    expect(await ids31(chain31({ [`${BUYBACK}:rescuer`]: EVIL }))).toContain(`rescuer:${BUYBACK}`)
    expect(await ids31(chain31({ [`${V31}:platformTreasury`]: EVIL }))).toContain(`platform:${V31}`)
    expect(await ids31(chain31({ [`${BOOK31}:feeRecipient`]: EVIL }))).toContain(`book:${V31}`)
    expect(await ids31(chain31({ [`${V31}:owner`]: EVIL }))).toContain(`owner:${V31}`)
  })

  it('upkeep pokes an armed buyback and flushes only the pools AutoLp still owes', async () => {
    expect(await v31Upkeep(chain31(), V31)).toEqual({ buyback: null, autoLp: AUTOLP, flush: [HOOK_B] })
    const armed = chain31({ [`${BUYBACK}:nextLeg`]: [true, 10n ** 16n] })
    expect((await v31Upkeep(armed, V31)).buyback).toBe(BUYBACK)
  })
})
