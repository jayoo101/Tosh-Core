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
 *   WATCH_ISSUE_REPO owner/name to file INTO, overriding GITHUB_REPOSITORY
 *   WATCH_RUN_URL    optional link back to the Actions run
 *   PAGER_TELEGRAM_TOKEN  bot token; with the next one, turns this into a pager
 *   PAGER_TELEGRAM_CHAT   chat id to push into
 */

import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const FILE = argv.find(a => !a.startsWith('--'))
/* Where findings are filed, which stopped being the same question as where the
 * code lives on 2026-09-11, when this repository went public. The issue tracker
 * went public with it — issues are not code and appear in no diff, so this is
 * easy to miss — and a watcher that files there is publishing the protocol's
 * live weak state to everyone at the moment it is weakest. STATE-07 is the
 * sharp case: it fires exactly during the window SECURITY_AUDIT.md §2.3 leaves
 * unbounded, and alerts.json is now public too, so the alert supplies the
 * timing and the repository supplies the method.
 *
 * `WATCH_ISSUE_REPO` takes precedence over `GITHUB_REPOSITORY`, which Actions
 * always sets to the running repository. Unset, behaviour is exactly what it
 * was, so a fork and a local `--dry` still work without configuration.
 *
 * Both the de-duplication read and the write use this, so they cannot drift
 * apart and start filing duplicates into one repository while reading another. */
const REPO = process.env.WATCH_ISSUE_REPO || process.env.GITHUB_REPOSITORY || 'jayoo101/Tosh-Core'
const TOKEN = process.env.GITHUB_TOKEN
const RUN_URL = process.env.WATCH_RUN_URL || ''

/* The push channel, which is the half of PM-E2 that filing issues never was.
 * `ONCHAIN_MONITORING.md` §7.3: "an issue is not a notification unless someone
 * has repository notifications on and reads them out of hours; a P0 filed at
 * 03:00 into an inbox nobody watches has been detected and not reported."
 *
 * Telegram rather than a paging vendor because `INCIDENT_RESPONSE.md` §1
 * already names Signal/Telegram as the incident channel, so this reaches the
 * signers where they have already agreed to be reached, and because it costs
 * nothing — a paid tier would be a standing bill against a protocol whose
 * reservoir is measured in hundredths of an ETH.
 *
 * Unset, this file behaves exactly as it did. It is NOT silent about being
 * unset, though: a pager nobody configured and a pager nobody can tell is
 * unconfigured are the same pager, so every non-dry pass says which it is. */
const TG_TOKEN = process.env.PAGER_TELEGRAM_TOKEN
const TG_CHAT = process.env.PAGER_TELEGRAM_CHAT
const PAGER_ON = Boolean(TG_TOKEN && TG_CHAT)

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
  if (!res.ok) {
    const detail = `${init.method || 'GET'} ${path} → ${res.status} ${await res.text()}`
    /* A private repository answers 404, not 403, to a token that cannot see
     * it, so "Not Found" here reads as "the sink is gone" when it almost
     * always means "the token cannot reach the sink". WATCH_ISSUE_REPO is
     * configured once and this is the error that configuring it wrong
     * produces, so spend three lines saying so rather than leaving the next
     * person to rediscover which of the two it was. */
    if (res.status === 404 && process.env.WATCH_ISSUE_REPO) {
      throw new Error(`${detail}\nWATCH_ISSUE_REPO is ${REPO}. Check that the token reaches it — ` +
        `a private repository returns 404 to a token without access, so this is far more likely ` +
        `to be an expired or wrongly scoped ALERT_REPO_TOKEN than a missing repository.`)
    }
    throw new Error(detail)
  }
  return res.status === 204 ? null : res.json()
}

/* Checked on every pass, and the quiet passes are the point. This script used
 * to return before its first API call whenever nothing paged — which is almost
 * every hour — so a sink it could not reach stayed green until the first
 * finding that actually mattered.
 *
 * A fine-grained PAT expires on a date nobody remembers. "The day
 * ALERT_REPO_TOKEN lapsed" and "the day of the first P0" are independent
 * events, and discovering the first one during the second is the entire
 * failure mode. One GET per hour buys a red job on the day it lapses instead.
 *
 * Only when the sink is overridden: on the default path the token is minted for
 * this repository by the run using it, so there is nothing for a request to
 * find out. */
