/**
 * Guard: nothing in the ambient shell may quietly outrank `.env.local`.
 *
 * Next.js does not treat `.env.local` as authoritative. Its loader skips any
 * key already present in `process.env`, so a variable exported in the shell
 * that started the dev server wins permanently — and restarting the server does
 * not clear it, because the export lives in the parent shell, not the server.
 *
 * ── Why this is worth a startup check ───────────────────────────────────────
 *
 * This has now cost this project twice, and the second time the guard added
 * after the first time did not fire.
 *
 * The failure has no symptoms. `contracts.ts` gets a syntactically valid
 * address, so the app boots. Every read goes out to a real RPC and comes back
 * HTTP 200 with `0x`, because there is no contract at that address to answer.
 * viem decodes empty into `undefined`, react-query settles the query as
 * successful-but-empty, and the admin console renders in full with an em dash
 * in every readout. No console error, no error boundary, no failed request —
 * the page looks like a healthy console pointed at a chain that has nothing on
 * it. Diagnosing it means dumping RPC calldata to notice the `to:` field is an
 * address nobody configured.
 *
 * `contracts.ts` does reject the precompile range at import time, which caught
 * the first occurrence (`0x00…01`). It could not catch the second, because the
 * value in circulation the second time was `0x11…11` — the placeholder that
 * `.github/workflows/frontend.yml` and `scripts/runTsGuard.mjs` both set so a
 * build with no deployment can prerender. Widening that regex to cover it is
 * not an option: CI depends on that exact value being accepted.
 *
 * So the check has to be about provenance rather than shape. A value is
 * suspect not because of what it looks like but because `.env.local` asked for
 * something else and did not get it. That is decidable here, cheaply, before
 * the server starts, and it names the offending variable instead of leaving an
 * operator to infer it from an empty page.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 *
 * Runs from `predev` only. CI has no `.env.local`, so this exits silently
 * there and the workflow's job-level variables stay in charge, which is what
 * they are for. `next build` is likewise untouched: a production build is
 * supposed to take its values from the deploy environment.
 *
 * Set `TOSH_ALLOW_ENV_SHADOW=1` to proceed anyway — deliberately overriding
 * one key for one session is legitimate, and this should inform that choice
 * rather than forbid it.
 */

import { readFileSync, existsSync } from 'node:fs'

const ENV_FILE = '.env.local'
const ESCAPE_HATCH = 'TOSH_ALLOW_ENV_SHADOW'

/**
 * Only the keys the file actually declares. A commented-out block is a record
 * of a configuration not in use, so a shell value matching one is not a
 * conflict — there is nothing for it to override.
 */
function declaredKeys(text) {
  const declared = new Map()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq <= 0) continue

    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    // Strip one layer of matching quotes, then a trailing `# comment`, the way
    // dotenv does — otherwise a quoted value compares unequal to the identical
    // value in the environment and reports a conflict that is not one.
    let value = line.slice(eq + 1).trim()
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value)
    if (quoted) value = quoted[2]
    else value = value.replace(/\s+#.*$/, '').trim()

    // Last assignment wins, matching the loader.
    declared.set(key, value)
  }
  return declared
}

if (!existsSync(ENV_FILE)) {
  process.exit(0)
}

const declared = declaredKeys(readFileSync(ENV_FILE, 'utf8'))

const conflicts = []
for (const [key, fileValue] of declared) {
  const ambient = process.env[key]
  if (ambient !== undefined && ambient !== fileValue) {
    conflicts.push({ key, ambient, fileValue })
  }
}

if (conflicts.length === 0) {
  console.log(`[env] ${ENV_FILE} is authoritative — no shell variable shadows it.`)
  process.exit(0)
}

const subject = conflicts.length === 1 ? 'variable outranks' : 'variables outrank'
console.error(
  `\n[env] ${conflicts.length} shell ${subject} ${ENV_FILE} and will be used instead:\n`,
)
for (const { key, ambient, fileValue } of conflicts) {
  console.error(`  ${key}`)
  console.error(`    shell      ${ambient}      <- wins`)
  console.error(`    ${ENV_FILE} ${fileValue}      <- ignored`)
}

console.error(`
Next.js will not override a variable that is already in process.env, so
editing ${ENV_FILE} and restarting the dev server cannot fix this. Clear it in
the shell you start the server from:

  PowerShell   Remove-Item Env:${conflicts[0].key}
  bash / zsh   unset ${conflicts[0].key}

An inline assignment persists for the rest of the session, so
\`$env:FOO="x"; node script.mjs\` leaves FOO set for every later command
including \`npm run dev\`. Prefer a per-process form that does not:

  PowerShell   $env:FOO="x"; node script.mjs; Remove-Item Env:FOO
  bash / zsh   FOO=x node script.mjs

To start anyway, set ${ESCAPE_HATCH}=1.
`)

if (process.env[ESCAPE_HATCH] === '1') {
  console.error(`[env] ${ESCAPE_HATCH}=1 — continuing with the shell values above.\n`)
  process.exit(0)
}

process.exit(1)
