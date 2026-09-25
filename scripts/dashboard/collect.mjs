/**
 * The six collectors behind the dashboard.
 *
 * Each returns `{ ok, needs?, error?, ...data }` rather than throwing, because
 * the panels have different credential requirements and one missing key should
 * cost you one panel, not the page. A panel that cannot be filled says which
 * credential is missing — the failure mode to avoid is a panel of zeroes that
 * looks like an answer.
 */

import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { fetchLogs, deploymentBlock, LogSourceUnavailable } from '../lib/etherscanLogs.mjs'
import { candidateRpcs } from '../lib/bscProvider.mjs'
import * as redis from '../lib/upstash.mjs'
import {
  FACTORY, LADDER_TREASURY, QUOTE_ASSET, QUOTE_DECIMALS, TOKEN_DECIMALS,
  DEAD_ADDRESS, TRIGGER_STEP, FACTORY_ABI, TREASURY_ABI, HOOK_ABI, ERC20_ABI,
  TOPICS, REDIS_KEYS, POG_DEFAULTS, topicAddress,
} from './config.mjs'
import { loadPool } from './pool.mjs'
import { quoteLeg, spotPrice, roundTripCost } from './quote.mjs'

const coder = ethers.AbiCoder.defaultAbiCoder()

/**
 * Failures that are the network rather than the question.
 *
 * Observed while building this, all from public BSC endpoints and all on reads
 * that succeed on the next attempt: TLS sockets closed before the handshake
 * completes, resets mid-response, and the `could not coalesce error` the
 * dataseed nodes produce for anything ethers cannot parse. These say nothing
 * about the chain, so retrying is correct — whereas retrying a missing getter
 * or a rejected API key just wastes time and quota.
 */
const TRANSIENT = /socket disconnected|ECONNRESET|ECONNREFUSED|coalesce|timeout|ETIMEDOUT|EAI_AGAIN|failed to detect|503|502|429/i

/** Move to the next endpoint, so a retry is not served by whatever just failed. */
function rotateProvider(ctx) {
  const urls = candidateRpcs()
  if (urls.length < 2) return false
  ctx.rpcIndex = ((ctx.rpcIndex ?? 0) + 1) % urls.length
  ctx.provider = new ethers.JsonRpcProvider(urls[ctx.rpcIndex], 56, {
    staticNetwork: true, batchMaxCount: 1,
  })
  return true
}

/**
 * Wrap a collector so one failure is contained and explained.
 *
 * Retries only transient network errors, and rotates the endpoint before each
 * retry. Without this a single dropped socket empties a whole panel — which is
 * how the burn panel first came back blank while the money panel, reading the
 * same treasury over the same connection a second later, filled in fine.
 */
async function attempt(ctx, fn, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      return { ok: true, ...(await fn()) }
    } catch (e) {
      if (e instanceof LogSourceUnavailable) return { ok: false, needs: 'ETHERSCAN_API_KEY', error: e.message }
      if (e instanceof redis.StoreUnavailable) return { ok: false, needs: 'UPSTASH_REDIS_REST_URL + _TOKEN', error: e.message }
      if (i < retries && ctx && TRANSIENT.test(String(e.message))) {
        rotateProvider(ctx)
        continue
      }
      return { ok: false, error: e.message }
    }
  }
}

/** The factory's deployment block, from Foundry's record of its own run. */
function factoryFromBlock() {
  const path = new URL('../../broadcast/DeployMainnet.s.sol/56/run-latest.json', import.meta.url)
  return deploymentBlock(JSON.parse(readFileSync(path, 'utf8')), FACTORY)
}

/**
 * Every launch the factory has created.
 *
 * Shared rather than per-panel: three panels need the project list, and each
 * log scan is a paid API call, so fetching it once and passing it down keeps the
 * page to one pass over history.
 */
export async function collectLaunches(ctx) {
  return attempt(ctx, async () => {
    const logs = await fetchLogs({
      apiKey: ctx.apiKey, address: FACTORY, topic0: TOPICS.LaunchCreated,
      fromBlock: ctx.fromBlock, toBlock: ctx.head,
    })
    const launches = logs.map((l) => {
      // topics: [sig, launchId, token, hook]; data: creator, name, symbol
      const [creator, name, symbol] = coder.decode(['address', 'string', 'string'], l.data)
      return {
        launchId: Number(BigInt(l.topics[1])),
        token: topicAddress(l.topics[2]),
        hook: topicAddress(l.topics[3]),
        creator, name, symbol,
        block: l.blockNumber,
      }
    }).sort((a, b) => a.launchId - b.launchId)
    return { launches }
  })
}

