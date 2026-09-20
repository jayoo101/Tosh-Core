/**
 * No source file may import wagmi's `useChainId`.
 *
 *   node scripts/runTsGuard.mjs scripts/checkWalletChain.ts
 *
 * ── The incident ────────────────────────────────────────────────────────────
 *
 * Every wrong-network check in this app asked `useChainId()` what chain the
 * wallet was on. That hook cannot answer the question. It returns
 * `config.state.chainId`, and `createConfig`'s `syncConnectedChain` subscriber
 * refuses to move that value onto a chain the config does not list:
 *
 *     // If chain is not configured, then don't switch over to it.
 *     const isChainConfigured = chains.getState().some((x) => x.id === chainId)
 *     if (!isChainConfigured) return
 *
 * `providers.tsx` registers the target chain and Foundry. A wallet on anything
 * else therefore left `useChainId()` reporting the target id, and every
 * `chainId !== TARGET_CHAIN_ID` in the app read 97 !== 97 and passed.
 *
 * The result was a wallet parked on 4663 — this build's previous target, so
 * real wallets are genuinely still there — seeing no wrong-network strip, a
 * live Deploy button, and viem's `ChainMismatchError` only after the click.
 * `useActionGate` exists precisely to catch that before the click and was
 * structurally unable to: it was comparing the config against itself.
 *
 * `useAccount().chainId` reads the connection instead, so it reports the real
 * chain whether or not this build configures it. `useWalletChainId` wraps it.
 *
 * ── What this checks ────────────────────────────────────────────────────────
 *
 * The import, not the call. `useChainId` has no correct use in this codebase:
 * the only value it can return is `TARGET_CHAIN_ID` or `FOUNDRY_CHAIN_ID`, and
 * anything that genuinely wants the configured chain should say
 * `TARGET_CHAIN_ID` and be obvious about it. Banning the import is therefore
 * exact rather than over-broad, and it cannot be defeated by aliasing.
 *
 * Test files are scanned too, and deliberately: a test that reaches for the
 * config's chain where it means the wallet's is re-introducing the bug in the
 * place meant to catch it.
 *
 * ⚠ ONE TEST IS EXEMPT, AND THE EXEMPTION IS THE POINT OF THE TEST. This guard
 *   used to say that `actionGate.test.tsx` was fine because it MOCKED
 *   `useChainId` rather than importing it. That was the wrong thing to be
 *   reassured by. The mock supplied both hooks' answers, so the test asserted
 *   that the gate preferred the reading the test itself had invented — it would
 *   have passed just as well had wagmi behaved the opposite way, which is the
 *   entire failure it existed to prevent.
 *
 *   It now mounts real wagmi against a fake wallet on 4663 and asserts that the
 *   two hooks DISAGREE: `useAccount().chainId` is 4663 and `useChainId()` is
 *   the configured 97. Pinning that claim requires importing the banned hook,
 *   because the claim is about the banned hook. Calling it in order to prove it
 *   wrong is the opposite of trusting it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const BANNED = 'useChainId'
const REPLACEMENT = "useWalletChainId from '@/lib/useWalletChainId'"

/** The file allowed to reach for the wallet's chain directly. */
const OWNER = join('src', 'lib', 'useWalletChainId.ts')

/**
 * Files that may import the banned hook, each for a stated reason. Keyed by
 * path so a rename cannot carry an exemption somewhere it was never argued for.
 */
const EXEMPT = new Map([
  [
    join('src', 'components', 'ui', 'actionGate.test.tsx'),
    'asserts that `useChainId()` reports the CONFIG chain while '
    + '`useAccount().chainId` reports the wallet\'s — the disagreement the fix '
    + 'rests on cannot be pinned without calling both',
  ],
])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

/**
 * `import { a, useChainId, b } from 'wagmi'` and the `import * as` form, over
 * however many lines the import is spread across. Matching the import
 * statement rather than a bare occurrence of the identifier is what keeps a
 * prose mention — this guard's own header, the docblock on `useWalletChainId`
 * — from failing the build.
 */
const WAGMI_IMPORT = /import\s+(?:type\s+)?(\{[^}]*\}|\*\s+as\s+\w+)\s+from\s+['"]wagmi['"]/g

const failures: string[] = []
const exemptionsUsed = new Set<string>()
let scanned = 0
let wagmiImports = 0

for (const file of sourceFiles('src')) {
  const rel = relative('.', file)
  const raw = readFileSync(file, 'utf8')
  scanned++

  let m: RegExpExecArray | null
  WAGMI_IMPORT.lastIndex = 0
  while ((m = WAGMI_IMPORT.exec(raw))) {
    wagmiImports++
    if (!new RegExp(`\\b${BANNED}\\b`).test(m[1])) continue
    if (EXEMPT.has(rel)) { exemptionsUsed.add(rel); continue }
    const line = raw.slice(0, m.index).split('\n').length
    failures.push(`${rel}:${line}  imports \`${BANNED}\` from wagmi.`)
  }
}

// An exemption that no longer applies is a hole standing open for the next file
// that lands on that path. Each one has to still be doing the job it was argued
// for, or it goes.
for (const [path, why] of EXEMPT) {
  if (exemptionsUsed.has(path)) continue
  console.error(`checkWalletChain: ${path} no longer imports \`${BANNED}\`.`)
  console.error(`  Its exemption was granted because it ${why}.`)
  console.error('  Drop the entry from EXEMPT rather than leaving the hole open.')
  process.exit(1)
}

// The scan walks `src` looking for a specific import shape. If it ever stops
// finding ANY wagmi import, the walk or the pattern broke — a moved directory,
// a switched quote style, a package rename — and this guard would then pass on
// a codebase it never read. That is the same silent-pass failure the payable
// guard's header describes.
if (wagmiImports === 0) {
  console.error('checkWalletChain: found no wagmi imports anywhere under src/.')
  console.error(`  Scanned ${scanned} file(s). The scan is broken, not the code.`)
  process.exit(1)
}

if (failures.length > 0) {
  console.error(`Files importing \`${BANNED}\`:\n`)
  for (const f of failures) console.error(`  ${f}`)
  console.error(
    `\n\`${BANNED}\` reports the CONFIG's chain, never the wallet's. wagmi refuses`
    + '\nto move that value onto a chain the config does not list, so it answers'
    + '\n`TARGET_CHAIN_ID` for a wallet on any unconfigured chain — and every'
    + '\nwrong-network check built on it silently passes. A wallet on 4663 got a'
    + '\nlive Deploy button and a `ChainMismatchError` after the click.'
    + `\n\nUse ${REPLACEMENT}.`
    + `\nIf you truly want the chain this build targets, say \`TARGET_CHAIN_ID\`.`,
  )
  process.exit(1)
}

console.log(
  `No \`${BANNED}\` import in ${scanned} source file(s) `
  + `(${wagmiImports} wagmi import(s) inspected); `
  + `${OWNER} is the one route to the wallet's chain.`,
)
for (const path of exemptionsUsed) {
  console.log(`  exempt, still earning it: ${path}`)
}
