#!/usr/bin/env node
/**
 * Fails before a hand-kept PAT can expire in silence.
 *
 * GitHub exposes no API for a fine-grained token's expiry, so each date is a
 * mirror kept by hand under `monitoring/`. Rotate the PAT, then edit its date
 * file in the same commit — a stale date fails early, which is loud, rather
 * than late, which is quiet.
 *
 * Both tokens below fail the same way: quietly, and into a state that reads as
 * "nothing to report". Neither pages, because the thing that would page is
 * what stopped.
 *
 *   node scripts/checkTokenExpiry.mjs                    every token
 *   node scripts/checkTokenExpiry.mjs ALERT_REPO_TOKEN   one of them
 *   node scripts/checkTokenExpiry.mjs --soon-is-fatal    inside 21 days is red
 *
 * Expired is always fatal. `--soon-is-fatal` also fails inside the window, so
 * a push sees it before a cron does.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOON_DAYS = 21

const TOKENS = [
  {
    name: 'ALERT_REPO_TOKEN',
    file: 'alert-token-expires',
    consequence:
      'Filing will 401 and the checkpoint will deliberately stop advancing, so the '
      + 'next pass after a rotation rescans the window rather than skipping it.',
    rotate:
      'Rotate the PAT on jayoo101/tosh-alerts (Issues: read and write, Metadata: read), '
      + 'update the ALERT_REPO_TOKEN secret, and write the new date to '
      + 'monitoring/alert-token-expires in the same commit.',
  },
  {
    // Added 2026-09-14, the day this token's permissions were finally right.
    // Its lapse is the quieter of the two: findings still file, and the only
    // symptom is that passes get rarer — which is indistinguishable from a
    // quiet chain unless somebody is reading WATCHER-05's trigger names.
    name: 'WATCH_DISPATCH_TOKEN',
    file: 'watch-dispatch-token-expires',
    consequence:
      '/api/watch-ping will 502 and the cadence falls back to GitHub\'s own cron, '
      + 'which delivered 0.269 passes/hour no matter what interval it was asked for.',
    rotate:
      'Rotate the PAT on jayoo101/Tosh-Core (Contents: write, Metadata: read — Contents, '
      + 'because repository_dispatch is POST /repos/{o}/{r}/dispatches), re-add it as the '
      + 'Vercel Sensitive variable, REDEPLOY so the new value is baked into the running '
      + 'functions, and write the new date to monitoring/watch-dispatch-token-expires in '
      + 'the same commit.',
  },
]

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const soonIsFatal = process.argv.includes('--soon-is-fatal')

const selected = only.length ? TOKENS.filter((t) => only.includes(t.name)) : TOKENS
const unknown = only.filter((n) => !TOKENS.some((t) => t.name === n))
if (unknown.length) {
  console.error(`checkTokenExpiry: no such token: ${unknown.join(', ')}`)
  process.exit(2)
}

let failed = false

for (const token of selected) {
  const path = resolve(ROOT, 'monitoring', token.file)
  const raw = readFileSync(path, 'utf8').trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    console.error(`checkTokenExpiry: ${path} is not YYYY-MM-DD: ${JSON.stringify(raw)}`)
    process.exit(2)
  }

  const left = Math.floor((Date.parse(`${raw}T00:00:00Z`) - Date.now()) / 86_400_000)

  if (left < 0) {
    console.error(
      `${token.name} expired ${-left} day(s) ago on ${raw}. ${token.consequence} ${token.rotate}`,
    )
    failed = true
    continue
  }

  if (left <= SOON_DAYS) {
    const msg = `${token.name} expires in ${left} day(s) (${raw}). ${token.rotate}`
    if (soonIsFatal) {
      console.error(msg)
      failed = true
      continue
    }
    console.log(`::warning title=${token.name} expires in ${left} day(s)::${msg}`)
    continue
  }

  console.log(`${token.name} has ${left} day(s) left (expires ${raw}).`)
}

process.exit(failed ? 1 : 0)
