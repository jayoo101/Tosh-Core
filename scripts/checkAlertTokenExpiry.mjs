#!/usr/bin/env node
/**
 * Fails before ALERT_REPO_TOKEN can expire in silence.
 *
 * The PAT lives in a GitHub secret. GitHub exposes no API for a fine-grained
 * token's expiry, so the date is a hand-kept mirror in
 * `monitoring/alert-token-expires`. Rotate the PAT, then edit that file in the
 * same commit — a stale date fails early, which is loud, rather than late,
 * which is quiet.
 *
 * watch.yml already annotates this date. Until now it never changed its own
 * exit status, so a scheduled run stayed green through expiry and the next
 * filing 401 just stopped writing findings. This script is the half that turns
 * red: expired is always fatal; `--soon-is-fatal` also fails inside the
 * 21-day window so a push sees it before the cron does.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATE_FILE = resolve(ROOT, 'monitoring', 'alert-token-expires')
const SOON_DAYS = 21
const soonIsFatal = process.argv.includes('--soon-is-fatal')

const raw = readFileSync(DATE_FILE, 'utf8').trim()
if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
  console.error(`checkAlertTokenExpiry: ${DATE_FILE} is not YYYY-MM-DD: ${JSON.stringify(raw)}`)
  process.exit(2)
}

const expires = Date.parse(`${raw}T00:00:00Z`)
const left = Math.floor((expires - Date.now()) / 86_400_000)

const rotate =
  'Rotate the PAT on jayoo101/tosh-alerts (Issues: read and write, Metadata: read), ' +
  'update the ALERT_REPO_TOKEN secret, and write the new date to ' +
  'monitoring/alert-token-expires in the same commit.'

if (left < 0) {
  console.error(
    `ALERT_REPO_TOKEN expired ${-left} day(s) ago on ${raw}. ` +
      `Filing will 401 and the checkpoint will not advance. ${rotate}`,
  )
  process.exit(1)
}

if (left <= SOON_DAYS) {
  const msg =
    `ALERT_REPO_TOKEN expires in ${left} day(s) (${raw}). ${rotate}`
  if (soonIsFatal) {
    console.error(msg)
    process.exit(1)
  }
  console.log(`::warning title=ALERT_REPO_TOKEN expires in ${left} day(s)::${msg}`)
  process.exit(0)
}

console.log(`ALERT_REPO_TOKEN has ${left} day(s) left (expires ${raw}).`)
