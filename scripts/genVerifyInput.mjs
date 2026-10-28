#!/usr/bin/env node
/**
 * Produce everything a block explorer's manual verification form needs for the
 * v2 deployment, for when `forge verify-contract` cannot be used (no explorer
 * API key, or a key whose plan does not cover the chain).
 *
 * Usage:  node scripts/genVerifyInput.mjs [chainId]      (default 56)
 * Reads:  broadcast/DeployV2.s.sol/<chainId>/run-latest.json
 * Output: verify-input/NN-<Contract>-<addr>.standard-input.json
 *         verify-input/NN-<Contract>-<addr>.constructor-args.txt
 *         verify-input/00-INDEX.txt
 *         (verify-input/ is gitignored — regenerate, don't commit)
 *
 * WHICH CONTRACTS
 * ───────────────
 * Every CREATE in the broadcast, plus the contracts a constructor deploys:
 * each `ToshFactory` creates its token implementation, its `CircuitNFT`, and
 * the NFT creates the revenue-vault implementation. Forge records those under
 * `additionalContracts` with their init code, and they need verifying as much
 * as the top-level ones — the token implementation is what every launch clones.
 *
 * CONSTRUCTOR ARGUMENTS COME FROM THE INIT CODE, NOT FROM THE SCRIPT
 * ───────────────────────────────────────────────────────────────────
 * The deployed init code is this tree's creation bytecode followed by the
 * ABI-encoded arguments, so the arguments are whatever follows the compiled
 * bytecode. That also checks the tree: if the compiled bytecode is not a prefix
 * of what was deployed, this source is not the deployed source and the entry
 * is reported as a mismatch instead of producing a document that would fail.
 *
 * WHY STANDARD JSON AND NOT FLATTENED SOURCE
 * ──────────────────────────────────────────
 * `foundry.toml` sets `via_ir = true`. Flattened-source verification has
 * nowhere to say that, so the explorer recompiles through the non-IR pipeline,
 * produces different bytecode, and reports a mismatch that looks like the
 * source being wrong. Standard JSON carries `settings.viaIR`, the optimizer
 * runs, the EVM version and the remappings, so the recompile matches.
 *
 * ENCODING IS LOAD-BEARING
 * ────────────────────────
 * Written with an explicit UTF-8 `writeFileSync` rather than shell redirection.
 * PowerShell's `>` emits UTF-16LE, which the form rejects with a parse error
 * that names no cause.
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'verify-input')
const CHAIN_ID = process.argv[2] || process.env.TARGET_CHAIN_ID || '56'
const BROADCAST = join(ROOT, 'broadcast', 'DeployV2.s.sol', CHAIN_ID, 'run-latest.json')

const EXPLORER = { 56: 'https://bscscan.com', 97: 'https://testnet.bscscan.com' }[CHAIN_ID] ?? 'https://bscscan.com'

/** The form lists full build names; solc's commit for each release is fixed. */
const SOLC_COMMIT = { '0.8.26': '8a97fa7a' }
const SOLC = /^solc\s*=\s*"([^"]+)"/m.exec(readFileSync(join(ROOT, 'foundry.toml'), 'utf8'))?.[1] ?? 'unknown'
const COMPILER = SOLC_COMMIT[SOLC] ? `v${SOLC}+commit.${SOLC_COMMIT[SOLC]}` : `v${SOLC} (pick the matching build)`

/** Source path of every contract the v2 deploy creates, by contract name. */
const SOURCE = {
  ToshBidBook:         'src/ToshBidBook.sol',
  ToshHookLens:        'src/ToshHookLens.sol',
  ToshLadderTreasury:  'src/ToshLadderTreasury.sol',
  ToshLaunchpadHook:   'src/ToshLaunchpadHook.sol',
  ToshFactory:         'src/ToshFactory.sol',
  ToshLaunchGateway:   'src/ToshLaunchGateway.sol',
  ToshToken:           'src/ToshToken.sol',
  CircuitNFT:          'src/CircuitNFT.sol',
  CircuitRevenueVault: 'src/CircuitRevenueVault.sol',
}

