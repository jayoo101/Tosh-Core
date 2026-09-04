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

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
  { id: 4663,  name: 'Robinhood Chain',         mainnet: true },
  { id: 46630, name: 'Robinhood Chain testnet', mainnet: false },
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

console.log(
  failures === 0
    ? '\nEvery chain string reads correctly on every supported chain.'
    : `\n${failures} copy defect(s) — see FAIL lines above.`,
)
process.exit(failures === 0 ? 0 : 1)
