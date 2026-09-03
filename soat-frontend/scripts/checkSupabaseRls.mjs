/**
 * Diagnostic: does the live Supabase project enforce the policies in
 * `supabase/migrations/0001_projects_rls.sql`?
 *
 * The sibling of `checkSupabase.mjs`, and deliberately a different kind of
 * check. That one is static: it reads source and refuses a `.from(...)` chain
 * with no `.abortSignal()`. This one talks to the real project, because the
 * property that matters here is not expressible in source at all — it lives in
 * the database's policy catalogue, and it is wrong by DEFAULT until a migration
 * makes it right.
 *
 * That default is the whole point. The policy this migration replaced read
 *
 *     CREATE POLICY "service write" ON projects FOR INSERT WITH CHECK (true);
 *
 * which names a service and grants PUBLIC — including `anon`, the role behind
 * the key every browser is handed. Under it, anyone could POST rows straight to
 * PostgREST and skip `POST /api/projects`, where the checks are: read the launch
 * from chain by tx_hash, recover the signer, require it to equal the creator.
 *
 * `route.post.test.ts` proves the route uses the service role. It cannot prove
 * the database would refuse anyone else, because in a test the database is a
 * mock that agrees with whatever it is asked. Only the live project can answer
 * that, and only after the migration has actually been run against it — which
 * is a step a human performs by hand, in a dashboard, exactly once, and can
 * therefore forget.
 *
 * So the load-bearing assertion below is the NEGATIVE one: anon INSERT must
 * fail. A green run here means the side door is shut.
 *
 * Usage:  node scripts/checkSupabaseRls.mjs
 */

import { readFileSync, existsSync } from 'node:fs'

const ENV_FILE = '.env.local'
const TIMEOUT_MS = 8_000
const PROBE_TX = `0xdiagnostic${'0'.repeat(52)}`.slice(0, 66)
// 0 is not a valid EIP-155 chain id, so a diagnostic row cannot be mistaken for
// a real one by the filtered reads even if cleanup fails and it survives.
const PROBE_CHAIN = 0

// ── Env ──────────────────────────────────────────────────────────────────────
// Same precedence Next applies: the ambient shell outranks the file, so this
// reports on the values the app would actually use.
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

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '')
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

function fail(message, detail) {
  console.log(`\nFAIL  ${message}`)
  if (detail) console.log(detail)
  process.exit(1)
}

if (!url || !anonKey) {
  const missing = [
    !url && 'NEXT_PUBLIC_SUPABASE_URL',
    !anonKey && 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ].filter(Boolean).join(' and ')
  fail(`${missing} is not set in ${ENV_FILE}.`,
    '      Supabase dashboard -> Project Settings -> API.')
}

// PostgREST directly rather than @supabase/supabase-js, for the same reason
// checkUpstash.mjs speaks REST: a diagnostic that takes a different path can
// pass while the path in production fails.
async function rest(method, path, { key, body, prefer } = {}) {
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  }
  if (prefer) headers.prefer = prefer

  const started = performance.now()
  let res
  try {
    res = await fetch(`${url}/rest/v1/${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    fail(`Could not reach ${url} (${err.name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS} ms` : err.message}).`,
      '      Check the project URL, and that the project is not paused —\n' +
      '      Supabase pauses free projects after a week of inactivity, and a\n' +
      '      paused project refuses connections rather than answering slowly.')
  }
  const elapsed = performance.now() - started
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, body: parsed, raw: text, elapsed }
}

console.log(`Endpoint  ${url}`)
console.log(`anon key  ${anonKey.slice(0, 8)}…${anonKey.slice(-4)} (${anonKey.length} chars)`)
console.log(`service   ${serviceKey ? `${serviceKey.slice(0, 8)}…${serviceKey.slice(-4)} (${serviceKey.length} chars)` : 'not set — write checks will be skipped'}\n`)

// ── 1. The table exists ──────────────────────────────────────────────────────
const probe = await rest('GET', 'projects?select=id&limit=1', { key: anonKey })

if (probe.status === 404 || (probe.status === 400 && /relation|does not exist/i.test(probe.raw))) {
  fail('The `projects` table does not exist on this project.',
    '      Run supabase/migrations/0001_projects_rls.sql in the SQL editor.')
}
if (probe.status === 401 || probe.status === 403) {
  fail(`anon cannot SELECT (HTTP ${probe.status}).`,
    '      The migration grants SELECT to anon; without it the directory is\n' +
    '      empty for every visitor. Re-run 0001_projects_rls.sql.')
}
if (probe.status !== 200) {
  fail(`Unexpected answer to a plain SELECT (HTTP ${probe.status}).`, `      ${probe.raw.slice(0, 300)}`)
}
console.log('SELECT    anon reads the directory                        ok')

// ── 1b. Migration 0002 has been run ──────────────────────────────────────────
//
// Asked of the live schema rather than of the repository, because the two are
// only connected by a human pasting a file into a dashboard. The application
// filters both reads on `chain_id`; against a project still on 0001 that
// filter names a column that does not exist, and PostgREST answers 400 — so
// the directory is empty and every lookup misses, on a database that is
// otherwise healthy and a build that is otherwise correct.
const schema = await rest('GET', 'projects?select=chain_id&limit=1', { key: anonKey })
if (schema.status === 400 && /chain_id/.test(schema.raw)) {
  fail('The `projects` table has no `chain_id` column — 0002 has not been run.',
    '      Run supabase/migrations/0002_projects_chain_id.sql in the SQL editor.\n\n' +
    '      Until then both read paths ask for a column that is not there, so the\n' +
    '      directory renders empty and every project lookup falls through to the\n' +
    '      chain — while writes keep succeeding, which is what makes this quiet.')
}
if (schema.status !== 200) {
  fail(`Unexpected answer when checking for chain_id (HTTP ${schema.status}).`,
    `      ${schema.raw.slice(0, 300)}`)
}
console.log('SCHEMA    chain_id present — 0002 has been run             ok')

