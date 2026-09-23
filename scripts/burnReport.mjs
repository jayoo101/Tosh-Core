/**
 * Where a project's supply goes, and what it costs in BEM to send it there.
 *
 *   node scripts/burnReport.mjs [SYMBOL|0xtoken]      # default: the largest raise
 *
 * ── The thing this report exists to correct ──────────────────────────────────
 *
 * BEM IS NEVER BURNED. Not one wei of it, by any code path in this protocol, and
 * it is worth being blunt about because "the BEM burn" is the natural way to
 * describe what the flywheel does and it is the wrong way round.
 *
 * There are exactly two burn channels, both of which destroy the PROJECT TOKEN:
 *
 *   1. SELL TAX — `ToshLaunchpadHook`, `SellTaxBurned(uint256)`. 1.0 % of the
 *      token-side input of every sell is taken at `vault.take(currency1,
 *      DEAD_ADDRESS, tax)` and never exists again. It costs no BEM at all: the
 *      seller pays it in the token they were selling.
 *
 *   2. BUYBACK — `ToshLadderTreasury`, `BuybackBurned(token, nativeIn,
 *      tokensBurned)`. BEM accumulated from the buy-side tax is SPENT through
 *      the V4 pool to market-buy the token, and the output goes to
 *      `DEAD_ADDRESS`. The BEM leaves the treasury into the POOL, where it
 *      becomes pool reserves that LPs and traders can take out again. It is
 *      spent, not destroyed.
 *
 * So `balanceOf(0xdead)` on the project token is the real "burned" figure and
 * the sum of the two channels. The same call on BEM answers the question people
 * usually mean to ask, and the answer is normally zero — which this report
 * prints rather than assumes, because a third party could always send BEM there
 * by hand and that would not be the protocol doing it.
 *
 * ── Why the totals come from balances and the split comes from logs ──────────
 *
 * `balanceOf(0xdead)` is one call, cannot be wrong, and needs no block range.
 * The per-channel split needs `eth_getLogs`, which the free BSC endpoints
 * truncate, rate-limit or refuse for archive depth — so the split is reported as
 * "what the logs we could actually read say", with the span stated, and it never
 * contradicts the balance because the balance is not derived from it.
 */
import { ethers } from 'ethers'

import { connect, withFallback } from './lib/bscProvider.mjs'
import { scanBack } from './lib/logScan.mjs'
import {
  FACTORY, LADDER_TREASURY, QUOTE_ASSET, QUOTE_DECIMALS, DEAD_ADDRESS,
  TRIGGER_STEP, ERC20_ABI, fmt,
} from './dashboard/config.mjs'

const FACTORY_ABI = [
  'function launchCount() view returns (uint256)',
  'function launches(uint256) view returns (address token, address hook, address creator, uint256 createdAt)',
]

const HOOK_ABI = [
  'function projectToken() view returns (address)',
  'function launched() view returns (bool)',
  'function creator() view returns (address)',
  'function genesisDeadline() view returns (uint256)',
  'function totalNativeDeposited() view returns (uint256)',
  'function ladderTreasury() view returns (address)',
  'function platformFeeRecipient() view returns (address)',
  'function TAX_BPS() view returns (uint256)',
  'function PLATFORM_SWAP_FEE_BPS() view returns (uint256)',
  'function POOL_FEE() view returns (uint24)',
  'function getPoolKey() view returns (tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters))',
]

const TREASURY_ABI = [
  'function reservoir() view returns (uint256)',
  'function ladderTokenCount() view returns (uint256)',
  'function ladderTokens(uint256) view returns (address)',
  'function isLadderToken(address) view returns (bool)',
  'function untilNextTrigger() view returns (uint256)',
  'function nextSpendAmount() view returns (uint256)',
  'function currentCursor() view returns (uint256)',
  'function SPEND_BPS() view returns (uint256)',
  'function BATCH_SIZE() view returns (uint256)',
  'function LEGS_PER_POKE() view returns (uint256)',
]

