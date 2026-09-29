#!/usr/bin/env node
/*
 * safeLaunchTx.mjs
 * ────────────────
 * Build the owner Safe's `createLaunch` or `launch` transaction as a Safe
 * Transaction Builder file, after checking everything that can be checked
 * without signing.
 *
 *   node scripts/safeLaunchTx.mjs create --name "Foo" --symbol FOO \
 *        --developer 0x… --hard-cap 1000 --wallet-cap 46.4 --duration 24h
 *   node scripts/safeLaunchTx.mjs launch --hook 0x…
 *
 *   [--factory 0x…] [--rpc url] [--out file.json]
 *
 * Caps are whole BEM (8 decimals); `--hard-cap none` launches with no cap. `--duration` is 3h, 24h or 72h. The output
 * is imported in the Safe web app under Transaction Builder → "drag and drop";
 * the owners then sign and execute it as usual. Nothing here holds a key or
 * broadcasts.
 *
 * ── Why the Safe matters to the salt ────────────────────────────────────────
 *
 * The factory binds each hook address to `msg.sender`
 * (`finalSalt = keccak256(abi.encode(msg.sender, hookSalt))`), and the caller
 * is always the owner Safe. The predicted hook address printed here therefore
 * holds only when THIS Safe executes THIS file. A file built against one Safe
 * and executed from another still launches, at a different address.
 *
 * ── Why a file and not the launch page ──────────────────────────────────────
 *
 * The launch page sends from the connected wallet and waits for a receipt. A
 * Safe returns a pending safeTxHash instead, possibly days before execution,
 * so the page's receipt-driven flow has nothing to wait on. This script is the
 * multisig route; the page is for a single-key owner.
 */

import { writeFileSync } from 'node:fs'
import {
  createPublicClient, http, parseAbi, encodeFunctionData, encodeAbiParameters,
  keccak256, parseUnits, formatUnits, getAddress, isAddress,
} from 'viem'

import { loadRoleEnv } from './loadRoleEnv.mjs'
import {
  computeHookInitcodeHash, pickHookSalt,
  GENESIS_DURATION_FAST, GENESIS_DURATION_STANDARD, GENESIS_DURATION_SLOW,
} from '../soat-frontend/src/app/lib/hookAddress.ts'

const FACTORY_ABI = parseAbi([
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function hookImplementation() view returns (address)',
  'function MIN_HARD_CAP() view returns (uint256)',
  'function MAX_HARD_CAP() view returns (uint256)',
  'function UNCAPPED() view returns (uint256)',
  'function nameTaken(bytes32) view returns (bool)',
  'function registeredHooks(address) view returns (bool)',
  'function hookInitcodeHash(address projectTreasury, address creator, uint256 hardCap, uint256 perWalletCap, uint256 genesisDuration) view returns (bytes32)',
  'function createLaunch(string name, string symbol, address developer, bytes32 hookSalt, uint256 hardCap, uint256 walletCap, uint256 genesisDuration) returns (address token, address hook)',
  'function launch(address hook)',
  // Revert reasons `simulateContract` should decode, factory and hook both.
  'error OwnableUnauthorizedAccount(address account)',
  'error EnforcedPause()',
  'error HookNotRegistered()',
  'error InvalidDeveloper()',
  'error HardCapTooLow()',
  'error HardCapTooHigh()',
  'error InvalidWalletCap()',
  'error NameTaken()',
  'error EmptyName()',
  'error DeployFailed()',
  'error TokenBelowQuoteAsset()',
  'error OnlyFactory()',
  'error GenesisActive()',
  'error AlreadyLaunched()',
  'error ZeroAmount()',
  'error LaunchWindowExpired()',
  'error RaiseTooSmallForLadder()',
  'error InvalidDuration()',
])

const HOOK_ABI = parseAbi([
  'function launched() view returns (bool)',
  'function genesisDeadline() view returns (uint256)',
  'function LAUNCH_WINDOW() view returns (uint256)',
  'function totalNativeDeposited() view returns (uint256)',
  'function ladderViable() view returns (bool)',
])

const DURATIONS = { '3h': GENESIS_DURATION_FAST, '24h': GENESIS_DURATION_STANDARD, '72h': GENESIS_DURATION_SLOW }

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1]
  return fallback
}

const bem = (v) => `${formatUnits(v, 8)} BEM`

/** The decoded custom error when viem found one, else its one-line message. */
function revertReason(e) {
  let c = e
  while (c) {
    if (c.data?.errorName) return `${c.data.errorName}(${(c.data.args ?? []).join(', ')})`
    c = c.cause
  }
  return (e.shortMessage ?? e.message ?? '').split('\n')[0]
}
const stamp = (t) => new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z'

let failed = 0
function check(label, pass, detail) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failed++
  return pass
}

