#!/usr/bin/env node
/**
 * checkBlockscoutKey.mjs — does the PRO API actually serve the five chains the
 * Proof-of-Gas scan needs, and does the key work?
 * ─────────────────────────────────────────────────────────────────────────────
 * PM-F9. Written before a key existed, because the migration it gates is only
 * safe if a specific claim is true, and that claim is currently taken on the
 * vendor's word:
 *
 *   Robinhood Chain (4663) is in the Blockscout multichain registry, therefore
 *   the PRO API can read it, therefore we can drop five per-instance hosts, two
 *   API dialects, and the Cloudflare `User-Agent` workaround.
 *
 * "In the registry" was verified — the chain is listed with a name and an
 * explorer. "The PRO API serves it, on the endpoints we need, with the fields we
 * need" was not, and cannot be without a key. If it turns out 4663 is listed but
 * not served, the migration is off and the per-instance path stays; that is a
 * two-line answer this script exists to produce rather than discover halfway
 * through a refactor.
 *
 * The fields matter as much as the chains. The scan needs, per chain:
 *   · outbound transactions only, filterable server-side or cheaply locally
 *   · a fee figure that includes the OP-stack L1 data fee where one exists,
 *     which on the per-instance path only v2's `fee.value` provided
 *
 * So this checks the data, not just the HTTP status. A 200 carrying a shape we
 * cannot sum is a failure, and the point of running this first is that it says so
 * in one place instead of in production.
 *
 * Usage:
 *   BLOCKSCOUT_API_KEY=... node scripts/checkBlockscoutKey.mjs
 *   BLOCKSCOUT_API_KEY=... node scripts/checkBlockscoutKey.mjs --address 0x...
 *
 * Exit codes:  0 all five chains usable · 1 something is not · 2 no key given
 */

const KEY = process.env.BLOCKSCOUT_API_KEY ?? ''
const PRO = 'https://api.blockscout.com'

/** Mirrors `GAS_SCAN_CHAINS` in soat-frontend/src/app/lib/gasHistory.ts.
 *  `execFeeIsWholeFee: false` marks the OP-stack chains, where `gasUsed *
 *  gasPrice` omits the L1 data fee — the reason a fee field is checked at all. */
const CHAINS = [
  { name: 'Ethereum', chainId: 1,     execFeeIsWholeFee: true  },
  { name: 'Arbitrum', chainId: 42161, execFeeIsWholeFee: true  },
  { name: 'Optimism', chainId: 10,    execFeeIsWholeFee: false },
  { name: 'Base',     chainId: 8453,  execFeeIsWholeFee: false },
  { name: 'Robinhood', chainId: 4663, execFeeIsWholeFee: true  },
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
  console.error('✗ BLOCKSCOUT_API_KEY is not set.')
  console.error('')
  console.error('  Get one at https://dev.blockscout.com — free tier is 5 req/s and')
  console.error('  100k credits/day; Builder ($49/mo) is 15 req/s and 100M credits/mo.')
  console.error('  Without a key the public instances cap Arbitrum and Base at ten')
  console.error('  requests per ~40 min, which caps the launch at ~10 wallets/hour.')
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

/** v1, Etherscan-compatible. What four of five chains use today. */
async function checkV1(chain) {
  const r = await call(keyed(
    `/v2/api?chain_id=${chain.chainId}&module=account&action=txlist`
    + `&address=${PROBE_ADDRESS}&page=1&offset=5&sort=desc`,
  ))
  if (r.status !== 200) {
    return { ok: false, detail: `HTTP ${r.status}${r.reason ? ` (${r.reason})` : ''}` }
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

/** v2. The only path that carried an L1-inclusive `fee.value` per-instance, so
 *  it is required on the OP-stack chains and preferred everywhere. */
async function checkV2(chain) {
  const r = await call(keyed(
    `/v2/${chain.chainId}/addresses/${PROBE_ADDRESS}/transactions?filter=from`,
  ))
  if (r.status !== 200) {
    return { ok: false, detail: `HTTP ${r.status}${r.reason ? ` (${r.reason})` : ''}` }
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

  // A chain is usable if either dialect answers with summable rows. It is
  // *fully* usable only if the fee figure is complete, which on OP-stack means
  // v2 — v1 there omits the L1 data fee and silently under-counts.
  const usable = v1.ok || v2.ok
  const feeComplete = chain.execFeeIsWholeFee ? usable : v2.ok

  results.push({ chain: chain.name, chainId: chain.chainId, usable, feeComplete, v1, v2 })

  const mark = !usable ? '✗' : feeComplete ? '✓' : '!'
  console.log(`${mark} ${chain.name.padEnd(10)} (${String(chain.chainId).padStart(5)})`)
  console.log(`    v1 ${v1.ok ? 'ok ' : 'NO '} ${v1.detail}`)
  console.log(`    v2 ${v2.ok ? 'ok ' : 'NO '} ${v2.detail}`)
  if (usable && !feeComplete) {
    console.log('    ! OP-stack chain without v2: L1 data fees would be uncounted')
  }
  console.log('')
}

console.log('─'.repeat(72))
console.log(`rate limit : ${rateLimitSeen ?? 'not reported'} req/s`)
console.log(`credits    : ${creditsSeen ?? 'not reported'} remaining`)
console.log('')

const unusable = results.filter(r => !r.usable)
const incomplete = results.filter(r => r.usable && !r.feeComplete)
const robinhood = results.find(r => r.chainId === 4663)

if (unusable.length === 0 && incomplete.length === 0) {
  console.log('✓ All five chains readable with complete fee figures.')
  console.log('  The PRO API migration is viable: one host, one key, chain_id per')
  console.log('  chain, and the Cloudflare User-Agent workaround can go.')
  process.exit(0)
}

console.log('✗ Not all five chains are usable as the scan needs them.')
for (const r of unusable) {
  console.log(`  · ${r.chain} (${r.chainId}) unreadable — v1: ${r.v1.detail}; v2: ${r.v2.detail}`)
}
for (const r of incomplete) {
  console.log(`  · ${r.chain} (${r.chainId}) readable but v2 is missing, so L1 data fees`)
  console.log('    would be dropped. Under-counts only, but decide it rather than inherit it.')
}
if (robinhood && !robinhood.usable) {
  console.log('')
  console.log('  Robinhood 4663 is the one that decides the migration. Listed in the')
  console.log('  chains registry but not served here means: keep the per-instance path,')
  console.log('  keep the browser User-Agent, and use the key only to raise limits on')
  console.log('  the other four. That is a smaller change and still worth making.')
}
process.exit(1)