async function assertSinkReachable() {
  await gh(`/repos/${REPO}`)
  console.log(`sink ${REPO} reachable`)
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
      if (!m) continue
      const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name))
      keys.set(m[1], {
        number: issue.number,
        title: issue.title,
        labels,
        createdAt: issue.created_at,
      })
    }
    if (batch.length < 100) break
  }
  return keys
}

/* Which open issues should page AGAIN on this pass.
 *
 * A pager that fires once and then goes quiet is the failure mode it exists to
 * prevent: the 03:00 P0 that woke nobody has still been detected and not
 * reported, and the second pass knows the situation is unresolved because
 * nothing here ever auto-closes. So an unresolved P0 keeps paging, hourly, for
 * as long as it stays unresolved.
 *
 * Acknowledgement therefore has to exist, or this is just a slower version of
 * the same uselessness. It is the issue itself, and it needs no new state:
 * close the issue, or add the `acked` label to it. Either says a human has the
 * situation, and both are one click from the notification that woke them.
 *
 * P0 only. A P1 that pages once is a reasonable trade against waking three
 * people every hour over a pause drill; the two severities that reach here at
 * P1 are SWITCH-01/02, which are pauses, which a human performed on purpose
 * almost every time. */
function needsRepaging(seen) {
  return [...seen.values()].filter(i =>
    i && i.labels?.includes('P0') && !i.labels.includes('acked'))
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

// ── Page ─────────────────────────────────────────────────────────────────────

/* Plain text, with no `parse_mode`.
 *
 * Markdown would render nicer and would also let an alert message containing an
 * underscore or a backtick fail the send with "can't parse entities" — turning
 * a formatting detail into a missed page. Alert text comes from
 * `alerts.json` and from chain data, so it is not under this file's control;
 * the pager has to be indifferent to what is in it. */
async function telegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
  })
  if (!res.ok) {
    /* Telegram's body names the reason precisely and the reasons are all
     * actionable: 401 is a revoked bot token, 400 "chat not found" is a chat id
     * that never existed or a bot that was removed from the group, 403 is a bot
     * the group blocked. Pass it through rather than summarising it. */
    throw new Error(`telegram sendMessage → ${res.status} ${await res.text()}`)
  }
}

/* Checked on every non-dry pass, for the reason `assertSinkReachable` is.
 *
 * That comment was written after shipping a sink whose credential was only
 * exercised when something paged, i.e. almost never, so "the day the token
 * lapsed" and "the day of the first P0" would have been discovered together.
 * A bot token is revocable from a phone, a bot can be removed from a group, and
 * a group can be deleted — all of which are quiet, and all of which produce a
 * pager that looks configured. Two GETs an hour buy a red job on the day it
 * breaks instead.
 *
 * `getChat` rather than only `getMe`: `getMe` proves the token, and a valid
 * token pointed at a chat the bot was kicked out of is the more likely of the
 * two failures. */
async function assertPagerReachable() {
  for (const [method, params] of [['getMe', ''], ['getChat', `?chat_id=${encodeURIComponent(TG_CHAT)}`]]) {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}${params}`)
    if (!res.ok) throw new Error(`telegram ${method} → ${res.status} ${await res.text()}`)
  }
  console.log('pager reachable (telegram bot and chat both answer)')
}

/* Called AFTER the issues exist, on purpose.
 *
 * The page is a pointer to the issue, so the issue has to be there when someone
 * taps it. And if this throws, the workflow's persist step already declines to
 * advance the checkpoint, so the next pass rescans the same window, dedupes
 * against the issues that were filed, files nothing, and pages again. A
 * delivery failure therefore retries without duplicating — which is the reason
 * filing and paging are ordered this way rather than combined. */
async function pageOut(fresh, repage) {
  if (!fresh.length && !repage.length) return

  if (!PAGER_ON) {
    console.log(`NO PAGER CONFIGURED: ${fresh.length} new and ${repage.length} unacknowledged P0 ` +
      `finding(s) were written down and nobody was woken. Set PAGER_TELEGRAM_TOKEN and ` +
      `PAGER_TELEGRAM_CHAT. ONCHAIN_MONITORING.md §7.3.`)
    return
  }

  const lines = []
  if (fresh.length) {
    lines.push(`TOSH WATCHER — ${fresh.length} new paging finding(s)`, '')
    for (const { f } of fresh) {
      lines.push(`[${f.severity}] ${f.id}`, f.message)
      if (f.playbook) lines.push(`playbook: ${f.playbook}`)
      lines.push('')
    }
  }
  if (repage.length) {
    lines.push(`STILL OPEN AND UNACKNOWLEDGED — ${repage.length} P0(s):`, '')
    for (const i of repage) {
      lines.push(`#${i.number} ${i.title}`, `open since ${i.createdAt}`, '')
    }
    lines.push('This repeats every pass until the issue is closed or labelled `acked`.', '')
  }
  if (RUN_URL) lines.push(RUN_URL)
  lines.push(`issues: https://github.com/${REPO}/issues?q=is%3Aopen+label%3Awatcher`)

  const text = lines.join('\n')
  if (DRY) {
    console.log(`\n── would page ──\n${text}`)
    return
  }
  /* Telegram caps a message at 4096 characters and rejects anything longer
   * outright. A storm pass is exactly when that is reached and exactly when the
   * page matters, so truncate rather than let the send fail. */
  await telegram(text.length > 3900 ? `${text.slice(0, 3900)}\n… truncated; see the issues link` : text)
  console.log(`paged: ${fresh.length} new, ${repage.length} unacknowledged P0(s)`)
}