/**
 * PANEL 1 — the funnel.
 *
 * The question with no answer in production today. `/api/pog-scan` computes
 * eligibility and hands it to the browser; nothing aggregates it. So this
 * assembles the funnel from the three places that do remember something:
 *
 *   scans attempted   → Upstash rate-limit counters (hourly windows)
 *   scans passed      → Upstash scan jobs, last 48h, with the gas figures
 *   quota registered  → on-chain PoGRegistered, complete history
 *   money deposited   → on-chain GenesisDeposit, complete history
 *
 * The last two are permanent and exact. The first two expire, so they describe
 * recent traffic rather than all of it — which is the right way round, because
 * the recent window is what a decision about the floor should be based on.
 */
export async function collectFunnel(ctx) {
  return attempt(ctx, async () => {
    const [pogLogs, depositLogs] = await Promise.all([
      fetchLogs({
        apiKey: ctx.apiKey, address: FACTORY, topic0: TOPICS.PoGRegistered,
        fromBlock: ctx.fromBlock, toBlock: ctx.head,
      }),
      fetchLogs({
        apiKey: ctx.apiKey, address: FACTORY, topic0: TOPICS.GenesisDeposit,
        fromBlock: ctx.fromBlock, toBlock: ctx.head,
      }),
    ])

    // `registerPoG` emits on every call and only ever raises a quota, so a
    // wallet can appear repeatedly. Collapsing to the highest quota per wallet
    // makes this a census of people instead of of transactions.
    const quotaByWallet = new Map()
    for (const l of pogLogs) {
      const user = topicAddress(l.topics[1])
      const quota = BigInt(l.data)
      const prev = quotaByWallet.get(user)
      if (prev === undefined || quota > prev) quotaByWallet.set(user, quota)
    }

    const depositByWallet = new Map()
    let depositTotal = 0n
    let referredCount = 0
    for (const l of depositLogs) {
      const user = topicAddress(l.topics[1])
      // data: amount, lifetimeReferrer — projectReferrer is topic[3].
      const [amount] = coder.decode(['uint256', 'address'], l.data)
      depositByWallet.set(user, (depositByWallet.get(user) ?? 0n) + amount)
      depositTotal += amount
      if (BigInt(l.topics[3]) !== 0n) referredCount += 1
    }

    const quotas = [...quotaByWallet.values()].sort((a, b) => (a < b ? -1 : 1))
    const ceiling = ctx.band.maxAllocWei
    const atCeiling = quotas.filter((q) => q >= ceiling).length

    // Recent scan outcomes, if the store is reachable. This is the only place
    // the rejection side of the funnel is visible at all — a wallet that
    // scanned, came back below the floor and left leaves no other trace.
    let recent = null
    if (redis.configured()) {
      try {
        const { keys, truncated } = await redis.scanKeys(REDIS_KEYS.scanJobPattern)
        // The credit gauge lives under the same prefix and is not a scan job.
        const jobKeys = keys.filter((k) => k !== REDIS_KEYS.credits)
        const raw = jobKeys.length ? await redis.mget(jobKeys) : []
        const jobs = raw.map((v) => { try { return JSON.parse(v) } catch { return null } })
          .filter((j) => j && j.status === 'done' && j.result)
        const totals = jobs.map((j) => BigInt(j.result.totalWei))
        const eligible = totals.filter((t) => t >= ctx.band.floorWei).length
        recent = {
          window: '48h (Redis TTL)',
          scanned: jobs.length,
          eligible,
          truncated,
          // The distribution is the actionable part: a population clustered two
          // orders of magnitude below the floor calls for a different decision
          // than one clustered just under it.
          totals: totals.sort((a, b) => (a < b ? -1 : 1)).map(String),
        }
      } catch (e) {
        recent = { error: e.message }
      }
    }

    // Hourly scan-attempt counters. Only new upstream scans are charged, so
    // cache hits and polls are invisible here — this is a floor on traffic.
    let attempts = null
    if (redis.configured()) {
      try {
        const { keys } = await redis.scanKeys(REDIS_KEYS.globalLimitPattern)
        const vals = keys.length ? await redis.mget(keys) : []
        attempts = {
          windows: keys.length,
          total: vals.reduce((a, v) => a + (Number(v) || 0), 0),
        }
      } catch (e) {
        attempts = { error: e.message }
      }
    }

    return {
      registered: quotaByWallet.size,
      registrations: pogLogs.length,
      depositors: depositByWallet.size,
      deposits: depositLogs.length,
      depositTotal: depositTotal.toString(),
      referredDeposits: referredCount,
      quotaMedian: (quotas[Math.floor(quotas.length / 2)] ?? 0n).toString(),
      quotaTotal: quotas.reduce((a, b) => a + b, 0n).toString(),
      atCeiling,
      // The conversion that matters: of everyone allowed in, how many came.
      depositConversion: quotaByWallet.size === 0 ? null
        : depositByWallet.size / quotaByWallet.size,
      recent,
      attempts,
      band: {
        floorWei: ctx.band.floorWei.toString(),
        maxAllocWei: ctx.band.maxAllocWei.toString(),
        rate: ctx.band.rate,
        source: ctx.band.source,
      },
    }
  })
}

