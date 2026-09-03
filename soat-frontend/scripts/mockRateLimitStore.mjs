#!/usr/bin/env node
/*
 * mockRateLimitStore.mjs
 * ──────────────────────
 * A stand-in for the Upstash Redis REST pipeline API, so the shared rate-limit
 * backend in `src/app/lib/rateLimitStore.ts` can be exercised without an
 * account. PM-F5 in `docs/PRE_MAINNET_CHECKLIST.md`.
 *
 * This exists because the interesting states of a shared rate limiter are the
 * ones you cannot reach with the default config: the shared counter actually
 * answering, and the shared counter being down. Without something like this the
 * only path anyone ever runs is the in-memory fallback, which is the one path
 * that is NOT what production does.
 *
 * Usage
 * ─────
 *   # terminal 1
 *   node scripts/mockRateLimitStore.mjs
 *
 *   # terminal 2 — point the app at it, then trip a limit
 *   UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079 \
 *   UPSTASH_REDIS_REST_TOKEN=test-token \
 *     npm run dev
 *
 *   # 6 rapid POSTs; /api/sign-allocation allows 5 per 30 s
 *   for i in $(seq 1 6); do
 *     curl -s -o /dev/null -w '%{http_code}\n' -X POST \
 *       -H 'Content-Type: application/json' -d '{}' \
 *       http://localhost:3000/api/sign-allocation
 *   done
 *
 * What to look for:
 *   • The 6th request is 429, and this server logs the INCR reaching 6.
 *   • Kill this server and repeat: requests are still limited, but the 429
 *     carries `X-RateLimit-Backend: degraded-memory` — the documented
 *     fail-degraded behaviour, not fail-open and not fail-closed.
 *
 * Not for any real use: state is in a Map, there is no persistence, and the
 * token check is a string compare.
 */

import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 8079)
const TOKEN = process.env.MOCK_TOKEN ?? 'test-token'

const store = new Map()

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    if (req.url !== '/pipeline' || req.method !== 'POST') {
      res.writeHead(404).end('only POST /pipeline is implemented')
      return
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      console.log('[mock] rejected: bad or missing bearer token')
      res.writeHead(401).end('unauthorized')
      return
    }

    let commands
    try {
      commands = JSON.parse(body)
    } catch {
      res.writeHead(400).end('body is not JSON')
      return
    }

    const results = commands.map(([op, key, arg]) => {
      switch (op) {
        case 'INCR': {
          const n = (store.get(key) ?? 0) + 1
          store.set(key, n)
          return { result: n }
        }
        case 'PEXPIRE': {
          // unref so a pending TTL never holds the process open.
          setTimeout(() => store.delete(key), Number(arg)).unref()
          return { result: 1 }
        }
        default:
          return { error: `mock does not implement ${op}` }
      }
    })

    console.log(`[mock] ${JSON.stringify(commands)} -> ${JSON.stringify(results)}`)
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(results))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] rate-limit store listening on http://127.0.0.1:${PORT}`)
  console.log(`[mock] token: ${TOKEN}`)
})
