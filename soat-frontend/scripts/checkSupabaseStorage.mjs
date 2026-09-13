/**
 * Diagnostic: has `0003_project_logos_bucket.sql` reached the live project, and
 * does the deployed bucket still say what the migration says?
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * It had not been applied, and nothing noticed. `POST /api/projects/logo`
 * returned 502 "Could not store that image" for every upload by every user for
 * four days, because Supabase storage answered `NoSuchBucket` — while the route
 * was correct, its unit tests were green, `npm run verify` was green, and
 * `check:supabase` was green. Nothing in this repository asked whether a file in
 * `supabase/migrations/` had ever run.
 *
 * That gap is structural, not an oversight. A migration is applied by a human
 * pasting it into a dashboard exactly once, and the only evidence it happened
 * lives in a database no test can see. `checkSupabaseRls.mjs` covers `projects`
 * for the same reason; this is the same check for storage, kept separate because
 * either can fail while the other passes — two migrations, two failure days.
 *
 * The 0003 failure had a second cause worth encoding: the migration could not be
 * applied through the dashboard at all. It ended with `CREATE POLICY` against
 * `storage.objects`, owned by `supabase_storage_admin`, so the editor's
 * `postgres` role hit `42501: must be owner of table objects` — and since the
 * editor runs a script as one transaction, the bucket INSERT above it rolled back
 * with it. Those statements now live in `0003b`, which is optional. This check
 * asserts BEHAVIOUR rather than the presence of those policies, so a project
 * that legitimately skipped `0003b` passes.
 *
 * ── Why the first check needs no credentials ───────────────────────────────
 *
 * A guard that cannot run in the posture the project actually deploys in is not
 * a guard. `SUPABASE_SERVICE_ROLE_KEY` lives only in Vercel — `checkSecretStore`
 * keeps it out of every local file on purpose — so an earlier draft of this
 * script that required it would have failed with "key not set" on every machine
 * that has this repository, which is indistinguishable from passing and is
 * exactly the silence that let the original bug live.
 *
 * So the assertion this file was born for is the one that needs nothing. The
 * public object endpoint discriminates the two 404s in its `code` field:
 *
 *     .../object/public/project-logos/nope   NoSuchKey     bucket is there
 *     .../object/public/no-such-bucket/nope  NoSuchBucket  bucket is NOT there
 *
 * Everything below that tier is additive, and skipped rather than failed when
 * its key is absent — with the skips named in the summary, because a run that
 * checked three things out of six and says so is useful, and one that implies it
 * checked six is not.
 *
 * ── What is asserted, and why each one ─────────────────────────────────────
 *
 *   no key   1. The bucket exists.              The drift this file was born for.
 *   anon     2. anon cannot write.              The route holds the size cap, the
 *                                               magic-byte sniff and the rate
 *                                               limit; a bucket writable with the
 *                                               key every browser is handed makes
 *                                               all three optional.
 *   service  3. `public`, `file_size_limit` and `allowed_mime_types` match the
 *               migration, and the size also matches `LOGO_MAX_BYTES`. Three
 *               copies of one number — SQL, TypeScript, live database. Two
 *               agreeing while the third drifts is a 413 nobody can reproduce.
 *   service  4. The mime list is enforced, not merely recorded. Probed with an
 *               SVG, because a column can list a restriction the service is not
 *               applying.
 *   service  5. Upload, then read back with no key at all. The two halves of the
 *               journey users actually take, in order.
 *
 * Usage:  npm run check:storage
 *         Full coverage needs SUPABASE_SERVICE_ROLE_KEY; `vercel env pull` puts
 *         it in `.env.local` if you want it, and it is fine not to.
 */

import { readFileSync, existsSync } from 'node:fs'
import { CheckFailed, installFailureExit } from './lib/checkExit.mjs'

installFailureExit()

const ENV_FILE   = '.env.local'
const TIMEOUT_MS = 10_000
const BUCKET     = 'project-logos'

const MIGRATION_PATH = new URL(
  '../supabase/migrations/0003_project_logos_bucket.sql', import.meta.url,
)
const LOGO_UPLOAD_PATH = new URL('../src/lib/logoUpload.ts', import.meta.url)

/** Probe objects are prefixed so a survivor of a failed cleanup is identifiable
 *  at a glance in the dashboard, and can never collide with the route's own
 *  `<address>/<hash>` layout. */
