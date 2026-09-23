/**
 * When did BEM start sitting at 0xdead, and did Tosh put it there?
 *
 *   node scripts/bemDeadTrace.mjs
 *
 * WHY THIS IS A SEPARATE INVESTIGATION. `burnReport.mjs` found 1,824 BEM at the
 * dead address and flagged it, because no Tosh code path can produce it: the only
 * `vault.take(..., DEAD_ADDRESS, ...)` calls in `src/` pass `key.currency1`, the
 * PROJECT token, in both the hook's sell tax and the treasury's buyback. BEM is
 * always `currency0`. So either the reading is a coincidence with a raise of a
 * similar size, or something outside this repo is burning BEM.
 *
 * The cheap way to tell them apart is not a log scan over BEM's whole history —
 * the free endpoints will not serve it — but a handful of ARCHIVE BALANCE READS.
 * `balanceOf(0xdead)` at a block before the launch either already holds the
 * figure or it does not, and that single fact decides whether a Tosh transaction
 * could be responsible at all.
 */
import { ethers } from 'ethers'

import { candidateRpcs, BSC_CHAIN_ID } from './lib/bscProvider.mjs'
import { QUOTE_ASSET, QUOTE_DECIMALS, DEAD_ADDRESS, ERC20_ABI, fmt } from './dashboard/config.mjs'

/** The block ToshFactory was created in, from broadcast/DeployMainnet.s.sol/56. */
const DEPLOY_BLOCK = 123171457

const bem = (v) => `${fmt(v, QUOTE_DECIMALS, 4)} BEM`

/**
 * An archive read, tried across endpoints.
 *
 * Separate from `withFallback` because the failure being routed around is
 * specific: `publicnode` serves the head happily and answers any historical
 * state with `-32602 Archive requests require a personal token`. A helper that
 * retried on any error would keep asking the one node that structurally cannot
 * answer.
 */
async function balanceAt(block) {
  const failures = []
  for (const url of candidateRpcs()) {
    try {
      const p = new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, {
        staticNetwork: true, batchMaxCount: 1,
      })
      const c = new ethers.Contract(QUOTE_ASSET, ERC20_ABI, p)
      return { value: await c.balanceOf(DEAD_ADDRESS, { blockTag: block }), url }
    } catch (e) {
      failures.push(`${url}: ${(e.shortMessage || e.message).slice(0, 70)}`)
    }
  }
  return { error: failures }
}

async function main() {
  const head = await (async () => {
    for (const url of candidateRpcs()) {
      try {
        const p = new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 })
        return await p.getBlockNumber()
      } catch { /* next */ }
    }
    throw new Error('no endpoint answered getBlockNumber')
  })()

  console.log(`BEM ${QUOTE_ASSET} · balanceOf(0xdead) back through time`)
  console.log(`head ${head} · factory deployed at ${DEPLOY_BLOCK} (${head - DEPLOY_BLOCK} blocks ago)\n`)

  // ~3s blocks on BSC. Chosen to bracket the launch (≈23h ago) on both sides and
  // to reach back before the factory existed, which is the decisive sample: BEM
  // at 0xdead BEFORE Tosh was deployed cannot have been put there by Tosh.
  const samples = [
    ['now',                 head],
    ['~6h ago',             head - 7_200],
    ['~12h ago',            head - 14_400],
    ['~24h ago',            head - 28_800],
    ['~36h ago',            head - 43_200],
    ['~3d ago',             head - 86_400],
    ['~7d ago',             head - 201_600],
    ['factory deploy',      DEPLOY_BLOCK],
    ['1 block pre-factory', DEPLOY_BLOCK - 1],
  ]

  let archiveWorked = false
  for (const [label, block] of samples) {
    if (block < 0) continue
    const r = await balanceAt(block)
    if (r.error) {
      console.log(`  ${label.padEnd(20)} block ${block}   unreadable on every endpoint`)
      continue
    }
    archiveWorked = true
    console.log(`  ${label.padEnd(20)} block ${block}   ${bem(r.value)}`)
  }

  if (!archiveWorked) {
    console.log(`\nNo endpoint served historical state. Put an archive URL in BSC_RPC`)
    console.log(`and re-run; the head reading alone cannot attribute the balance.`)
    return
  }

  console.log(`\nReading it: if the figure is already non-zero at "1 block pre-factory",`)
  console.log(`no Tosh transaction can be responsible — BEM burns its own supply and`)
  console.log(`the resemblance to a raise total is a coincidence. If it JUMPS around`)
  console.log(`the launch instead, that is a real finding and the launch tx needs`)
  console.log(`reading transfer by transfer.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
