/**
 * Every burn of a launched project's token, reconciled against the dead address.
 *
 *   node scripts/burnLedger.mjs [SYMBOL|0xtoken]     # defaults to TO
 *
 * WHY THIS EXISTS ALONGSIDE burnReport.mjs. That script counts the hook's and the
 * treasury's own events — `SellTaxBurned`, `BuybackBurned` — which is the right
 * way to attribute burns to a CHANNEL, but it can only see burns those channels
 * announce, and its first run reconciled 19,480 tokens of events against 232,308
 * actually sitting at 0xdead. A 92% gap is not a rounding difference, and the
 * honest reading of it is that the event set is not the whole story.
 *
 * So this comes at it from the other end. `Transfer(from, 0xdead, value)` on the
 * token is the ledger the ERC-20 balance is DERIVED from, so its sum is the dead
 * balance by construction — any shortfall is a scanning failure and is reported
 * as one, never absorbed. Grouping the transfers by `from` then says who burned,
 * which is what identifies an unannounced channel: a sender that is neither the
 * hook nor the treasury is a burn this protocol's events do not describe.
 */
import { ethers } from 'ethers'

import { withFallback } from './lib/bscProvider.mjs'
import { logHead, scanBack, MAX_LOG_SPAN } from './lib/logScan.mjs'
import {
  FACTORY, ERC20_ABI, LADDER_TREASURY,
  QUOTE_ASSET, QUOTE_DECIMALS, DEAD_ADDRESS, fmt,
} from './dashboard/config.mjs'

/** ToshFactory's creation block, from broadcast/DeployMainnet.s.sol/56. No token predates it. */
const DEPLOY_BLOCK = 123171457

/** Not in the shared config's FACTORY_ABI, which covers admin reads only. */
const ENUMERATE_ABI = [
  'function launchCount() view returns (uint256)',
  'function launches(uint256) view returns (address token, address hook, address creator, uint256 createdAt)',
]
/** `vault()` is the whole reason this script exists — see the POOL RESERVES note. */
const VAULT_ABI = ['function vault() view returns (address)']

const TRANSFER = ethers.id('Transfer(address,address,uint256)')
const pad = (a) => ethers.zeroPadValue(ethers.getAddress(a), 32)

async function resolve(want) {
  return withFallback(async (p) => {
    const f = new ethers.Contract(FACTORY, ENUMERATE_ABI, p)
    const n = Number(await f.launchCount())
    for (let i = 0; i < n; i++) {
      const l = await f.launches(i)
      const token = new ethers.Contract(l.token, ERC20_ABI, p)
      const symbol = await token.symbol()
      const hit = want.startsWith('0x')
        ? l.token.toLowerCase() === want.toLowerCase()
        : symbol.toUpperCase() === want.toUpperCase()
      if (!hit) continue
      return {
        index: i, symbol, token: l.token, hook: l.hook,
        decimals: Number(await token.decimals()),
        vault: await new ethers.Contract(l.hook, VAULT_ABI, p).vault(),
      }
    }
    throw new Error(`no launch matches ${want}`)
  })
}