const PROBE_PREFIX = '_diagnostic'

/** A real 1×1 PNG, not random bytes. The route sniffs magic bytes, and a probe
 *  that could not survive the route's own checks is testing a shorter path than
 *  the one users take. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

// ── Env ──────────────────────────────────────────────────────────────────────
// Same precedence Next applies: the ambient shell outranks the file.
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

const url        = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '')
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

const skipped = []

/** Report and stop. Throws rather than exiting — see `lib/checkExit.mjs`. */
function fail(message, detail) {
  console.log(`\nFAIL  ${message}`)
  if (detail) console.log(detail)
  throw new CheckFailed(message)
}

function ok(label, text) {
  console.log(`${label.padEnd(9)} ${text.padEnd(48)} ok`)
}

function skip(label, why, cost) {
  console.log(`${label.padEnd(9)} skipped — ${why}`)
  skipped.push(cost)
}

if (!url) {
  fail(`NEXT_PUBLIC_SUPABASE_URL is not set in ${ENV_FILE}.`,
    '      Supabase dashboard -> Project Settings -> API. Nothing here can run\n' +
    '      without knowing which project to ask.')
}

// ── What the repository claims ───────────────────────────────────────────────
//
// Parsed from the migration rather than hardcoded, so this check cannot drift
// from the file it is checking. A parse failure is a hard failure: it means the
// migration was reshaped and nobody revisited this script, and a diagnostic that
// silently falls back to stale constants is worse than no diagnostic.
const sql = readFileSync(MIGRATION_PATH, 'utf8')

const declaredPublic = /VALUES\s*\([^)]*?\b(TRUE|FALSE)\b/is.exec(sql)?.[1]
const declaredSize   = /,\s*(\d+),\s*(?:--[^\n]*)?\s*\n\s*ARRAY\s*\[/i.exec(sql)?.[1]
const declaredMimes  = /ARRAY\s*\[([^\]]+)\]/i.exec(sql)?.[1]

if (!declaredPublic || !declaredSize || !declaredMimes) {
  fail('Could not read the bucket definition out of 0003_project_logos_bucket.sql.',
    '      This script compares the live bucket against that file, so it cannot\n' +
    '      run without parsing it. Either the INSERT was reshaped or the file\n' +
    '      moved. Fix the patterns near the top of this script — do not drop the\n' +
    '      comparison, which is the only thing keeping the SQL honest.')
}

const wantPublic = declaredPublic.toUpperCase() === 'TRUE'
const wantSize   = Number(declaredSize)
const wantMimes  = declaredMimes
  .split(',')
  .map(s => s.trim().replace(/^'|'$/g, ''))
  .filter(Boolean)
  .sort()

// The third copy of the size limit. `LOGO_MAX_BYTES` is what the route rejects
// on; the bucket is what storage rejects on. If they disagree, one of them
// produces an error the other cannot explain.
const logoUploadSrc = readFileSync(LOGO_UPLOAD_PATH, 'utf8')
const maxBytesLit   = /LOGO_MAX_BYTES\s*=\s*([0-9_]+)/.exec(logoUploadSrc)?.[1]
if (!maxBytesLit) {
  fail('Could not find LOGO_MAX_BYTES in src/lib/logoUpload.ts.',
    '      It is one of three copies of the same number and this script compares\n' +
    '      all three. Update the pattern rather than dropping the comparison.')
}
const routeMaxBytes = Number(maxBytesLit.replace(/_/g, ''))

console.log(`Endpoint  ${url}`)
console.log(`Bucket    ${BUCKET}`)
console.log(`Declared  public=${wantPublic}  limit=${wantSize}  mime=[${wantMimes.join(', ')}]`)
console.log(`Keys      anon ${anonKey ? 'set' : 'not set'}, service ${serviceKey ? 'set' : 'not set'}\n`)

