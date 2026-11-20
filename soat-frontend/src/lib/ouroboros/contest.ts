/**
 * Invite-contest qualification. One prize per Agent ID, decided from chain
 * order. This module does not send transactions and does not read the database.
 *
 * Public copy lives here so the page and the tests share one text.
 */

export const CONTEST_START = '2026-11-20T14:00:00Z'
/** Exclusive. */
export const CONTEST_END = '2026-11-27T14:00:00Z'
export const CONTEST_START_SEC = Date.parse(CONTEST_START) / 1000
export const CONTEST_END_SEC = Date.parse(CONTEST_END) / 1000
/** Results published by this time; appeals close 48 hours later. */
export const CONTEST_RESULTS_BY = '2026-11-29T14:00:00Z'
export const CONTEST_APPEALS_UNTIL = '2026-12-01T14:00:00Z'

export const CONTEST_BONUS_WEI = 5n * 10n ** 18n
export const CONTEST_CAP = 6000
export const CONTEST_SHARES = 30
export const CONTEST_ENTRY = 'https://toshx.xyz/ouroboros'

export const CONTEST_RULES_ZH = [
  `邀请赛时间（UTC，含开始、不含结束）：${CONTEST_START} 至 ${CONTEST_END}。报名页：${CONTEST_ENTRY}。`,
  '签名提交邀请码后，需人工审核通过才激活链接。只有审核通过之后建立的邀请关系才计奖，不追溯通过前的铸造。通过前可以分享链接，但不计奖。',
  '新用户指活动开始前从未参与过 Ouroboros 铸造的 Agent ID。开始前已有铸造记录的地址可以做邀请人，不能作为被邀请的新用户。',
  '须在该钱包第一次 L2 铸造之前完成有效绑定；第一次归属之后不可更改；不能邀请自己。活动时间内，同一 Agent ID 的 L2 铸造份额累计满 30（可分多次）记一次。只计 L2 铸造，不计市场上的买入或卖出。',
  `每笔奖励固定 5 BSC USDT。有效邀请硬上限 ${CONTEST_CAP} 次、合计 30000 USDT，按打满第 30 份的链上区块、交易和日志顺序排列。取消资格后，名额顺延给下一位，不按报名先后占名额。`,
  '奖励不是即时到账，也没有领取按钮。Gas 由付款方承担，收款地址实收 5 USDT。若自动付款已开启，付款钱包按每小时批量转出；未开启时不会自动转账。是否开启以合作方页面上的状态为准，本页不表示当前已经开启。单次合计超过 1000 USDT 或单人超过 500 USDT 会暂停并等待多签批准，余额不足也会暂停。',
  `活动结束后 48 小时内（不晚于 ${CONTEST_RESULTS_BY}）公布脱敏结果，其后 48 小时可申诉（至 ${CONTEST_APPEALS_UNTIL}）。申诉处理完成后的 3 个工作日（UTC 周一至周五）内支付尚未结清的尾款。这是人工时限，不是自动到账。同一个人使用多个身份等无法仅凭链上数据判定的情况，由人工复核并留下记录；系统不会自动认定两个 Agent ID 属于同一个人。`,
].join('\n')

export const CONTEST_RULES_EN = [
  `Contest window (UTC, start inclusive, end exclusive): ${CONTEST_START} to ${CONTEST_END}. Apply at ${CONTEST_ENTRY}.`,
  'A signed application activates a link only after a person approves it. Only a relationship created after that approval counts. Earlier mints are not backfilled. The link can be shared before approval and earns nothing until then.',
  'A new user is an Agent ID that had never minted Ouroboros before the window opened. An address that already minted can invite, and cannot be the invited new user.',
  'The wallet must be bound before its first L2 mint. That first attribution never changes. Self-invites do not count. Inside the window, L2 mint shares of one Agent ID add up to 30, in one or more mints, for one reward. Only L2 mints count, not buys or sells on a market.',
  `Each reward is exactly 5 BSC USDT. Hard cap: ${CONTEST_CAP} valid invites, 30000 USDT. Order is the block, transaction and log of the mint that reaches the 30th share. A disqualification passes that slot to the next Agent ID in that order, not to whoever applied first.`,
  'Rewards are not instant and there is no claim button. The payer pays gas; the recipient is credited 5 USDT. When automatic payout is on, the payout wallet sends hourly batches. When it is off, nothing is sent automatically. The partner page shows the live switch; this page does not mean the switch is on. A batch above 1000 USDT in total, or 500 USDT to one partner, waits for a multisig approval, as does a batch the wallet cannot cover.',
  `Within 48 hours after the end (by ${CONTEST_RESULTS_BY}) anonymised results are published, followed by 48 hours of appeals (until ${CONTEST_APPEALS_UNTIL}). Remaining prizes are paid within 3 business days (Monday–Friday, UTC) after appeals are decided. That deadline is an operator commitment, not an automatic payment. Cases that chain data cannot decide, such as one person using several identities, are reviewed by a person and written down. The system does not decide on its own that two Agent IDs are the same person.`,
].join('\n')