/** The two burn channels, plus the BEM inflows that fund the second one. */
const IFACE = new ethers.Interface([
  'event SellTaxBurned(uint256 tokenAmount)',
  'event BuyTaxToTreasury(uint256 nativeAmount)',
  'event PlatformSwapFeePaid(address indexed recipient, uint256 nativeAmount)',
  'event BuybackBurned(address indexed token, uint256 nativeIn, uint256 tokensBurned)',
  'event BuybackSkipped(address indexed token, uint256 nativeIn)',
  'event TaxReceived(address indexed hook, uint256 amount)',
  'event Launched(uint256 totalNative, uint256 lpNative, uint128 lpLiquidity, uint160 sqrtPriceX96, uint256 p0)',
])

const TOPIC = (name) => IFACE.getEvent(name).topicHash

const tok = (v, d = 18) => `${fmt(v, d, 4)}`
const bem = (v) => `${fmt(v, QUOTE_DECIMALS, 4)} BEM`
const pct = (part, whole) =>
  whole === 0n ? 'n/a' : `${(Number((part * 1000000n) / whole) / 10000).toFixed(4)}%`

/**
 * `eth_getLogs` over a span the free endpoints will actually serve.
 *
 * Delegated to ./lib/logScan.mjs after this function's first version reported
 * 19,480 tokens burned against 232,308 actually at 0xdead. The cause was not the
 * chunk size but the ENDPOINT LIST: it retried each chunk through `withFallback`,
 * and almost nothing in that list serves `eth_getLogs` at all, so nearly every
 * chunk landed in `gaps`. The warning below fired correctly and the figures were
 * still useless. Hence a list of endpoints picked for logs specifically.
 *
 * What survives from that version is the part that was right: a range that fails
 * everywhere is COUNTED AND REPORTED rather than skipped silently, because a burn
 * total with a hole in it that presents as complete is worse than one that says
 * where the hole is.
 */
async function scanLogs({ address, topics, fromBlock, toBlock }) {
  const out = []
  const gaps = []
  for await (const w of scanBack({ address, topics, fromBlock, toBlock })) {
    if (w.failed) gaps.push([w.from, w.to])
    else out.push(...w.logs)
  }
  return { logs: out, gaps }
}

function sum(logs, field) {
  return logs.reduce((acc, l) => {
    try { return acc + IFACE.parseLog(l).args[field] } catch { return acc }
  }, 0n)
}