// ── File ─────────────────────────────────────────────────────────────────────

/* Wrapped, and exiting by `process.exitCode` rather than `process.exit()`.
 * Calling process.exit() with fetch's sockets still closing aborts node on
 * Windows with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and a
 * 0xC0000409 status — after printing the correct result. In CI that reads as a
 * failed delivery step on a delivery that succeeded, which is the worst way for
 * an alerting path to be wrong. */
async function main() {
  if (!DRY && process.env.WATCH_ISSUE_REPO) await assertSinkReachable()
  if (!DRY && PAGER_ON) await assertPagerReachable()
  if (!DRY && !PAGER_ON) {
    console.log('pager not configured (PAGER_TELEGRAM_TOKEN / PAGER_TELEGRAM_CHAT unset) — ' +
      'findings will be written down and nobody will be woken')
  }

  /* The open-issue list is read even on a pass where nothing paged, and that
   * pass is the whole reason repaging exists.
   *
   * An event finding is a historical fact tied to a block, so a GOV-01 filed on
   * Monday does not appear in Tuesday's findings. `paging.length` is therefore 0
   * on every pass after the one that found it, while the issue sits open and
   * unacknowledged. Returning early here — which this function used to do —
   * would mean the pager only ever fires on the pass that discovers something,
   * which is the single-shot behaviour that makes a pager decorative. */
  const wantOpen = paging.length > 0 || (PAGER_ON && !DRY)
  const seen = DRY || !wantOpen ? new Map() : await openKeys()
  const repage = needsRepaging(seen)

  if (paging.length === 0) {
    console.log(`no paging findings among ${findings.length} finding(s) — nothing to file`)
    await pageOut([], repage)
    return
  }
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
    console.log(`  suppressed ${key} — already open as #${issue.number}`)
  }

  if (DRY) {
    for (const { f, key } of fresh) {
      console.log(`\n── would file: [${f.severity}] ${f.id} (${key})\n${body(f, key)}`)
    }
    console.log(`\n${fresh.length} would be filed, ${suppressed.length} suppressed`)
    await pageOut(fresh, repage)
    return
  }

  if (fresh.length === 0) {
    console.log(`nothing new: all ${paging.length} paging finding(s) are already open`)
    await pageOut([], repage)
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
    /* One page for the storm, not one per finding. The individual messages are
     * in the issue; what a human needs at 03:00 is the count and the warning
     * that the usual cause is a lost checkpoint rather than a chain on fire. */
    await pageOut([{
      f: {
        severity: 'P0',
        id: 'STORM',
        message: `${fresh.length} paging findings in one pass, filed as summary #${issue.number}. ` +
          `The usual cause is a lost checkpoint re-reporting history as new — check the scanned ` +
          `block range in the run log before treating these as live.`,
      },
    }], repage)
    return
  }

  /* `acked` is created here even though nothing applies it, because it is the
   * acknowledgement mechanism `needsRepaging` reads and a label that does not
   * exist yet is one a woken operator has to invent at 03:00. */
  await ensureLabels(['watcher', 'acked', ...new Set(fresh.map(({ f }) => f.severity))])

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
  await pageOut(fresh, repage)
}

await main().catch(err => {
  console.error(`delivery failed: ${err.message}`)
  process.exitCode = 1
})
