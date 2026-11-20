import { describe, expect, it } from 'vitest'

import {
  CONTEST_APPEALS_UNTIL, CONTEST_BONUS_WEI, CONTEST_CAP, CONTEST_END, CONTEST_RESULTS_BY, CONTEST_RULES_EN,
  CONTEST_RULES_ZH, CONTEST_SHARES, CONTEST_START, allocateTransfer, bindAccount, findFirstBlockAtOrAfter,
  qualifyContest, unpaidByPartner, type ContestAward, type ContestBounds, type ContestLink, type ContestMint,
} from './contest'

const U = 10n ** 18n
const OPEN: ContestBounds = { startBlock: 100, endBlock: 200, headBeforeEnd: false }
const LINK: ContestLink = { code: 'abc', partner: '0xpartner', effectiveBlock: 100 }

function mint(over: Partial<ContestMint> & Pick<ContestMint, 'blockNumber'>): ContestMint {
  return {
    txHash: over.txHash ?? `0x${over.blockNumber.toString(16)}`,
    logIndex: over.logIndex ?? 0,
    txIndex: over.txIndex === undefined ? 0 : over.txIndex,
    stage: over.stage ?? 'L2',
    account: over.account ?? '0xuser',
    agentKey: over.agentKey ?? '0xagent',
    shares: over.shares ?? CONTEST_SHARES,
    refCode: over.refCode === undefined ? 'abc' : over.refCode,
    blockNumber: over.blockNumber,
  }
}

function payable(result: { awards: ContestAward[] }) {
  return result.awards.filter(a => a.status === 'payable')
}

describe('contest window block search', () => {
  const ts = async (block: number) => 1_000 + block

  it('returns the first block at the target, and null when the head is earlier', async () => {
    expect(await findFirstBlockAtOrAfter(10, 20, 1_015, ts)).toBe(15)
    expect(await findFirstBlockAtOrAfter(10, 20, 1_015.5, ts)).toBe(16)
    expect(await findFirstBlockAtOrAfter(10, 20, 1_000, ts)).toBe(10)
    expect(await findFirstBlockAtOrAfter(10, 20, 1_030, ts)).toBeNull()
  })
})