async function main() {
  const wanted = (process.argv[2] ?? '').trim()

  const { provider, url, blockNumber } = await connect()
  const now = (await provider.getBlock(blockNumber)).timestamp
  console.log(`chain 56 · block ${blockNumber} · ${url}\n`)

  // ── Pick the project ──────────────────────────────────────────────────────
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider)
  const count = Number(await factory.launchCount())

  const rows = []
  for (let i = 0; i < count; i++) {
    const [token, hook, creator, createdAt] = await withFallback(async (p) => {
      const f = new ethers.Contract(FACTORY, FACTORY_ABI, p)
      return f.launches(i)
    })
    const erc = new ethers.Contract(token, ERC20_ABI, provider)
    const [symbol, raised] = await withFallback(async (p) => Promise.all([
      new ethers.Contract(token, ERC20_ABI, p).symbol(),
      new ethers.Contract(hook, HOOK_ABI, p).totalNativeDeposited(),
    ]))
    rows.push({ i, token, hook, creator, createdAt, symbol, raised, erc })
  }

  let pick
  if (wanted === '') {
    pick = rows.reduce((a, b) => (b.raised > a.raised ? b : a))
    console.log(`no argument given — reporting on the largest raise\n`)
  } else if (wanted.startsWith('0x')) {
    pick = rows.find((r) => r.token.toLowerCase() === wanted.toLowerCase()
                         || r.hook.toLowerCase() === wanted.toLowerCase())
  } else {
    pick = rows.find((r) => r.symbol.toUpperCase() === wanted.toUpperCase())
  }
  if (!pick) {
    console.error(`no launch matches "${wanted}". Symbols on the factory: ${rows.map(r => r.symbol).join(', ')}`)
    process.exit(1)
  }

  const token = new ethers.Contract(pick.token, ERC20_ABI, provider)
  const hook = new ethers.Contract(pick.hook, HOOK_ABI, provider)

  const [name, symbol, decimals, supply, deadBal, hookBal, launched, deadline] =
    await withFallback(async (p) => {
      const t = new ethers.Contract(pick.token, ERC20_ABI, p)
      const h = new ethers.Contract(pick.hook, HOOK_ABI, p)
      return Promise.all([
        t.name(), t.symbol(), t.decimals(), t.totalSupply(),
        t.balanceOf(DEAD_ADDRESS), t.balanceOf(pick.hook),
        h.launched(), h.genesisDeadline(),
      ])
    })
  const d = Number(decimals)

  console.log(`═══ $${symbol} — "${name}" ═══`)
  console.log(`  token    ${pick.token}`)
  console.log(`  hook     ${pick.hook}`)
  console.log(`  creator  ${pick.creator}`)
  console.log(`  state    ${launched ? 'LAUNCHED · trading' : 'not launched'}`)
  console.log(`  genesis  closed ${Math.floor((now - Number(deadline)) / 3600)}h ago`)
  console.log(`  raised   ${bem(pick.raised)}`)
  console.log(`  decimals ${d}\n`)

  // ── Supply and the only number that settles "how much is burned" ──────────
  console.log(`── supply ──`)
  console.log(`  total supply      ${tok(supply, d)} ${symbol}`)
  console.log(`  at 0xdead         ${tok(deadBal, d)} ${symbol}   (${pct(deadBal, supply)} of supply)`)
  console.log(`  held by the hook  ${tok(hookBal, d)} ${symbol}   (unclaimed genesis + shelf inventory)`)
  console.log(`  circulating-ish   ${tok(supply - deadBal - hookBal, d)} ${symbol}\n`)

  // ── Is BEM burned at all? ────────────────────────────────────────────────
  const [bemSupply, bemDead, bemTreasury, bemPool] = await withFallback(async (p) => {
    const q = new ethers.Contract(QUOTE_ASSET, ERC20_ABI, p)
    // The Vault, NOT `key.poolManager`. Infinity splits the two: the manager owns
    // pool state, the Vault owns balances. Reading the manager returns 0 and
    // presents as "the pool holds no BEM", which is a wrong answer rather than a
    // missing one — the hook's own comments at ToshLaunchpadHook.sol:691 say so.
    const vault = await new ethers.Contract(pick.hook, ['function vault() view returns (address)'], p).vault()
    return Promise.all([
      q.totalSupply(), q.balanceOf(DEAD_ADDRESS),
      q.balanceOf(LADDER_TREASURY), q.balanceOf(vault),
    ])
  })

  console.log(`── BEM, the quote asset ──`)
  console.log(`  total supply      ${bem(bemSupply)}`)
  console.log(`  at 0xdead         ${bem(bemDead)}   ${bemDead === 0n
    ? '← no BEM has ever been burned, by this protocol or anyone else'
    : '← NOTE: someone has sent BEM to 0xdead. No Tosh code path does this.'}`)
  console.log(`  in the treasury   ${bem(bemTreasury)}   (buyback ammunition, spendable)`)
  console.log(`  in the V4 vault   ${bem(bemPool)}   (pool reserves — where buybacks send it)\n`)

  // ── The engine that spends BEM ───────────────────────────────────────────
  const tre = await withFallback(async (p) => {
    const c = new ethers.Contract(LADDER_TREASURY, TREASURY_ABI, p)
    const n = Number(await c.ladderTokenCount())
    const list = []
    for (let i = 0; i < n; i++) list.push(await c.ladderTokens(i))
    return {
      reservoir: await c.reservoir(),
      count: n,
      list,
      cursor: Number(await c.currentCursor()),
      isLadder: await c.isLadderToken(pick.token),
      untilNext: await c.untilNextTrigger(),
      nextSpend: await c.nextSpendAmount(),
      spendBps: await c.SPEND_BPS(),
      batch: await c.BATCH_SIZE(),
    }
  })

  console.log(`── buyback engine (ToshLadderTreasury ${LADDER_TREASURY}) ──`)
  console.log(`  reservoir         ${bem(tre.reservoir)}`)
  console.log(`  trigger step      ${bem(TRIGGER_STEP)}`)
  console.log(`  until next fire   ${bem(tre.untilNext)} more tax needed`)
  console.log(`  next spend        ${bem(tre.nextSpend)}   (${Number(tre.spendBps) / 100}% of the reservoir, ${tre.batch} tokens per cycle)`)
  console.log(`  ladder tokens     ${tre.count}${tre.count ? ` → ${tre.list.join(', ')}` : ''}`)
  console.log(`  $${symbol} listed    ${tre.isLadder ? 'YES — buybacks can burn it' : 'NO'}`)
  if (!tre.isLadder) {
    console.log(`                    ⚠ an unlisted token is never bought back, so its`)
    console.log(`                      only burn channel is the sell tax.`)
  }
  console.log('')

  // ── Split the burn by channel, from logs ─────────────────────────────────
  // 200,000 blocks ≈ 7 days, which covers every launch made since the mainnet
  // factory went up. The old 60,000 default silently cut off the busiest stretch
  // of $TO's life — its first day of trading, which holds 14 of its 16 buybacks.
  const span = Number(process.env.BURN_SCAN_BLOCKS ?? 200000)
  const from = Math.max(0, blockNumber - span)
  console.log(`── burn channels · logs over the last ${span.toLocaleString('en-US')} blocks (≈${(span * 3 / 86400).toFixed(1)}d) ──`)

  const sell = await scanLogs({
    address: pick.hook, topics: [TOPIC('SellTaxBurned')], fromBlock: from, toBlock: blockNumber,
  })
  const buyTax = await scanLogs({
    address: pick.hook, topics: [TOPIC('BuyTaxToTreasury')], fromBlock: from, toBlock: blockNumber,
  })
  const platFee = await scanLogs({
    address: pick.hook, topics: [TOPIC('PlatformSwapFeePaid')], fromBlock: from, toBlock: blockNumber,
  })
  const buyback = await scanLogs({
    address: LADDER_TREASURY, topics: [TOPIC('BuybackBurned')], fromBlock: from, toBlock: blockNumber,
  })
  const skipped = await scanLogs({
    address: LADDER_TREASURY, topics: [TOPIC('BuybackSkipped')], fromBlock: from, toBlock: blockNumber,
  })

  const sellBurned = sum(sell.logs, 'tokenAmount')
  const mine = buyback.logs.filter((l) => {
    try { return IFACE.parseLog(l).args.token.toLowerCase() === pick.token.toLowerCase() }
    catch { return false }
  })
  const buybackSpent = sum(mine, 'nativeIn')
  const buybackBurned = sum(mine, 'tokensBurned')

  console.log(`  1 · SELL TAX → 0xdead        ${sell.logs.length} event(s), ${tok(sellBurned, d)} ${symbol} burned`)
  console.log(`      costs no BEM — the seller pays it in the token being sold`)
  console.log(`  2 · BUYBACK → 0xdead         ${mine.length} event(s), ${tok(buybackBurned, d)} ${symbol} burned`)
  console.log(`      BEM spent into the pool   ${bem(buybackSpent)}`)
  console.log(`      skipped legs (all tokens) ${skipped.logs.length}`)
  console.log('')
  console.log(`  BEM tax collected in this span`)
  console.log(`      → treasury (0.70%)       ${bem(sum(buyTax.logs, 'nativeAmount'))} over ${buyTax.logs.length} buy(s)`)
  console.log(`      → platform (0.30%)       ${bem(sum(platFee.logs, 'nativeAmount'))} over ${platFee.logs.length} buy(s)`)

  const gaps = [...sell.gaps, ...buyTax.gaps, ...platFee.gaps, ...buyback.gaps, ...skipped.gaps]
  if (gaps.length) {
    console.log(`\n  ⚠ ${gaps.length} block range(s) could not be read on any endpoint, so the`)
    console.log(`    per-channel figures above are a FLOOR. The 0xdead balance is not —`)
    console.log(`    it is a single call and it is the authoritative total.`)
  }

  const accounted = sellBurned + buybackBurned
  console.log(`\n── reconciliation ──`)
  console.log(`  channels seen in logs   ${tok(accounted, d)} ${symbol}`)
  console.log(`  actually at 0xdead      ${tok(deadBal, d)} ${symbol}`)
  const diff = deadBal - accounted
  if (diff === 0n) {
    console.log(`  → the logs account for every burned token in this span.`)
  } else if (diff > 0n) {
    console.log(`  → ${tok(diff, d)} ${symbol} burned outside the scanned span or by a`)
    console.log(`    channel this report does not name. Widen with BURN_SCAN_BLOCKS.`)
  } else {
    console.log(`  → logs exceed the balance, which should be impossible. Investigate`)
    console.log(`    before quoting either figure.`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
