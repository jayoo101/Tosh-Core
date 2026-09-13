/**
 * Diagnostic: is the shared rate-limit store actually reachable, and fast
 * enough to sit on the hot path?
 *
 * Not wired into `npm run guards`. CI has no Upstash credentials and should
 * not: the in-memory fallback is the correct configuration there. This is for
 * the one question a checklist row cannot answer from source — whether the
 * credentials someone just pasted work.
 *
 * It exercises the same REST call `rateLimitStore.ts` makes, rather than the
 * `@upstash/redis` SDK, because a diagnostic that takes a different path can
 * pass while the path in production fails. Same `/pipeline` endpoint, same
 * bearer header, same command shape.
 *
 * Latency is reported because it is not incidental here. `consumeRateLimit`
 * runs before every rate-limited handler, so this round trip is added to every
 * `/api/sign-allocation`, `/api/projects` and `/api/admin/config` request. A
 * database in the wrong region is not a slow database, it is a slow API.
 *
 * Usage:  node scripts/checkUpstash.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { CheckFailed, installFailureExit } from './lib/checkExit.mjs'

installFailureExit()

const ENV_FILE = '.env.local'
const KEY = `tosh:rl:diagnostic:${Date.now()}`
const WINDOW_MS = 10_000
const SAMPLES = 5

// ── Env ──────────────────────────────────────────────────────────────────────
// Same precedence Next applies: the ambient shell outranks the file, so this
// reports on the values the dev server would actually use.
function loadEnvFile(path) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (key in process.env) continue
    let value = trimmed.slice(eq + 1).trim()
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value)
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '')
    process.env[key] = value
  }
}

loadEnvFile(ENV_FILE)

const url = (process.env.UPSTASH_REDIS_REST_URL ?? '').replace(/\/+$/, '')
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? ''

/** Report and stop. Throws rather than exiting — see `lib/checkExit.mjs`. */
function fail(message, detail) {
  console.log(`\nFAIL  ${message}`)
  if (detail) console.log(detail)
  throw new CheckFailed(message)
}

if (!url || !token) {
  const missing = [
    !url && 'UPSTASH_REDIS_REST_URL',
    !token && 'UPSTASH_REDIS_REST_TOKEN',
  ].filter(Boolean).join(' and ')
  fail(
    `${missing} not set, so the limiter is per-instance.`,
    '      Counters then live in one process: N instances multiply every quota\n' +
    '      by N, and a deploy resets them. On serverless that is close to no\n' +
    '      limit at all — including on /api/sign-allocation.\n\n' +
    `      Create a database at console.upstash.com, then put both values in\n` +
    `      soat-frontend/${ENV_FILE} (REST API section, not the redis:// URL).`,
  )
}

if (!url.startsWith('https://')) {
  fail(`UPSTASH_REDIS_REST_URL is not https (${url}).`,
    '      The REST endpoint is an https URL. A `redis://` connection string\n' +
    '      belongs to the TCP protocol and this code path does not speak it.')
}

// ── The call the limiter makes ───────────────────────────────────────────────
async function pipeline(commands) {
  const started = performance.now()
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    cache: 'no-store',
  })
  const elapsed = performance.now() - started
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    fail(`upstash pipeline failed: ${res.status} ${res.statusText}`,
      res.status === 401
        ? '      401 means the token is wrong, or it is the read-only token.\n' +
          '      The limiter INCRs, so it needs a read/write token.'
        : `      ${text.slice(0, 300)}`)
  }
  return { body: await res.json(), elapsed }
}

console.log(`Endpoint  ${url}`)
console.log(`Token     ${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)\n`)

// 1. INCR twice and confirm the counter is shared and monotonic. This is the
//    whole point: an in-memory fallback would also return 1 and 2, but not to
//    a second process, which is the case that matters.
const first = await pipeline([['INCR', KEY], ['PEXPIRE', KEY, String(WINDOW_MS)]])
const second = await pipeline([['INCR', KEY], ['PEXPIRE', KEY, String(WINDOW_MS)]])

const a = first.body?.[0]?.result
const b = second.body?.[0]?.result
if (a !== 1 || b !== 2) {
  fail(`INCR did not count as expected (got ${JSON.stringify(a)} then ${JSON.stringify(b)}).`,
    '      The limiter reads result[0] of the pipeline and treats a non-number\n' +
    '      as an outage, so this shape matters as much as the connection.')
}
console.log(`INCR      1 → 2 on a shared key                          ok`)

// 2. The expiry has to be set, or a key created at the end of one window
//    outlives its usefulness and the quota never refills.
const ttl = (await pipeline([['PTTL', KEY]])).body?.[0]?.result
if (typeof ttl !== 'number' || ttl <= 0 || ttl > WINDOW_MS) {
  fail(`PEXPIRE did not set a sane TTL (PTTL returned ${JSON.stringify(ttl)}).`,
    '      Without it the window key never expires and the bucket never refills.')
}
console.log(`PEXPIRE   TTL ${ttl} ms of a ${WINDOW_MS} ms window                 ok`)

// 3. Latency. Every rate-limited request pays this.
const samples = []
for (let i = 0; i < SAMPLES; i++) {
  samples.push((await pipeline([['PTTL', KEY]])).elapsed)
}
samples.sort((x, y) => x - y)
const median = samples[Math.floor(samples.length / 2)]
const worst = samples[samples.length - 1]

console.log(`Latency   median ${median.toFixed(0)} ms, worst ${worst.toFixed(0)} ms over ${SAMPLES} calls`)

await pipeline([['DEL', KEY]])
console.log(`Cleanup   diagnostic key removed                         ok`)

console.log('\nShared rate limiting is live.')

// The latency number is measured from wherever this runs, which on a developer
// machine is not where the requests will come from. Reading it as a verdict on
// the database gets the sign backwards: a high number from a laptop in Asia
// against a us-east-1 database is what CORRECT provisioning looks like, and
// "fixing" it by moving the database to the laptop's region would put a
// cross-ocean hop in front of every production request instead.
//
// So this reports the measurement and says what would make it meaningful,
// rather than grading it.
console.log(
  `\nThat ${median.toFixed(0)} ms is from this machine, not from the deployment\n` +
  'region, and only the latter is on the hot path. Run this from the same\n' +
  'region the app is deployed to before reading it as a number that matters —\n' +
  'single-digit ms is what co-located looks like. A high reading here is\n' +
  'expected, and is what you want, when the database sits next to production\n' +
  'rather than next to you.',
)
