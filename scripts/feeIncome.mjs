/**
 * Where platform fee income sits, and how much of it is there.
 *
 * ⚠ THE WORD "FEE" NAMES FOUR DIFFERENT FLOWS IN THIS SYSTEM, AND THREE OF THEM
 *   ARE NOT INCOME. Reading a single balance and calling it revenue is wrong in
 *   both directions, so this script separates them by destination:
 *
 *     0.30 % of every buy's BEM input  -> platformTreasury   INCOME
 *     launchFee, 0.005 BNB per launch  -> platformTreasury   INCOME
 *     0.70 % of every buy's BEM input  -> ladderTreasury     buyback fuel, spent
 *     1.00 % of every sell, in token   -> 0x…dEaD            burned, gone
 *     Phase-2 shelf cut, orphan refs   -> ladderTreasury     buyback fuel, spent
 *
 *   `ToshLaunchpadHook._skimInputTax` is the authority for the first four:
 *   `TAX_BPS` is 100 and `PLATFORM_SWAP_FEE_BPS` is 30 CARVED OUT OF IT, not
 *   added on top, and the sell leg is `vault.take(currency1, DEAD_ADDRESS, tax)`
 *   rather than a transfer to anyone.
 *
 * ⚠ A BALANCE IS NOT A TOTAL. Whatever has been withdrawn from the fee address
 *   is income that was earned and is no longer in the balance, so the balance is
 *   a FLOOR on lifetime income, never the figure itself. The cumulative total
 *   needs the event log — `PlatformSwapFeePaid` and `LaunchFeeForwarded` — which
 *   needs ETHERSCAN_API_KEY, because no free BSC endpoint serves historical
 *   `eth_getLogs` (see `scripts/pogFunnel.mjs` for that finding). Without the
 *   key this prints the balances and says plainly that it cannot tell you
 *   whether anything left, rather than presenting a floor as a total.
 */
import { readFileSync } from 'node:fs'

import { ethers } from 'ethers'

import { connect, withFallback } from './lib/bscProvider.mjs'
import { fetchLogs, deploymentBlock, LogSourceUnavailable } from './lib/etherscanLogs.mjs'
import {
  FACTORY, LADDER_TREASURY, QUOTE_ASSET, QUOTE_DECIMALS, TOKEN_DECIMALS,
  FACTORY_ABI, ERC20_ABI, fmt, topicAddress,
} from './dashboard/config.mjs'

/** Not in the shared config because only this script reads the pool directly. */
const FACTORY_HOOK_ABI = ['function tokenToHook(address) view returns (address)']
const LADDER_ABI = [
  'function ladderTokenCount() view returns (uint256)',
  'function ladderTokens(uint256) view returns (address)',
]
const HOOK_POOL_ABI = [
  'function getPoolKey() view returns (tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters))',
]
/**
 * ⚠ SIX FIELDS IN THE POOL KEY, NOT FIVE. PancakeSwap Infinity adds
 *   `poolManager` to the V4 tuple, and the poolId is the hash of the whole
 *   struct — so a V4-shaped 5-field encoding produces a syntactically valid hash
 *   for a pool that does not exist, and every read below returns a confident
 *   zero instead of failing.
 */
const SAFE_ABI = [
  'function VERSION() view returns (string)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function nonce() view returns (uint256)',
]
const POOL_MANAGER_ABI = [
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32) view returns (uint128)',
  'function getFeeGrowthGlobals(bytes32) view returns (uint256, uint256)',
  'function getPosition(bytes32, address, int24, int24, bytes32) view returns (tuple(uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128))',
]

/**
 * Foundry's own record of the mainnet deploy, which is where the factory's
 * deployment block comes from. See `deploymentBlock` for why this is read from
 * disk rather than found by bisecting `getCode` against a live node.
 */
const BROADCAST = new URL('../broadcast/DeployMainnet.s.sol/56/run-latest.json', import.meta.url)

/** From the contracts, so the arithmetic below is checkable against source. */
const TAX_BPS = 100n
const PLATFORM_SWAP_FEE_BPS = 30n

const TOPICS = {
  PlatformSwapFeePaid: ethers.id('PlatformSwapFeePaid(address,uint256)'),
  LaunchFeeForwarded: ethers.id('LaunchFeeForwarded(uint256)'),
  LaunchCreated: ethers.id('LaunchCreated(uint256,address,address,address,string,string)'),
}

const bnb = (v) => `${fmt(v, 18, 6)} BNB`
const bem = (v) => `${fmt(v, QUOTE_DECIMALS, 4)} BEM`