if (!existsSync(BROADCAST)) {
  console.error(`[genVerifyInput] no v2 broadcast for chain ${CHAIN_ID}: ${BROADCAST}`)
  console.error('                 Constructor arguments are read out of the deploy log, so')
  console.error('                 this cannot run before the deploy it is verifying.')
  process.exit(2)
}

const log = JSON.parse(readFileSync(BROADCAST, 'utf8'))

/** Top-level CREATEs and constructor-created contracts, in deployment order. */
const deployed = []
for (const t of log.transactions) {
  if (t.transactionType !== 'CREATE') continue
  deployed.push({ name: t.contractName, address: t.contractAddress, initCode: t.transaction.input })
  for (const a of t.additionalContracts ?? []) {
    deployed.push({ name: a.contractName, address: a.address, initCode: a.initCode })
  }
}

const bytecodeCache = new Map()
function creationBytecode(target) {
  if (!bytecodeCache.has(target)) {
    const out = execFileSync('forge', ['inspect', target, 'bytecode'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
    bytecodeCache.set(target, out.trim().toLowerCase())
  }
  return bytecodeCache.get(target)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const index = [
  `ToshX v2 — manual verification inputs for chain ${CHAIN_ID}`,
  `Broadcast commit: ${log.commit ?? 'unknown'}`,
  '',
  'For each contract below, open the form link and choose:',
  '  Compiler type     Solidity (Standard-Json-Input)',
  `  Compiler version  ${COMPILER}`,
  '  License           MIT',
  'Upload the .standard-input.json, paste the .constructor-args.txt contents',
  '(without 0x if the form asks), and submit.',
  '',
]

let failed = 0
deployed.forEach((d, i) => {
  const n = String(i + 1).padStart(2, '0')
  const file = SOURCE[d.name]
  if (!file) {
    console.error(`FAIL  ${d.name} ${d.address}: no source path known for this contract`)
    failed++
    return
  }
  const target = `${file}:${d.name}`
  const code = creationBytecode(target)
  const init = d.initCode.toLowerCase()
  if (!init.startsWith(code)) {
    console.error(`FAIL  ${d.name} ${d.address}: this tree's bytecode is not the deployed one`)
    failed++
    return
  }
  const args = init.slice(code.length)

  const raw = execFileSync('forge', ['verify-contract', d.address, target, '--show-standard-json-input'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  })
  // Parsed before writing: on some failures forge prints a diagnostic to stdout.
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    console.error(`FAIL  ${d.name}: forge did not emit JSON:\n${raw.slice(0, 400)}`)
    failed++
    return
  }

  const stem = `${n}-${d.name}-${d.address.slice(2, 8).toLowerCase()}`
  writeFileSync(join(OUT, `${stem}.standard-input.json`), JSON.stringify(doc), 'utf8')
  writeFileSync(join(OUT, `${stem}.constructor-args.txt`), args ? `0x${args}\n` : '(none)\n', 'utf8')

  const line = `${n}  ${d.name.padEnd(20)} ${d.address}`
  console.log(line)
  index.push(line)
  index.push(`    upload   ${stem}.standard-input.json  (viaIR ${doc.settings.viaIR}, runs ${doc.settings.optimizer.runs}, evm ${doc.settings.evmVersion})`)
  index.push(`    args     ${stem}.constructor-args.txt  (${args ? `${args.length / 2} bytes` : 'none'})`)
  index.push(`    form     ${EXPLORER}/verifyContract?a=${d.address}`)
  index.push('')
})

writeFileSync(join(OUT, '00-INDEX.txt'), index.join('\n'), 'utf8')
console.log(`\n${deployed.length - failed} of ${deployed.length} written to verify-input/ — see 00-INDEX.txt`)
if (failed) process.exitCode = 1