// ── Transport ────────────────────────────────────────────────────────────────
// The storage REST API directly rather than @supabase/supabase-js, for the same
// reason checkSupabaseRls.mjs speaks PostgREST: a diagnostic that takes a
// different path can pass while the path in production fails.
async function storage(method, path, { key, body, contentType } = {}) {
  const headers = {}
  if (key) {
    headers.apikey = key
    headers.authorization = `Bearer ${key}`
  }
  if (contentType) headers['content-type'] = contentType

  // An explicit, cleared timer rather than `AbortSignal.timeout`. The signal
  // version leaves a live libuv timer handle behind, and `fail()` exits the
  // process — on Windows that combination aborts inside libuv
  // (`!(handle->flags & UV_HANDLE_CLOSING)`), replacing exit code 1 with
  // 0xC0000409 and burying the diagnostic under a C assertion. A guard whose
  // failure path crashes is a guard nobody trusts the output of.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let res, err
  try {
    res = await fetch(`${url}/storage/v1/${path}`, {
      method, headers, body, signal: controller.signal,
    })
  } catch (caught) {
    err = caught
  }
  clearTimeout(timer)

  if (err) {
    const timedOut = err.name === 'AbortError' || err.name === 'TimeoutError'
    fail(`Could not reach ${url} (${timedOut ? `no answer in ${TIMEOUT_MS} ms` : err.message}).`,
      '      Check the project URL, and that the project is not paused —\n' +
      '      Supabase pauses free projects after a week of inactivity, and a\n' +
      '      paused project refuses connections rather than answering slowly.')
  }
  const raw = await res.text()
  let parsed = null
  try { parsed = raw ? JSON.parse(raw) : null } catch { /* not json */ }
  return { status: res.status, body: parsed, raw }
}

const MISSING_BUCKET_HELP =
  '      Every logo upload returns 502 "Could not store that image" until it\n' +
  '      exists, and nothing else breaks — the launch completes, the row is\n' +
  '      written, the directory renders. Only the artwork is missing, which is\n' +
  '      why this survived a release unnoticed.\n\n' +
  '      Fix, in order of preference:\n' +
  '        1. `supabase db push` from soat-frontend/ (applies 0003 and 0003b).\n' +
  '        2. Run supabase/migrations/0003_project_logos_bucket.sql in the SQL\n' +
  '           editor. It is safe there now — the statements that failed with\n' +
  '           42501 moved to the optional 0003b.\n' +
  '        3. Dashboard -> Storage -> New bucket, by hand:\n' +
  `             name              ${BUCKET}\n` +
  `             public            ${wantPublic}\n` +
  `             file size limit   ${wantSize} bytes\n` +
  `             allowed MIME      ${wantMimes.join(',')}`

// ── 1. The bucket exists — no credentials required ───────────────────────────
const keyless = await storage(
  'GET', `object/public/${BUCKET}/${PROBE_PREFIX}/does-not-exist.png`,
)
const code = keyless.body?.code ?? ''

if (/NoSuchBucket/i.test(code) || /bucket not found/i.test(keyless.raw)) {
  fail(`The \`${BUCKET}\` bucket does not exist on this project.`, MISSING_BUCKET_HELP)
}
if (!/NoSuchKey/i.test(code)) {
  // Any third answer is unclassified, and guessing is how a broken guard reads
  // as a passing one. Storage is entitled to change these strings; this check is
  // not entitled to assume it did not.
  fail(`Could not tell whether the bucket exists (HTTP ${keyless.status}).`,
    `      ${keyless.raw.slice(0, 300)}\n\n` +
    '      Expected NoSuchKey (bucket present, probe object absent) or\n' +
    '      NoSuchBucket. Neither came back, so the discriminator this check\n' +
    '      relies on has moved. Verify by hand and update the patterns above:\n' +
    `        ${url}/storage/v1/object/public/${BUCKET}/nope.png`)
}
ok('BUCKET', 'exists — 0003 has been applied')