/**
 * PANEL 2 — pool health, and why the candles look the way they do.
 *
 * The impact curve is the point. A chart full of violent wicks is usually read
 * as "not enough volume", and on this pool it is the opposite: there is not
 * enough DEPTH, so ordinary-sized orders move the price several percent and
 * every one of them prints a wick. Showing impact at a ladder of sizes makes
 * that legible in a way a TVL number does not, and the remedy it implies —
 * add liquidity — is the one that also earns fees.
 */
export async function collectPools(ctx, launches) {
  const sizes = [5, 10, 25, 50, 100]
  const out = []
  for (const l of launches) {
    out.push(await attempt(ctx, async () => {
      const pool = await loadPool(l.hook, ctx.provider)
      const curve = sizes.map((whole) => {
        const amountIn = ethers.parseUnits(String(whole), QUOTE_DECIMALS)
        const q = quoteLeg(pool, amountIn, 'buy')
        return { quote: whole, impact: q.impact, out: q.amountOut.toString() }
      })
      // Virtual reserves of a full-range position: x = L/√P, y = L·√P. Exact
      // here because every position in these pools spans the full range.
      const sqrtP = Number(pool.sqrtPriceX96) / 2 ** 96
      const depthQuote = Number(pool.liquidity) / sqrtP / 10 ** QUOTE_DECIMALS
      const depthToken = Number(pool.liquidity) * sqrtP / 10 ** TOKEN_DECIMALS
      const rt = roundTripCost(pool, ethers.parseUnits('25', QUOTE_DECIMALS))

      return {
        hook: l.hook, token: l.token, symbol: l.symbol, name: l.name,
        spot: spotPrice(pool),
        liquidity: pool.liquidity.toString(),
        lpFee: pool.lpFee,
        protocolFee: Number(BigInt(pool.protocolFee) & 0xfffn),
        swapFeePips: Number(curve.length ? quoteLeg(pool, ethers.parseUnits('1', QUOTE_DECIMALS), 'buy').swapFeePips : 0n),
        depthQuote, depthToken,
        curve,
        roundTripAt25: rt.lossFraction,
        /**
         * Extra depth needed to bring a 25 BEM order under 1% impact.
         *
         * Impact scales roughly inversely with liquidity, so the multiple is
         * the ratio of current impact to target. Presented as a target depth
         * rather than a multiplier because "add this much" is the decision.
         */
        depthFor1PctAt25: (() => {
          const at25 = curve.find((c) => c.quote === 25)?.impact ?? 0
          if (at25 <= 0.01) return null
          return depthQuote * (at25 / 0.01) - depthQuote
        })(),
      }
    }))
  }
  return out
}

