/**
 * The collectors behind the v2 dashboard.
 *
 * Each returns `{ ok, error?, ...data }` rather than throwing, so one failing
 * read costs one panel and not the page. A panel that cannot be filled says
 * why — the failure mode to avoid is a panel of zeroes that looks like an
 * answer.
 *
 * Everything is read from chain 56 over public RPC. No API key is involved:
 * the state comes from view calls, the history from `logs.mjs`.
 */

import { ethers } from 'ethers'
import { candidateRpcs, BSC_CHAIN_ID } from '../lib/bscProvider.mjs'
import {
  MARKETS, BID_BOOK, LENS, OWNER_SAFE, SAFE_OWNERS, SAFE_THRESHOLD, DEPLOY_BLOCK,
  TOKEN_DECIMALS, FACTORY_ABI, GATEWAY_ABI, SAFE_ABI, TREASURY_ABI,
  BIDBOOK_ABI, LENS_ABI, HOOK_ABI, ERC20_ABI, checkDeploymentFile,
} from './config.mjs'
import { syncLogs } from './logs.mjs'
import { loadPool } from './pool.mjs'
import { quoteLeg, spotPrice, roundTripCost } from './quote.mjs'

/**
 * Failures that are the network rather than the question: TLS sockets closed
 * mid-handshake, resets, the `could not coalesce error` the dataseed nodes
 * produce, rate limits. Retrying these is correct; retrying a missing getter
 * just wastes time.
 */
const TRANSIENT = /socket disconnected|ECONNRESET|ECONNREFUSED|coalesce|timeout|ETIMEDOUT|EAI_AGAIN|failed to detect|503|502|429/i

function rotateProvider(ctx) {
  const urls = candidateRpcs()
  if (urls.length < 2) return
  ctx.rpcIndex = ((ctx.rpcIndex ?? 0) + 1) % urls.length
  ctx.provider = new ethers.JsonRpcProvider(urls[ctx.rpcIndex], BSC_CHAIN_ID, {
    staticNetwork: true, batchMaxCount: 1,
  })
}

async function attempt(ctx, fn, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      return { ok: true, ...(await fn()) }
    } catch (e) {
      if (i < retries && TRANSIENT.test(String(e.message))) {
        rotateProvider(ctx)
        continue
      }
      return { ok: false, error: e.shortMessage || e.message }
    }
  }
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const ZERO = ethers.ZeroAddress
const c = (ctx, address, abi) => new ethers.Contract(address, abi, ctx.provider)

/**
 * PANEL 1 — who can do what, and whether it is still what was deployed.
 *
 * The checks are the claims `docs/AUDIT.md` publishes: each factory owned by
 * its gateway, each gateway answering to the 2-of-3 Safe, both treasuries
 * owned by that Safe directly, no ownership transfer half-way through. A check
 * that fails here means the published description of custody is wrong.
 */