// ── 2. anon cannot write ─────────────────────────────────────────────────────
//
// The load-bearing negative, same reasoning as the anon writes in
// checkSupabaseRls.mjs: the size cap, the magic-byte sniff and the rate limit
// live in the route and are not expressible as a row predicate, so they stay
// load-bearing only while the route is the sole writer.
if (!anonKey) {
  skip('ANON', 'NEXT_PUBLIC_SUPABASE_ANON_KEY not set', 'anon cannot write')
} else {
  const anonPath = `${PROBE_PREFIX}/anon-${Date.now()}.png`
  const anonPut = await storage('POST', `object/${BUCKET}/${anonPath}`, {
    key: anonKey, body: PNG_1X1, contentType: 'image/png',
  })

  if (anonPut.status >= 200 && anonPut.status < 300) {
    if (serviceKey) await storage('DELETE', `object/${BUCKET}/${anonPath}`, { key: serviceKey })
    fail('anon CAN upload. The bucket is an open file host.',
      '      The anon key is handed to every browser, so anyone can park bytes\n' +
      '      under a name of their choosing on our storage quota and our domain,\n' +
      '      skipping the size cap, the magic-byte sniff and the rate limit in\n' +
      '      POST /api/projects/logo.\n\n' +
      '      Look for an INSERT policy that should not exist:\n' +
      "        SELECT policyname, cmd, roles FROM pg_policies\n" +
      "         WHERE schemaname = 'storage' AND tablename = 'objects';\n\n" +
      '      0003b creates a SELECT policy and nothing else, on purpose — under\n' +
      '      RLS a missing policy denies, and that absence IS the rule.' +
      (serviceKey ? '' : `\n\n      The probe object was left behind: ${BUCKET}/${anonPath}`))
  }
  if (anonPut.status !== 400 && anonPut.status !== 401 && anonPut.status !== 403) {
    fail(`anon upload was refused, but with HTTP ${anonPut.status} rather than 400/401/403.`,
      `      ${anonPut.raw.slice(0, 300)}\n` +
      '      Refused is right; check it is refused for the right reason. A size\n' +
      '      or mime rejection also refuses, and would stop refusing the moment\n' +
      '      the body was better formed.')
  }
  ok('ANON', `upload refused, HTTP ${anonPut.status}`)
}

