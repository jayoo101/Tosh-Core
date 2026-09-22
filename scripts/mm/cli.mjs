#!/usr/bin/env node
/**
 * Command line for the market-making tool.
 *
 * Read-only commands run with nothing but `MM_RPC_URL`. Anything that can move
 * money additionally needs `MM_PRIVATE_KEY` and an explicit `--execute`; see
 * `config.mjs` for the reasoning behind that split.
 */

import { ethers } from 'ethers'
import { loadPool, verifyInfrastructure, readBalances, provider } from './pool.mjs'
import { quoteLeg, spotPrice, roundTripCost, fmt } from './quote.mjs'
import { QUOTE_DECIMALS, TOKEN_DECIMALS, SAFETY, CHAIN_ID } from './config.mjs'

function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      out.flags[k] = v === undefined ? true : v
    } else out._.push(a)
  }
  return out
}

const USAGE = `
tosh market maker

  verify  --hook=0x…              check pinned addresses and pool wiring
  quote   --hook=0x… --buy=25     what 25 BEM buys, and at what cost
          --hook=0x… --sell=1000  what selling 1000 tokens returns

Environment
  MM_RPC_URL       required, chain ${CHAIN_ID}
  MM_PRIVATE_KEY   required only for commands that send
`

function requireHook(flags) {
  const hook = flags.hook
  if (!hook || !ethers.isAddress(hook)) throw new Error('--hook=0x… is required')
  return ethers.getAddress(hook)
}

async function cmdVerify(flags) {
  const prov = provider()
  const infra = await verifyInfrastructure(prov)
  console.log(`\nInfrastructure on chain ${CHAIN_ID}`)
  for (const [name, v] of Object.entries(infra)) {
    console.log(`  ${name.padEnd(18)} ${v.address}  ${v.bytes} bytes`)
  }

  const pool = await loadPool(requireHook(flags), prov)
  console.log(`\nPool ${pool.id}`)
  console.log(`  quote  (currency0) ${pool.quote}`)
  console.log(`  token  (currency1) ${pool.token}`)
  console.log(`  fee / spacing      ${pool.key.fee} / ${Number((BigInt(pool.key.parameters) >> 16n) & 0xffffffn)}`)
  console.log(`  bitmap             ${pool.bitmap}`)
  console.log(`  sqrtPriceX96       ${pool.sqrtPriceX96}`)
  console.log(`  tick               ${pool.tick}`)
  console.log(`  lpFee / protocol   ${pool.lpFee} / ${pool.protocolFee}`)
  console.log(`  liquidity          ${pool.liquidity}`)
  console.log(`  spot               ${spotPrice(pool).toPrecision(6)} quote per token`)
  console.log('\nAll pinned addresses and the published PoolKey agree.\n')
}

async function cmdQuote(flags) {
  const pool = await loadPool(requireHook(flags))
  const side = flags.buy !== undefined ? 'buy' : 'sell'
  const raw = flags.buy !== undefined ? flags.buy : flags.sell
  if (raw === undefined || raw === true) throw new Error('pass --buy=<BEM> or --sell=<tokens>')

  const decIn = side === 'buy' ? QUOTE_DECIMALS : TOKEN_DECIMALS
  const decOut = side === 'buy' ? TOKEN_DECIMALS : QUOTE_DECIMALS
  const amountIn = ethers.parseUnits(String(raw), decIn)

  const q = quoteLeg(pool, amountIn, side)
  const spot = spotPrice(pool)

  console.log(`\n${side === 'buy' ? 'Buy' : 'Sell'} quote`)
  console.log(`  spot                 ${spot.toPrecision(6)} quote per token`)
  console.log(`  amount in            ${fmt(amountIn, decIn)}`)
  console.log(`  hook tax (1%)       -${fmt(q.hookTax, decIn)}`)
  console.log(`  pool fee             ${(Number(q.swapFeePips) / 10_000).toFixed(4)}%   (${pool.lpFee} lp + ${Number(BigInt(pool.protocolFee) & 0xfffn)} protocol pips, composed)`)
  console.log(`  reaches the curve    ${fmt(q.effectiveIn, decIn)}`)
  console.log(`  expected out         ${fmt(q.amountOut, decOut)}`)
  console.log(`  min out (${Number(SAFETY.slippageBps) / 100}% slip)   ${fmt(q.minOut, decOut)}`)
  console.log(`  price impact         ${(q.impact * 100).toFixed(4)}%`)

  // Only meaningful for a buy: it asks what a full round trip costs, and the
  // round trip starts by spending the quote asset.
  if (side === 'buy') {
    const rt = roundTripCost(pool, amountIn)
    console.log(`\n  Round trip at this size`)
    console.log(`    spend              ${fmt(rt.spent, QUOTE_DECIMALS)}`)
    console.log(`    get back           ${fmt(rt.recovered, QUOTE_DECIMALS)}`)
    console.log(`    cost               ${(rt.lossFraction * 100).toFixed(3)}%  (two 1% hook taxes, two ${(Number(q.swapFeePips) / 10_000).toFixed(4)}% pool fees, plus impact)`)
  }

  if (flags.owner && ethers.isAddress(flags.owner)) {
    const b = await readBalances(pool, ethers.getAddress(flags.owner))
    console.log(`\n  Wallet ${flags.owner}`)
    console.log(`    ${b.quote.symbol.padEnd(8)} ${fmt(b.quote.balance, b.quote.decimals)}`)
    console.log(`    ${b.token.symbol.padEnd(8)} ${fmt(b.token.balance, b.token.decimals)}`)
  }
  console.log()
}

const COMMANDS = { verify: cmdVerify, quote: cmdQuote }

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2))
  const cmd = _[0]
  if (!cmd || flags.help || !COMMANDS[cmd]) {
    console.log(USAGE)
    process.exit(cmd && !COMMANDS[cmd] ? 1 : 0)
  }
  await COMMANDS[cmd](flags)
}

main().catch((e) => {
  console.error(`\n  ✗ ${e.message}\n`)
  process.exit(1)
})
