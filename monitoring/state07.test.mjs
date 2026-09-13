/**
 * Tests for STATE-07 in watch.mjs.  Run:  node monitoring/state07.test.mjs
 *
 * ── Why this file is committed when no other harness in this repository is ──
 *
 * STATE-07 is the only automated check on a rule the contracts do not enforce:
 * `_buybackSqrtFloor` falls back to an UNBOUNDED price floor, and the natspec
 * that chose to keep that fallback says the operational rule is "the only thing
 * holding it".  `alerts.json` answers that with "an operational rule nobody
 * checks is not a control.  This is the check."  By the same argument, a control
 * nobody tests is not a control either — and §5.11 of the audit dossier found
 * that this one could be silenced by a single failing call without paging anyone.
 *
 * It cannot be tested any other way.  The ladder is empty on both live chains, so
 * the loop body never executes and a clean run proves nothing about the branches
 * that matter.  This injects a stub `call()` for the four selectors STATE-07
 * uses, builds a three-token ladder — one healthy hook, one that reverts, one
 * reporting zero — and asserts on the JSON findings the script prints.
 *
 * Case 4 is the load-bearing one: it restores the pre-§5.11 structure and shows
 * what that missed, so the assertions cannot pass vacuously.
 *
 * Not on the push path, and for a reason rather than by neglect: it runs the real
 * script five times, every selector the stub does not intercept still reaches an
 * RPC, and that endpoint 429s on the seventh identical request.  Gating pushes on
 * it would be slow and would put load on the thing the monitor depends on.
 *
 * It runs daily in `soak.yml` instead.  Until 2026-09-13 it ran only when
 * somebody remembered to type the command, which for a harness guarding the one
 * control holding the unbounded-buyback risk shut is not a schedule.
 *
 * One consequence of running the real script: if the RPC is unreachable
 * outright, watch.mjs can exit before STATE-07 is reached, and this fails for a
 * reason unrelated to STATE-07.  Soak gates no merges, so that costs attention
 * rather than velocity.
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SRC = new URL('./watch.mjs', import.meta.url)
const COPY = new URL('./.watch.mutant.mjs', import.meta.url)
const original = readFileSync(SRC, 'utf8')

const REAL_CALL = `async function call(to, signature, suffix = '') {
  return rpc('eth_call', [{ to, data: selector(signature) + suffix }, 'latest'])
}`

if (!original.includes(REAL_CALL)) {
  console.error('anchor for call() not found — harness needs updating')
  process.exit(2)
}

/** Three tokens; hook b2 reverts, hook b3 reports zero, hook b1 is healthy. */
const stub = (opts = {}) => `async function call(to, signature, suffix = '') {
  const w = h => h.replace(/^0x/, '').padStart(64, '0')
  const TOKENS = ['0x${'a'.repeat(39)}1', '0x${'a'.repeat(39)}2', '0x${'a'.repeat(39)}3']
  const HOOKS  = ['0x${'b'.repeat(39)}1', '0x${'b'.repeat(39)}2', '0x${'b'.repeat(39)}3']
  if (signature === 'ladderTokenCount()') {
    ${opts.countThrows ? "throw new Error('execution reverted: count')" : "return '0x' + w('3')"}
  }
  if (signature === 'ladderTokens(uint256)') {
    const i = parseInt(suffix, 16)
    ${opts.entryThrowsAt != null ? `if (i === ${opts.entryThrowsAt}) throw new Error('execution reverted: entry')` : ''}
    return '0x' + w(TOKENS[i])
  }
  if (signature === 'getPoolKey(address)') {
    const i = TOKENS.findIndex(t => t.toLowerCase().slice(-40) === String(suffix).slice(-40))
    return '0x' + w('0') + w('0') + w('0') + w('0') + w(HOOKS[i])
  }
  if (signature === 'twapSqrtPriceX96()') {
    const i = HOOKS.findIndex(h => h.toLowerCase() === String(to).toLowerCase())
    if (i === 1) throw new Error('execution reverted')
    if (i === 2) return '0x' + w('0')
    if (i === 0) return '0x' + w('1000000000000000000000000')
  }
  return rpc('eth_call', [{ to, data: selector(signature) + suffix }, 'latest'])
}`

/** The structure as it was before the fix, for the final case. */
const OLD_BLOCK_MARKER = 'try {\n  const count = Number(BigInt(await call(TREASURY, \'ladderTokenCount()\')))'

/* `fileURLToPath`, and no `shell: true`. Both halves were a Windows-only hack
 * that would have failed on the runner this harness is scheduled on:
 * `new URL(...).pathname.slice(1)` turns `/C:/…` into `C:/…`, which is what
 * Windows needs, and turns POSIX `/home/runner/…` into `home/runner/…` — a
 * RELATIVE path, resolved against the repo root, pointing nowhere. The harness
 * would then produce no findings and every assertion below would fail for a
 * reason that has nothing to do with STATE-07, which is the outcome this file's
 * own header warns about. Never observed because the soak step that runs it is
 * newer than the code.
 *
 * Dropping `shell: true` is the same fix twice: it is what made the path a
 * shell word in the first place, and it is what Node ≥22 warns about (DEP0190)
 * for passing unescaped args through a shell. There is no shell feature in use
 * here — one executable, three literal arguments. */