async function main() {
  const { provider, url, blockNumber } = await connect()
  console.log(`chain 56 · block ${blockNumber} · ${url}\n`)

  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider)

  const [treasury, launchFee] = await Promise.all([
    factory.platformTreasury(),
    factory.launchFee(),
  ])

  console.log('── FEE ADDRESS ' + '─'.repeat(48))
  console.log(`  platformTreasury   ${treasury}`)
  console.log(`  ladderTreasury     ${LADDER_TREASURY}   (buyback fuel, NOT income)`)
  console.log(`  launchFee now      ${bnb(launchFee)} per launch`)

  // Is it an EOA or a contract? Decides whether "withdraw" even means anything,
  // and whether a balance here is spendable by a key or by code.
  const code = await withFallback((p) => p.getCode(treasury))
  console.log(`  address type       ${code === '0x' ? 'EOA (key-controlled)' : `contract (${(code.length - 2) / 2} bytes)`}`)
  await describeSafe(treasury, code)

  console.log('\n── BALANCE HELD RIGHT NOW ' + '─'.repeat(37))
  const quote = new ethers.Contract(QUOTE_ASSET, ERC20_ABI, provider)
  const [nativeBal, quoteBal] = await Promise.all([
    withFallback((p) => p.getBalance(treasury)),
    withFallback((p) => new ethers.Contract(QUOTE_ASSET, ERC20_ABI, p).balanceOf(treasury)),
  ])
  console.log(`  BNB   ${bnb(nativeBal)}   <- launch fees`)
  console.log(`  BEM   ${bem(quoteBal)}   <- 0.30% of buy volume`)

  // Context, so the two numbers above can be read against the pot they were
  // carved from rather than in isolation.
  const reservoirBal = await withFallback((p) =>
    new ethers.Contract(QUOTE_ASSET, ERC20_ABI, p).balanceOf(LADDER_TREASURY))
  console.log(`\n  for contrast, ladderTreasury holds ${bem(reservoirBal)} of BEM`)
  console.log('  it takes 0.70% of the same buys, so ~2.33x the platform cut,')
  console.log('  and it SPENDS that on buyback+burn rather than banking it.')

  await stranded()
  await cumulative(blockNumber, quoteBal, nativeBal)
}

/**
 * The 0.30 % POOL_FEE credited to the genesis position, which nobody can collect.
 *
 * ⚠ THIS IS NOT INCOME AND IT IS NOT RECOVERABLE. It is counted here because
 *   "how much fee have we earned" has a third answer that neither treasury
 *   balance shows, and because the figure is the same order of magnitude as the
 *   banked total — large enough that leaving it out of a revenue picture makes
 *   the picture wrong.
 *
 *   Infinity credits swap fees to the LP POSITION and realises them only when
 *   the position owner calls `modifyLiquidity`. The genesis position's owner is
 *   the hook (V4 keys positions to `msg.sender`), and the hook's `unlockCallback`
 *   decodes exactly one action, `ACTION_ADD_LIQUIDITY`, reverting `UnknownAction`
 *   on anything else — which `launch()` uses once and nothing calls again. So
 *   there is no caller, and no calldata, that reaches this position. The header
 *   of ToshLaunchpadHook describes v4.x having this exact defect and v5.0 fixing
 *   it by opening the pool to third-party LPs; that made the fee collectable for
 *   THEM, and the genesis position still holds 99.8 % of the liquidity.
 *
 * Full range is what makes the arithmetic exact rather than an estimate.
 * `feeGrowthInside = feeGrowthGlobal - outside(lower) - outside(upper)`, and both
 * bounds were initialised while `feeGrowthGlobal` was zero and are never crossed
 * (±887200 is the aligned tick extreme), so both outside terms stay zero and
 * inside == global. No tick-crossing history needs reconstructing.
 */
async function stranded() {
  console.log('\n── LP FEE STRANDED IN THE GENESIS POSITION ' + '─'.repeat(21))
  // Through `withFallback` rather than on a provider handed in: this is a chain
  // of eight dependent reads, and a socket dropped on the fifth has to restart
  // the whole chain on another endpoint rather than abort the report.
  await withFallback(strandedOn)
}

