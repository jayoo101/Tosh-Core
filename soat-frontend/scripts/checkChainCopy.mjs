/**
 * PM-F6 guard: evaluate every user-visible chain string on every chain the UI
 * can be pointed at, and fail if any of them lies.
 *
 * The bug this exists to prevent shipped in five components at once. Each built
 * its byline as `` `${MAINNET_CHAIN_LABEL} · testnet ${ACTIVE_CHAIN_LABEL}` ``
 * with "testnet" as a literal, which is true on staging and becomes "Ethereum ·
 * testnet Ethereum" the moment `NEXT_PUBLIC_CHAIN_ID` is 1 — in the site
 * footer, on every page. Nothing failed; the copy just quietly became false.
 *
 * Reviewing the strings on the chain you happen to be running cannot catch
 * that, because the wrong ones only appear on a chain you are not running. So
 * this transpiles `src/lib/chain.ts` and imports it once per chain id in a
 * fresh process — the values are module-level constants, so a fresh process is
 * the only way to re-evaluate them.
 */

import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const SRC = 'src/lib/chain.ts'
const TMP = 'src/lib/.chainCopyProbe.mjs'

// Must stay in step with `CHAINS_BY_ID` in src/lib/chain.ts, which now THROWS
// on an id it does not know rather than falling back. An entry here for an
// unregistered chain fails the probe with that error, which is the intended
// coupling: the two lists describe the same set and should break together.
const CHAINS = [
  { id: 56, name: 'BNB Smart Chain',         mainnet: true },
  { id: 97, name: 'BNB Smart Chain testnet', mainnet: false },
  { id: 31337, name: 'Foundry devnet',          mainnet: false },
]

/** Strings the user reads. Every one of these must be true on every chain. */
const COPY_KEYS = ['CHAIN_BYLINE', 'CHAIN_POSITIONING', 'CHAIN_STATUS_BADGE', 'MAINNET_CHAIN_LABEL', 'ACTIVE_CHAIN_LABEL']

/**
 * The landing hero's two derived pieces, checked separately from `COPY_KEYS`
 * because the generic rules there do not fit them: one is a boolean and the
 * other is legitimately EMPTY on mainnet, which `COPY_KEYS` treats as a defect.
 *
 * These exist because the per-string repetition check below cannot see the
 * hero. It asks whether one string names the settlement chain twice, and the
 * hero's repetition was spread across four separate elements — the badge, the
 * line beside the badge, the `<h1>`, and the opening words of the paragraph
 * under it. Each string was individually fine. The screenful said "Robinhood
 * Chain" four times above the fold.
 */
const HERO_KEYS = ['BADGE_NAMES_SETTLEMENT_CHAIN', 'CHAIN_STAGING_NOTE']

