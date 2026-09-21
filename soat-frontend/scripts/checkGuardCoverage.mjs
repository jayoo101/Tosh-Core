/**
 * Guard: every guard in the `guards` aggregate is also wired into CI.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `npm run guards` is what a developer runs, and `.github/workflows/frontend.yml`
 * is what actually blocks a merge. They are two hand-maintained lists of the
 * same thing, and nothing compared them — so a guard added to the aggregate and
 * not to the workflow runs on the author's machine, passes, and then never runs
 * again. It is not a broken guard; it is an absent one, which is worse, because
 * the aggregate makes it look covered.
 *
 * This is the same failure mode as the test floors in `frontend.yml` and
 * `test.yml`, which sat 58 and 32 tests adrift precisely because "the number is
 * maintained by hand" and "the number is checked" were assumed to be the same
 * statement. Both were found by auditing rather than by CI. A guard that exists
 * but does not run is the one kind of guard no other guard can see.
 *
 * ── Why this is not a plain string diff ─────────────────────────────────────
 *
 * The workflow invokes some guards by npm alias (`npm run guard:rpc`) and others
 * by script path (`node scripts/checkPublicEnv.mjs`). A textual search for the
 * alias therefore reports `guard:env` as missing when its script is in fact run
 * on every push — a false positive, and a false positive here is expensive: it
 * invites someone to "fix" it by adding a second step that runs the same script
 * twice. So each entry is resolved through `package.json` to the script file it
 * actually executes, and EITHER form counts as covered.
 *
 * ── LOCAL_ONLY, and why it is a list and not a flag ─────────────────────────
 *
 * One guard genuinely cannot run in CI. It is named here with its reason rather
 * than skipped silently, so that the next person to read this file learns why
 * the exception exists instead of concluding the check is unreliable and
 * widening it. Adding to this list should feel like it needs an argument.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = join(HERE, '..')
const REPO = join(FRONTEND, '..')
const PKG = join(FRONTEND, 'package.json')
const WORKFLOW = join(REPO, '.github', 'workflows', 'frontend.yml')

/**
 * Guards that are correct to run locally and impossible to run in CI.
 *
 * Keyed by script name so renaming the npm alias cannot silently re-exempt a
 * different guard than the one argued for here.
 */
const LOCAL_ONLY = {
  'checkEnvShadow.mjs':
    'Compares the ambient shell against `.env.local`, and CI has no `.env.local` — '
    + 'the workflow supplies its variables as ambient env, which is the exact state '
    + 'this guard is built to refuse. It would fail every run, and for the wrong reason.',
}

const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
const workflow = readFileSync(WORKFLOW, 'utf8')

const aggregate = pkg.scripts?.guards
if (typeof aggregate !== 'string') {
  console.log('FAIL  package.json has no `guards` script, so there is no aggregate to check against.')
  process.exit(1)
}

const entries = aggregate
  .split('&&')
  .map((s) => s.trim().replace(/^npm run /, ''))
  .filter((s) => s.startsWith('guard:'))

if (entries.length === 0) {
  console.log('FAIL  the `guards` aggregate lists no `guard:*` entries. Did its shape change?')
  process.exit(1)
}

let failures = 0
let covered = 0
let exempt = 0

for (const alias of entries) {
  const command = pkg.scripts?.[alias]
  if (typeof command !== 'string') {
    console.log(`FAIL  \`guards\` runs \`${alias}\`, but package.json defines no such script.`)
    failures++
    continue
  }

  // `runTsGuard.mjs` fronts several TypeScript guards, so the path alone cannot
  // identify them — the alias is the only distinguishing name, and the workflow
  // does use the alias for all of those. Resolve both and accept either.
  const script = command.match(/scripts\/[A-Za-z0-9._-]+/)?.[0] ?? null
  const scriptName = script?.split('/').pop() ?? null

  const reason = scriptName ? LOCAL_ONLY[scriptName] : undefined
  if (reason !== undefined) {
    exempt++
    continue
  }

  const byAlias = workflow.includes(alias)
  const byPath = script !== null && workflow.includes(script)
  if (byAlias || byPath) {
    covered++
    continue
  }

  failures++
  console.log(
    `FAIL  ${alias} (${script ?? 'unresolved script'}) is in \`npm run guards\` but not in\n`
    + `        ${relative(REPO, WORKFLOW)}, so it runs on a developer's machine and never\n`
    + '        blocks a merge. Add a step running it, or — if it genuinely cannot run in\n'
    + '        CI — add it to LOCAL_ONLY in this file WITH the reason.',
  )
}

console.log(
  failures === 0
    ? `\nAll ${covered} CI-runnable guard${covered === 1 ? '' : 's'} in the aggregate are wired into `
      + `frontend.yml (${exempt} local-only, by name).`
    : `\n${failures} guard${failures === 1 ? '' : 's'} in \`npm run guards\` never run in CI.`,
)
process.exit(failures === 0 ? 0 : 1)
