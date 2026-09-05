#!/usr/bin/env node
/**
 * checkBlockscoutKey.mjs — is this key usable by the Proof-of-Gas scan?
 * ─────────────────────────────────────────────────────────────────────────────
 * PM-F9. Run this against a key BEFORE it goes into production, and again after
 * every rotation. It answers, in one screen, the only question that matters: can
 * `gasHistory.ts` read all five chains through this key, on both dialects, with
 * the fields it sums.
 *
 * WHAT THIS ORIGINALLY EXISTED FOR, AND WHAT CHANGED
 *
 * It was written before any key existed, to decide whether the migration off the
 * five per-instance hosts was even possible. That hinged on one claim taken on
 * the vendor's word: that Robinhood Chain (4663), listed in the multichain
 * registry, is actually *served* by the PRO API. It is — checked with a live key
 * on 2026-09-05, on both dialects — so the migration happened and this script's
 * job changed from "decide" to "re-check", which is the job it keeps for as long
 * as the key can be rotated or the tier changed.
 *
 * Two URL shapes were guessed wrong in the first version and are now measured:
 *
 *     v1   https://api.blockscout.com/{chainId}/api?module=account&action=txlist
 *     v2   https://api.blockscout.com/{chainId}/api/v2/addresses/{a}/transactions
 *
 * The chain id is the FIRST PATH SEGMENT. It is not the `chain_id` query
 * parameter the docs describe, and it is not `/v2/{chainId}/…`; both of those
 * return 404 against this deployment. Anything that "tidies" these back toward
 * the documented form will break all five chains at once, which is why
 * `gasHistory.test.ts` asserts the shape as well.
 *
 * WHY BOTH DIALECTS ARE REQUIRED, NOT EITHER
 *
 * The scanner reads every chain probe-first: one v2 page with `filter=from`, and
 * only if a second page exists does it re-walk the chain through v1's 10,000-row
 * windows. So v2 failing costs the cheap exact path for light wallets, and v1
 * failing costs heavy senders their history entirely. Neither is a fallback for
 * the other, and a check that accepted "either one works" would pass a key that
 * silently breaks one half of the traffic.
 *
 * Usage:
 *   BLOCKSCOUT_API_KEY=... node scripts/checkBlockscoutKey.mjs
 *   BLOCKSCOUT_API_KEY=... node scripts/checkBlockscoutKey.mjs --address 0x...
 *
 * Exit codes:  0 key is usable on all five chains · 1 it is not · 2 no key given
 */

const KEY = process.env.BLOCKSCOUT_API_KEY ?? ''
const PRO = 'https://api.blockscout.com'

/** Mirrors `GAS_SCAN_CHAINS` in soat-frontend/src/app/lib/gasHistory.ts.
 *
 *  `execFeeIsWholeFee: false` marks the two chains where `gasUsed * gasPrice`
 *  omits the L1 data fee, so v1 under-counts there. Re-measured 2026-09-05 over
 *  50 transactions per chain against v2's authoritative `fee.value`: Optimism
 *  2.30 % low, Base 0.02 % low, and Ethereum, Arbitrum and Robinhood exact to the
 *  wei — the last two because Nitro bills L1 cost through an inflated `gasUsed`
 *  rather than a separate field. */
const CHAINS = [
  { name: 'Ethereum',  chainId: 1,     execFeeIsWholeFee: true  },
  { name: 'Arbitrum',  chainId: 42161, execFeeIsWholeFee: true  },
  { name: 'Optimism',  chainId: 10,    execFeeIsWholeFee: false },
  { name: 'Base',      chainId: 8453,  execFeeIsWholeFee: false },
  { name: 'Robinhood', chainId: 4663,  execFeeIsWholeFee: true  },
]

/** An address with history on several chains, so a 200 with an empty result can
 *  be told from a 200 that proves nothing. Overridable: this one will not stay
 *  busy forever, and a silent address would make every check vacuously pass. */
const argv = process.argv.slice(2)
const addrFlag = argv.indexOf('--address')
const PROBE_ADDRESS = addrFlag >= 0 && argv[addrFlag + 1]
  ? argv[addrFlag + 1]
  : '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' // vitalik.eth

if (!KEY) {
  console.error('BLOCKSCOUT_API_KEY is not set.')
  console.error('')
  console.error('  The scan cannot run at all without one: api.blockscout.com answers')
  console.error('  402 unkeyed, on every chain, so every scan fails rather than')
  console.error('  degrading. Get a key at https://dev.blockscout.com.')
  console.error('')
  console.error('  Measured tiers: free is 5 req/s and 100k credits/day, which at')
  console.error('  ~20 credits a call is ~5,000 calls/day — roughly 1,000 light or')
  console.error('  200 heavy wallets. Builder ($49/mo) is 15 req/s and 100M')
  console.error('  credits/month.')
  process.exit(2)
}

const results = []
let creditsSeen = null
let rateLimitSeen = null

async function call(url) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    const credits = res.headers.get('x-credits-remaining')
    const limit = res.headers.get('x-ratelimit-limit')
    if (credits !== null) creditsSeen = credits
    if (limit !== null) rateLimitSeen = limit
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text, ms: Date.now() - started }
  } catch (e) {
    return { status: 'ERR', reason: e?.message ?? String(e), ms: Date.now() - started }
  }
}

