/**
 * Runs a TypeScript guard script under plain `node`, with no TS runner
 * installed.
 *
 *   node scripts/runTsGuard.mjs scripts/checkClMath.ts
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `scripts/checkLpActions.ts` and `scripts/checkClMath.ts` were written with
 * `npx tsx` in their usage lines, but `tsx` is not a dependency of this
 * package and never was — so neither guard could be wired into CI, and neither
 * ran for months. That is the same shape as the `checkCloneInitcodeTuple.mjs`
 * incident recorded in .github/workflows/test.yml: a guard that exists but is
 * unreachable is worth nothing.
 *
 * `scripts/checkChainCopy.mjs` already solved the "run TS without a TS runner"
 * problem here by transpiling with the `typescript` package this repo already
 * depends on. It only needed one leaf module, so it could write a single temp
 * file. These two guards pull in a graph (`lpActions` → `contracts` → `abis`,
 * `chain`), so the same trick is applied through module hooks instead: the
 * transpile is identical, it just covers every `.ts` reached transitively.
 *
 * Deliberately NOT `tsx`: adding a dependency to run a check is a strictly
 * larger supply-chain surface than calling a compiler that is already in the
 * tree because `tsc --noEmit` needs it.
 *
 * ── What it handles ─────────────────────────────────────────────────────────
 *
 *   • extension-less relative imports (`./contracts`), which Node's ESM
 *     resolver rejects and a bundler would have supplied,
 *   • the `@/*` → `./src/*` path alias from tsconfig.json, read from that file
 *     rather than restated here so the two cannot drift,
 *   • type stripping, via `ts.transpileModule`,
 *   • the one env var `src/lib/contracts.ts` throws on at import time, so a
 *     guard runs from a clean checkout with no setup step.
 *
 * Node's own `--experimental-strip-types` covers only the last-but-two of
 * those, which is why it is not enough on its own.
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const ROOT = resolvePath(fileURLToPath(import.meta.url), '../..')

/**
 * `src/lib/contracts.ts` throws at import time without this, and every guard
 * here reaches it transitively. None of them read the value — they check byte
 * layouts and fixed-point maths — so a placeholder is supplied rather than
 * making each caller export one, the same way checkChainCopy.mjs supplies the
 * `NEXT_PUBLIC_CHAIN_ID` it needs.
 *
 * Only when unset, so `frontend.yml`'s job-level value still wins. Matches the
 * address that workflow uses: syntactically valid, deliberately not a real
 * deployment, so a leaked log cannot be mistaken for one.
 */
process.env.NEXT_PUBLIC_FACTORY_ADDRESS ||= '0x1111111111111111111111111111111111111111'
process.env.NEXT_PUBLIC_CHAIN_ID ||= '97'

/**
 * Path aliases, read from tsconfig so a renamed alias fails loudly here
 * instead of being silently unresolved.
 */
function tsconfigAliases() {
  const raw = readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')
  const { paths = {}, baseUrl = '.' } = JSON.parse(raw).compilerOptions ?? {}
  return Object.entries(paths).map(([pattern, targets]) => ({
    prefix: pattern.replace(/\*$/, ''),
    target: resolvePath(ROOT, baseUrl, String(targets[0]).replace(/\*$/, '')),
  }))
}

const ALIASES = tsconfigAliases()

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '/index.ts', '/index.tsx']

const isFile = (p) => existsSync(p) && statSync(p).isFile()

/** First of `base` + each suffix that is a real file. */
function firstExisting(base) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix
    if (isFile(candidate)) return candidate
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const alias = ALIASES.find((a) => specifier.startsWith(a.prefix))
    let base = null

    if (alias) {
      base = resolvePath(alias.target, specifier.slice(alias.prefix.length))
    } else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)
    }

    if (base) {
      const hit = firstExisting(base)
      if (hit) return { url: pathToFileURL(hit).href, format: 'module', shortCircuit: true }
    }

    return nextResolve(specifier, context)
  },

  load(url, context, nextLoad) {
    if (!/\.m?tsx?$/.test(url) || !url.startsWith('file:')) return nextLoad(url, context)

    const source = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: fileURLToPath(url),
    }).outputText

    return { format: 'module', source, shortCircuit: true }
  },
})

const entry = process.argv[2]
if (!entry) {
  console.error('usage: node scripts/runTsGuard.mjs <script.ts>')
  process.exit(1)
}

await import(pathToFileURL(resolvePath(process.cwd(), entry)).href)