export async function collectPlatform(ctx) {
  return attempt(ctx, async () => {
    const safe = c(ctx, OWNER_SAFE, SAFE_ABI)
    const book = c(ctx, BID_BOOK, BIDBOOK_ABI)
    const [owners, threshold, bookInit, nextBidId, feeRecipient] = await Promise.all([
      safe.getOwners(), safe.getThreshold(), book.initialized(), book.nextBidId(), book.feeRecipient(),
    ])

    const checks = []
    const check = (ok, text) => checks.push({ ok, text })
    check(owners.length === SAFE_OWNERS && Number(threshold) === SAFE_THRESHOLD,
      `所有者 Safe 是 ${threshold}-of-${owners.length}（应为 ${SAFE_THRESHOLD}-of-${SAFE_OWNERS}）`)
    check(bookInit, 'BidBook 已初始化')

    const deployment = checkDeploymentFile()
    for (const m of deployment.mismatches) check(false, `地址与部署记录不一致：${m}`)

    const markets = []
    for (const m of MARKETS) {
      const f = c(ctx, m.factory, FACTORY_ABI)
      const g = c(ctx, m.gateway, GATEWAY_ABI)
      const t = c(ctx, m.treasury, TREASURY_ABI)
      const q = c(ctx, m.quote, ERC20_ABI)
      const [
        owner, pendingOwner, paused, genesisPaused, ladderHaltedUntil, minBuy,
        minHardCap, maxHardCap, minAgentCap, maxAgentCap, launchCount, fTreasury, fBook, fQuote,
        gFactory, gSafe,
        tOwner, tPending, tFactory, reservoir, nextSpend, untilTrigger, ladderTokens, piggyback,
        escrow, fees, bookBalance,
      ] = await Promise.all([
        f.owner(), f.pendingOwner(), f.paused(), f.globalGenesisPaused(), f.globalLadderHaltedUntil(), f.minBuy(),
        f.minHardCap(), f.maxHardCap(), f.minAgentCap(), f.maxAgentCap(), f.launchCount(),
        f.ladderTreasury(), f.bidBook(), f.quoteAsset(),
        g.factory(), g.safe(),
        t.owner(), t.pendingOwner(), t.factory(), t.reservoir(), t.nextSpendAmount(), t.untilNextTrigger(),
        t.ladderTokenCount(), t.piggybackActive(),
        book.escrowTotal(m.quote), book.feesAccrued(m.quote), q.balanceOf(BID_BOOK),
      ])

      check(same(owner, m.gateway), `${m.symbol} 工厂归其 gateway 所有`)
      check(same(gFactory, m.factory) && same(gSafe, OWNER_SAFE), `${m.symbol} gateway 指向本工厂和所有者 Safe`)
      check(same(tOwner, OWNER_SAFE), `${m.symbol} treasury 直接归所有者 Safe`)
      check(same(pendingOwner, ZERO) && same(tPending, ZERO), `${m.symbol} 没有进行中的所有权转移`)
      check(same(fTreasury, m.treasury) && same(tFactory, m.factory) && same(fBook, BID_BOOK) && same(fQuote, m.quote),
        `${m.symbol} 工厂、treasury、BidBook、报价资产互相指认`)

      markets.push({
        ...m,
        paused, genesisPaused,
        ladderHaltedUntil: Number(ladderHaltedUntil),
        minBuy, minHardCap, maxHardCap, minAgentCap, maxAgentCap,
        launchCount: Number(launchCount),
        reservoir, nextSpend, untilTrigger,
        ladderTokens: Number(ladderTokens),
        piggyback,
        escrow, fees, bookBalance,
        // The book owes every open bid its escrow and the platform its fees.
        // Anything less in its balance is a shortfall someone cannot withdraw.
        bookSolvent: bookBalance >= escrow + fees,
      })
      check(bookBalance >= escrow + fees, `BidBook 的 ${m.symbol} 余额覆盖托管和未提手续费`)
    }

    return {
      safe: { address: OWNER_SAFE, owners, threshold: Number(threshold) },
      bidBook: { address: BID_BOOK, nextBidId: Number(nextBidId), feeRecipient },
      deploymentFile: deployment.present,
      markets,
      checks,
    }
  })
}

/**
 * Phase of a launch, from the lens's own fields, judged at the head block's
 * timestamp rather than this machine's clock.
 */
function phaseOf(s, now) {
  if (s.launched) return { key: 'launched', text: '已上线', level: 'ok' }
  if (s.soldOutAt > 0n) return { key: 'soldOut', text: '已售罄，待上线', level: 'warn' }
  if (now < s.genesisDeadline) return { key: 'genesis', text: '发售中', level: 'ok' }
  if (s.raised === 0n) return { key: 'abandoned', text: '已过期，无人购买', level: 'dim' }
  return { key: 'ended', text: '发售结束，待上线', level: 'warn' }
}

/**
 * PANEL 2 — every launch on both factories, and the pool of each one that has
 * launched.
 *
 * `ToshHookLens.genesisState` is one call per launch for nearly everything the
 * table needs, which is what it exists for.
 */
export async function collectLaunches(ctx) {
  return attempt(ctx, async () => {
    const lens = c(ctx, LENS, LENS_ABI)
    const launches = []
    for (const m of MARKETS) {
      const f = c(ctx, m.factory, FACTORY_ABI)
      const n = Number(await f.launchCount())
      for (let i = 0; i < n; i++) {
        const info = await f.launches(i)
        const tok = c(ctx, info.token, ERC20_ABI)
        const [s, symbol, name, hookPaused, ladderHalted] = await Promise.all([
          lens.genesisState(info.hook), tok.symbol(), tok.name(),
          f.hookGenesisPaused(info.hook), f.ladderMintingHalted(info.hook),
        ])
        const phase = phaseOf(s, BigInt(ctx.headTs))
        const row = {
          market: m.key, symbolQ: m.symbol, quoteDecimals: m.quoteDecimals,
          id: i, hook: info.hook, token: info.token, creator: info.creator,
          createdAt: Number(info.createdAt), symbol, name, phase, hookPaused, ladderHalted,
          hardCap: s.hardCap, perAgentCap: s.perAgentCap, raised: s.raised, sold: s.sold,
          currentPrice: s.currentPrice, genesisDeadline: Number(s.genesisDeadline),
          soldOutAt: Number(s.soldOutAt), publicLaunchAt: Number(s.publicLaunchAt),
          controller: s.projectController, fund: s.projectFund, fundAvailable: s.fundAvailable,
        }
        if (s.launched) row.pool = await poolHealth(ctx, info.hook, m)
        launches.push(row)
      }
    }
    return { launches }
  })
}