describe('invite contest qualification', () => {
  it('pays 5 USDT once when L2 shares reach 30 inside the window after approval', () => {
    const result = qualifyContest([mint({ blockNumber: 120, shares: 30 })], [LINK], [], OPEN)
    expect(payable(result)).toHaveLength(1)
    expect(payable(result)[0]).toMatchObject({
      partner: '0xpartner', amount: CONTEST_BONUS_WEI.toString(), rank: 1, fillBlock: 120,
    })
  })

  it('does not pay 29 shares, and does not pay twice when one mint is larger than 30', () => {
    expect(payable(qualifyContest([mint({ blockNumber: 120, shares: 29 })], [LINK], [], OPEN))).toHaveLength(0)
    expect(payable(qualifyContest([mint({ blockNumber: 120, shares: 40 })], [LINK], [], OPEN))).toHaveLength(1)
  })

  it('counts split L2 mints in chain order and ignores market rows, which are not mints', () => {
    const result = qualifyContest([
      mint({ blockNumber: 150, shares: 10, txIndex: 2, txHash: '0x2' }),
      mint({ blockNumber: 150, shares: 10, txIndex: 0, txHash: '0x0' }),
      mint({ blockNumber: 140, shares: 10, txHash: '0x1' }),
    ], [LINK], [], OPEN)
    expect(payable(result)[0]).toMatchObject({ fillTxHash: '0x2', fillBlock: 150 })
  })

  it('ignores a non-L2 mint toward the 30 shares', () => {
    const result = qualifyContest([
      mint({ blockNumber: 110, shares: 20, stage: 'L1' }),
      mint({ blockNumber: 120, shares: 10 }),
    ], [LINK], [], OPEN)
    expect(payable(result)).toHaveLength(0)
  })

  it('excludes an Agent ID that minted before the window, and still lets that address invite someone else', () => {
    const old = mint({ blockNumber: 90, shares: 1, refCode: null, stage: 'L2' })
    const again = mint({ blockNumber: 120, shares: 30 })
    expect(payable(qualifyContest([old, again], [LINK], [], OPEN))).toHaveLength(0)

    const invitee = mint({ blockNumber: 130, shares: 30, account: '0xnew', agentKey: '0xnew-agent' })
    const awards = payable(qualifyContest([old, invitee], [LINK], [], OPEN))
    expect(awards.map(a => a.agentKey)).toEqual(['0xnew-agent'])
  })

  it('does not count shares at the end block, and does count the last included block', () => {
    const before = mint({ blockNumber: 180, shares: 20, txHash: '0xa' })
    const edge = mint({ blockNumber: 199, shares: 10, txHash: '0xb' })
    const after = mint({ blockNumber: 200, shares: 10, txHash: '0xc' })
    expect(payable(qualifyContest([before, after], [LINK], [], OPEN))).toHaveLength(0)
    expect(payable(qualifyContest([before, edge], [LINK], [], OPEN))[0].fillTxHash).toBe('0xb')
  })

  it('does not qualify anyone until the start block is known, or after the end when the end block is missing', () => {
    const rows = [mint({ blockNumber: 120 })]
    expect(qualifyContest(rows, [LINK], [], { startBlock: null, endBlock: null, headBeforeEnd: true }).boundsReady).toBe(false)
    expect(qualifyContest(rows, [LINK], [], { startBlock: 100, endBlock: null, headBeforeEnd: false }).awards).toHaveLength(0)
    expect(payable(qualifyContest(rows, [LINK], [], { startBlock: 100, endBlock: null, headBeforeEnd: true }))).toHaveLength(1)
  })

  it('ignores a code that is not approved yet, including one approved only after the first L2 mint', () => {
    expect(payable(qualifyContest([mint({ blockNumber: 120 })], [], [], OPEN))).toHaveLength(0)
    const late = { ...LINK, effectiveBlock: 130 }
    const first = mint({ blockNumber: 120, shares: 10, refCode: 'abc', txHash: '0x1' })
    const second = mint({ blockNumber: 140, shares: 20, refCode: 'abc', txHash: '0x2' })
    expect(payable(qualifyContest([first, second], [late], [], OPEN))).toHaveLength(0)
  })

  it('keeps the first binding and rejects a self-invite', () => {
    const other: ContestLink = { code: 'zed', partner: '0xother', effectiveBlock: 100 }
    const rows = [
      mint({ blockNumber: 110, shares: 10, refCode: 'abc', txHash: '0x1' }),
      mint({ blockNumber: 120, shares: 20, refCode: 'zed', txHash: '0x2' }),
    ]
    expect(payable(qualifyContest(rows, [LINK, other], [], OPEN))[0].partner).toBe('0xpartner')
    const self: ContestLink = { code: 'me', partner: '0xuser', effectiveBlock: 100 }
    expect(payable(qualifyContest([mint({ blockNumber: 120, refCode: 'me' })], [self], [], OPEN))).toHaveLength(0)
  })

  it('binds from a mint at or before the first L2 mint, and not from a later one', () => {
    const early = mint({ blockNumber: 110, shares: 1, stage: 'L2', refCode: null, txHash: '0xearly' })
    const later = mint({ blockNumber: 130, shares: 30, refCode: 'abc', txHash: '0xlater' })
    expect(bindAccount('0xuser', [early, later], [LINK])).toBeNull()
    expect(payable(qualifyContest([early, later], [LINK], [], OPEN))).toHaveLength(0)

    const taggedFirst = mint({ blockNumber: 110, shares: 30, refCode: 'abc' })
    expect(bindAccount('0xuser', [taggedFirst], [{ ...LINK, effectiveBlock: 110 }])?.code).toBe('abc')
  })

  it('leaves an Agent ID unresolved, and unpaid, while a counted mint has no transaction index', () => {
    const result = qualifyContest([mint({ blockNumber: 120, txIndex: null })], [LINK], [], OPEN)
    expect(result.unresolved).toEqual(['0xagent'])
    expect(result.awards).toHaveLength(0)
  })

  it('holds more than one minting account instead of guessing, and a reviewed assign can pick a bound one', () => {
    const rows = [
      mint({ blockNumber: 120, shares: 15, account: '0xuser', refCode: 'abc', txHash: '0x1' }),
      mint({ blockNumber: 130, shares: 15, account: '0xsecond', agentKey: '0xagent', refCode: 'zed', txHash: '0x2' }),
    ]
    const links = [LINK, { code: 'zed', partner: '0xother', effectiveBlock: 100 }]
    const held = qualifyContest(rows, links, [], OPEN)
    expect(held.awards[0]).toMatchObject({ status: 'held', reason: 'multiple-accounts' })

    const assigned = qualifyContest(rows, links, [{
      agentKey: '0xagent', decision: 'assign', account: '0xsecond', code: 'zed', partner: '0xother', at: '2026-11-21T00:00:00Z',
    }], OPEN)
    expect(payable(assigned)[0]).toMatchObject({ partner: '0xother', account: '0xsecond' })
  })

  it('orders the cap by the filling log, rolls a disqualification forward, and keeps a hold in its slot', () => {
    const rows = [1, 2, 3].map(n => mint({
      blockNumber: 100 + n, agentKey: `0xa${n}`, account: `0xu${n}`, txHash: `0x${n}`,
    }))
    const coded = rows.map((row, i) => ({ ...row, refCode: `c${i + 1}` }))
    const ownLinks = coded.map((row, i) => ({ code: row.refCode!, partner: `0xp${i + 1}`, effectiveBlock: 100 }))
    const top = qualifyContest(coded, ownLinks, [], OPEN, 2)
    expect(payable(top).map(a => a.agentKey)).toEqual(['0xa1', '0xa2'])
    expect(top.awards.find(a => a.agentKey === '0xa3')?.status).toBe('over_cap')

    const rolled = qualifyContest(coded, ownLinks, [
      { agentKey: '0xa1', decision: 'disqualify', at: '2026-11-22T00:00:00Z' },
    ], OPEN, 2)
    expect(payable(rolled).map(a => a.agentKey)).toEqual(['0xa2', '0xa3'])

    const held = qualifyContest(coded, ownLinks, [
      { agentKey: '0xa1', decision: 'hold', at: '2026-11-22T00:00:00Z' },
    ], OPEN, 2)
    expect(held.awards.find(a => a.agentKey === '0xa1')?.status).toBe('held')
    expect(payable(held).map(a => a.agentKey)).toEqual(['0xa2'])
    expect(held.awards.find(a => a.agentKey === '0xa3')?.status).toBe('over_cap')
  })

  it('is unchanged when the same mints are shuffled', () => {
    const rows = [130, 110, 120].map(blockNumber => mint({ blockNumber, shares: 10, txHash: `0x${blockNumber}` }))
    const forward = qualifyContest(rows, [LINK], [], OPEN)
    const backward = qualifyContest([...rows].reverse(), [LINK], [], OPEN)
    expect(backward.awards).toEqual(forward.awards)
  })

  it('fills exactly 6000 slots and leaves the next Agent ID outside', () => {
    const rows = Array.from({ length: CONTEST_CAP + 1 }, (_, i) => mint({
      blockNumber: 100 + (i % 50),
      txIndex: Math.floor(i / 50),
      logIndex: i,
      agentKey: `0x${(i + 1).toString(16).padStart(4, '0')}`,
      account: `0x${(i + 1).toString(16).padStart(40, 'a')}`,
      txHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
    }))
    const result = qualifyContest(rows, [LINK], [], { startBlock: 100, endBlock: 100 + 50, headBeforeEnd: false })
    expect(result.awards.filter(a => a.status === 'payable')).toHaveLength(CONTEST_CAP)
    expect(result.awards.filter(a => a.status === 'over_cap')).toHaveLength(1)
    expect(result.awards[CONTEST_CAP - 1].rank).toBe(CONTEST_CAP)
  })
})

