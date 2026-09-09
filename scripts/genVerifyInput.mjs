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
 *
 * TRAP IN THIS FILE, found the hard way: `transactions[].hash` does NOT belong
 * to the entry it sits in. In the 4663 log, `transactions[1]` is the ToshFactory
 * CREATE and carries `0xbcec476c…`, which on chain is a 36-byte
 * `setFactory(address)` call; the real factory CREATE is `0x0eed646b…`, filed
 * under `transactions[4]` and labelled a treasury CALL. `receipts[]` IS aligned
 * positionally and is the authoritative mapping. This script therefore uses
 * `contractAddress` and `arguments`, which live on the entry and are correct,
 * and never `hash`.
 */
const BROADCAST = join(ROOT, 'broadcast', 'DeployMainnet.s.sol', '4663', 'run-latest.json')

/**
 * Three contracts, not two. PM-C4 named the factory and the treasury; the
 * factory also links `HookDeployLib`, which `forge script` deploys through the
 * canonical CREATE2 proxy at `0x4e59b448…` rather than as a transaction from the
 * deployer — which is why it never appears in `transactions[]`, why the deployer's
 * nonce sequence skips it, and why nobody noticed it existed on mainnet.
 *
 * It is not a live attack surface: both call sites are in the factory's
 * constructor, and the deployed factory's runtime code contains zero references
 * to the library address. Verifying it is an audit-trail concern rather than a
 * safety one — `deployImplementation` is what burned `platformTreasury` into the
 * hook's `platformFeeRecipient` immutable, which is permanent and takes 0.30 % of
 * every buy forever, so a reader tracing where that value came from ends up here.
 */
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
  {
    name: 'HookDeployLib',
    target: 'src/libraries/HookDeployLib.sol:HookDeployLib',
    ctorTypes: [],
    // Deployed by the CREATE2 proxy, so it is not a `CREATE` entry and its
    // address has to come from the `libraries` field instead.
    fromLibraries: true,
  },
]

const log = JSON.parse(
  execFileSync('node', ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(BROADCAST)})))`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
)
const { transactions, libraries = [] } = log

/**
 * `forge inspect … bytecode` leaves an unlinked `__$<hash>$__` placeholder where
 * the library address goes, and `--show-standard-json-input` emits
 * `settings.libraries` empty. Blockscout accepts that anyway — it matches the
 * placeholder positionally against whatever 20 bytes are on chain — so the
 * factory verifies as an exact match with this field blank. It is filled in
 * regardless, because a submission that states its link explicitly does not
 * depend on the verifier's heuristic, and because the verified page then records
 * WHICH library the factory was linked against instead of leaving a reader to
 * find that out for themselves.
 */
function libraryLinks() {
  const out = {}
  for (const entry of libraries) {
    const [file, name, address] = entry.split(':')
    out[file] ??= {}
    out[file][name] = address
  }
  return out
}

mkdirSync(OUT, { recursive: true })

console.log('Blockscout standard-JSON inputs for chain 4663\n')

const links = libraryLinks()

for (const c of CONTRACTS) {
  let address
  if (c.fromLibraries) {
    const entry = libraries.find((l) => l.includes(`:${c.name}:`))
    address = entry?.split(':')[2]
  } else {
    address = transactions.find(
      (t) => t.transactionType === 'CREATE' && t.contractName === c.name,
    )?.contractAddress
  }
  if (!address) {
    console.error(`FAIL  no deployment record for ${c.name} in the broadcast log`)
    process.exitCode = 1
    continue
  }
  const created = c.fromLibraries
    ? { contractAddress: address, arguments: null }
    : transactions.find((t) => t.transactionType === 'CREATE' && t.contractName === c.name)

  const raw = execFileSync(
    'forge',
    ['verify-contract', address, c.target, '--show-standard-json-input'],
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

  // Narrowed deliberately. An earlier pass wrote the link into all three
  // documents, which is wrong twice over: `ToshLadderTreasury` does not import
  // HookDeployLib at all (the file is absent from its 25 sources, and solc is
  // entitled to reject a link naming a source it was not given), and a library
  // does not link against itself. Inject only where the file is actually present
  // and is not the contract being verified.
  const applicable = Object.fromEntries(
    Object.entries(links).filter(([file, names]) =>
      file in doc.sources && !Object.keys(names).includes(c.name),
    ),
  )
  if (Object.keys(applicable).length) doc.settings.libraries = applicable

  const path = join(OUT, `${c.name}.json`)
  writeFileSync(path, JSON.stringify(doc), 'utf8')

  const args = created.arguments?.length
    ? execFileSync(
        'cast',
        ['abi-encode', `constructor(${c.ctorTypes.join(',')})`, ...created.arguments],
        { cwd: ROOT, encoding: 'utf8' },
      ).trim()
    : '(none)'

  console.log(`${c.name}`)
  console.log(`  address           ${address}`)
  console.log(`  upload            verify-input/${c.name}.json  (${statSync(path).size.toLocaleString()} bytes, UTF-8)`)
  console.log(`  contract name     ${c.target.split(':')[1]}`)
  console.log(`  compiler          v0.8.26 (pick the exact build the form lists)`)
  console.log(`  viaIR             ${doc.settings.viaIR}   optimizer ${doc.settings.optimizer.enabled}/${doc.settings.optimizer.runs}   evm ${doc.settings.evmVersion}`)
  console.log(`  sources           ${Object.keys(doc.sources).length} files`)
  console.log(`  libraries         ${JSON.stringify(doc.settings.libraries ?? {})}`)
  console.log(`  constructor args  ${args}`)
  console.log(`  form              https://robinhoodchain.blockscout.com/address/${address}/contract-verification`)
  console.log()
}

console.log('Pick "Solidity (Standard JSON input)". The constructor arguments go in')
console.log('the separate field WITHOUT the leading 0x if the form strips it — Blockscout')
console.log('accepts both, but reports a mismatch rather than a format error when wrong.')
console.log('HookDeployLib takes no constructor arguments; leave that field empty.')
