/**
 * The delivery half of PM-E2: turns `watch.mjs` findings into GitHub Issues.
 *
 * `watch.mjs` deliberately stops at stdout — "a pager wired to a monitor that
 * mis-detects is worse than no pager", and detection had to be right first.
 * Detection has now been rehearsed (ONCHAIN_MONITORING.md §7.2), so this is the
 * sink. It is a separate process rather than a flag on the watcher for the same
 * reason the watcher is run-once: the command CI runs is the command a human
 * can run, and a delivery bug cannot take detection down with it.
 *
 * ── Deduplication is the whole problem ──────────────────────────────────────
 *
 * Findings come in two shapes and they need opposite treatment.
 *
 * An EVENT finding is a discrete historical fact with a transaction hash. It is
 * filed once and never again, because the block it happened in does not change.
 *
 * A STATE finding is a claim about right now, re-evaluated every pass. A
 * factory whose owner is wrong is wrong on every run until someone fixes it. If
 * each pass filed an issue, a single unresolved P0 would produce one issue per
 * cycle forever — and §6's noise budget is spent by exactly that, with the P0s
 * getting muted alongside the noise. So state findings are keyed on the
 * SITUATION, not the reading: while an issue for that key is open, later passes
 * observing the same situation add nothing.
 *
 * Nothing here ever closes an issue. A check that stops firing is not evidence
 * the condition cleared — it is equally consistent with the check breaking, the
 * RPC lying, or the contract being replaced. Closing is a human act.
 *
 * Usage:
 *   node monitoring/report.mjs findings.jsonl          file the paging findings
 *   node monitoring/report.mjs findings.jsonl --dry    print, touch nothing
 *
 *   GITHUB_TOKEN     required unless --dry. Locally: $(gh auth token)
 *   GITHUB_REPOSITORY  owner/name. Locally: defaults to jayoo101/Tosh-Core
 *   WATCH_RUN_URL    optional link back to the Actions run
 */

import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const FILE = argv.find(a => !a.startsWith('--'))
const REPO = process.env.GITHUB_REPOSITORY || 'jayoo101/Tosh-Core'
const TOKEN = process.env.GITHUB_TOKEN
const RUN_URL = process.env.WATCH_RUN_URL || ''

if (!FILE) {
  console.error('usage: node monitoring/report.mjs <findings.jsonl> [--dry]')
  process.exit(2)
}
if (!TOKEN && !DRY) {
  console.error('GITHUB_TOKEN is unset. Locally: GITHUB_TOKEN=$(gh auth token) node monitoring/report.mjs …')
  process.exit(2)
}

/* An issue storm is its own outage. If the watcher loses its checkpoint it
 * rescans up to MONITOR_MAX_SPAN and every event in that window arrives as
 * "new" — during the 46630 rehearsal that was 11 alerts over 900k blocks, and
 * on a busy mainnet it would be far more. Past this many, one issue is filed
 * saying so, because a hundred notifications and no notifications land on a
 * human the same way. */
const STORM_THRESHOLD = 20

const findings = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter(l => l.trim())
  .map(l => {
    try { return JSON.parse(l) } catch { return null }
  })
  .filter(Boolean)

const paging = findings.filter(f => f.page === true)

if (paging.length === 0) {
  console.log(`no paging findings among ${findings.length} finding(s) — nothing to file`)
  process.exit(0)
}

/**
 * The dedup key. `tx` is present exactly on event findings and absent on state
 * checks, which is the same line the two shapes fall on above.
 *
 * State findings are discriminated by the first address in their message, so
 * STATE-01 on two different hooks is two situations while STATE-01 on the same
 * hook is one. Numbers are deliberately NOT part of the key: STATE-02 reports a
 * balance, and keying on it would file a fresh issue every time the balance
 * moved, which is the every-cycle repetition this exists to prevent.
 */
function dedupKey(f) {
  if (f.tx) return `${f.id}:${f.tx}`
  const addr = f.message.match(/0x[0-9a-fA-F]{40}/)
  return `${f.id}:${addr ? addr[0].toLowerCase() : 'singleton'}`
}

const marker = key => `<!-- watch-key: ${key} -->`

// ── GitHub ───────────────────────────────────────────────────────────────────

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

/* Every open watcher issue, read once. Listing beats the search API, which lags
 * by tens of seconds and is not worth the query syntax here.
 *
 * Listing is NOT immediately consistent either — measured, after asserting the
 * opposite in an earlier draft of this comment. Two passes run seconds apart
 * both saw an empty list and both filed, producing exactly the duplicate set
 * this function exists to prevent; a third pass minutes later suppressed all
 * four correctly. So the guarantee is "consistent within a minute or so", not
 * "consistent".
 *
 * That is fine for the scheduler, whose cadence is measured in tens of minutes,
 * and it is why a manual `workflow_dispatch` fired immediately after a
 * scheduled run can double-file. The concurrency group serialises overlapping
 * runs but does nothing about back-to-back ones. Duplicates are cheap to close;
 * the alternative is caching filed keys in the state branch, which coupled the
 * sink to the checkpoint for a problem that only appears when a human is
 * already watching the run. */