async function main() {
  const want = process.argv[2] ?? 'TO'
  const P = await resolve(want)
  const head = await logHead()

  const tok = (v) => fmt(v, P.decimals, 4)
  const bem = (v) => `${fmt(v, QUOTE_DECIMALS, 4)} BEM`

  const [deadTok, supply, vaultBem, vaultTok] = await withFallback(async (p) => {
    const t = new ethers.Contract(P.token, ERC20_ABI, p)
    const q = new ethers.Contract(QUOTE_ASSET, ERC20_ABI, p)
    return [await t.balanceOf(DEAD_ADDRESS), await t.totalSupply(), await q.balanceOf(P.vault), await t.balanceOf(P.vault)]
  })

  console.log(`$${P.symbol} · launch #${P.index} · ${P.token}`)
  console.log(`  hook    ${P.hook}`)
  console.log(`  vault   ${P.vault}   (the Infinity Vault, which is where pool funds actually sit)`)
  console.log(`\nSUPPLY`)
  console.log(`  total supply        ${tok(supply)} ${P.symbol}`)
  console.log(`  burned at 0xdead    ${tok(deadTok)} ${P.symbol}   ${(Number(deadTok) / Number(supply) * 100).toFixed(4)}% of supply`)
  console.log(`\nPOOL RESERVES (in the Vault)`)
  console.log(`  ${bem(vaultBem)}`)
  console.log(`  ${tok(vaultTok)} ${P.symbol}`)

  // ── the ledger ────────────────────────────────────────────────────────────
  // Newest-first, stopping the moment the running sum reaches the dead balance.
  // That equality is the proof of completeness; without it the per-sender split
  // below is a lower bound and says so.
  console.log(`\nscanning Transfer(→0xdead) back from ${head} in ${MAX_LOG_SPAN}-block windows…`)

  const bySender = new Map()
  const rows = []
  let sum = 0n
  let windows = 0
  let failed = 0

  for await (const w of scanBack({
    address: P.token, topics: [TRANSFER, null, pad(DEAD_ADDRESS)],
    fromBlock: DEPLOY_BLOCK, toBlock: head,
  })) {
    windows++
    if (w.failed) { failed++; continue }
    for (const log of w.logs) {
      const from = ethers.getAddress(ethers.dataSlice(log.topics[1], 12))
      const value = BigInt(log.data)
      sum += value
      bySender.set(from, (bySender.get(from) ?? 0n) + value)
      rows.push({ from, value, block: log.blockNumber, tx: log.transactionHash })
    }
    if (sum >= deadTok) break
    if (windows % 20 === 0) process.stdout.write(`  …${w.from} · ${tok(sum)} of ${tok(deadTok)} found\n`)
  }

  const complete = sum === deadTok
  console.log(`  ${windows} windows read${failed ? `, ${failed} unreadable` : ''} · ${rows.length} burns · ${tok(sum)} ${P.symbol}`)
  console.log(complete
    ? `  RECONCILED — the sum equals balanceOf(0xdead) exactly, so nothing is missing.`
    : `  INCOMPLETE — ${tok(deadTok - sum)} ${P.symbol} of burns were not found. Treat the split below as a floor.`)

  // ── who burned ────────────────────────────────────────────────────────────
  const label = (a) => {
    if (a.toLowerCase() === P.hook.toLowerCase()) return 'the hook (sell tax, 1.0% of token-side input)'
    if (a.toLowerCase() === LADDER_TREASURY.toLowerCase()) return 'the ladder treasury (buy-and-burn)'
    if (a.toLowerCase() === P.vault.toLowerCase()) return 'the Infinity Vault (a take() by hook or treasury)'
    if (a === ethers.ZeroAddress) return 'the zero address (a mint straight to dead)'
    return 'NOT A TOSH CONTRACT — unannounced burn'
  }

  console.log(`\nWHO BURNED`)
  for (const [from, value] of [...bySender].sort((a, b) => (b[1] > a[1] ? 1 : -1))) {
    const share = sum > 0n ? (Number(value) / Number(sum) * 100).toFixed(2) : '—'
    console.log(`  ${tok(value).padStart(16)} ${P.symbol}  ${share.padStart(6)}%  ${from}`)
    console.log(`  ${''.padStart(16)}                  ${label(from)}`)
  }

  // ── which channel ─────────────────────────────────────────────────────────
  // The Vault is the sender for both of the protocol's burns, so "who" cannot
  // separate them and the hook's and treasury's own events have to. Scanned over
  // exactly the span the transfers covered, so the two sums are comparable to the
  // reconciled total rather than to each other alone.
  const oldest = rows.reduce((a, r) => Math.min(a, r.block), head)
  console.log(`\nWHICH CHANNEL (events, blocks ${oldest}–${head})`)

  // `cost` is what the channel consumed in BEM to destroy those tokens, and it is
  // zero for the sell tax by design: that burn is skimmed out of the trader's own
  // token-side input, so it costs the protocol nothing. The buyback's cost is the
  // only place BEM leaves the treasury, and reporting it next to the tokens burned
  // is the honest way to show the trade — BEM is not destroyed there either, it is
  // pushed into the pool as reserves in exchange for tokens that are.
  const channels = [
    ['sell tax  ', P.hook, 'SellTaxBurned(uint256)',
      (d) => ({ burned: BigInt(d), cost: 0n })],
    ['buy & burn', LADDER_TREASURY, 'BuybackBurned(address,uint256,uint256)',
      (d) => {
        const [nativeIn, burned] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], d)
        return { burned, cost: nativeIn }
      }],
  ]

  let channelSum = 0n
  for (const [name, address, sig, decode] of channels) {
    let total = 0n
    let spent = 0n
    let count = 0
    let lost = 0
    for await (const w of scanBack({
      address, topics: [ethers.id(sig)], fromBlock: oldest, toBlock: head,
    })) {
      if (w.failed) { lost++; continue }
      for (const log of w.logs) {
        const { burned, cost } = decode(log.data)
        total += burned; spent += cost; count++
      }
    }
    channelSum += total
    const price = spent > 0n && total > 0n
      ? `  ·  ${bem(spent)} spent, ${fmt(spent * 10n ** BigInt(P.decimals) / total, QUOTE_DECIMALS, 8)} BEM per token`
      : spent === 0n ? '  ·  costs no BEM' : ''
    console.log(`  ${name}  ${tok(total).padStart(16)} ${P.symbol}  over ${count} event${count === 1 ? '' : 's'}${lost ? ` (${lost} windows unreadable)` : ''}${price}`)
  }

  const residual = sum - channelSum
  console.log(`  ${''.padEnd(10)}  ${tok(residual).padStart(16)} ${P.symbol}  unattributed`)
  console.log(residual === 0n
    ? `  Both channels account for the whole burn.`
    : `  ${(Number(residual) / Number(sum) * 100).toFixed(2)}% of the burn is not covered by either event.`)

  console.log(`\nLARGEST SINGLE BURNS`)
  for (const r of [...rows].sort((a, b) => (b.value > a.value ? 1 : -1)).slice(0, 8)) {
    console.log(`  ${tok(r.value).padStart(16)} ${P.symbol}  block ${r.block}  ${r.tx}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