function usage() {
  console.error('usage: node scripts/safeLaunchTx.mjs create --name N --symbol S --developer 0x… --hard-cap BEM --wallet-cap BEM --duration 3h|24h|72h')
  console.error('       node scripts/safeLaunchTx.mjs launch --hook 0x…')
  console.error('       [--factory 0x…] [--rpc url] [--out file.json]')
  return 2
}

/** Safe Transaction Builder batch, one plain CALL from the Safe. */
function builderFile({ chainId, safe, to, data, name, description }) {
  return {
    version: '1.0',
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: {
      name,
      description,
      txBuilderVersion: '1.16.5',
      createdFromSafeAddress: safe,
      createdFromOwnerAddress: '',
    },
    transactions: [{ to, value: '0', data, contractMethod: null, contractInputsValues: null }],
  }
}

async function main() {
  const mode = process.argv[2]
  if (mode !== 'create' && mode !== 'launch') return usage()

  loadRoleEnv(['BSC_RPC', 'FACTORY_ADDRESS'])
  const rpc = arg('rpc', process.env.BSC_RPC)
  const factoryArg = arg('factory', process.env.FACTORY_ADDRESS)
  if (!rpc) { console.error('✗ no RPC: pass --rpc or set BSC_RPC.'); return 2 }
  if (!factoryArg || !isAddress(factoryArg)) { console.error('✗ no factory: pass --factory or set FACTORY_ADDRESS.'); return 2 }
  const factory = getAddress(factoryArg)

  const pub = createPublicClient({ transport: http(rpc) })
  const chainId = await pub.getChainId()
  const read = (functionName, args = []) => pub.readContract({ address: factory, abi: FACTORY_ABI, functionName, args })

  const owner = getAddress(await read('owner'))
  const ownerCode = await pub.getCode({ address: owner })
  console.log(`chain ${chainId} · factory ${factory}`)
  console.log(`owner ${owner} (${ownerCode && ownerCode !== '0x' ? 'contract — expected the Safe' : 'EOA'})\n`)
  if (!ownerCode || ownerCode === '0x') {
    console.log('note  the owner is an EOA, so it can sign directly — the launch page or cast work too.\n')
  }

  let file, summary
  if (mode === 'create') {
    ;({ file, summary } = await buildCreate({ pub, read, factory, owner, chainId }))
  } else {
    ;({ file, summary } = await buildLaunch({ pub, read, factory, owner, chainId }))
  }
  if (!file) return 1

  if (failed > 0) {
    console.error(`\n✗ ${failed} check(s) failed. No file written.`)
    return 1
  }

  const out = arg('out', `safe-${mode}-${Date.now()}.json`)
  writeFileSync(out, JSON.stringify(file, null, 2))
  console.log(`\n${summary}`)
  console.log(`\n✓ wrote ${out}`)
  console.log('  Safe web app → Apps → Transaction Builder → drag the file in → review → create batch → sign.')
  return 0
}

