/**
 * Diagnostic: does an error raised in production actually reach Sentry, and
 * reach the project someone is watching?
 *
 * PM-E3 asks for two things: `NEXT_PUBLIC_SENTRY_DSN` set, and a test event
 * that lands in the right project. Source can answer the first. Only a real
 * event can answer the second, which is why this script exists rather than a
 * checklist row asserting the env var is non-empty.
 *
 * Not wired into `npm run guards`. CI has no DSN and should not have one —
 * monitoring is opt-in per environment (`observability.ts`), and a build that
 * shipped its own error reports into the production project would be worse
 * than a build with none.
 *
 * It posts an envelope to the same ingest endpoint `@sentry/nextjs` posts to,
 * rather than importing the SDK. A diagnostic that takes a different path can
 * pass while the path in production fails.
 *
 * ── The distinction this script is really for ──────────────────────────────
 * A 200 from the ingest endpoint means the DSN was accepted. It does NOT mean
 * the event is visible where you are looking. A DSN addresses a project by
 * NUMERIC id; a human opens a project by SLUG. Paste the DSN of an old
 * personal project into production and every check that stops at "200, DSN
 * works" stays green while the on-call dashboard stays empty forever.
 *
 * So when an auth token is available this resolves the DSN's numeric id back
 * to a slug and prints it. That is the step that turns "an event was accepted"
 * into "an event landed in tosh-production".
 *
 * ── And "reach Sentry" has two routes, not one ─────────────────────────────
 * In production the browser does not post to ingest. `tunnelRoute` sends it
 * through the app's own origin so an ad-blocker cannot drop every report, and
 * that route can be broken while direct ingest is fine. Given a deployment
 * URL this posts a second envelope through `/monitoring` and reports on it
 * separately — because the tunnel is the hot path and the direct check is not.
 *
 * Usage:  node scripts/checkSentry.mjs [https://deployment-url]
 *         npm run check:sentry -- https://deployment-url
 */

import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { CheckFailed, installFailureExit } from './lib/checkExit.mjs'

installFailureExit()

const ENV_FILE = '.env.local'
const INGEST_DEADLINE_MS = 15_000

// ── Env ──────────────────────────────────────────────────────────────────────
// Same precedence Next applies: the ambient shell outranks the file, so this
// reports on the values a build would actually use.
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

/** Report and stop. Throws rather than exiting — see `lib/checkExit.mjs`. */
function fail(message, detail) {
  console.log(`\nFAIL  ${message}`)
  if (detail) console.log(detail)
  throw new CheckFailed(message)
}

const publicDsn = (process.env.NEXT_PUBLIC_SENTRY_DSN ?? '').trim()
const serverDsn = (process.env.SENTRY_DSN ?? '').trim()
const org       = (process.env.SENTRY_ORG ?? '').trim()
const project   = (process.env.SENTRY_PROJECT ?? '').trim()
const authToken = (process.env.SENTRY_AUTH_TOKEN ?? '').trim()

// `observability.ts` derives this identically. Reproduced rather than imported
// because this is a .mjs script outside the bundler's path aliases.
const environment =
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT
  ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development')

if (!publicDsn) {
  fail(
    'NEXT_PUBLIC_SENTRY_DSN not set, so every report site is a no-op.',
    '      `isMonitoringEnabled()` is false without it, which means\n' +
    '      `reportError` returns immediately and the error boundaries in\n' +
    '      app/error.tsx and app/global-error.tsx catch a broken page and\n' +
    '      tell nobody. That is the correct state for local dev; it is not a\n' +
    '      state production should ever be in.\n\n' +
    '      Create a project at sentry.io, then put the DSN in\n' +
    `      soat-frontend/${ENV_FILE} and in Vercel Production.`,
  )
}