// ── 3–5. Everything that needs the writer's own key ──────────────────────────
if (!serviceKey) {
  skip('CONFIG', 'SUPABASE_SERVICE_ROLE_KEY not set',
    'bucket settings match the migration')
  skip('ENFORCE', 'SUPABASE_SERVICE_ROLE_KEY not set',
    'the mime restriction is enforced')
  skip('UPLOAD', 'SUPABASE_SERVICE_ROLE_KEY not set',
    'the route\'s own write path works end to end')
} else {
  // ── 3. It says what the migration says ─────────────────────────────────────
  const bucket = await storage('GET', `bucket/${BUCKET}`, { key: serviceKey })

  if (bucket.status === 401 || bucket.status === 403) {
    fail(`The service key was refused when reading bucket metadata (HTTP ${bucket.status}).`,
      '      Check SUPABASE_SERVICE_ROLE_KEY is the service_role key and not a\n' +
      '      second copy of the anon key — same shape, same length, and the anon\n' +
      '      key cannot read this endpoint.')
  }
  if (bucket.status !== 200 || !bucket.body) {
    fail(`Unexpected answer reading bucket metadata (HTTP ${bucket.status}).`,
      `      ${bucket.raw.slice(0, 300)}`)
  }

  const livePublic = bucket.body.public === true
  if (livePublic !== wantPublic) {
    fail(`The bucket is public=${livePublic}, the migration says public=${wantPublic}.`,
      wantPublic
        ? '      `ProjectLogo` renders a plain <img> at the public object URL, which\n' +
          '      carries no token. On a private bucket every logo in the directory is\n' +
          '      a broken image, and the upload that produced it reported success.'
        : '      A bucket more open than the migration declares. Reconcile before\n' +
          '      assuming the migration describes production.')
  }

  const liveSize = Number(bucket.body.file_size_limit)
  if (liveSize !== wantSize) {
    fail(`file_size_limit is ${liveSize} on the project, ${wantSize} in the migration.`,
      '      Re-run 0003; its ON CONFLICT DO UPDATE resets exactly these columns.')
  }
  if (liveSize !== routeMaxBytes) {
    fail(`file_size_limit is ${liveSize} but LOGO_MAX_BYTES is ${routeMaxBytes}.`,
      '      The two rejections read completely differently to a user. The route\n' +
      '      says "over the N KB limit" with a 413 it can explain; storage says\n' +
      '      "exceeded the maximum allowed size" and the route turns that into a\n' +
      '      502 with no size in it at all. Whichever is lower is the real limit,\n' +
      '      and it should be the route — that is the one that can say why.')
  }

  const liveMimes = [...(bucket.body.allowed_mime_types ?? [])].sort()
  if (liveMimes.join(',') !== wantMimes.join(',')) {
    fail('allowed_mime_types on the project does not match the migration.',
      `      project    [${liveMimes.join(', ') || '(none — every type allowed)'}]\n` +
      `      migration  [${wantMimes.join(', ')}]\n\n` +
      '      An empty list is not a small difference: it allows everything,\n' +
      '      including image/svg+xml, which is a document that can carry <script>\n' +
      '      and would be served from a domain that also serves our storage.\n' +
      '      Re-run 0003.')
  }
  ok('CONFIG', `public=${livePublic}, ${liveSize} bytes, ${liveMimes.length} mime types`)

  // ── 4. The mime restriction is enforced, not merely recorded ───────────────
  //
  // Asked with the service role on purpose. `service_role` is BYPASSRLS, so this
  // isolates the bucket's own restriction from anything RLS would have refused
  // anyway — and a column listing four types while storage accepts a fifth is
  // the sort of thing only a probe can find.
  const svgPath = `${PROBE_PREFIX}/svg-${Date.now()}.svg`
  const svgPut = await storage('POST', `object/${BUCKET}/${svgPath}`, {
    key: serviceKey,
    body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    contentType: 'image/svg+xml',
  })
  if (svgPut.status >= 200 && svgPut.status < 300) {
    await storage('DELETE', `object/${BUCKET}/${svgPath}`, { key: serviceKey })
    fail('The bucket accepted image/svg+xml despite not listing it.',
      '      allowed_mime_types is being recorded and not enforced, so the column\n' +
      '      checked just above proves nothing. An SVG is a document, not a\n' +
      '      bitmap: it can carry <script>, served from a domain that also serves\n' +
      '      our storage. The route\'s magic-byte sniff is now the only thing\n' +
      '      between a creator and a stored SVG — verify it still is.')
  }
  ok('ENFORCE', 'image/svg+xml refused by the bucket')

  // ── 5. The journey users actually take ─────────────────────────────────────
  const probePath = `${PROBE_PREFIX}/probe-${Date.now()}.png`
  const put = await storage('POST', `object/${BUCKET}/${probePath}`, {
    key: serviceKey, body: PNG_1X1, contentType: 'image/png',
  })
  if (put.status < 200 || put.status >= 300) {
    fail(`The service role cannot upload (HTTP ${put.status}).`,
      `      ${put.raw.slice(0, 300)}\n` +
      '      The bucket exists and is configured, and writes still fail — a 502\n' +
      '      on every logo upload with a healthy-looking bucket behind it.')
  }

  // No key at all, not the anon key: the browser fetching an <img> sends
  // neither, and "works with the anon key" is a different, weaker claim.
  const publicRead = await storage('GET', `object/public/${BUCKET}/${probePath}`)
  if (publicRead.status !== 200) {
    await storage('DELETE', `object/${BUCKET}/${probePath}`, { key: serviceKey })
    fail(`The uploaded object does not read back without a key (HTTP ${publicRead.status}).`,
      `      ${publicRead.raw.slice(0, 200)}\n` +
      '      Uploads succeed and every <img> is broken — the one failure mode\n' +
      '      where the creator is told it worked and can see that it did not.')
  }
  ok('UPLOAD', 'service role writes, object reads back with no key')

  const cleanup = await storage('DELETE', `object/${BUCKET}/${probePath}`, { key: serviceKey })
  if (cleanup.status >= 400) {
    fail(`Could not remove the diagnostic object (HTTP ${cleanup.status}).`,
      `      Delete it by hand: ${BUCKET}/${probePath}`)
  }
  ok('Cleanup', 'diagnostic object removed')
}

// ── Summary ──────────────────────────────────────────────────────────────────
if (skipped.length === 0) {
  console.log(
    '\nStorage is live and matches the migration: 0003 has been applied, reads\n' +
    'are public, writes are the API route\'s alone.',
  )
} else {
  console.log(
    `\n0003 has been applied — the bucket is there, which is the drift this check\n` +
    'exists to catch. Not verified on this run:\n' +
    skipped.map(s => `  · ${s}`).join('\n') + '\n\n' +
    'That is a pass, not a partial failure: the keys those need are deliberately\n' +
    'Vercel-only. Run it with `vercel env pull` in place, or from an environment\n' +
    'that already has them, when you want the rest.',
  )
}

console.log(
  '\nNot asserted either way: whether 0003b ran. Its policies are defence in\n' +
  'depth and unreachable while the bucket is public and the writer is BYPASSRLS,\n' +
  'so their presence is not observable from here — and a project that skipped\n' +
  'them because the SQL editor cannot create them is correct, not broken. The\n' +
  'behaviour they exist to guarantee is what gets checked above.',
)