/**
 * Depth, impact and round-trip cost for one launched pool, priced at the
 * market's own sizes so a USDT pool is not read as if it were quoted in BNB.
 */
async function poolHealth(ctx, hook, m) {
  return attempt(ctx, async () => {
    const pool = await loadPool(hook, ctx.provider, m)
    const status = await c(ctx, hook, HOOK_ABI).tierStatus()
    const curve = m.sizes.map((whole) => {
      const q = quoteLeg(pool, ethers.parseUnits(String(whole), m.quoteDecimals), 'buy')
      return { quote: whole, impact: q.impact }
    })
    // Virtual reserves of a full-range position: x = L/√P, y = L·√P. Exact
    // here because every position in these pools spans the full range.
    const sqrtP = Number(pool.sqrtPriceX96) / 2 ** 96
    const probe = ethers.parseUnits(String(m.probe), m.quoteDecimals)
    return {
      spot: spotPrice(pool),
      depthQuote: Number(pool.liquidity) / sqrtP / 10 ** m.quoteDecimals,
      depthToken: Number(pool.liquidity) * sqrtP / 10 ** TOKEN_DECIMALS,
      lpFee: pool.lpFee,
      swapFeePips: Number(quoteLeg(pool, probe, 'buy').swapFeePips),
      curve,
      probe: m.probe,
      roundTrip: roundTripCost(pool, probe).lossFraction,
      tier: {
        index: Number(status.tierIndex),
        remaining: status.remaining,
        unlocked: status.unlocked,
        spotPrice: status.spotPrice,
        twapPrice: status.twapPrice,
        ceiling: status.ceiling,
      },
    }
  })
}

const FACTORY_IFACE = new ethers.Interface(FACTORY_ABI)
const GATEWAY_IFACE = new ethers.Interface(GATEWAY_ABI)
const TREASURY_IFACE = new ethers.Interface(TREASURY_ABI)
const BOOK_IFACE = new ethers.Interface(BIDBOOK_ABI)
const HOOK_IFACE = new ethers.Interface(HOOK_ABI)

/** Owner-side actions, listed so a change nobody announced is visible. */
const ADMIN_EVENTS = new Set([
  'GenesisPausedSet', 'Blacklisted', 'LadderMintingHalted', 'LadderMintingResumed', 'HardCapBoundsSet',
  'AgentCapBoundsSet', 'NameReleased', 'Paused', 'Unpaused', 'OwnershipTransferStarted',
  'OwnershipTransferred', 'Executed', 'LadderTokenAdded', 'LadderTokenRemoved', 'FeesSwept',
])

/**
 * PANEL 3 — what has actually happened since deployment, from event logs.
 *
 * Synced in two passes: the platform contracts first, because the hooks to
 * read are named by the factories' `LaunchCreated` logs, and each hook is read
 * from the block it was created in.
 */