/**
 * PANEL 3 — burn attribution, and whether the buyback is actually firing.
 *
 * Total burned is the easy half: it is the dead address's balance. The half
 * worth building is the split, because the two sources mean different things.
 * `BuybackBurned` is the treasury spending real BEM to buy tokens off the
 * market — demand. The remainder is sell tax, which burns supply without any
 * buying at all. Reporting one number hides which is happening.
 *
 * `BuybackSkipped` is the alarm. A treasury that is funded, armed and skipping
 * is a treasury doing nothing, and nothing else on the page would show it.
 */
export async function collectBurn(ctx, launches) {
  return attempt(ctx, async () => {
    const treasury = new ethers.Contract(LADDER_TREASURY, TREASURY_ABI, ctx.provider)
    const [reservoir, ladderCount, untilNext, nextSpend, cursor] = await Promise.all([
      treasury.reservoir(), treasury.ladderTokenCount(), treasury.untilNextTrigger(),
      treasury.nextSpendAmount(), treasury.currentCursor(),
    ])

    /**
     * The event history is optional, and deliberately so.
     *
     * The reads above — reservoir, armed count, next trigger — are the live
     * health of the buyback and they cost nothing but an RPC call. Letting one
     * throttled Etherscan request take them down with it would hide "the
     * treasury has zero tokens armed" behind "could not reach Etherscan",
     * which is the wrong failure to show. Attribution degrades; state does not.
     */
    let burned = []
    let skipped = []
    let taxIn = []
    let logsError = null
    try {
      const pull = (topic0) => fetchLogs({
        apiKey: ctx.apiKey, address: LADDER_TREASURY, topic0,
        fromBlock: ctx.fromBlock, toBlock: ctx.head,
      })
      burned = await pull(TOPICS.BuybackBurned)
      skipped = await pull(TOPICS.BuybackSkipped)
      taxIn = await pull(TOPICS.TaxReceived)
    } catch (e) {
      logsError = e.message
    }

    const perToken = new Map()
    let spentTotal = 0n
    for (const l of burned) {
      const token = topicAddress(l.topics[1])
      const [nativeIn, tokensBurned] = coder.decode(['uint256', 'uint256'], l.data)
      const e = perToken.get(token) ?? { spent: 0n, burned: 0n, count: 0 }
      e.spent += nativeIn; e.burned += tokensBurned; e.count += 1
      perToken.set(token, e)
      spentTotal += nativeIn
    }
    const skippedPerToken = new Map()
    for (const l of skipped) {
      const token = topicAddress(l.topics[1])
      skippedPerToken.set(token, (skippedPerToken.get(token) ?? 0) + 1)
    }

    // Per-token totals, so buyback burn can be separated from sell-tax burn.
    const tokens = []
    for (const l of launches) {
      const erc = new ethers.Contract(l.token, ERC20_ABI, ctx.provider)
      const [supply, dead, armed] = await Promise.all([
        erc.totalSupply(), erc.balanceOf(DEAD_ADDRESS), treasury.isLadderToken(l.token),
      ])
      const bb = perToken.get(l.token) ?? { spent: 0n, burned: 0n, count: 0 }
      tokens.push({
        token: l.token, symbol: l.symbol, armed,
        totalSupply: supply.toString(),
        deadBalance: dead.toString(),
        buybackBurned: bb.burned.toString(),
        buybackSpent: bb.spent.toString(),
        buybackCount: bb.count,
        // Whatever reached the dead address that buybacks did not put there.
        // Negative would mean the accounting is wrong, so it is surfaced rather
        // than clamped.
        sellTaxBurned: (dead - bb.burned).toString(),
        skipped: skippedPerToken.get(l.token) ?? 0,
        burnedFraction: supply === 0n ? 0 : Number(dead) / Number(supply),
      })
    }

    return {
      logsError,
      reservoir: reservoir.toString(),
      ladderCount: Number(ladderCount),
      untilNextTrigger: untilNext.toString(),
      nextSpendAmount: nextSpend.toString(),
      cursor: Number(cursor),
      triggerStep: TRIGGER_STEP.toString(),
      buybackCount: burned.length,
      buybackSpent: spentTotal.toString(),
      skippedCount: skipped.length,
      taxReceipts: taxIn.length,
      tokens,
      recent: burned.slice(-10).reverse().map((l) => {
        const [nativeIn, tokensBurned] = coder.decode(['uint256', 'uint256'], l.data)
        return {
          token: topicAddress(l.topics[1]),
          nativeIn: nativeIn.toString(),
          tokensBurned: tokensBurned.toString(),
          block: l.blockNumber,
          tx: l.transactionHash,
        }
      }),
    }
  })
}

