/**
 * Quote amounts must go through `fmtQuote` / `fmtQuoteFull`, never the
 * 18-decimal default.
 *
 *   node scripts/runTsGuard.mjs scripts/checkQuoteFormat.ts
 *
 * ── The incident ────────────────────────────────────────────────────────────
 *
 * `fmt` and `fmtFull` default to 18 decimals because they were written when
 * the quote asset was the native coin. After the move to 8-decimal BEM, four
 * money surfaces kept calling the default on quote-wei:
 *
 *   HeroStats / ProjectDetail  — headline p0 / shelf price
 *   ShelfLadder                — live spot and TWAP
 *   ReferralPanel / Ledger     — claimable commission hints
 *
 * `fmt(1000n)` is `1.00e-15`. `fmtQuote(1000n)` is `1.00e-5`. Ten orders
 * small, and still a plausible meme-coin price, which is why a screenshot
 * does not catch it. The same file that introduced `fmtQuote` spelled this
 * out (`format.ts`) and the call sites were not walked.
 *
 * ── What this checks ────────────────────────────────────────────────────────
 *
 * 1. No file outside `format.ts` may import `fmtFull`. The remaining callers
 *    all wanted the quote scale and should say `fmtQuoteFull`.
 * 2. No `fmt(...)` call whose first argument is a known quote-priced name
 *    (`p0`, `currentPrice`, `spotPrice`, `twapPrice`, `tierPrice`, `shelfP0`,
 *    or a member of those names). Token amounts keep using `fmt`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const OWNER = 'src/components/ProjectTerminal/format.ts'

const FMT_FULL_IMPORT = /import\s*\{[^}]*\bfmtFull\b[^}]*\}\s*from\s*['"][^'"]+['"]/g
const QUOTE_PRICED = /\bfmt\(\s*(?:[\w.]+\.)?(?:p0|price|currentPrice|spotPrice|twapPrice|tierPrice|shelfP0)\b/g

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue
      out.push(...sourceFiles(p))
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

const failures: string[] = []
let scanned = 0
let quoteFmtHits = 0

for (const file of sourceFiles('src')) {
  const rel = relative('.', file).replace(/\\/g, '/')
  const raw = readFileSync(file, 'utf8')
  scanned++
  if (/\bfmtQuote\b/.test(raw) || /\bfmtQuoteFull\b/.test(raw)) quoteFmtHits++

  if (rel.replace(/\\/g, '/') === OWNER) continue

  FMT_FULL_IMPORT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FMT_FULL_IMPORT.exec(raw))) {
    const line = raw.slice(0, m.index).split('\n').length
    failures.push(`${rel}:${line}  imports \`fmtFull\`. Quote amounts use \`fmtQuoteFull\`; token amounts use \`fmt\`.`)
  }

  QUOTE_PRICED.lastIndex = 0
  while ((m = QUOTE_PRICED.exec(raw))) {
    const line = raw.slice(0, m.index).split('\n').length
    failures.push(`${rel}:${line}  \`fmt(${m[0].slice(4).trim()}\` — this value is quote-wei per token. Use \`fmtQuote\`.`)
  }
}

if (quoteFmtHits === 0) {
  console.error('checkQuoteFormat: found no fmtQuote / fmtQuoteFull under src/.')
  console.error(`  Scanned ${scanned} file(s). The scan is broken, not the code.`)
  process.exit(1)
}

if (failures.length > 0) {
  console.error('Quote amounts drawn on the 18-decimal scale:\n')
  for (const f of failures) console.error(`  ${f}`)
  console.error(
    '\n`fmt` / `fmtFull` default to 18 decimals. Quote-wei at 8 decimals drawn'
    + '\nthat way is understated by 10^10 and still looks like a price.'
    + '\nUse `fmtQuote` / `fmtQuoteFull`.',
  )
  process.exit(1)
}

console.log(
  `Quote amounts named as quote in ${scanned} source file(s) `
  + `(${quoteFmtHits} file(s) already using fmtQuote*).`,
)