export async function collectActivity(ctx) {
  return attempt(ctx, async () => {
    const head = ctx.head - 2
    const platform = {}
    for (const m of MARKETS) for (const a of [m.factory, m.gateway, m.treasury]) platform[a] = DEPLOY_BLOCK
    platform[BID_BOOK] = DEPLOY_BLOCK
    let { logs } = await syncLogs(platform, head)

    const created = {}
    for (const l of logs) {
      if (!MARKETS.some((m) => same(m.factory, l.address))) continue
      const ev = safeParse(FACTORY_IFACE, l)
      if (ev?.name === 'LaunchCreated') created[ev.args.hook] = l.block
    }
    let fetched = 0
    if (Object.keys(created).length) {
      const r = await syncLogs(created, head)
      logs = r.logs
      fetched = r.fetched
    }

    const marketOfHook = {}
    for (const l of logs) {
      const m = MARKETS.find((x) => same(x.factory, l.address))
      const ev = m && safeParse(FACTORY_IFACE, l)
      if (ev?.name === 'LaunchCreated') marketOfHook[ev.args.hook.toLowerCase()] = m.key
    }

    const per = Object.fromEntries(MARKETS.map((m) => [m.key, {
      buys: 0, paid: 0n, agents: new Set(), wallets: new Set(),
      bidsPlaced: 0, bidsFilled: 0, bidsCancelled: 0, filledGross: 0n, bookFees: 0n,
      taxIn: 0n, buybacks: 0, buybackSpent: 0n, buybackBurned: 0n, skipped: 0, pokes: 0,
      shelfMints: 0, shelfSpent: 0n, sellTaxBurned: 0n, launches: 0, pokeFailures: 0,
    }]))
    const recentBuys = []
    const admin = []

    for (const l of logs) {
      const fm = MARKETS.find((m) => same(m.factory, l.address))
      const gm = MARKETS.find((m) => same(m.gateway, l.address))
      const tm = MARKETS.find((m) => same(m.treasury, l.address))
      const hm = marketOfHook[l.address]
      let ev
      let mk
      if (fm) { ev = safeParse(FACTORY_IFACE, l); mk = fm.key }
      else if (gm) { ev = safeParse(GATEWAY_IFACE, l); mk = gm.key }
      else if (tm) { ev = safeParse(TREASURY_IFACE, l); mk = tm.key }
      else if (same(l.address, BID_BOOK)) { ev = safeParse(BOOK_IFACE, l); mk = marketOfHook[String(ev?.args?.hook || '').toLowerCase()] }
      else if (hm) { ev = safeParse(HOOK_IFACE, l); mk = hm }
      if (!ev) continue

      if (ADMIN_EVENTS.has(ev.name)) {
        admin.push({ name: ev.name, market: mk, address: l.address, block: l.block, tx: l.tx, args: describeArgs(ev) })
      }
      const p = per[mk]
      if (!p) continue
      switch (ev.name) {
        case 'GenesisBuy':
          p.buys++; p.paid += ev.args.paid
          p.agents.add(ev.args.agentKey); p.wallets.add(ev.args.buyer.toLowerCase())
          recentBuys.push({ market: mk, hook: l.address, buyer: ev.args.buyer, paid: ev.args.paid, tokens: ev.args.tokens, block: l.block, tx: l.tx })
          break
        case 'BidPlaced': p.bidsPlaced++; break
        case 'BidFilled': p.bidsFilled++; p.filledGross += ev.args.gross; p.bookFees += ev.args.buyerFee + ev.args.sellerFee; break
        case 'BidCancelled': p.bidsCancelled++; break
        case 'TaxReceived': p.taxIn += ev.args.amount; break
        case 'BuybackBurned': p.buybacks++; p.buybackSpent += ev.args.nativeIn; p.buybackBurned += ev.args.tokensBurned; break
        case 'BuybackSkipped': p.skipped++; break
        case 'PiggybackExecuted': p.pokes++; break
        case 'TierMinted': p.shelfMints++; p.shelfSpent += ev.args.nativeIn; break
        case 'SellTaxBurned': p.sellTaxBurned += ev.args.tokenAmount; break
        case 'Launched': p.launches++; break
        case 'PiggybackPokeFailed': p.pokeFailures++; break
      }
    }

    const markets = MARKETS.map((m) => {
      const p = per[m.key]
      return { key: m.key, symbol: m.symbol, quoteDecimals: m.quoteDecimals, ...p, agents: p.agents.size, wallets: p.wallets.size }
    })
    return {
      markets,
      recentBuys: recentBuys.slice(-12).reverse(),
      admin: admin.slice(-20).reverse(),
      logCount: logs.length,
      fetched,
      syncedTo: head,
    }
  })
}

function safeParse(iface, l) {
  try { return iface.parseLog({ topics: l.topics, data: l.data }) } catch { return null }
}

/**
 * Large integers are shown in 18-decimal units: both quote assets and every
 * launch token use 18 decimals, so a bound or amount above 1e12 is a quantity
 * of one of them, never a count.
 */
function describeArgs(ev) {
  return ev.fragment.inputs.map((input, i) => {
    const v = ev.args[i]
    if (typeof v !== 'bigint') return `${input.name}=${String(v)}`
    return `${input.name}=${v >= 10n ** 12n ? ethers.formatUnits(v, 18) : v.toString()}`
  }).join(' ')
}

/** PANEL 4 — the reading itself: which endpoint, how far behind, how much history is cached. */
export async function collectInfra(ctx) {
  return attempt(ctx, async () => ({
    rpc: ctx.url,
    paid: ctx.paid,
    head: ctx.head,
    headAgeSeconds: Math.max(0, Math.round(Date.now() / 1000) - ctx.headTs),
    endpoints: [...new Set(candidateRpcs())],
  }))
}
