/**
 * Every call to a payable contract function must carry a `value`.
 *
 *   node scripts/runTsGuard.mjs scripts/checkPayableCalls.ts
 *
 * ── The incident ────────────────────────────────────────────────────────────
 *
 * The launch page pre-flights `createLaunch` with `simulateContract` before it
 * opens the wallet, and `useTosh.createLaunch` then sends the real thing. While
 * the launch fee was a BEM `transferFrom` the simulation correctly sent no
 * `value` — there was nothing to send. When the fee became native BNB the write
 * grew `value: expectedFee` and the simulation did not.
 *
 * So the pre-flight checked a transaction nobody was going to send. The factory
 * saw `msg.value == 0`, reverted with `InsufficientLaunchFee`, and the page
 * turned that into "The value sent does not cover the launch fee." — shown to a
 * creator whose wallet had never been asked for anything. Every launch was
 * blocked, and the transaction the wallet would actually have sent was fine.
 *
 * Nothing caught it. `tsc` is happy because `value` is optional on viem's call
 * types, eslint has no opinion, and the e2e script drives the contract directly
 * rather than the page, so it exercised the write and never the pre-flight.
 * The one test that would have failed is a test of the page, which needs the
 * whole wagmi surface mocked to get to the line.
 *
 * ── What this checks, and what it deliberately does not ─────────────────────
 *
 * Payability is read from the ABIs the frontend actually ships, not from a list
 * kept here, so a new payable function is covered the day it lands. Today there
 * is exactly one (`createLaunch`) and two call sites.
 *
 * It asserts a `value` key is PRESENT, never that the amount is right — that is
 * a question about two runtime figures and this is a source scan. Presence is
 * the whole of the bug above: the key was missing, not wrong.
 *
 * A read of a payable function is not a thing this codebase does, so there is
 * no exemption for one. If a genuine zero-value call to a payable function ever
 * appears, write `value: 0n` — which is clearer at the call site than silence
 * anyway, since silence is what this guard exists to stop.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { ERC20_ABI, FACTORY_ABI, HOOK_ABI, TREASURY_ABI } from '../src/app/lib/abis'

interface AbiEntry { type?: string; name?: string; stateMutability?: string }

const ABIS: Record<string, readonly AbiEntry[]> = {
  FACTORY_ABI, HOOK_ABI, TREASURY_ABI, ERC20_ABI,
}

/** Function names the shipped ABIs mark `payable`, with the ABI that says so. */
function payableFunctions(): Map<string, string> {
  const found = new Map<string, string>()
  for (const [label, abi] of Object.entries(ABIS)) {
    for (const e of abi) {
      if (e.type === 'function' && e.stateMutability === 'payable' && e.name) {
        found.set(e.name, label)
      }
    }
  }
  return found
}

/**
 * The source with every comment and string literal replaced by spaces of the
 * same length.
 *
 * Offsets are preserved so a match in the blanked text points at the same place
 * in the original. Brace matching runs on this rather than the raw file because
 * a `}` inside a comment or a template literal is not a brace — and the comment
 * this guard was written for talks about `msg.value` in prose directly above
 * the key it checks for.
 */
function blankNonCode(src: string): string {
  const out = src.split('')
  let i = 0
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }

  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      blank(i, end === -1 ? src.length : end)
      i = end === -1 ? src.length : end
      continue
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      blank(i, end === -1 ? src.length : end + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let k = i + 1
      while (k < src.length) {
        if (src[k] === '\\') { k += 2; continue }
        if (src[k] === c) break
        k++
      }
      blank(i, Math.min(k + 1, src.length))
      i = k + 1
      continue
    }
    i++
  }
  return out.join('')
}

/** The `{ … }` that encloses `pos`, as `[open, close]` offsets, or null. */
function enclosingObject(code: string, pos: number): [number, number] | null {
  let depth = 0
  let open = -1
  for (let i = pos; i >= 0; i--) {
    if (code[i] === '}') depth++
    else if (code[i] === '{') {
      if (depth === 0) { open = i; break }
      depth--
    }
  }
  if (open === -1) return null

  depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (depth === 0) return [open, i]
    }
  }
  return null
}

/** True when the object spanning `[open, close]` has a top-level `value:` key. */
function hasValueKey(code: string, open: number, close: number): boolean {
  let depth = 0
  for (let i = open + 1; i < close; i++) {
    const c = code[i]
    if (c === '{' || c === '[' || c === '(') { depth++; continue }
    if (c === '}' || c === ']' || c === ')') { depth--; continue }
    if (depth !== 0) continue
    if (code.startsWith('value', i) && /^\s*:/.test(code.slice(i + 5))) {
      const before = i === 0 ? ',' : code[i - 1]
      if (/[\s,{]/.test(before)) return true
    }
  }
  return false
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

const payable = payableFunctions()
if (payable.size === 0) {
  console.error('checkPayableCalls: no payable functions in any shipped ABI.')
  console.error('  Either the ABIs were regenerated without one, or the import above is wrong.')
  console.error('  A guard that checks nothing passes silently, so this is a failure.')
  process.exit(1)
}

const failures: string[] = []
let checked = 0

for (const file of sourceFiles('src')) {
  const raw = readFileSync(file, 'utf8')
  // Match on the raw source — `blankNonCode` erases string literals, and the
  // function name IS a string literal. `code` keeps the same offsets, so the
  // match position carries over to the brace walk below.
  const code = blankNonCode(raw)
  const re = /functionName:\s*'([A-Za-z0-9_]+)'/g
  let m: RegExpExecArray | null

  while ((m = re.exec(raw))) {
    const fn = m[1]
    if (!payable.has(fn)) continue
    checked++

    const span = enclosingObject(code, m.index)
    if (span === null) {
      failures.push(`${relative('.', file)}: could not find the call object around '${fn}'.`)
      continue
    }
    if (!hasValueKey(code, span[0], span[1])) {
      const line = raw.slice(0, m.index).split('\n').length
      failures.push(
        `${relative('.', file)}:${line}  '${fn}' is payable (${payable.get(fn)}) `
        + 'but this call sends no `value`.',
      )
    }
  }
}

// A guard that inspects nothing reports success, which is the failure mode this
// file's own header describes. `createLaunch` is called from the launch page and
// from `useTosh`; if neither is visible any more, the scan is broken — a renamed
// key, a moved directory, a literal built by concatenation — not the call sites.
if (checked === 0) {
  console.error('checkPayableCalls: found no calls to any payable function.')
  console.error(`  Expected at least one for [${[...payable.keys()].join(', ')}].`)
  console.error('  The scan is broken, not the code. Fix the guard before trusting a pass.')
  process.exit(1)
}

if (failures.length > 0) {
  console.error('Payable calls missing a `value`:\n')
  for (const f of failures) console.error(`  ${f}`)
  console.error(
    '\nA payable function funds itself from `msg.value`. A call without one is a'
    + '\ndifferent transaction than the one you meant — and when the call is a'
    + '\n`simulateContract` pre-flight, it is a check of a transaction nobody will'
    + '\nsend, which is how every launch on this site was blocked by a revert the'
    + '\nreal write would never have hit.'
    + '\n\nPass `value:` alongside `args:`, or `value: 0n` if zero is genuinely meant.',
  )
  process.exit(1)
}

const names = [...payable.keys()].join(', ')
console.log(`All ${checked} call(s) to payable function(s) [${names}] send a \`value\`.`)