function run(source) {
  writeFileSync(COPY, source)
  const r = spawnSync(process.execPath, [fileURLToPath(COPY), '--dry', '--since', '1'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      MONITOR_FACTORY: '0x2E690A91b383eDB21f6b5B4180Cc4a2C905C6BeA',
      MONITOR_TREASURY: '0x3Fd38489e4B3F021324354Fb5A014Cc904D66C20',
      MONITOR_STATE: '',
    },
  })
  const state07 = (r.stdout ?? '').split('\n')
    .filter(l => l.trim().startsWith('{'))
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(f => f && f.id === 'STATE-07')
  return { state07, stderr: r.stderr ?? '' }
}

const results = []
const check = (name, pass, detail) => {
  results.push(pass)
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n          ${detail}`}`)
}

console.log('\nSTATE-07 — the only control holding the unbounded-buyback risk shut\n')

// 1. Both doors to "no price bound" are reported, and both page.
{
  const { state07 } = run(original.replace(REAL_CALL, stub()))
  const reverted = state07.find(f => /did not answer/.test(f.message))
  const zero = state07.find(f => /== 0/.test(f.message))
  check('a reverting hook is reported at all', !!reverted, JSON.stringify(state07, null, 2))
  check('a reverting hook PAGES, like the zero case', !!reverted?.page, JSON.stringify(reverted))
  check('the loop continues past the revert and still finds the zero',
    !!zero, JSON.stringify(state07.map(f => f.message)))
  check('the zero case still pages', !!zero?.page, JSON.stringify(zero))
  check('the healthy hook produces nothing', state07.length === 2, `${state07.length} findings`)
}

// 2. An entry that cannot even be resolved names its index and does not blind the rest.
{
  const { state07 } = run(original.replace(REAL_CALL, stub({ entryThrowsAt: 1 })))
  const indexed = state07.find(f => /index 1 of 3/.test(f.message))
  const zero = state07.find(f => /== 0/.test(f.message))
  check('an unresolvable entry names its index', !!indexed, JSON.stringify(state07.map(f => f.message)))
  check('an unresolvable entry pages', !!indexed?.page, JSON.stringify(indexed))
  check('later tokens are still checked after it', !!zero, JSON.stringify(state07.map(f => f.message)))
}

// 3. A token list that cannot be read is a monitor fault, not a finding — and says so.
{
  const { state07 } = run(original.replace(REAL_CALL, stub({ countThrows: true })))
  const only = state07.length === 1 ? state07[0] : null
  check('an unreadable token list yields exactly one record', !!only, JSON.stringify(state07))
  check('and it says NO token was checked', /NO token was checked/.test(only?.message ?? ''), only?.message)
  check('and it does not page (nothing was observed)', only?.page === false, JSON.stringify(only))
}

// 4. THE REGRESSION. Restore the original structure and show what it missed.
{
  const oldStructure = `try {
  const count = Number(BigInt(await call(TREASURY, 'ladderTokenCount()')))
  for (let i = 0; i < count; i++) {
    const token = asAddress(await call(TREASURY, 'ladderTokens(uint256)', word(i)))
    const key = await call(TREASURY, 'getPoolKey(address)', word(BigInt(token)))
    const hook = asAddress(key.slice(2).slice(4 * 64, 5 * 64))
    const twap = BigInt(await call(hook, 'twapSqrtPriceX96()'))
    if (twap === 0n) {
      record('STATE-07', sev('STATE-07'), pages('STATE-07'),
        \`Ladder token \${token} has twapSqrtPriceX96() == 0 on hook \${hook}\`,
        { playbook: 'docs/ONCHAIN_MONITORING.md §4 STATE-07' })
    }
  }
  if (count === 0) gap('STATE-07', 'no ladder tokens listed')
} catch (err) {
  record('STATE-07', 'P1', false, \`ladder TWAP check failed: \${err.message}\`)
}`

  const start = original.indexOf(OLD_BLOCK_MARKER)
  const endMarker = 'record(\'STATE-07\', \'P1\', false,\n    `ladder token list could not be read'
  const end = original.indexOf(endMarker)
  if (start < 0 || end < 0) {
    check('could anchor the pre-fix structure', false, 'markers not found')
  } else {
    const tail = original.indexOf('}', original.indexOf('\n', end)) + 1
    const reverted = original.slice(0, start) + oldStructure + original.slice(tail)
    const { state07 } = run(reverted.replace(REAL_CALL, stub()))
    const zero = state07.find(f => /== 0/.test(f.message))
    const anyPaging = state07.some(f => f.page)
    check('PRE-FIX: the zero-TWAP token after the revert was NEVER reported',
      !zero, `it was reported, so this harness is not exercising the defect: ${JSON.stringify(state07.map(f => f.message))}`)
    check('PRE-FIX: nothing paged, despite a bound being absent',
      !anyPaging, JSON.stringify(state07))
  }
}

rmSync(COPY, { force: true })

const passed = results.filter(Boolean).length
console.log(`\n  ${passed}/${results.length} assertions held`)
process.exitCode = passed === results.length ? 0 : 1
