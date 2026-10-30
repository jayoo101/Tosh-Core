/**
 * On-chain watch for the live v3 deployment, run by `/api/monitor`.
 *
 * Every check compares what the chain says now with the custody SECURITY.md
 * describes: the 2-of-3 Safe owns both ladder treasuries, receives the
 * platform and BidBook fees, and owns each factory through its launch
 * gateway. A difference is either a Safe decision someone should know about
 * or something worse, and either way people should hear it from the bot, not
 * from a user.
 *
 * The checks only read. `Reader` is the seam the tests use.
 */
import { getAddress, parseAbi, type Address } from 'viem'

export const OWNER_SAFE: Address = '0x02DE4629129D104C63329D13A6Ca67E43db7B310'
export const SAFE_OWNERS: readonly Address[] = [
  '0xC2EA14cE2112B18AFBC78fE78C969b3002F07cbB',
  '0x0db9114FA8082800B23AA6141ec88F2a64Ca1c6E',
  '0x3b7ff171A71281b1D77e18ae1A0bC725D69712E6',
]
export const SAFE_THRESHOLD = 2n

export const SAFE_ABI = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
])
export const FACTORY_ABI = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function paused() view returns (bool)',
  'function ladderTreasury() view returns (address)',
  'function platformTreasury() view returns (address)',
  'function bidBook() view returns (address)',
])
export const GATEWAY_ABI = parseAbi(['function safe() view returns (address)'])
export const OWNED_ABI = parseAbi(['function owner() view returns (address)'])
export const BIDBOOK_ABI = parseAbi(['function feeRecipient() view returns (address)'])

/** `read(address, abi, functionName)`; throws when the chain cannot answer. */
export type Reader = <T>(address: Address, abi: readonly unknown[], functionName: string) => Promise<T>

export interface Alert {
  /** Stable while the condition holds, so a repeat can be suppressed. */
  id: string
  text: string
  /** How long a sent alert stays quiet before it may be sent again. */
  quietSeconds: number
}

const REPEAT = 6 * 3600
const ONCE = 30 * 24 * 3600

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export interface Targets {
  factories: Address[]
  bidBook: Address | undefined
}

export async function runChecks(read: Reader, targets: Targets, indexProblem: () => Promise<string | null>): Promise<Alert[]> {
  const alerts: Alert[] = []
  const flag = (id: string, text: string, quietSeconds = REPEAT) => alerts.push({ id, text, quietSeconds })
  const guard = async (id: string, what: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      flag(`read:${id}`, `⚠️ 监控读不到链上数据：${what}\n${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
    }
  }

  await guard('safe', `Safe ${short(OWNER_SAFE)}`, async () => {
    const [owners, threshold, nonce] = await Promise.all([
      read<readonly Address[]>(OWNER_SAFE, SAFE_ABI, 'getOwners'),
      read<bigint>(OWNER_SAFE, SAFE_ABI, 'getThreshold'),
      read<bigint>(OWNER_SAFE, SAFE_ABI, 'nonce'),
    ])
    const expected = new Set(SAFE_OWNERS.map(a => a.toLowerCase()))
    const changed = owners.length !== expected.size || owners.some(o => !expected.has(o.toLowerCase()))
    if (changed || threshold !== SAFE_THRESHOLD) {
      flag(
        'safe-shape',
        `🚨 Safe 的签名人或门槛变了\n门槛 ${threshold}/${owners.length}（应为 ${SAFE_THRESHOLD}/${SAFE_OWNERS.length}）\n` +
          `签名人：${owners.map(short).join(', ')}`,
      )
    }
    flag(
      `safe-nonce:${nonce}`,
      `ℹ️ Safe 执行过的交易数现在是 ${nonce}。每执行一笔新交易都会收到这条提醒，不是你们发起的就要立刻查。\n` +
        `https://app.safe.global/transactions/history?safe=bnb:${OWNER_SAFE}`,
      ONCE,
    )
  })

  for (const factory of targets.factories) {
    await guard(`factory:${factory}`, `factory ${short(factory)}`, async () => {
      const [owner, pending, paused, ladder, platform, book] = await Promise.all([
        read<Address>(factory, FACTORY_ABI, 'owner'),
        read<Address>(factory, FACTORY_ABI, 'pendingOwner'),
        read<boolean>(factory, FACTORY_ABI, 'paused'),
        read<Address>(factory, FACTORY_ABI, 'ladderTreasury'),
        read<Address>(factory, FACTORY_ABI, 'platformTreasury'),
        read<Address>(factory, FACTORY_ABI, 'bidBook'),
      ])
      const [gatewaySafe, ladderOwner] = await Promise.all([
        read<Address>(owner, GATEWAY_ABI, 'safe').catch(() => null),
        read<Address>(ladder, OWNED_ABI, 'owner'),
      ])
      const f = short(factory)
      if (!gatewaySafe || !same(gatewaySafe, OWNER_SAFE)) {
        flag(`owner:${factory}`, `🚨 factory ${f} 的所有者变了：现在是 ${getAddress(owner)}，不再是 Safe 的发射网关`)
      }
      if (!same(pending, '0x0000000000000000000000000000000000000000')) {
        flag(`pending:${factory}`, `🚨 factory ${f} 有一笔待接受的所有权转移，接收方 ${getAddress(pending)}`)
      }
      if (paused) flag(`paused:${factory}`, `⏸️ factory ${f} 处于暂停状态，新项目无法创建`)
      if (!same(ladderOwner, OWNER_SAFE)) {
        flag(`ladder:${ladder}`, `🚨 回购金库 ${short(ladder)} 的所有者变了：现在是 ${getAddress(ladderOwner)}`)
      }
      if (!same(platform, OWNER_SAFE)) {
        flag(`platform:${factory}`, `🚨 factory ${f} 的平台收款地址变了：现在是 ${getAddress(platform)}`)
      }
      if (targets.bidBook && !same(book, targets.bidBook)) {
        flag(`book:${factory}`, `🚨 factory ${f} 指向的挂单合约变了：现在是 ${getAddress(book)}`)
      }
    })
  }

  const book = targets.bidBook
  if (book) {
    await guard('bidbook', `BidBook ${short(book)}`, async () => {
      const to = await read<Address>(book, BIDBOOK_ABI, 'feeRecipient')
      if (!same(to, OWNER_SAFE)) flag('bidbook-fees', `🚨 挂单市场手续费的收款地址变了：现在是 ${getAddress(to)}`)
    })
  }

  const stale = await indexProblem().catch((err: unknown) => `index check failed: ${String(err)}`)
  if (stale) {
    flag('index', `⚠️ 网站的链上索引没在更新（${stale}）。市场、成交记录会变慢或显示不全，请看 Vercel 上 /api/v2/index 的 cron 日志。`)
  }

  return alerts
}