// ── 1. Is the DSN even a DSN? ────────────────────────────────────────────────
// Parsed rather than regex-matched so the failure says which part is wrong.
function parseDsn(raw, label) {
  let u
  try {
    u = new URL(raw)
  } catch {
    fail(`${label} is not a URL (${raw.slice(0, 40)}…).`,
      '      A DSN looks like https://<publicKey>@<host>/<projectId>.')
  }
  const projectId = u.pathname.replace(/^\/+/, '')
  // `o<orgId>.ingest.<region>.sentry.io` — the tunnel rewrite is keyed on both,
  // and the region matters: this org is on `de`, and an API call to plain
  // sentry.io for a regional org is a different endpoint, not a redirect.
  const hostParts = /^o(\d+)\.ingest\.(?:([a-z0-9-]+)\.)?sentry\.io$/i.exec(u.host)
  if (!u.username) {
    fail(`${label} has no public key.`,
      '      Expected https://<publicKey>@<host>/<projectId>. A DSN copied\n' +
      '      from the wrong field in the Sentry UI often loses the key.')
  }
  if (!/^\d+$/.test(projectId)) {
    fail(`${label} has no numeric project id (path was "${u.pathname}").`,
      '      The last path segment of a DSN is the project id, and it is\n' +
      '      always numeric. A slug there means this is not an ingest DSN.')
  }
  if (u.protocol !== 'https:') {
    fail(`${label} is not https (${u.protocol}).`,
      '      Ingest is https. An http DSN would send error payloads, which\n' +
      '      can include user context, in the clear.')
  }
  // orgId/region stay undefined for self-hosted Sentry, which has neither in
  // its host. Only the tunnel check needs them, and it says so when they are
  // missing rather than guessing.
  return {
    host: u.host,
    publicKey: u.username,
    projectId,
    orgId: hostParts?.[1],
    region: hostParts?.[2],
  }
}

// Before parsing, not after. A DSN is a write-only ingest key, which is why it
// is safe in a NEXT_PUBLIC_ var; an auth token is not, and the two sit in
// adjacent fields in the Sentry UI. `parseDsn` would reject a token too — as
// "not a URL", which sends the reader off to fix a typo. The exposure needs
// naming, because pasting the correct DSN afterwards does not un-publish the
// token that was already in a browser bundle.
if (/^sntry[su]_/.test(publicDsn)) {
  fail('NEXT_PUBLIC_SENTRY_DSN holds what looks like an auth token.',
    '      Tokens beginning sntrys_ / sntryu_ are credentials, and this\n' +
    '      variable is inlined into the browser bundle by every build that\n' +
    '      read it. Rotate it in Sentry now — replacing the value here does\n' +
    '      not recall the builds that already shipped it. Then put the ingest\n' +
    '      DSN here and the new token in SENTRY_AUTH_TOKEN.')
}

const dsn = parseDsn(publicDsn, 'NEXT_PUBLIC_SENTRY_DSN')

console.log(`Host        ${dsn.host}`)
console.log(`Project id  ${dsn.projectId}`)
console.log(`Public key  ${dsn.publicKey.slice(0, 8)}… (${dsn.publicKey.length} chars)`)
console.log(`Environment ${environment}`)
console.log('')

if (serverDsn) {
  const s = parseDsn(serverDsn, 'SENTRY_DSN')
  const sameProject = s.projectId === dsn.projectId && s.host === dsn.host
  console.log(
    `Server DSN  set, project ${s.projectId}` +
    (sameProject
      ? ' — same project as the browser'
      : ` — DIFFERENT project from the browser (${dsn.projectId})`),
  )
  if (!sameProject) {
    console.log(
      '            Deliberate per sentry.server.config.ts, which reads\n' +
      '            SENTRY_DSN first so server and browser can be split. Worth\n' +
      '            confirming both are on someone\'s dashboard, because an\n' +
      '            alert rule usually names one project.',
    )
  }
} else {
  console.log('Server DSN  unset — server events fall back to the public DSN (intended)')
}
console.log('')

// ── 2. Send a real event through the real endpoint ───────────────────────────
// The envelope endpoint, because that is what the SDK uses. `store` still
// works and is simpler, and using it would make this a test of a path
// production does not take.
const eventId = randomUUID().replace(/-/g, '')
const sentAt = new Date().toISOString()

const event = {
  event_id: eventId,
  timestamp: sentAt,
  platform: 'node',
  level: 'error',
  environment,
  logger: 'scripts/checkSentry.mjs',
  // Shaped like what `reportError` produces, so what lands looks like the real
  // thing rather than a message Sentry groups on its own.
  exception: {
    values: [{
      type: 'ToshMonitoringProbe',
      value:
        'PM-E3 diagnostic event. If you are reading this in an alert, the ' +
        'DSN works and someone ran scripts/checkSentry.mjs — no incident.',
    }],
  },
  tags: { surface: 'api-route', tosh_probe: 'pm-e3' },
  extra: { sent_by: 'scripts/checkSentry.mjs', sent_at: sentAt },
}

const envelope =
  JSON.stringify({ event_id: eventId, sent_at: sentAt, dsn: publicDsn }) + '\n' +
  JSON.stringify({ type: 'event' }) + '\n' +
  JSON.stringify(event) + '\n'

