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
export const HALT_GATEWAY_ABI = parseAbi([
  'function haltedHooks() view returns (address[])',
  'function renewAll()',
])
export const HALT_UNTIL_ABI = parseAbi(['function hookLadderHaltedUntil(address) view returns (uint256)'])
export const V31_FACTORY_ABI = parseAbi([
  'function launchCount() view returns (uint256)',
  'function launches(uint256) view returns (address token, address hook, address creator, uint256 createdAt)',
  'function hookImplementation() view returns (address)',
])
export const V31_BUYBACK_ABI = parseAbi([
  'function rescuer() view returns (address)',
  'function pendingRescue() view returns (address token, address to, uint64 readyAt)',
  'function nextLeg() view returns (bool burnLeg, uint256 amount)',
  'function pokeBuyback()',
])
export const V31_AUTOLP_ABI = parseAbi([
  'function pendingQuote(address) view returns (uint256)',
  'function flush(address)',
])
const AUTOLP_OF_ABI = parseAbi(['function autoLp() view returns (address)'])

/** Most recent v3.1 launches the keeper looks at for an AutoLp backlog. */
const UPKEEP_HOOKS = 200n

/** A permanent halt younger than this is left alone; older, the keeper renews it. */
export const RENEW_AFTER = 24n * 3600n
/** The factory's halt window, which `renewAll` re-arms in full. */
const HALT_WINDOW = 7n * 24n * 3600n
/** Remaining time under which a permanent halt is alerted on as unrenewed. */
const WARN_UNDER = 2n * 24n * 3600n

/** `read(address, abi, functionName, args)`; throws when the chain cannot answer. */
export type Reader = <T>(address: Address, abi: readonly unknown[], functionName: string, args?: readonly unknown[]) => Promise<T>

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
  /** v3-shaped factories: Safe-owned ladder treasury, Safe platform fees, the shared BidBook. */
  factories: Address[]
  bidBook: Address | undefined
  /** The v3.1 factory, whose treasury and fee recipient are the ownerless buyback. */
  v31Factory?: Address
}

export interface PermanentHalt {
  factory: Address
  gateway: Address
  hook: Address
  until: bigint
}

/**
 * Every `haltForever` shelf halt behind `factories`. A factory whose owner is
 * the older gateway, without `haltedHooks`, contributes none.
 */
export async function permanentHalts(read: Reader, factories: Address[]): Promise<PermanentHalt[]> {
  const out: PermanentHalt[] = []
  for (const factory of factories) {
    const gateway = await read<Address>(factory, FACTORY_ABI, 'owner')
    const hooks = await read<readonly Address[]>(gateway, HALT_GATEWAY_ABI, 'haltedHooks').catch(() => [] as const)
    for (const hook of hooks) {
      const until = await read<bigint>(factory, HALT_UNTIL_ABI, 'hookLadderHaltedUntil', [hook])
      out.push({ factory, gateway, hook, until })
    }
  }
  return out
}

/** Gateways with a permanent halt last armed more than `RENEW_AFTER` ago. */
export function gatewaysToRenew(halts: PermanentHalt[], now: bigint): Address[] {
  const due = halts.filter(h => h.until < now + HALT_WINDOW - RENEW_AFTER).map(h => getAddress(h.gateway))
  return [...new Set(due)]
}

export interface V31Upkeep {
  /** The buyback, when a poke would run a leg; `null` when it is not armed. */
  buyback: Address | null
  autoLp: Address
  /** Hooks whose pool AutoLp still owes liquidity. */
  flush: Address[]
}

/**
 * What the keeper should try on v3.1. Swaps only ever convert the buyback's
 * USDT, so its burn leg runs only when poked, and AutoLp liquidity a mint
 * could not add waits for a `flush`. Both are open to anyone.
 */
export async function v31Upkeep(read: Reader, factory: Address): Promise<V31Upkeep> {
  const [buyback, impl, count] = await Promise.all([
    read<Address>(factory, FACTORY_ABI, 'ladderTreasury'),
    read<Address>(factory, V31_FACTORY_ABI, 'hookImplementation'),
    read<bigint>(factory, V31_FACTORY_ABI, 'launchCount'),
  ])
  const [[, amount], autoLp] = await Promise.all([
    read<readonly [boolean, bigint]>(buyback, V31_BUYBACK_ABI, 'nextLeg'),
    read<Address>(impl, AUTOLP_OF_ABI, 'autoLp'),
  ])
  const flush: Address[] = []
  for (let i = count > UPKEEP_HOOKS ? count - UPKEEP_HOOKS : 0n; i < count; i++) {
    const [, hook] = await read<readonly [Address, Address, Address, bigint]>(factory, V31_FACTORY_ABI, 'launches', [i])
    if ((await read<bigint>(autoLp, V31_AUTOLP_ABI, 'pendingQuote', [hook])) > 0n) flush.push(hook)
  }
  return { buyback: amount > 0n ? buyback : null, autoLp, flush }
}

