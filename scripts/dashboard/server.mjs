#!/usr/bin/env node
/**
 * The local dashboard.
 *
 *   node scripts/dashboard/server.mjs
 *   → http://127.0.0.1:7391
 *
 * WHY LOCAL ONLY, AND WHY THAT IS ENFORCED RATHER THAN DOCUMENTED
 *
 * This process holds an Etherscan key, an Upstash token that can read the
 * production store, and possibly a paid RPC URL. It binds to `127.0.0.1` so
 * that nothing outside this machine can reach it — not `0.0.0.0`, which on a
 * laptop on a café network means the café. There is no flag to change that,
 * because the only reason to want one is the reason not to have one. If this
 * ever needs to be shared, it should be a deployed read-only app with its own
 * auth, not this.
 *
 * Environment (each missing one costs its panels, not the page):
 *   ETHERSCAN_API_KEY            every on-chain event count
 *   UPSTASH_REDIS_REST_URL       scan volume, live PoG floor, credit gauge
 *   UPSTASH_REDIS_REST_TOKEN
 *   BSC_RPC                      optional paid endpoint for contract reads
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { connect } from '../lib/bscProvider.mjs'
import {
  collectLaunches, collectFunnel, collectPools, collectBurn,
  collectMoney, collectConfig, collectInfra, readBand, factoryFromBlock,
} from './collect.mjs'
import { render } from './view.mjs'

const PORT = Number(process.env.DASHBOARD_PORT || 7391)
const HOST = '127.0.0.1'

/**
 * How long a collected snapshot is reused.
 *
 * Not a performance tweak — a budget one. A full pass is roughly a dozen
 * Etherscan calls, and the page auto-refreshes, so serving live data on every
 * request would turn one open browser tab into a steady drain on the same API
 * quota the production scan path depends on. The refresh interval and this TTL
 * are deliberately equal: the page never displays anything older than it says
 * it is, and never fetches more often than it displays.
 */
const CACHE_MS = Number(process.env.DASHBOARD_CACHE_MS || 60_000)
const REFRESH_SECONDS = Math.round(CACHE_MS / 1000)

/**
 * Load `.env.local` from the frontend if the shell has not already provided
 * these.
 *
 * Convenience with a hard rule: an existing environment variable always wins,
 * so a file cannot quietly override something set deliberately. Only the four
 * keys this tool uses are read — the file holds a signing key too, and there is
 * no reason for this process to have it in memory.
 */
function loadLocalEnv() {
  const path = new URL('../../soat-frontend/.env.local', import.meta.url)
  if (!existsSync(path)) return
  const wanted = new Set([
    'ETHERSCAN_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'BSC_RPC',
  ])
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const [, k, rawV] = m
    if (!wanted.has(k) || process.env[k]) continue
    const v = rawV.trim().replace(/^["']|["']$/g, '')
    if (v && v !== '[SENSITIVE]') process.env[k] = v
  }
}

let cache = { at: 0, html: null }

async function collectAll() {
  const started = Date.now()
  const { provider, url, blockNumber, paid } = await connect()

  const fromBlock = factoryFromBlock()
  const band = await readBand()
  const ctx = {
    provider, head: blockNumber, fromBlock, band,
    apiKey: process.env.ETHERSCAN_API_KEY,
  }

  // Launches first: three panels need the project list, and refetching it per
  // panel would triple the paid calls for the same answer.
  const launchResult = await collectLaunches(ctx)
  const launches = launchResult.ok ? launchResult.launches : []

  // Sequential rather than parallel. Etherscan rate-limits per key, and a
  // burst of a dozen concurrent calls is the reliable way to get throttled
  // into a panel of errors that look like missing data.
  const funnel = await collectFunnel(ctx)
  const burn = await collectBurn(ctx, launches)
  const config = await collectConfig(ctx)
  const money = await collectMoney(ctx, launches)
  const infra = await collectInfra(ctx)
  const pools = await collectPools(ctx, launches)

  if (!launchResult.ok) {
    // Without the project list the per-project panels have nothing to iterate,
    // so say why once rather than leaving three panels mysteriously empty.
    for (const p of [burn, money]) if (p.ok) p.note = launchResult.error
  }

  return render({
    meta: {
      head: blockNumber, fromBlock, rpc: url, paidRpc: paid,
      elapsedMs: Date.now() - started,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z',
      refreshSeconds: REFRESH_SECONDS,
    },
    funnel, pools, burn, money, config, infra,
  })
}

loadLocalEnv()

const present = (k) => (process.env[k] ? '有' : '缺失')
console.log(`\n  Tosh 本地看板`)
console.log(`  ETHERSCAN_API_KEY         ${present('ETHERSCAN_API_KEY')}`)
console.log(`  UPSTASH_REDIS_REST_URL    ${present('UPSTASH_REDIS_REST_URL')}`)
console.log(`  UPSTASH_REDIS_REST_TOKEN  ${present('UPSTASH_REDIS_REST_TOKEN')}`)
console.log(`  BSC_RPC                   ${present('BSC_RPC')}`)

createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return }

  const fresh = Date.now() - cache.at < CACHE_MS
  if (req.url === '/refresh') { cache = { at: 0, html: null } }

  try {
    if (!fresh || !cache.html) {
      cache = { at: Date.now(), html: await collectAll() }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(cache.html)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<pre style="color:#f85149;background:#0d1117;padding:20px;font:13px monospace">`
      + `采集失败\n\n${String(e.stack || e.message)}</pre>`)
  }
}).listen(PORT, HOST, () => {
  console.log(`\n  → http://${HOST}:${PORT}`)
  console.log(`  缓存 ${REFRESH_SECONDS}s（省 Etherscan 额度）· /refresh 强制刷新\n`)
})