const ingestUrl =
  `https://${dsn.host}/api/${dsn.projectId}/envelope/` +
  `?sentry_key=${encodeURIComponent(dsn.publicKey)}&sentry_version=7`

const started = performance.now()
let res
try {
  res = await fetch(ingestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-sentry-envelope' },
    body: envelope,
    signal: AbortSignal.timeout(INGEST_DEADLINE_MS),
  })
} catch (err) {
  fail(`could not reach ingest at ${dsn.host}: ${err?.message ?? err}`,
    '      Nothing was sent. If this is a timeout rather than a DNS failure,\n' +
    '      note that the browser reaches Sentry through the app\'s own origin\n' +
    '      (tunnelRoute "/monitoring" in next.config.ts), so a network that\n' +
    '      blocks sentry.io directly does not by itself break production.')
}
const elapsed = performance.now() - started

if (res.status === 401 || res.status === 403) {
  fail(`ingest rejected the key: ${res.status} ${res.statusText}`,
    '      The public key and the project id in the DSN disagree, or the key\n' +
    '      was rotated. Copy the DSN again from Settings → Client Keys.')
}
if (res.status === 429) {
  fail('ingest returned 429 — the project is rate limited or over quota.',
    '      Events are being dropped right now, which is indistinguishable\n' +
    '      from having no monitoring. Check the org\'s quota before relying\n' +
    '      on this project for production.')
}
if (!res.ok) {
  const text = await res.text().catch(() => '')
  fail(`ingest returned ${res.status} ${res.statusText}`, `      ${text.slice(0, 300)}`)
}

const accepted = await res.json().catch(() => ({}))
console.log(`Ingest      accepted in ${elapsed.toFixed(0)} ms, id ${accepted.id ?? eventId}`)

// ── 3. The path a browser actually takes ─────────────────────────────────────
// Everything above talked straight to ingest. A browser in production does
// not: `tunnelRoute: '/monitoring'` in next.config.ts makes the SDK post to
// the app's own origin, which rewrites to ingest server-side. That exists so a
// wallet extension or a corporate blocklist cannot silently drop every report
// — and it means the check above and production disagree about the route, the
// same mismatch this file's header warns against.
//
// The rewrite is not a route handler. It matches on `has` query conditions, so
// `POST /monitoring` with no `?o=&p=` is a 404 by design, and a 404 here says
// nothing about whether the tunnel works. The org id and region come out of
// the DSN host rather than being configured, because that is where the SDK
// gets them too.
const siteUrl = (process.env.TOSH_SITE_URL ?? process.argv[2] ?? '').trim().replace(/\/+$/, '')
if (!siteUrl) {
  console.log(
    'Tunnel      skipped — pass a deployment to test the browser\'s own path:\n' +
    '            npm run check:sentry -- https://<deployment>\n' +
    '            Direct ingest working does not imply the tunnel does; they\n' +
    '            are different routes and only the tunnel is on the hot path.',
  )
} else if (!dsn.orgId) {
  console.log(`Tunnel      skipped — no org id in DSN host "${dsn.host}" (self-hosted?)`)
} else {
  const tunnelEventId = randomUUID().replace(/-/g, '')
  const tunnelSentAt = new Date().toISOString()
  const tunnelEnvelope =
    JSON.stringify({ event_id: tunnelEventId, sent_at: tunnelSentAt, dsn: publicDsn }) + '\n' +
    JSON.stringify({ type: 'event' }) + '\n' +
    JSON.stringify({
      ...event,
      event_id: tunnelEventId,
      timestamp: tunnelSentAt,
      platform: 'javascript',
      exception: { values: [{ type: 'ToshTunnelProbe', value: event.exception.values[0].value }] },
      tags: { ...event.tags, tosh_probe: 'pm-e3-tunnel' },
    }) + '\n'

  const q = new URLSearchParams({ o: dsn.orgId, p: dsn.projectId })
  if (dsn.region) q.set('r', dsn.region)
  // Kept in a variable rather than inlined into the messages below: `tunnelRoute`
  // also accepts `true`, in which case the SDK generates a random path per
  // build, and a message naming "/monitoring" would then name the wrong one.
  const tunnelPath = '/monitoring'
  const tunnelUrl = `${siteUrl}${tunnelPath}?${q}`
  try {
    const t = await fetch(tunnelUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: tunnelEnvelope,
      signal: AbortSignal.timeout(INGEST_DEADLINE_MS),
    })
    if (t.ok) {
      const body = await t.json().catch(() => ({}))
      console.log(`Tunnel      ${siteUrl}${tunnelPath} forwarded to ingest, id ${body.id ?? tunnelEventId}`)
    } else if (t.status === 404) {
      // A 404 here has two very different causes and they need different
      // answers. Vercel answers 404 for a deployment that does not exist at
      // all, so blaming the rewrite would send someone to audit
      // next.config.ts over a mistyped hostname. Ask the site root which case
      // this is before naming a cause.
      let rootOk = false
      try {
        const root = await fetch(`${siteUrl}/`, { signal: AbortSignal.timeout(INGEST_DEADLINE_MS) })
        rootOk = root.ok
      } catch { /* treated as unreachable below */ }
      console.log(
        rootOk
          ? `Tunnel      404 from ${siteUrl}${tunnelPath} — the rewrite is not there.\n` +
            '            Browser reports are being posted to a URL that does not\n' +
            '            exist, and the SDK does not fall back to ingest, so every\n' +
            '            client-side error is lost while the server side looks fine.\n' +
            '            Check that this deployment was built after tunnelRoute was\n' +
            '            set, and that no rewrite or middleware shadows the path.'
          : `Tunnel      ${siteUrl}/ does not serve the app, so the 404 from\n` +
            `            ${tunnelPath} says nothing about the tunnel. Check the URL\n` +
            '            before reading anything into this line.',
      )
      process.exitCode = 1
    } else {
      console.log(`Tunnel      ${t.status} ${t.statusText} from ${siteUrl}${tunnelPath}`)
      process.exitCode = 1
    }
  } catch (err) {
    console.log(`Tunnel      could not reach ${siteUrl}: ${err?.message ?? err}`)
    process.exitCode = 1
  }
}
console.log('')