export interface ContestMint {
  txHash: string
  logIndex: number
  /** Null when the indexer has not stored the transaction position yet. */
  txIndex: number | null
  blockNumber: number
  /** Mint stage as stored on the index. Only `L2` adds shares. */
  stage: string
  account: string
  agentKey: string
  shares: number
  refCode: string | null
}

export interface ContestLink {
  code: string
  partner: string
  /** Earliest block at which this link may count. */
  effectiveBlock: number
}

export type ContestDecisionKind = 'hold' | 'disqualify' | 'clear' | 'assign'

export interface ContestDecision {
  agentKey: string
  decision: ContestDecisionKind
  account?: string | null
  code?: string | null
  partner?: string | null
  at: string
}

export interface ContestBounds {
  startBlock: number | null
  /** Exclusive. Null when that block has not been mined. */
  endBlock: number | null
  /** Chain head timestamp is still before the contest end. */
  headBeforeEnd: boolean
}

export interface ContestAward {
  agentKey: string
  account: string
  code: string
  partner: string
  fillTxHash: string
  fillLogIndex: number
  fillTxIndex: number
  fillBlock: number
  amount: string
  rank: number
  status: 'payable' | 'held' | 'over_cap'
  reason: string | null
}

export interface ContestResult {
  awards: ContestAward[]
  /** Agent IDs left unpaid because a log needed for ordering is not stored yet. */
  unresolved: string[]
  boundsReady: boolean
}

const normAddr = (a: string) => a.toLowerCase()
const normKey = (k: string) => (k.startsWith('0x') || k.startsWith('0X') ? k.toLowerCase() : k)

function chainOrder(a: ContestMint, b: ContestMint): number {
  return a.blockNumber - b.blockNumber
    || (a.txIndex ?? 0) - (b.txIndex ?? 0)
    || a.logIndex - b.logIndex
    || (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0)
}

function inWindow(m: ContestMint, start: number, end: number | null): boolean {
  if (m.blockNumber < start) return false
  if (end == null) return true
  return m.blockNumber < end
}

/**
 * First block whose timestamp is at least `targetSec`, or null when `high`
 * is still earlier. Timestamps must not decrease as the block number increases.
 */
export async function findFirstBlockAtOrAfter(
  low: number,
  high: number,
  targetSec: number,
  getTimestamp: (block: number) => Promise<number>,
): Promise<number | null> {
  if (!Number.isInteger(low) || !Number.isInteger(high) || high < low) return null
  if ((await getTimestamp(high)) < targetSec) return null
  if ((await getTimestamp(low)) >= targetSec) return low
  let lo = low
  let hi = high
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((await getTimestamp(mid)) >= targetSec) hi = mid
    else lo = mid
  }
  return hi
}

/** Immutable binding: the first usable code at or before that wallet's first L2 mint. */
export function bindAccount(account: string, mints: ContestMint[], links: ContestLink[]): { code: string; partner: string } | null {
  const who = normAddr(account)
  const mine = mints.filter(m => normAddr(m.account) === who).sort(chainOrder)
  const firstL2 = mine.find(m => m.stage === 'L2')
  if (!firstL2) return null
  const byCode = new Map(links.map(l => [l.code, l]))
  for (const m of mine) {
    if (chainOrder(m, firstL2) > 0) break
    if (!m.refCode) continue
    const link = byCode.get(m.refCode)
    if (!link) continue
    if (link.effectiveBlock > m.blockNumber) continue
    if (normAddr(link.partner) === who) continue
    return { code: link.code, partner: normAddr(link.partner) }
  }
  return null
}

function latestDecision(reviews: ContestDecision[]): Map<string, ContestDecision> {
  const ordered = [...reviews].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0)
  const out = new Map<string, ContestDecision>()
  for (const r of ordered) out.set(normKey(r.agentKey), r)
  return out
}

interface Candidate {
  agentKey: string
  account: string
  code: string
  partner: string
  fill: ContestMint
  status: 'payable' | 'held'
  reason: string | null
}

/**
 * Awards inside the cap, in chain order. Disqualified Agent IDs are omitted
 * so the next one takes the slot. A hold keeps its place and is not paid.
 */