export async function runChecks(
  read: Reader,
  targets: Targets,
  indexProblem: () => Promise<string | null>,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<Alert[]> {
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

  const v31 = targets.v31Factory
  if (v31) {
    await guard(`v31:${v31}`, `v3.1 factory ${short(v31)}`, async () => {
      const [owner, pending, paused, buyback, platform, book] = await Promise.all([
        read<Address>(v31, FACTORY_ABI, 'owner'),
        read<Address>(v31, FACTORY_ABI, 'pendingOwner'),
        read<boolean>(v31, FACTORY_ABI, 'paused'),
        read<Address>(v31, FACTORY_ABI, 'ladderTreasury'),
        read<Address>(v31, FACTORY_ABI, 'platformTreasury'),
        read<Address>(v31, FACTORY_ABI, 'bidBook'),
      ])
      const [gatewaySafe, rescuer, rescue, bookFees] = await Promise.all([
        read<Address>(owner, GATEWAY_ABI, 'safe').catch(() => null),
        read<Address>(buyback, V31_BUYBACK_ABI, 'rescuer'),
        read<readonly [Address, Address, bigint]>(buyback, V31_BUYBACK_ABI, 'pendingRescue'),
        read<Address>(book, BIDBOOK_ABI, 'feeRecipient'),
      ])
      const f = short(v31)
      const b = short(buyback)
      if (!gatewaySafe || !same(gatewaySafe, OWNER_SAFE)) {
        flag(`owner:${v31}`, `🚨 v3.1 factory ${f} 的所有者现在是 ${getAddress(owner)}，不是 Safe 的发射网关`)
      }
      if (!same(pending, '0x0000000000000000000000000000000000000000')) {
        flag(`pending:${v31}`, `🚨 v3.1 factory ${f} 有一笔待接受的所有权转移，接收方 ${getAddress(pending)}`)
      }
      if (paused) flag(`paused:${v31}`, `⏸️ v3.1 factory ${f} 处于暂停状态，新项目无法创建`)
      if (!same(platform, buyback)) {
        flag(`platform:${v31}`, `🚨 v3.1 factory ${f} 的平台收款地址 ${getAddress(platform)} 不是回购合约 ${getAddress(buyback)}`)
      }
      if (!same(rescuer, OWNER_SAFE)) {
        flag(`rescuer:${buyback}`, `🚨 回购合约 ${b} 的救援人是 ${getAddress(rescuer)}，不是 Safe`)
      }
      const [token, to, readyAt] = rescue
      if (readyAt > 0n) {
        flag(
          `rescue:${buyback}:${readyAt}`,
          `🚨 回购合约 ${b} 有一笔救援请求：把全部 ${getAddress(token)} 转给 ${getAddress(to)}，` +
            `${new Date(Number(readyAt) * 1000).toISOString()} 起可执行。不是你们发起的，立刻用 Safe 调用 cancelRescue()。`,
        )
      }
      if (!same(bookFees, OWNER_SAFE)) {
        flag(`book:${v31}`, `🚨 v3.1 挂单合约 ${short(book)} 的手续费收款地址变了：现在是 ${getAddress(bookFees)}`)
      }
    })
  }

  await guard('halts', '永久暂停的货架', async () => {
    for (const h of await permanentHalts(read, v31 ? [...targets.factories, v31] : targets.factories)) {
      const left = h.until - now
      if (left <= 0n) {
        flag(`halt-lapsed:${h.hook}`, `🚨 项目 ${short(h.hook)} 的永久暂停没人续期，已经失效，货架现在可以铸币。任何钱包调用网关 ${getAddress(h.gateway)} 的 renewAll() 即可恢复。`)
      } else if (left < WARN_UNDER) {
        flag(`halt-expiring:${h.hook}`, `⚠️ 项目 ${short(h.hook)} 的永久暂停还剩 ${Number(left / 3600n)} 小时就要失效，自动续期没有生效。任何钱包调用网关 ${getAddress(h.gateway)} 的 renewAll() 即可续期。`)
      }
    }
  })

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
