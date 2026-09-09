#!/usr/bin/env node
/**
 * Produce everything the Blockscout verification form needs, because the
 * command-line path to that form does not work on this chain.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `DeployMainnet.s.sol` was broadcast with `--verify`, and PM-C4 was left open
 * on the assumption that the flag had probably worked and merely needed
 * confirming. It had not worked, and it never could have: every path under
 * `https://robinhoodchain.blockscout.com/api` sits behind a Cloudflare
 * "managed" challenge, so any non-browser client — forge included — receives an
 * HTML interstitial titled "Just a moment..." where it expects JSON. Foundry
 * reports that as `Failed to deserialize response: expected value at line 1
 * column 1`, which reads like a malformed reply rather than a wall, and during
 * a broadcast it scrolls past under the deployment output. The contracts sat
 * unverified for a day with nothing saying so.
 *
 * The HTML surface is not challenged, so a human with a browser can complete
 * the form. That asymmetry is the whole reason this script's output is files
 * rather than a network call: the upload has to happen from a browser, and the
 * only part that can be automated is preparing exactly what gets uploaded.
 *
 * WHY STANDARD JSON AND NOT FLATTENED SOURCE
 * ──────────────────────────────────────────
 * `foundry.toml` sets `via_ir = true`. Flattened-source verification submits a
 * file plus a handful of form fields and has nowhere to say that, so the
 * explorer recompiles through the non-IR pipeline, produces different bytecode,
 * and reports a mismatch that looks like the source being wrong. Standard JSON
 * carries `settings.viaIR` inside the document, along with the optimizer runs,
 * the EVM version and the remappings, so the recompile matches by construction.
 *
 * ENCODING IS LOAD-BEARING
 * ────────────────────────
 * Written with an explicit UTF-8 `writeFileSync` rather than shell redirection.
 * PowerShell's `>` emits UTF-16LE, which doubles the file size and is rejected
 * by the form with a parse error that names no cause. That happened once here;
 * the size difference (1,053,286 vs 537,408 bytes) was the only visible symptom.
 *
 * Usage:  node scripts/genVerifyInput.mjs
 * Output: verify-input/<Contract>.json  (gitignored — regenerate, don't commit)
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'verify-input')

/**
 * Constructor arguments are ABI-encoded here rather than quoted from a runbook.
 * They are read out of the broadcast log, which is the only record of what was
 * actually passed — retyping them from the deploy script's defaults is how you
 * verify a contract against arguments it was not deployed with.
 */
const BROADCAST = join(ROOT, 'broadcast', 'DeployMainnet.s.sol', '4663', 'run-latest.json')

const CONTRACTS = [
  {
    name: 'ToshFactory',
    target: 'src/ToshFactory.sol:ToshFactory',
    ctorTypes: ['address', 'address', 'address', 'address'],
  },
  {
    name: 'ToshLadderTreasury',
    target: 'src/ToshLadderTreasury.sol:ToshLadderTreasury',
    ctorTypes: ['address', 'address'],
  },
]

const { transactions } = JSON.parse(
  execFileSync('node', ['-e', `process.stdout.write(require(${JSON.stringify(BROADCAST)}).transactions ? JSON.stringify({transactions: require(${JSON.stringify(BROADCAST)}).transactions}) : '{}')`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
)

mkdirSync(OUT, { recursive: true })

console.log('Blockscout standard-JSON inputs for chain 4663\n')

for (const c of CONTRACTS) {
  const created = transactions.find(
    (t) => t.transactionType === 'CREATE' && t.contractName === c.name,
  )
  if (!created) {
    console.error(`FAIL  no CREATE for ${c.name} in the broadcast log`)
    process.exitCode = 1
    continue
  }

  const raw = execFileSync(
    'forge',
    ['verify-contract', created.contractAddress, c.target, '--show-standard-json-input'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  )

  // Parse before writing. `forge` prints diagnostics to stdout on some failures,
  // and a form rejecting a 40-byte error message is a worse afternoon than this
  // script refusing to produce one.
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    console.error(`FAIL  ${c.name}: forge did not emit JSON:\n${raw.slice(0, 400)}`)
    process.exitCode = 1
    continue
  }

  const path = join(OUT, `${c.name}.json`)
  writeFileSync(path, JSON.stringify(doc), 'utf8')

  const args = execFileSync(
    'cast',
    ['abi-encode', `constructor(${c.ctorTypes.join(',')})`, ...created.arguments],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim()

  console.log(`${c.name}`)
  console.log(`  address           ${created.contractAddress}`)
  console.log(`  upload            verify-input/${c.name}.json  (${statSync(path).size.toLocaleString()} bytes, UTF-8)`)
  console.log(`  contract name     ${c.target.split(':')[1]}`)
  console.log(`  compiler          v${doc.settings.__forgeSolcVersion ?? '0.8.26'} (pick the exact build the form lists)`)
  console.log(`  viaIR             ${doc.settings.viaIR}   optimizer ${doc.settings.optimizer.enabled}/${doc.settings.optimizer.runs}   evm ${doc.settings.evmVersion}`)
  console.log(`  sources           ${Object.keys(doc.sources).length} files`)
  console.log(`  constructor args  ${args}`)
  console.log(`  form              https://robinhoodchain.blockscout.com/address/${created.contractAddress}/contract-verification`)
  console.log()
}

console.log('Pick "Solidity (Standard JSON input)". The constructor arguments go in')
console.log('the separate field WITHOUT the leading 0x if the form strips it — Blockscout')
console.log('accepts both, but reports a mismatch rather than a format error when wrong.')