export function qualifyContest(
  mints: ContestMint[],
  links: ContestLink[],
  reviews: ContestDecision[],
  bounds: ContestBounds,
  maxAwards = CONTEST_CAP,
): ContestResult {
  if (bounds.startBlock == null || (bounds.endBlock == null && !bounds.headBeforeEnd)) {
    return { awards: [], unresolved: [], boundsReady: false }
  }
  const start = bounds.startBlock
  const end = bounds.endBlock
  const decisions = latestDecision(reviews)
  const unresolved: string[] = []
  const candidates: Candidate[] = []
  const byAgent = new Map<string, ContestMint[]>()
  for (const m of mints) {
    const key = normKey(m.agentKey)
    const list = byAgent.get(key)
    if (list) list.push(m)
    else byAgent.set(key, [m])
  }

  for (const [agentKey, rows] of byAgent) {
    if (rows.some(m => m.blockNumber < start)) continue
    const counted = rows.filter(m => m.stage === 'L2' && m.shares > 0 && inWindow(m, start, end))
    if (counted.length === 0) continue
    if (counted.some(m => m.txIndex == null)) {
      unresolved.push(agentKey)
      continue
    }
    const ordered = [...counted].sort(chainOrder)
    let cum = 0
    let fill: ContestMint | null = null
    const contributing: ContestMint[] = []
    for (const m of ordered) {
      contributing.push(m)
      const next = cum + m.shares
      if (fill == null && cum < CONTEST_SHARES && next >= CONTEST_SHARES) fill = m
      cum = next
      if (fill) break
    }
    if (!fill || cum < CONTEST_SHARES) continue

    const decision = decisions.get(agentKey)
    if (decision?.decision === 'disqualify') continue

    const accounts = [...new Set(contributing.map(m => normAddr(m.account)))]
    const automatic = accounts.length === 1 ? bindAccount(accounts[0]!, rows, links) : null
    let account = accounts[0]!
    let binding = automatic
    let status: 'payable' | 'held' = automatic ? 'payable' : 'held'
    let reason: string | null = automatic ? null : (accounts.length === 1 ? null : 'multiple-accounts')
    if (!automatic && accounts.length === 1) continue

    if (decision?.decision === 'hold') {
      status = 'held'
      reason = 'manual-hold'
    } else if (decision?.decision === 'assign') {
      const assigned = decision.account ? normAddr(decision.account) : ''
      const partner = decision.partner ? normAddr(decision.partner) : ''
      const code = decision.code ?? ''
      const bound = accounts.includes(assigned) ? bindAccount(assigned, rows, links) : null
      if (!bound || bound.code !== code || bound.partner !== partner) {
        status = 'held'
        reason = 'assign-mismatch'
      } else {
        account = assigned
        binding = bound
        status = 'payable'
        reason = null
      }
    } else if (accounts.length !== 1) {
      status = 'held'
      reason = 'multiple-accounts'
      const bound = accounts.map(a => ({ account: a, binding: bindAccount(a, rows, links) })).find(x => x.binding)
      if (!bound?.binding) continue
      account = bound.account
      binding = bound.binding
    }

    if (!binding) continue
    candidates.push({
      agentKey, account, code: binding.code, partner: binding.partner, fill, status, reason,
    })
  }

  candidates.sort((a, b) => chainOrder(a.fill, b.fill) || (a.agentKey < b.agentKey ? -1 : 1))
  const awards: ContestAward[] = candidates.map((c, i) => {
    const rank = i + 1
    const over = rank > maxAwards
    return {
      agentKey: c.agentKey,
      account: c.account,
      code: c.code,
      partner: c.partner,
      fillTxHash: c.fill.txHash,
      fillLogIndex: c.fill.logIndex,
      fillTxIndex: c.fill.txIndex ?? 0,
      fillBlock: c.fill.blockNumber,
      amount: CONTEST_BONUS_WEI.toString(),
      rank,
      status: c.status === 'held' ? 'held' : over ? 'over_cap' : 'payable',
      reason: c.reason,
    }
  })
  return { awards, unresolved, boundsReady: true }
}

/** Partner totals still to send: payable awards with no settlement, in whole prizes. */
export function unpaidByPartner(awards: ContestAward[], settledAgentKeys: Iterable<string>): Map<string, bigint> {
  const settled = new Set([...settledAgentKeys].map(normKey))
  const out = new Map<string, bigint>()
  for (const a of awards) {
    if (a.status !== 'payable' || settled.has(normKey(a.agentKey))) continue
    out.set(a.partner, (out.get(a.partner) ?? 0n) + BigInt(a.amount))
  }
  return out
}

export interface SettlementPiece { agentKey: string; amount: bigint }

/**
 * Whole prizes a single transfer can close, cheapest rank first.
 * A remainder below one prize is left unsettled. Already settled keys are skipped.
 */
export function allocateTransfer(
  awards: ContestAward[],
  settledAgentKeys: Iterable<string>,
  partner: string,
  value: bigint,
): SettlementPiece[] {
  const settled = new Set([...settledAgentKeys].map(normKey))
  const who = normAddr(partner)
  const mine = awards
    .filter(a => a.status === 'payable' && normAddr(a.partner) === who && !settled.has(normKey(a.agentKey)))
    .sort((a, b) => a.rank - b.rank)
  const pieces: SettlementPiece[] = []
  let left = value
  for (const a of mine) {
    const amount = BigInt(a.amount)
    if (left < amount) break
    pieces.push({ agentKey: a.agentKey, amount })
    left -= amount
  }
  return pieces
}