async function buildCreate({ pub, read, factory, owner, chainId }) {
  const name = arg('name')
  const symbol = arg('symbol')
  const developerArg = arg('developer')
  const hardCapArg = arg('hard-cap')
  const walletCapArg = arg('wallet-cap')
  const durationArg = arg('duration')
  if (!name || !symbol || !developerArg || !hardCapArg || !walletCapArg || !durationArg) {
    usage()
    return {}
  }

  check('developer is an address', isAddress(developerArg), developerArg)
  const duration = DURATIONS[durationArg]
  check('duration is 3h, 24h or 72h', duration !== undefined, durationArg)
  if (failed) return {}
  const developer = getAddress(developerArg)
  check('developer is not the zero address', developer !== '0x0000000000000000000000000000000000000000')

  // `--hard-cap none` (or 0): no cap, the round runs to its deadline. The
  // factory stores it as UNCAPPED, and its hookInitcodeHash maps 0 the same
  // way, so the local hash below must be computed from the stored value.
  const uncapped = hardCapArg === 'none' || Number(hardCapArg) === 0
  const hardCap = uncapped ? 0n : parseUnits(hardCapArg, 8)
  const walletCap = parseUnits(walletCapArg, 8)
  const [minHard, maxHard, paused, implementation, storedUncapped] = await Promise.all([
    read('MIN_HARD_CAP'), read('MAX_HARD_CAP'), read('paused'), read('hookImplementation'), read('UNCAPPED'),
  ])
  check('factory is not paused', paused === false)
  if (uncapped) {
    check('wallet cap is non-zero and at most MAX_HARD_CAP (no hard cap)',
      walletCap > 0n && walletCap <= maxHard, `${bem(walletCap)} (at most ${bem(maxHard)})`)
  } else {
    check('hard cap within MIN_HARD_CAP..MAX_HARD_CAP', hardCap >= minHard && hardCap <= maxHard,
      `${bem(hardCap)} (allowed ${bem(minHard)} – ${bem(maxHard)})`)
    check('wallet cap is non-zero and at most the hard cap', walletCap > 0n && walletCap <= hardCap, bem(walletCap))
  }
  const storedHardCap = uncapped ? storedUncapped : hardCap
  const hardCapText = uncapped ? 'none (runs to the deadline)' : bem(hardCap)
  check('symbol is upper-case', symbol === symbol.toUpperCase(), symbol)

  const nameKey = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [name, symbol]))
  check('name + symbol are not taken', (await read('nameTaken', [nameKey])) === false, `${name} / ${symbol}`)

  // The hook's `creator` is `msg.sender`, i.e. the owner Safe.
  const chainHash = await read('hookInitcodeHash', [developer, owner, hardCap, walletCap, duration])
  const localHash = computeHookInitcodeHash(implementation, owner, developer, storedHardCap, walletCap, duration)
  check('local initcode hash matches the factory', chainHash === localHash)

  let rawSalt, predicted
  for (let i = 0; i < 8; i++) {
    const c = pickHookSalt(factory, owner, chainHash)
    const code = await pub.getCode({ address: c.hookAddress })
    if (!code || code === '0x') { rawSalt = c.rawSalt; predicted = c.hookAddress; break }
  }
  if (!check('found an unoccupied hook address', rawSalt !== undefined)) return {}

  const args = [name, symbol, developer, rawSalt, hardCap, walletCap, duration]
  try {
    const { result } = await pub.simulateContract({
      address: factory, abi: FACTORY_ABI, functionName: 'createLaunch', args, account: owner,
    })
    check('createLaunch simulates from the owner', getAddress(result[1]) === getAddress(predicted),
      `hook ${result[1]}`)
  } catch (e) {
    check('createLaunch simulates from the owner', false, revertReason(e))
  }

  const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createLaunch', args })
  return {
    file: builderFile({
      chainId, safe: owner, to: factory, data,
      name: `createLaunch ${symbol}`,
      description: `${name} (${symbol}) · developer ${developer} · hard cap ${hardCapText} · wallet cap ${bem(walletCap)} · ${durationArg} · predicted hook ${predicted}`,
    }),
    summary: [
      `createLaunch("${name}", "${symbol}")`,
      `  developer      ${developer}   (receives the Circuit NFT)`,
      `  hard cap       ${hardCapText}`,
      `  wallet cap     ${bem(walletCap)}`,
      `  duration       ${durationArg}  (genesis window starts at execution)`,
      `  salt           ${rawSalt}`,
      `  predicted hook ${predicted}`,
      '  ⚠ the prediction holds only if this Safe executes this exact file.',
    ].join('\n'),
  }
}

async function buildLaunch({ pub, read, factory, owner, chainId }) {
  const hookArg = arg('hook')
  if (!hookArg || !isAddress(hookArg)) { usage(); return {} }
  const hook = getAddress(hookArg)
  const hr = (functionName) => pub.readContract({ address: hook, abi: HOOK_ABI, functionName })

  check('hook is registered on this factory', (await read('registeredHooks', [hook])) === true)
  if (failed) return {}

  const [launched, deadline, window, raised, viable, block] = await Promise.all([
    hr('launched'), hr('genesisDeadline'), hr('LAUNCH_WINDOW'), hr('totalNativeDeposited'), hr('ladderViable'),
    pub.getBlock(),
  ])
  const now = block.timestamp
  const closes = deadline + window
  check('not launched yet', launched === false)
  check('genesis window has closed', now > deadline, `deadline ${stamp(deadline)}`)
  check('launch window still open', now <= closes, `closes ${stamp(closes)}`)
  check('raise can carry the ladder', viable === true, `raised ${bem(raised)}`)

  try {
    await pub.simulateContract({ address: factory, abi: FACTORY_ABI, functionName: 'launch', args: [hook], account: owner })
    check('launch simulates from the owner', true)
  } catch (e) {
    check('launch simulates from the owner', false, revertReason(e))
  }

  const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: 'launch', args: [hook] })
  return {
    file: builderFile({
      chainId, safe: owner, to: factory, data,
      name: `launch ${hook}`,
      description: `factory.launch(${hook}) · raised ${bem(raised)} · window closes ${stamp(closes)}`,
    }),
    summary: [
      `launch(${hook})`,
      `  raised         ${bem(raised)}`,
      `  window closes  ${stamp(closes)} — the Safe must EXECUTE before this, not just sign`,
    ].join('\n'),
  }
}

process.exitCode = await main().catch((e) => {
  console.error('✗ ' + (e.shortMessage ?? e.message ?? e))
  return 1
})