// ── 4. Accepted where? ───────────────────────────────────────────────────────
// The step that distinguishes "the DSN works" from "the events are somewhere
// anyone will see them". Needs a token, so it degrades to a warning.
if (authToken && org) {
  const listUrl = `https://${dsn.host.replace(/^o\d+\.ingest\./, '')}/api/0/organizations/${encodeURIComponent(org)}/projects/`
  try {
    const r = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(INGEST_DEADLINE_MS),
    })
    if (r.ok) {
      const projects = await r.json()
      const match = Array.isArray(projects)
        ? projects.find((p) => String(p.id) === dsn.projectId)
        : undefined
      if (!match) {
        console.log(
          `Resolved    project ${dsn.projectId} is NOT in org "${org}"\n` +
          '            The event was accepted, so it went somewhere — just not\n' +
          '            into an org this token can see. That is the failure mode\n' +
          '            a 200 cannot detect: monitoring that reports green while\n' +
          '            the dashboard you watch stays empty.',
        )
        process.exitCode = 1
      } else {
        console.log(`Resolved    project ${dsn.projectId} is "${match.slug}" in org "${org}"`)
        if (project && match.slug !== project) {
          console.log(
            `            SENTRY_PROJECT says "${project}", the DSN points at\n` +
            `            "${match.slug}". Source maps would upload to one and\n` +
            '            events arrive in the other, so production stack traces\n' +
            '            stay minified while both variables look set.',
          )
          process.exitCode = 1
        }
      }
    } else if (r.status === 403) {
      // Not a misconfiguration. Sentry's current Organization Tokens are
      // fixed-scope `org:ci` — release creation, source-map upload, code
      // mappings — and the UI offers no way to add org:read or project:read.
      // The alternatives that could do it are worse: a personal token is a
      // person, not a deployment, and would break when they leave.
      //
      // So this particular cross-check cannot be automated with the credential
      // production should be using, and saying "token may lack project:read"
      // would send someone to a settings page that has no such checkbox.
      console.log(
        'Resolved    not available to this token, and that is expected.\n' +
        '            Organization Tokens are fixed-scope org:ci; listing\n' +
        '            projects needs org:read, which the UI cannot grant.',
      )
      // Not the end of it, though. Releases ARE readable with org:ci, and a
      // release carries the project slugs it was created against — so the
      // build's own artifacts say which project this pipeline uploads to.
      // That is half of what listing projects would have told us, and it is
      // the half about the deploy rather than about the DSN.
      const relUrl = `https://${dsn.host.replace(/^o\d+\.ingest\./, '')}/api/0/organizations/${encodeURIComponent(org)}/releases/`
      try {
        const rel = await fetch(relUrl, {
          headers: { Authorization: `Bearer ${authToken}` },
          signal: AbortSignal.timeout(INGEST_DEADLINE_MS),
        })
        const releases = rel.ok ? await rel.json() : []
        const latest = Array.isArray(releases) ? releases[0] : undefined
        const slugs = latest?.projects?.map((p) => p.slug) ?? []
        if (!latest) {
          console.log(
            '            No releases yet, so nothing has uploaded under this\n' +
            '            token. The first production deploy creates one.',
          )
        } else if (project && !slugs.includes(project)) {
          console.log(
            `            Release "${String(latest.version).slice(0, 12)}…" is attached to\n` +
            `            ${slugs.join(', ') || '(none)'}, not "${project}". Source maps are\n` +
            '            going somewhere other than where SENTRY_PROJECT points.',
          )
          process.exitCode = 1
        } else {
          console.log(
            `            Latest release "${String(latest.version).slice(0, 12)}…" is attached to\n` +
            `            "${project}", so the deploy pipeline uploads to the\n` +
            '            intended project. What that cannot confirm is the DSN:\n' +
            '            events could still arrive elsewhere. Confirm the probe\n' +
            '            event by eye once — after that the DSN is pinned in\n' +
            '            Vercel and changing it is a deliberate act.',
          )
        }
      } catch { /* the 403 above is the finding; this was a bonus */ }
    } else {
      console.log(`Resolved    could not list projects (${r.status} ${r.statusText})`)
    }
  } catch (err) {
    console.log(`Resolved    lookup failed (${err?.message ?? err})`)
  }
} else {
  console.log(
    'Resolved    skipped — needs SENTRY_ORG and SENTRY_AUTH_TOKEN.\n' +
    '            Without it this script can only say the DSN was accepted,\n' +
    '            not which project accepted it. Open the project and confirm\n' +
    `            the "ToshMonitoringProbe" event above arrived under\n` +
    `            environment "${environment}".`,
  )
}