/**
 * PANEL 4 — where the money actually sits.
 *
 * Four destinations, and the reason to show them together is that they are easy
 * to confuse: the platform's maintenance fee and the launch fees go to the same
 * Safe but in different assets (BEM and BNB), the buyback fuel goes to a
 * contract rather than a wallet, and each project's own shelf income goes to an
 * EOA the platform does not control.
 */
export async function collectMoney(ctx, launches) {
  return attempt(ctx, async () => {
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, ctx.provider)
    const quote = new ethers.Contract(QUOTE_ASSET, ERC20_ABI, ctx.provider)
    const [platformTreasury, launchFee] = await Promise.all([
      factory.platformTreasury(), factory.launchFee(),
    ])

    const [safeQuote, safeNative, treasuryQuote] = await Promise.all([
      quote.balanceOf(platformTreasury),
      ctx.provider.getBalance(platformTreasury),
      quote.balanceOf(LADDER_TREASURY),
    ])

    const admins = []
    for (const l of launches) {
      const hook = new ethers.Contract(l.hook, HOOK_ABI, ctx.provider)
      const admin = await hook.projectAdmin()
      const bal = await quote.balanceOf(admin)
      admins.push({ hook: l.hook, symbol: l.symbol, admin, balance: bal.toString() })
    }

    return {
      platformTreasury,
      safeQuote: safeQuote.toString(),
      safeNative: safeNative.toString(),
      treasuryQuote: treasuryQuote.toString(),
      launchFee: launchFee.toString(),
      admins,
    }
  })
}

/**
 * PANEL 5 — configuration, and whether it has drifted.
 *
 * Values alone are not useful; what matters is whether each one is where it
 * should be. So ownership is checked for being a contract (the Safe) rather
 * than an EOA, dials are shown against their contract-enforced ceilings, and
 * the change events are listed so a value that moved has a visible trail.
 */
export async function collectConfig(ctx) {
  return attempt(ctx, async () => {
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, ctx.provider)
    const treasury = new ethers.Contract(LADDER_TREASURY, TREASURY_ABI, ctx.provider)

    const [
      owner, paused, pogSigner, platformTreasury, launchFee, defaultSoftCap,
      maxPogAlloc, cooldown, quotaWindow, haltedUntil,
      maxLaunchFee, maxSoftCap, maxPogLimit, treasuryOwner,
    ] = await Promise.all([
      factory.owner(), factory.paused(), factory.pogSigner(), factory.platformTreasury(),
      factory.launchFee(), factory.defaultSoftCap(), factory.maxPogAllocationLimit(),
      factory.cooldownDuration(), factory.quotaWindowDuration(), factory.globalLadderHaltedUntil(),
      factory.MAX_LAUNCH_FEE(), factory.MAX_DEFAULT_SOFT_CAP(), factory.MAX_POG_ALLOCATION_LIMIT(),
      treasury.owner(),
    ])

    // An owner with no code is an EOA, which for this role is a finding rather
    // than a detail: the whole point of the Safe is that no single key can
    // retune the protocol.
    const [ownerCode, treasuryOwnerCode, signerCode] = await Promise.all([
      ctx.provider.getCode(owner), ctx.provider.getCode(treasuryOwner), ctx.provider.getCode(pogSigner),
    ])

    // Optional, for the same reason as in the burn panel: "the owner is an EOA"
    // is the finding on this page worth seeing most, and it must not depend on
    // an API that can be rate-limited.
    const changes = {}
    let logsError = null
    try {
      for (const name of ['LaunchFeeUpdated', 'PogSignerUpdated', 'DefaultSoftCapUpdated', 'MaxPogAllocationLimitUpdated', 'Blacklisted', 'LadderMintingHalted']) {
        const logs = await fetchLogs({
          apiKey: ctx.apiKey, address: FACTORY, topic0: TOPICS[name],
          fromBlock: ctx.fromBlock, toBlock: ctx.head,
        })
        changes[name] = logs.map((l) => ({ block: l.blockNumber, tx: l.transactionHash }))
      }
    } catch (e) {
      logsError = e.message
    }

    return {
      logsError,
      owner, ownerIsContract: ownerCode !== '0x',
      treasuryOwner, treasuryOwnerIsContract: treasuryOwnerCode !== '0x',
      paused,
      pogSigner, signerIsContract: signerCode !== '0x',
      platformTreasury,
      launchFee: launchFee.toString(), maxLaunchFee: maxLaunchFee.toString(),
      defaultSoftCap: defaultSoftCap.toString(), maxSoftCap: maxSoftCap.toString(),
      maxPogAlloc: maxPogAlloc.toString(), maxPogLimit: maxPogLimit.toString(),
      cooldownHours: Number(cooldown) / 3600,
      quotaWindowHours: Number(quotaWindow) / 3600,
      haltedUntil: Number(haltedUntil),
      changes,
    }
  })
}