function keyed(path) {
  const sep = path.includes('?') ? '&' : '?'
  return `${PRO}${path}${sep}apikey=${encodeURIComponent(KEY)}`
}

/** Turn the two auth failures into the sentence that fixes them, rather than a
 *  bare status repeated five times. */
function explainStatus(status) {
  if (status === 402) return 'HTTP 402 — key not accepted for billing (is it active?)'
  if (status === 401) return 'HTTP 401 — key rejected (wrong or revoked)'
  if (status === 429) return 'HTTP 429 — rate limited; re-run in a moment'
  return `HTTP ${status}`
}

/** v1, Etherscan-compatible. The path the scanner takes for heavy senders, where
 *  one request covers 10,000 rows and page size costs nothing extra. */
async function checkV1(chain) {
  const r = await call(keyed(
    `/${chain.chainId}/api?module=account&action=txlist`
    + `&address=${PROBE_ADDRESS}&page=1&offset=5&sort=desc`,
  ))
  if (r.status !== 200) {
    return { ok: false, detail: r.reason ? `${r.status} (${r.reason})` : explainStatus(r.status) }
  }
  const rows = Array.isArray(r.json?.result) ? r.json.result : null
  if (!rows) {
    // status "0" with a message is how this API reports "no, and here is why".
    const why = r.json?.message ?? r.json?.result ?? r.text?.slice(0, 120)
    return { ok: false, detail: `no result array: ${String(why).slice(0, 120)}` }
  }
  if (rows.length === 0) return { ok: true, detail: 'empty (probe address idle here)', rows: 0 }

  const row = rows[0]
  const hasFee = row.gasUsed !== undefined && row.gasPrice !== undefined
  const hasFrom = row.from !== undefined
  if (!hasFee || !hasFrom) {
    return { ok: false, detail: `row lacks ${!hasFee ? 'gasUsed/gasPrice' : 'from'}` }
  }
  return { ok: true, detail: `${rows.length} rows, gasUsed+gasPrice+from present`, rows: rows.length }
}

/** v2. The probe every chain starts with, and the only figure that carries the
 *  OP-stack L1 data fee. */
async function checkV2(chain) {
  const r = await call(keyed(
    `/${chain.chainId}/api/v2/addresses/${PROBE_ADDRESS}/transactions?filter=from`,
  ))
  if (r.status !== 200) {
    return { ok: false, detail: r.reason ? `${r.status} (${r.reason})` : explainStatus(r.status) }
  }
  const items = Array.isArray(r.json?.items) ? r.json.items : null
  if (!items) return { ok: false, detail: 'no items array' }
  if (items.length === 0) return { ok: true, detail: 'empty (probe address idle here)', rows: 0 }

  const feeValue = items[0]?.fee?.value
  if (feeValue === undefined) {
    return {
      ok: false,
      detail: 'items present but fee.value missing — cannot count L1 data fees',
    }
  }
  return { ok: true, detail: `${items.length} items, fee.value present`, rows: items.length }
}

console.log(`Blockscout PRO API — probing ${PROBE_ADDRESS}`)
console.log('')

for (const chain of CHAINS) {
  const v1 = await checkV1(chain)
  const v2 = await checkV2(chain)

  // BOTH, not either. v2 is the probe every chain starts with; v1 is the only
  // way a heavy sender's history gets read at all. Accepting one would pass a key
  // that silently breaks half the traffic — see the header.
  const usable = v1.ok && v2.ok

  results.push({ chain: chain.name, chainId: chain.chainId, usable, v1, v2 })

  console.log(`${usable ? 'ok  ' : 'FAIL'} ${chain.name.padEnd(10)} (${String(chain.chainId).padStart(5)})`)
  console.log(`       v1 ${v1.ok ? 'ok ' : 'NO '} ${v1.detail}`)
  console.log(`       v2 ${v2.ok ? 'ok ' : 'NO '} ${v2.detail}`)
  if (!chain.execFeeIsWholeFee && v1.ok && !v2.ok) {
    console.log('       note: without v2 this chain would under-count L1 data fees')
  }
  console.log('')
}

console.log('-'.repeat(72))
console.log(`rate limit : ${rateLimitSeen ?? 'not reported'} req/s`)
console.log(`credits    : ${creditsSeen ?? 'not reported'} remaining`)
if (rateLimitSeen !== null) {
  // The tier is worth naming explicitly, because the capacity difference is 20x
  // and the only visible difference is this header.
  const tier = Number(rateLimitSeen) >= 15 ? 'Builder or above' : 'free'
  console.log(`tier       : ${tier} (free is 5 req/s, Builder is 15)`)
}
console.log('')

const broken = results.filter(r => !r.usable)

if (broken.length === 0) {
  console.log('All five chains readable on both dialects. This key is usable.')
  console.log('Set BLOCKSCOUT_API_KEY in the deployment environment.')
  process.exit(0)
}

console.log('This key is NOT usable by the scan as written.')
console.log('')
for (const r of broken) {
  console.log(`  ${r.chain} (${r.chainId})`)
  if (!r.v2.ok) console.log(`    v2 failed: ${r.v2.detail}`)
  if (!r.v1.ok) console.log(`    v1 failed: ${r.v1.detail}`)
}
console.log('')
console.log('  Every chain must succeed for a total to be a total, so the scan fails')
console.log('  closed on any of these rather than reporting a smaller wallet. Fix the')
console.log('  key or the tier before deploying; do not ship a partial scan.')
process.exit(1)