// ── 5. Will a production stack trace be readable? ────────────────────────────
const canUploadSourcemaps = Boolean(authToken && org && project)
console.log('')
if (canUploadSourcemaps) {
  // Three non-empty variables satisfy next.config.ts's gate, which is not the
  // same as being able to upload. The gate cannot tell a live token from a
  // revoked one, and a build with a dead token uploads nothing and still
  // succeeds — `sourcemaps` failures are non-fatal by design. So ask the
  // endpoint sentry-cli actually uploads through whether this token may use
  // it. This is the one capability the token exists for; the checks above
  // only established that it authenticates at all.
  const apiHost = dsn.host.replace(/^o\d+\.ingest\./, '')
  const chunkUrl = `https://${apiHost}/api/0/organizations/${encodeURIComponent(org)}/chunk-upload/`
  try {
    const c = await fetch(chunkUrl, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(INGEST_DEADLINE_MS),
    })
    if (c.ok) {
      console.log(`Source maps token may upload (org "${org}", project "${project}")`)
    } else {
      console.log(
        `Source maps token CANNOT upload — ${c.status} ${c.statusText} from chunk-upload.\n` +
        '            All three variables are set, so next.config.ts will enable\n' +
        '            the upload and the build will still pass: a sourcemap step\n' +
        '            that fails is deliberately non-fatal. The cost lands on the\n' +
        '            first real incident, as a minified frame.',
      )
      process.exitCode = 1
    }
  } catch (err) {
    console.log(`Source maps could not reach chunk-upload (${err?.message ?? err})`)
  }
} else {
  const missing = [
    !authToken && 'SENTRY_AUTH_TOKEN',
    !org && 'SENTRY_ORG',
    !project && 'SENTRY_PROJECT',
  ].filter(Boolean).join(', ')
  console.log(
    `Source maps DISABLED — missing ${missing}.\n` +
    '            next.config.ts gates the upload on all three so a missing\n' +
    '            credential cannot fail the build. The cost is paid later: a\n' +
    '            production event arrives with a minified frame like\n' +
    '            `t.default@/_next/static/chunks/…`, and the one thing an\n' +
    '            error report is for — which line — is the thing it lacks.',
  )
}

if (process.exitCode) {
  console.log(
    '\nThe DSN works, but the checks above disagree about where its events\n' +
    'go. Resolve that before ticking PM-E3: the row asks for an event in the\n' +
    'RIGHT project, and that is the part this script found wrong.',
  )
} else {
  console.log(
    '\nAn error raised in production now reaches Sentry. Confirm the probe\n' +
    'event is visible in the project before ticking PM-E3 — ingest accepting\n' +
    'an envelope and a human being able to find it are two claims, and only\n' +
    'the first one was measured here.',
  )
}