async function openKeys() {
  const keys = new Map()
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(`/repos/${REPO}/issues?state=open&labels=watcher&per_page=100&page=${page}`)
    for (const issue of batch) {
      const m = (issue.body || '').match(/<!-- watch-key: (.+?) -->/)
      if (m) keys.set(m[1], issue.number)
    }
    if (batch.length < 100) break
  }
  return keys
}

async function ensureLabels(names) {
  const existing = new Set(
    (await gh(`/repos/${REPO}/labels?per_page=100`)).map(l => l.name))
  const colors = { watcher: '0e8a16', P0: 'b60205', P1: 'd93f0b', P2: 'fbca04' }
  for (const name of names) {
    if (existing.has(name)) continue
    await gh(`/repos/${REPO}/labels`, {
      method: 'POST',
      body: JSON.stringify({ name, color: colors[name] || 'ededed' }),
    })
    console.log(`  created label ${name}`)
  }
}

function body(f, key) {
  const lines = [
    `**${f.id}** · severity **${f.severity}**`,
    '',
    f.message,
    '',
  ]
  if (f.block) lines.push(`- block \`${f.block}\``)
  if (f.tx) lines.push(`- tx \`${f.tx}\``)
  if (f.playbook) lines.push(`- playbook: \`${f.playbook}\``)
  if (f.correlate) {
    lines.push('- **correlate before acting.** A governance or pause event that',
      '  matches a Safe transaction you recognise is routine; one that does not',
      '  is the incident this alert exists for.')
  }
  if (RUN_URL) lines.push(`- [watcher run](${RUN_URL})`)
  lines.push(
    '',
    'Filed by `monitoring/report.mjs`. Nothing closes this automatically — a',
    'check going quiet is not evidence the condition cleared. Close it when you',
    'have established what happened.',
    '',
    marker(key))
  return lines.join('\n')
}

// ── File ─────────────────────────────────────────────────────────────────────

/* Wrapped, and exiting by `process.exitCode` rather than `process.exit()`.
 * Calling process.exit() with fetch's sockets still closing aborts node on
 * Windows with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and a
 * 0xC0000409 status — after printing the correct result. In CI that reads as a
 * failed delivery step on a delivery that succeeded, which is the worst way for
 * an alerting path to be wrong. */
async function main() {
  const seen = DRY ? new Map() : await openKeys()
  const fresh = []
  const suppressed = []

  for (const f of paging) {
    const key = dedupKey(f)
    if (seen.has(key)) suppressed.push({ f, key, issue: seen.get(key) })
    else {
      fresh.push({ f, key })
      seen.set(key, null) // two findings can share a key within one pass
    }
  }

  for (const { key, issue } of suppressed) {
    console.log(`  suppressed ${key} — already open as #${issue}`)
  }

  if (DRY) {
    for (const { f, key } of fresh) {
      console.log(`\n── would file: [${f.severity}] ${f.id} (${key})\n${body(f, key)}`)
    }
    console.log(`\n${fresh.length} would be filed, ${suppressed.length} suppressed`)
    return
  }

  if (fresh.length === 0) {
    console.log(`nothing new: all ${paging.length} paging finding(s) are already open`)
    return
  }

  if (fresh.length > STORM_THRESHOLD) {
    await ensureLabels(['watcher', 'P0'])
    const key = `STORM:${new Date().toISOString().slice(0, 13)}`
    const summary = fresh.map(({ f }) => `- **${f.id}** (${f.severity}) ${f.message}`).join('\n')
    const issue = await gh(`/repos/${REPO}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: `[P0] Watcher produced ${fresh.length} paging findings in one pass`,
        labels: ['watcher', 'P0'],
        body: [
          `${fresh.length} paging findings arrived in a single pass, over the ${STORM_THRESHOLD}`,
          'threshold, so they are summarised here instead of filed individually.',
          '',
          '**Read this as a claim about the watcher first, and the chain second.**',
          'The usual cause is a lost checkpoint: with no `lastBlock`, the watcher',
          'rescans up to `MONITOR_MAX_SPAN` and re-reports history as new. Check',
          'the run log for the scanned block range before treating these as live.',
          '',
          summary,
          '',
          RUN_URL ? `[watcher run](${RUN_URL})` : '',
          marker(key),
        ].join('\n'),
      }),
    })
    console.log(`  filed storm summary #${issue.number} for ${fresh.length} findings`)
    return
  }

  await ensureLabels(['watcher', ...new Set(fresh.map(({ f }) => f.severity))])

  for (const { f, key } of fresh) {
    const headline = f.message.length > 90 ? f.message.slice(0, 87) + '…' : f.message
    const issue = await gh(`/repos/${REPO}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: `[${f.severity}] ${f.id} — ${headline}`,
        labels: ['watcher', f.severity],
        body: body(f, key),
      }),
    })
    console.log(`  filed #${issue.number} [${f.severity}] ${f.id} (${key})`)
  }

  console.log(`\n${fresh.length} filed, ${suppressed.length} suppressed`)
}

await main().catch(err => {
  console.error(`delivery failed: ${err.message}`)
  process.exitCode = 1
})