async function strandedOn(provider) {
  const treasury = new ethers.Contract(LADDER_TREASURY, LADDER_ABI, provider)
  const factory = new ethers.Contract(FACTORY, [...FACTORY_ABI, ...FACTORY_HOOK_ABI], provider)
  const count = Number(await treasury.ladderTokenCount())
  if (count === 0) {
    console.log('  no launched project yet, so no pool and nothing accrued')
    return
  }

  for (let i = 0; i < count; i++) {
    const token = await treasury.ladderTokens(i)
    const hook = await factory.tokenToHook(token)
    const symbol = await new ethers.Contract(token, ERC20_ABI, provider).symbol()
    const key = await new ethers.Contract(hook, HOOK_POOL_ABI, provider).getPoolKey()

    const poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'address', 'address', 'uint24', 'bytes32'],
      [key.currency0, key.currency1, key.hooks, key.poolManager, key.fee, key.parameters],
    ))

    const pm = new ethers.Contract(key.poolManager, POOL_MANAGER_ABI, provider)
    const [slot0, totalLiq, growth, pos] = await Promise.all([
      pm.getSlot0(poolId),
      pm.getLiquidity(poolId),
      pm.getFeeGrowthGlobals(poolId),
      // `internal constant` in the hook, so unreadable on-chain; pinned to
      // ToshLaunchpadHook.sol:555-556. A wrong pair here reads as a position
      // that does not exist — zero liquidity — rather than as an error, which is
      // why the liquidity share is printed below as a check on it.
      pm.getPosition(poolId, hook, -887200, 887200, ethers.ZeroHash),
    ])

    const L = pos[0]
    const owed0 = (L * (growth[0] - pos[1])) >> 128n
    const owed1 = (L * (growth[1] - pos[2])) >> 128n
    // Raw token1 priced into raw token0 at spot: price = (sqrtP / 2^96)^2 of
    // currency1 per currency0, so dividing by it converts the other way.
    const owed1AsQuote = (owed1 << 192n) / (slot0[0] * slot0[0])
    const share = Number((L * 10_000n) / totalLiq) / 100

    console.log(`  ${symbol}  pool ${poolId.slice(0, 18)}…  lpFee ${Number(slot0[3]) / 10_000}%`)
    console.log(`    genesis position holds ${share.toFixed(2)}% of all liquidity`)
    console.log(`    accrued, uncollectable:  ${bem(owed0)}`)
    console.log(`                             ${fmt(owed1, TOKEN_DECIMALS, 2)} ${symbol}  ≈ ${bem(owed1AsQuote)} at spot`)
    console.log(`    total                    ≈ ${bem(owed0 + owed1AsQuote)} of value`)
    if (pos[1] === 0n && pos[2] === 0n) {
      console.log('    feeGrowthInsideLast is still 0 on both sides — this position has')
      console.log('    never been settled once since it was created.')
    }
  }
}

/**
 * Who can actually move the money, and whether any has moved.
 *
 * Worth more than it looks. A fee address that is a contract raises the question
 * of whether the balance is spendable at all — the LP fee below is an example of
 * value that is not — and the answer here is yes: this is a Safe proxy, so the
 * owners can move it with `threshold` signatures.
 *
 * `nonce` is the load-bearing field. It counts EXECUTED Safe transactions, so a
 * zero would prove no outflow has ever happened and make the balance equal to
 * lifetime income with no log scan at all. Non-zero does not prove a withdrawal
 * — owner changes spend nonces too — but it does forbid the shortcut, which is
 * why it is read before any total is claimed.
 */
async function describeSafe(address, code) {
  // The Safe 1.x proxy is ~171 bytes and dispatches `masterCopy()` (0xa619486e)
  // before delegating. Matching on the selector rather than on the length keeps
  // this from firing on some other small contract of the same size.
  if (!code.includes('a619486e')) return

  const safe = new ethers.Contract(address, SAFE_ABI, null)
  try {
    const [version, threshold, owners, nonce] = await withFallback(async (p) => {
      const c = safe.connect(p)
      return Promise.all([c.VERSION(), c.getThreshold(), c.getOwners(), c.nonce()])
    })
    console.log(`  it is a Gnosis Safe ${version} · ${threshold}-of-${owners.length}`)
    for (const o of owners) console.log(`    owner  ${o}`)
    console.log(`  Safe nonce         ${nonce}  ${nonce === 0n
      ? '(nothing has ever been executed, so nothing has left)'
      : '(transactions have executed — outflows cannot be ruled out here)'}`)
  } catch (e) {
    console.log(`  (looks like a Safe proxy, but its fields did not read: ${e.shortMessage || e.message})`)
  }
}

/**
 * Lifetime income from the event log.
 *
 * Summed per event rather than inferred from balances, because that is the only
 * way to separate "never earned" from "earned and moved". The two are the same
 * balance and a very different business.
 */
