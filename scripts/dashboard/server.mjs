#!/usr/bin/env node
/**
 * The local dashboard for ToshX v2.
 *
 *   node scripts/dashboard/server.mjs
 *   → http://127.0.0.1:7391
 *
 * WHY LOCAL ONLY, AND WHY THAT IS ENFORCED RATHER THAN DOCUMENTED
 *
 * This process may hold a paid RPC URL, which is a credential. It binds to
 * `127.0.0.1` so that nothing outside this machine can reach it — not
 * `0.0.0.0`, which on a laptop on a café network means the café. There is no
 * flag to change that, because the only reason to want one is the reason not to
 * have one. If this ever needs to be shared, it should be a deployed read-only
 * app with its own auth, not this.
 *
 * Environment:
 *   BSC_RPC     optional paid endpoint, tried before the public ones
 *
 * Nothing else. Every number on the page is a view call or an event log on
 * chain 56; v1's Etherscan and Upstash panels left with PoG.
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { connect } from '../lib/bscProvider.mjs'
import { collectPlatform, collectLaunches, collectActivity, collectInfra } from './collect.mjs'
import { render } from './view.mjs'

const PORT = Number(process.env.DASHBOARD_PORT || 7391)
const HOST = '127.0.0.1'

/**
 * How long a collected snapshot is reused.
 *
 * A full pass is a few dozen view calls plus an incremental log sync, against
 * public endpoints that rate-limit. The refresh interval and this TTL are equal
 * on purpose: the page never shows anything older than it says it is, and
 * never fetches more often than it displays.
 */
const CACHE_MS = Number(process.env.DASHBOARD_CACHE_MS || 60_000)
const REFRESH_SECONDS = Math.round(CACHE_MS / 1000)

/**
 * Take `BSC_RPC` from the frontend's `.env.local` if the shell has not set it.
 *
 * An existing environment variable always wins, and nothing else is read from
 * the file: it holds server secrets this process has no use for.
 */
function loadLocalEnv() {
  const path = new URL('../../soat-frontend/.env.local', import.meta.url)
  if (!existsSync(path) || process.env.BSC_RPC) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*BSC_RPC\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const v = m[1].trim().replace(/^["']|["']$/g, '')
    if (v && v !== '[SENSITIVE]') process.env.BSC_RPC = v
  }
}

let cache = { at: 0, html: null }

async function collectAll() {
  const started = Date.now()
  const { provider, url, blockNumber, paid } = await connect()
  const block = await provider.getBlock(blockNumber)
  const ctx = { provider, url, paid, head: blockNumber, headTs: Number(block.timestamp) }

  // Sequential rather than parallel: public endpoints throttle bursts, and a
  // throttled burst reads as a page of errors that look like missing data.
  const platform = await collectPlatform(ctx)
  const launches = await collectLaunches(ctx)
  const activity = await collectActivity(ctx)
  const infra = await collectInfra(ctx)

  return render({
    meta: {
      head: blockNumber, headTs: ctx.headTs, rpc: url, paidRpc: paid,
      elapsedMs: Date.now() - started,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z',
      refreshSeconds: REFRESH_SECONDS,
    },
    platform, launches, activity, infra,
  })
}

loadLocalEnv()

console.log('\n  ToshX v2 本地看板')
console.log(`  BSC_RPC  ${process.env.BSC_RPC ? '有（优先使用）' : '未设置，使用公共节点'}`)

createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return }
  if (req.url === '/refresh') {
    cache = { at: 0, html: null }
    res.writeHead(303, { location: '/' }).end()
    return
  }

  try {
    if (Date.now() - cache.at >= CACHE_MS || !cache.html) {
      cache = { at: Date.now(), html: await collectAll() }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(cache.html)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<pre style="color:#f85149;background:#0d1117;padding:20px;font:13px monospace">'
      + `采集失败\n\n${String(e.stack || e.message).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))}</pre>`)
  }
}).listen(PORT, HOST, () => {
  console.log(`\n  → http://${HOST}:${PORT}`)
  console.log(`  缓存 ${REFRESH_SECONDS}s · /refresh 强制刷新\n`)
})