const js = ts.transpileModule(readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText

writeFileSync(TMP, js, 'utf8')

let failures = 0
const fail = (chain, msg) => { failures++; console.log(`FAIL  ${chain.name} (${chain.id}) — ${msg}`) }

/**
 * Chain names the UI must never contain as a literal.
 *
 * Everything above evaluates `chain.ts`. That is necessary and it is not
 * sufficient: a component can hard-code a chain name and the probe will never
 * look at it. `app/layout.tsx` did exactly that — its `metadata.description`
 * ended in "Currently staging on Base Sepolia testnet." and survived the entire
 * Robinhood Chain migration, so every search result and link preview named a
 * chain this build had not settled on for months. Page metadata is not one of
 * the four surfaces this guard was written around, and nothing else was looking.
 *
 * Two rules, and the second is the one with teeth:
 *
 *   1. No abandoned chain may be named at all.
 *   2. The CURRENT settlement chain may not be named outside `chain.ts` either.
 *      Rule 1 alone only ever catches the last migration, and always one
 *      migration too late; rule 2 makes the next one a build failure instead of
 *      an archaeology exercise, because the only way to say the chain's name is
 *      to derive it.
 */
const ABANDONED_CHAIN_NAMES = /base\s*sepolia|basescan|sepolia/i

/**
 * AMM names this build no longer settles on. Same argument as the chain names
 * above, one layer down: the landing badge, the page metadata, the launch
 * lede and the LP panel all still said "Uniswap V4" after the Infinity port,
 * because nothing in this guard looked at an AMM the way it looks at a chain.
 *
 * `\buniswap\b` rather than only `uniswap\s*v4`, because the bonding-halt copy
 * said "trades on Uniswap" with no version, which is the same lie wearing
 * fewer characters.
 */
const ABANDONED_AMM_NAMES = /\buniswap\b/i
const LABEL_SOURCE = 'src/lib/chain.ts'

/**
 * Coin tickers the UI must not hard-code, and the one exception.
 *
 * ⚠ RULE 3, ADDED AFTER THE BNB MIGRATION SHIPPED WITH ~230 "ETH"s STILL ON
 *   SCREEN. Rules 1 and 2 guard the chain's NAME. Nothing guarded the coin's
 *   ticker, and the coin is what almost every number on the site is denominated
 *   in — so the rename that moved `totalEthDeposited` to `totalNativeDeposited`
 *   across 843 sites, and rescaled every contract constant ×3.5, left the UI
 *   confidently labelling BNB amounts as ETH. Each individual string was
 *   untouched and therefore uninspected. That is the same failure mode as
 *   `layout.tsx` naming Base Sepolia for months, one layer down.
 *
 * The fix is `NATIVE_SYMBOL` in `chain.ts`, derived from the chain. This makes
 * bypassing it a build failure.
 *
 * THE EXCEPTION IS NOT A LOOPHOLE, it is the design. Proof-of-Gas measures gas
 * burned on ETH-settled chains, and that figure stays in ETH on purpose — a
 * ×3.5 rescale would have raised the eligibility bar while looking like a
 * rename. So the PoG rate is BNB-per-ETH, and screens like GasHistoryDialog
 * legitimately show "0.025 ETH" of gas directly above "0.04 BNB" of quota.
 *
 * So a ticker survives only where the SOURCE AROUND IT is reading a gas figure.
 * The test is against a window of source lines, not against the literal, and
 * that is not a convenience — a template literal reaches the AST already torn
 * into chunks, so `{fmt(BigInt(scan.floorWei))} ETH` arrives as the bare string
 * "ETH" with every clue stripped off. Judging the literal alone flagged all
 * fourteen legitimate PoG sites on the first run.
 *
 * Keyed on the identifiers that hold gas, because the copy does not always say
 * "gas" where it shows one: the Floor row renders `scan.floorWei` and the word
 * never appears. Identifiers are also the harder thing to fake, so the exception
 * cannot be claimed by writing "gas" into a sentence about deposits.
 *
 * Test files are out of scope. Their names quote copy on purpose, including copy
 * that has since changed, and a guard that could not tell a test name from a
 * label would force those records to be rewritten into uselessness.
 */
const COIN_TICKERS = /\b(?:ETH|BNB|WETH|WBNB)\b/

/** Reading a gas figure, so a ticker beside it is the PoG currency, not the
 *  settlement one. `NATIVE_SYMBOL` earns an exception too: a line that already
 *  consults it is currency-aware by construction, which covers comparisons like
 *  `NATIVE_SYMBOL !== 'ETH'` that gate the cross-currency note. */
const GAS_DENOMINATED_SOURCE =
  /gasWei|floorWei|GasCapWei|NATIVE_SYMBOL|historical gas|lifetime gas|gas burned|ETH-settled|ETH gas/i

/** Lines around the literal that the exception may be read from. One either
 *  side, because JSX wraps and the identifier often sits on the previous line. */
const GAS_CONTEXT_LINES = 1

/**
 * The quote asset's ticker, which the UI must not hard-code either.
 *
 * ⚠ RULE 4, AND IT IS THE THIRD TIME THIS SHAPE HAS SHIPPED. Read rules 1-3 in
 *   order: a chain name hard-coded in `layout.tsx` outlived a whole migration,
 *   then an AMM name did the same thing one layer down, then the coin's ticker
 *   did it again with ~230 "ETH"s still on screen after the BNB migration. Each
 *   time the guard was extended to cover exactly the thing that had just broken.
 *
 *   The denomination is the next one down, and it has moved faster than any of
 *   them: ETH, then BNB, then BEM, inside two months. Until this rule it was the
 *   only one of the four with no guard at all — which is precisely the state the
 *   coin ticker was in on the day it broke.
 *
 * `QUOTE_SYMBOL` in `contracts.ts` is the source, and it is READ FROM ENV rather
 * than derived from the chain, which makes hard-coding worse here than it is for
 * `NATIVE_SYMBOL`. Chain 97 runs against an 8-decimal mock whose `symbol()`
 * answers `mBEM`; chain 56 runs against real BEM. A literal "BEM" in a component
 * is therefore not merely fragile, it is already false on the only chain this is
 * deployed to — and the interface would be asserting a token that chain does not
 * have.
 *
 * `[mt]?` catches the stand-in forms. `\bBEM\b` alone does not match `mBEM`,
 * because the boundary it needs is between two word characters.
 *
 * Case-sensitive, following RULE 3 rather than rules 1 and 2: these are tickers
 * and they are written in caps, while a case-insensitive match would fire on
 * ordinary prose. Hex cannot produce a false positive — `M` is not a hex digit,
 * so no address or hash contains `BEM`.
 *
 * NO EXCEPTION, unlike rule 3. The Proof-of-Gas carve-out exists because gas is
 * genuinely denominated in a different asset from deposits, and both appear on
 * one screen. Nothing on any screen is denominated in a quote asset other than
 * the quote asset, so there is no second currency to name.
 *
 * ⚠ WHAT THIS RULE DOES NOT DO, stated because the asymmetry with rule 2 is real
 *   and a reader would otherwise assume parity: the probe above re-evaluates
 *   `chain.ts` once per chain in a fresh process, so it catches a string that is
 *   true on staging and false on mainnet. There is no equivalent pass for
 *   `QUOTE_POSITIONING`. `chain.ts` is self-contained and can be transpiled and
 *   imported alone; `contracts.ts` pulls in generated ABIs and throws on missing
 *   env, so probing it would mean standing up most of the app. This rule
 *   therefore catches hard-coding, not a wrong derivation. `QUOTE_POSITIONING`
 *   is one ternary on `IS_TESTNET` and is commented at its definition, which is
 *   a weaker guarantee than rule 2 offers and is the honest state of it.
 */
const QUOTE_TICKERS = /\b[mt]?BEM\b/
const QUOTE_SOURCE = 'src/lib/contracts.ts'

/** Cheap text-level reject, so only candidate files pay for a parse.
 *
 *  Named for what it does rather than for rule 1. It was `mightNameAChain`,
 *  which stopped being true when rule 3 added tickers and reads as though the
 *  other rules were not wired in. */
const mightCarryGuardedCopy = (text, mainnetLabel, isLabelSource) =>
  ABANDONED_CHAIN_NAMES.test(text)
  || ABANDONED_AMM_NAMES.test(text)
  || COIN_TICKERS.test(text)
  || QUOTE_TICKERS.test(text)
  || (!isLabelSource && Boolean(mainnetLabel) && text.includes(mainnetLabel))

/**
 * Literals only — string, template chunk, JSX text. Comments are deliberately
 * out of scope: `chain.ts` and `serverRpc.test.ts` both discuss Base Sepolia at
 * length in prose to explain what was changed and why, and a guard that could
 * not tell that apart from user-facing copy would force those explanations to
 * be deleted. So this walks the TypeScript AST rather than grepping the text.
 */
function scanLiterals(mainnetLabel) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(entry)) files.push(p)
    }
  }
  walk('src')

  let hits = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const rel = file.split('\\').join('/')
    const isLabelSource = rel.endsWith(LABEL_SOURCE)
    const isQuoteSource = rel.endsWith(QUOTE_SOURCE)
    const isTest = /\.test\.tsx?$/.test(rel)

    if (!mightCarryGuardedCopy(text, mainnetLabel, isLabelSource)) continue

    const srcLines = text.split('\n')
    /** Is the literal on line `n` (0-based) sitting next to a gas figure? */
    const gasContext = (n) => GAS_DENOMINATED_SOURCE.test(
      srcLines.slice(Math.max(0, n - GAS_CONTEXT_LINES), n + GAS_CONTEXT_LINES + 1).join('\n'),
    )

    const sf = ts.createSourceFile(
      file, text, ts.ScriptTarget.ES2022, true,
      /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )

    const visit = (node) => {
      const literal =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ||
        ts.isJsxText(node)

      if (literal) {
        const value = node.text
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        const where = `${rel}:${line + 1}`

        if (ABANDONED_CHAIN_NAMES.test(value)) {
          hits++
          console.log(`FAIL  ${where} — names an abandoned chain in user-visible copy: ${JSON.stringify(value.trim().slice(0, 80))}`)
        } else if (!isTest && ABANDONED_AMM_NAMES.test(value)) {
          hits++
          console.log(`FAIL  ${where} — names Uniswap in user-visible copy: ${JSON.stringify(value.trim().slice(0, 80))}`)
        } else if (!isLabelSource && mainnetLabel && value.includes(mainnetLabel)) {
          hits++
          console.log(`FAIL  ${where} — hard-codes "${mainnetLabel}"; import it from ${LABEL_SOURCE} instead: ${JSON.stringify(value.trim().slice(0, 80))}`)
        } else if (!isLabelSource && !isTest && COIN_TICKERS.test(value) && !gasContext(line)) {
          hits++
          console.log(
            `FAIL  ${where} — hard-codes a coin ticker; use NATIVE_SYMBOL from ${LABEL_SOURCE}`
            + ` (a ticker is allowed only where the surrounding source reads a gas`
            + ` figure, which is the Proof-of-Gas exception):`
            + ` ${JSON.stringify(value.trim().slice(0, 80))}`,
          )
        } else if (!isQuoteSource && !isTest && QUOTE_TICKERS.test(value)) {
          hits++
          console.log(
            `FAIL  ${where} — hard-codes the quote asset's ticker; use QUOTE_SYMBOL from`
            + ` ${QUOTE_SOURCE}, or QUOTE_POSITIONING if you are writing a sentence about`
            + ` the denomination. This is already false on chain 97, where the quote asset`
            + ` is an 8-decimal mock whose symbol() answers "mBEM":`
            + ` ${JSON.stringify(value.trim().slice(0, 80))}`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }

  failures += hits
  console.log(
    hits === 0
      // Four rule families, two source files. The old wording said "no chain
      // name", which was already only rule 1 and 2 of the three then wired in —
      // a passing line that under-reports what passed is its own small lie.
      ? `\n${files.length} source files scanned — no chain name, AMM, coin ticker or quote`
        + ` ticker is hard-coded outside ${LABEL_SOURCE} / ${QUOTE_SOURCE}.`
      : `\n${hits} hard-coded string(s) — see FAIL lines above.`,
  )
}

let mainnetLabel = ''

try {
  for (const chain of CHAINS) {
    const probe = `
      import * as m from './${TMP.split('/').pop()}'
      const out = {}
      for (const k of ${JSON.stringify([...COPY_KEYS, ...HERO_KEYS, 'IS_TESTNET'])}) out[k] = m[k]
      process.stdout.write(JSON.stringify(out))
    `
    const probeFile = 'src/lib/.chainCopyProbeRunner.mjs'
    writeFileSync(probeFile, probe, 'utf8')
    let values
    try {
      values = JSON.parse(execFileSync(process.execPath, [probeFile], {
        encoding: 'utf8',
        env: { ...process.env, NEXT_PUBLIC_CHAIN_ID: String(chain.id) },
      }))
    } finally {
      unlinkSync(probeFile)
    }

    console.log(`\n${chain.name} (${chain.id})`)
    for (const k of [...COPY_KEYS, ...HERO_KEYS]) {
      console.log(`  ${k.padEnd(28)} ${JSON.stringify(values[k])}`)
    }

    // Same on every arm by construction; captured here so the literal scan
    // below reads the label from the module rather than repeating it.
    mainnetLabel = String(values.MAINNET_CHAIN_LABEL ?? '')

    if (values.IS_TESTNET === chain.mainnet) {
      fail(chain, `IS_TESTNET is ${values.IS_TESTNET}, expected ${!chain.mainnet}`)
    }

    for (const k of COPY_KEYS) {
      const v = String(values[k] ?? '')

      // A mainnet build must never describe itself as anything provisional.
      if (chain.mainnet && /testnet|devnet|staging|sepolia/i.test(v)) {
        fail(chain, `${k} calls a production chain provisional: "${v}"`)
      }

      // "Ethereum · testnet Ethereum": the settlement chain and the active
      // chain are the same on mainnet, so any string naming both repeats
      // itself. Catching the repetition catches the whole class.
      const label = String(values.MAINNET_CHAIN_LABEL)
      if (k !== 'MAINNET_CHAIN_LABEL' && label && v.split(label).length > 2) {
        fail(chain, `${k} names "${label}" twice: "${v}"`)
      }

      if (!v.trim()) fail(chain, `${k} is empty`)
    }

    // ── The hero, as a composed screenful ────────────────────────────────
    const label = String(values.MAINNET_CHAIN_LABEL)
    const note = String(values.CHAIN_STAGING_NOTE ?? '')
    const isDevnet = chain.id === 31337

    // The `<h1>` always ends in the settlement chain's name, so this note --
    // which renders directly beneath it -- must never say it again. This is
    // the whole reason the constant exists apart from `CHAIN_POSITIONING`.
    if (label && note.includes(label)) {
      fail(chain, `CHAIN_STAGING_NOTE repeats the headline's "${label}": "${note}"`)
    }

    // Empty is the CORRECT value on mainnet, not a missing one: nothing is
    // provisional. Non-empty anywhere else, or the hero silently stops
    // disclosing that this is not production.
    if (chain.mainnet && note !== '') {
      fail(chain, `CHAIN_STAGING_NOTE must be empty on a production chain, got "${note}"`)
    }
    if (!chain.mainnet && note === '') {
      fail(chain, 'CHAIN_STAGING_NOTE is empty on a non-production chain — the hero stops disclosing it')
    }

    // Pins which arm shows the hero's "Settles on X" line. The badge names the
    // settlement chain on the mainnet and testnet arms and the ACTIVE chain on
    // the devnet one, so the extra line is redundant on the first two and is
    // the only mention on the third.
    const badgeNames = values.BADGE_NAMES_SETTLEMENT_CHAIN
    if (typeof badgeNames !== 'boolean') {
      fail(chain, `BADGE_NAMES_SETTLEMENT_CHAIN is ${typeof badgeNames}, expected a boolean`)
    } else if (badgeNames === isDevnet) {
      fail(
        chain,
        `BADGE_NAMES_SETTLEMENT_CHAIN is ${badgeNames} on ${isDevnet ? 'the devnet' : 'a named'} arm ` +
        `— the hero would ${badgeNames ? 'repeat "' + label + '" beside a badge that already says it' : 'never name the settlement chain'}`,
      )
    }
  }
} finally {
  unlinkSync(TMP)
}

if (!mainnetLabel) {
  console.log('FAIL  could not read MAINNET_CHAIN_LABEL — the literal scan below would be vacuous')
  failures++
} else {
  scanLiterals(mainnetLabel)
}

console.log(
  failures === 0
    ? '\nEvery chain string reads correctly on every supported chain, and none is hard-coded.'
    : `\n${failures} copy defect(s) — see FAIL lines above.`,
)
process.exit(failures === 0 ? 0 : 1)