async function cumulative(toBlock, quoteBal, nativeBal) {
  console.log('\n── LIFETIME INCOME ' + '─'.repeat(44))

  // Checked before the broadcast file is read, not after. `fetchLogs` would
  // raise the same error on a missing key, but only once `deploymentBlock` had
  // already required a file the no-key path has no use for — which would report
  // "run the deploy script" to someone whose only problem is an unset variable.
  const apiKey = process.env.ETHERSCAN_API_KEY
  if (!apiKey) {
    unavailable()
    return
  }

  const fromBlock = deploymentBlock(
    JSON.parse(readFileSync(BROADCAST, 'utf8')),
    FACTORY,
  )

  try {
    // Launches first, because `PlatformSwapFeePaid` is emitted by each HOOK and
    // Etherscan's log endpoint requires an address — so the set of hooks has to
    // be known before the fee events can be asked for at all.
    const launches = await fetchLogs({
      apiKey, address: FACTORY, topic0: TOPICS.LaunchCreated, fromBlock, toBlock,
    })
    // `hook` is the third indexed field, so topic3. Deduped: one hook could in
    // principle appear twice if a launch were ever re-emitted, and double
    // counting fee events is exactly the error this report must not make.
    const hooks = [...new Set(launches.map((l) => topicAddress(l.topics[3])))]

    const launchFees = await fetchLogs({
      apiKey, address: FACTORY, topic0: TOPICS.LaunchFeeForwarded, fromBlock, toBlock,
    })

    let swapTotal = 0n
    let swapCount = 0
    const perHook = []
    for (const hook of hooks) {
      const logs = await fetchLogs({
        apiKey, address: hook, topic0: TOPICS.PlatformSwapFeePaid, fromBlock, toBlock,
      })
      const total = logs.reduce((a, l) => a + BigInt(l.data), 0n)
      swapTotal += total
      swapCount += logs.length
      perHook.push({ hook, total, count: logs.length })
    }

    // `amount`/`nativeAmount` is the sole unindexed field on both events, so
    // `data` is exactly one word and needs no decoder.
    const launchTotal = launchFees.reduce((a, l) => a + BigInt(l.data), 0n)

    console.log(`  BEM from swaps    ${bem(swapTotal)}   over ${swapCount} taxed buys`)
    console.log(`  BNB from launches ${bnb(launchTotal)}   over ${launches.length} launches`)

    if (perHook.length > 1) {
      console.log('\n  by project:')
      for (const h of perHook.sort((a, b) => (b.total > a.total ? 1 : -1))) {
        console.log(`    ${h.hook}  ${bem(h.total).padStart(20)}  ${h.count} buys`)
      }
    }

    // Implied volume, as a sanity check on the swap figure: the cut is a fixed
    // 30 bps of input, so dividing back out must land near the real buy volume.
    // A wild answer here means the event set is incomplete, not that the
    // platform earned oddly.
    if (swapTotal > 0n) {
      const impliedBuys = (swapTotal * 10_000n) / PLATFORM_SWAP_FEE_BPS
      console.log(`\n  implied taxed buy volume ${bem(impliedBuys)}`)
      console.log(`  of which the reservoir took ${bem(impliedBuys * (TAX_BPS - PLATFORM_SWAP_FEE_BPS) / 10_000n)}`)
    }

    console.log('\n── EARNED vs STILL HELD ' + '─'.repeat(39))
    report('BEM', swapTotal, quoteBal, bem)
    report('BNB', launchTotal, nativeBal, bnb)
  } catch (e) {
    if (e instanceof LogSourceUnavailable) {
      console.log(`  UNAVAILABLE — ${e.message}`)
      unavailable()
      return
    }
    throw e
  }
}

function unavailable() {
  console.log('  UNKNOWN — needs ETHERSCAN_API_KEY.')
  console.log('  No free BSC endpoint serves historical eth_getLogs, so without')
  console.log('  the key this script cannot tell "never earned" from "earned and')
  console.log('  withdrawn". The balances above are a FLOOR on lifetime income,')
  console.log('  not the total — the fee Safe has a non-zero nonce, so it has')
  console.log('  executed transactions and outflows cannot be ruled out.')
  console.log('\n    $env:ETHERSCAN_API_KEY="…"; node scripts/feeIncome.mjs')
}

function report(label, earned, held, format) {
  if (earned === 0n) {
    console.log(`  ${label}  nothing has ever been collected`)
    return
  }
  const moved = earned > held ? earned - held : 0n
  const pct = Number((held * 10_000n) / earned) / 100
  console.log(`  ${label}  earned ${format(earned)} · still here ${format(held)} (${pct.toFixed(1)}%)`)
  if (moved > 0n) console.log(`        ${format(moved)} has been moved out`)
  // Strictly more than earned means income arrived by a route this script does
  // not model — a direct transfer, or a fee pipe added since it was written.
  if (held > earned) {
    console.log(`        ⚠ holds MORE than the events account for: ${format(held - earned)}`)
    console.log('          something funds this address outside the two known pipes.')
  }
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1) })