// ── 2. The assertions this file exists for ───────────────────────────────────
//
// All three write verbs, not just INSERT. The first version of this check
// tested INSERT alone, which would have passed a project where anon could
// UPDATE — and UPDATE is the easier attack: no squatting, no race against the
// creator, just rewrite the logo and outbound links of a project that already
// exists and is already trusted.
const WRITES = [
  ['INSERT', 'POST',   'projects', { chain_id: PROBE_CHAIN, tx_hash: PROBE_TX, name: 'RLS diagnostic', symbol: 'DIAG' }],
  ['UPDATE', 'PATCH',  `projects?tx_hash=eq.${PROBE_TX}`, { name: 'rewritten' }],
  ['DELETE', 'DELETE', `projects?tx_hash=eq.${PROBE_TX}`, undefined],
]

for (const [label, method, path, body] of WRITES) {
  const res = await rest(method, path, { key: anonKey, body })

  if (res.status >= 200 && res.status < 300) {
    // Clean up before failing: a row written under the anon key on a real
    // tx_hash is exactly the damage this check is about.
    if (serviceKey) await rest('DELETE', `projects?tx_hash=eq.${PROBE_TX}`, { key: serviceKey })
    fail(`anon CAN ${label}. The side door is open.`,
      '      Anyone with the anon key — which every browser is handed — can write\n' +
      '      directly to PostgREST, skipping the creator check in\n' +
      '      POST /api/projects, which reads the launch from chain and requires\n' +
      '      the signature to be the creator\'s.\n\n' +
      (label === 'INSERT'
        ? '      With INSERT they squat: `tx_hash` is UNIQUE, so a row written\n' +
          '      before the real creator publishes owns that project\'s logo and\n' +
          '      links, and the creator\'s own publish comes back 200\n' +
          '      { duplicate: true } — they are told it worked.\n\n'
        : `      With ${label} they do not even need to be first — they edit a\n` +
          '      project that already exists and is already trusted.\n\n') +
      '      Run supabase/migrations/0001_projects_rls.sql. If it has been run,\n' +
      '      look for a leftover permissive policy or grant:\n' +
      '        SELECT policyname, cmd, roles FROM pg_policies\n' +
      '         WHERE tablename = \'projects\';\n' +
      '        SELECT grantee, privilege_type\n' +
      '          FROM information_schema.role_table_grants\n' +
      '         WHERE table_name = \'projects\';')
  }

  if (res.status !== 401 && res.status !== 403) {
    fail(`anon ${label} was refused, but with HTTP ${res.status} rather than 401/403.`,
      `      ${res.raw.slice(0, 300)}\n` +
      '      Refused is the right outcome, but check it is refused for the right\n' +
      '      reason. A NOT NULL or constraint violation also refuses, and would\n' +
      '      stop refusing the moment the body was better formed.')
  }

  // 42501 is insufficient_privilege — the REVOKE in the migration, which is
  // the outer of its two locks. RLS's missing-policy denial is the inner one
  // and never gets consulted, which is why this is 401 and not 403. Either is
  // a pass; naming which one answered is worth a line, because a project where
  // the grants were fixed and the policies were not looks identical from here
  // until someone re-grants.
  const layer = res.body?.code === '42501' ? 'grant layer' : 'row-level security'
  console.log(`${label.padEnd(9)} anon refused, HTTP ${res.status} — ${layer.padEnd(19)} ok`)
}

// ── 3. The writer still works ────────────────────────────────────────────────
if (serviceKey) {
  const svcInsert = await rest('POST', 'projects', {
    key: serviceKey,
    prefer: 'return=representation',
    body: {
      chain_id: PROBE_CHAIN,
      tx_hash: PROBE_TX,
      name: 'RLS diagnostic',
      symbol: 'DIAG',
    },
  })

  if (svcInsert.status < 200 || svcInsert.status >= 300) {
    fail(`The service role cannot INSERT either (HTTP ${svcInsert.status}).`,
      `      ${svcInsert.raw.slice(0, 300)}\n` +
      '      Reads work and writes do not, which means publishing a project\n' +
      '      returns 503 for every creator. Check SUPABASE_SERVICE_ROLE_KEY is\n' +
      '      the service_role key and not a second copy of the anon key.')
  }
  console.log('INSERT    service role writes                             ok')

  const cleanup = await rest('DELETE', `projects?tx_hash=eq.${PROBE_TX}`, { key: serviceKey })
  if (cleanup.status >= 400) {
    fail(`Could not remove the diagnostic row (HTTP ${cleanup.status}).`,
      `      Delete it by hand: tx_hash = ${PROBE_TX}`)
  }
  console.log('Cleanup   diagnostic row removed                          ok')
} else {
  console.log('INSERT    service role — skipped, SUPABASE_SERVICE_ROLE_KEY not set')
}

console.log(`\nLatency   ${probe.elapsed.toFixed(0)} ms for the read, from this machine`)

console.log(
  '\nRLS is enforced: reads are public, writes are the API route\'s alone.\n\n' +
  'The latency above is measured from here, not from the deployment region,\n' +
  'and only the latter is on the hot path. Read it as a reachability check\n' +
  'rather than a performance one — and note the read deadline the app applies\n' +
  'is 1,200 ms (REGISTRY_READ_DEADLINE_MS), so a co-located deployment has\n' +
  'room that a cross-ocean developer machine does not.',
)