/**
 * PANEL 6 — the infrastructure budget that has twice taken the raise down.
 *
 * The credit gauge on its own is not the useful number; the useful number is
 * how long it lasts. Two outages came from a budget that looked fine until it
 * did not, so this converts the gauge and the observed scan rate into days of
 * runway.
 */
export async function collectInfra(ctx) {
  return attempt(ctx, async () => {
    if (!redis.configured()) throw new redis.StoreUnavailable('Upstash is not configured')

    const [creditsRaw, floorRaw, rateRaw, maxAllocRaw] = await redis.mget([
      REDIS_KEYS.credits, REDIS_KEYS.floorWei, REDIS_KEYS.gasToSatoRate, REDIS_KEYS.maxAllocWei,
    ])

    const { keys } = await redis.scanKeys(REDIS_KEYS.globalLimitPattern)
    const vals = keys.length ? await redis.mget(keys) : []
    const counts = vals.map((v) => Number(v) || 0)
    const scansObserved = counts.reduce((a, b) => a + b, 0)

    // Each scan costs 5-25 upstream calls depending on how much history a wallet
    // has; the high end is the one worth planning against.
    const CALLS_PER_SCAN = 25
    const credits = creditsRaw === null ? null : Number(creditsRaw)
    const perHour = keys.length ? scansObserved / keys.length : 0
    const daysLeft = credits && perHour > 0
      ? credits / (perHour * CALLS_PER_SCAN * 24)
      : null

    return {
      credits,
      windowsSeen: keys.length,
      scansObserved,
      scansPerHour: perHour,
      daysLeft,
      liveBand: {
        floorWei: floorRaw ?? null,
        rate: rateRaw ?? null,
        maxAllocWei: maxAllocRaw ?? null,
      },
      defaults: {
        floorWei: POG_DEFAULTS.floorWei.toString(),
        rate: POG_DEFAULTS.gasToAllocRate,
        maxAllocWei: POG_DEFAULTS.maxAllocWei.toString(),
      },
    }
  })
}

/**
 * The live PoG band.
 *
 * Read before anything else because eligibility is measured against it, and
 * comparing scan totals to the seeded default when production is running an
 * override would misreport every wallet on the page.
 */
export async function readBand() {
  let floorWei = POG_DEFAULTS.floorWei
  let maxAllocWei = POG_DEFAULTS.maxAllocWei
  let rate = POG_DEFAULTS.gasToAllocRate
  let source = 'defaults (Upstash not configured)'

  if (redis.configured()) {
    try {
      const [f, r, m] = await redis.mget([
        REDIS_KEYS.floorWei, REDIS_KEYS.gasToSatoRate, REDIS_KEYS.maxAllocWei,
      ])
      const overrides = []
      if (f) { floorWei = BigInt(f); overrides.push('floor') }
      if (m) { maxAllocWei = BigInt(m); overrides.push('maxAlloc') }
      if (r) { rate = Number(r); overrides.push('rate') }
      source = overrides.length ? `Upstash overrides: ${overrides.join(', ')}` : 'defaults (no overrides set)'
    } catch (e) {
      source = `defaults (Upstash unreachable: ${e.message})`
    }
  }
  return { floorWei, maxAllocWei, rate, source }
}

export { factoryFromBlock }