describe('contest settlement allocation', () => {
  const award = (agentKey: string, rank: number, partner = '0xpartner'): ContestAward => ({
    agentKey, account: '0xuser', code: 'abc', partner, fillTxHash: '0x', fillLogIndex: 0, fillTxIndex: 0,
    fillBlock: 120, amount: (5n * U).toString(), rank, status: 'payable', reason: null,
  })

  it('does not treat an existing settlement as a reason to skip a different prize', () => {
    const awards = [award('0xa', 1), award('0xb', 2)]
    const owed = unpaidByPartner(awards, ['0xa'])
    expect(owed.get('0xpartner')).toBe(5n * U)
  })

  it('closes whole 5 USDT prizes in rank order and leaves a remainder unsettled', () => {
    const awards = [award('0xa', 1), award('0xb', 2), award('0xc', 3)]
    expect(allocateTransfer(awards, [], '0xpartner', 12n * U).map(p => p.agentKey)).toEqual(['0xa', '0xb'])
    expect(allocateTransfer(awards, ['0xa'], '0xpartner', 5n * U).map(p => p.agentKey)).toEqual(['0xb'])
    expect(allocateTransfer(awards, [], '0xpartner', 4n * U)).toEqual([])
  })
})

describe('public contest rules', () => {
  it('states the window, cap and manual timeline without naming a previous sale stage or claiming payouts are on', () => {
    for (const text of [CONTEST_RULES_ZH, CONTEST_RULES_EN]) {
      expect(text).not.toContain('L1')
      expect(text).toContain(CONTEST_START)
      expect(text).toContain(CONTEST_END)
      expect(text).toContain(CONTEST_RESULTS_BY)
      expect(text).toContain(CONTEST_APPEALS_UNTIL)
      expect(text).toContain(String(CONTEST_CAP))
      expect(text).toContain('30000')
      expect(text).toContain('https://toshx.xyz/ouroboros')
      expect(text).toMatch(/未开启时不会自动转账|When it is off, nothing is sent/)
      expect(text).toMatch(/不表示当前已经开启|does not mean the switch is on/)
    }
  })
})
