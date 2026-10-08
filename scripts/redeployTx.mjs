#!/usr/bin/env node
/*
 * redeployTx.mjs — the deploy-day reads and Safe batches for the BSC 56 redeploy
 * (docs/GENESIS_FEE_REDEPLOY_zh.md §7, steps 4–10).
 *
 *   check   --factory 0x… --treasury 0x… --stage deployed|handed|live
 *           Read-only. Proves the pair is this build (selectors, constants,
 *           wiring) and that ownership / pause match the named stage.
 *
 *   handoff --factory 0x… --treasury 0x…
 *           Transaction Builder batch, one Safe signature round:
 *             old factory pause()           (skipped if already paused)
 *             new factory acceptOwnership()
 *             new treasury acceptOwnership()
 *
 *   unpause --factory 0x…
 *           Transaction Builder batch: new factory unpause().
 *
 *   list    --factory 0x… --treasury 0x… --token 0x…
 *           Transaction Builder batch: new treasury addLadderToken(token).
 *           The token may come from the new factory or the old one (TO).
 *
 * The new addresses are always passed explicitly. `.env.production` still
 * names the OLD factory as FACTORY_ADDRESS, so falling back to it would build
 * a batch against the contract being retired.
 *
 * Every batch call is simulated as the Safe (eth_call from the Safe address)
 * before the file is written; a call the Safe could not make writes nothing.
 */

import { writeFileSync } from 'node:fs'
import {
  createPublicClient, http, parseAbi, encodeFunctionData, getAddress, isAddress,
  toFunctionSelector, zeroAddress,
} from 'viem'

import { loadRoleEnv } from './loadRoleEnv.mjs'

const OLD_FACTORY = '0x20dE906A96FfB89BE6fd6267A0876A68017792F7'
const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'
const UNCAPPED = (1n << 128n) - 1n

const OWNABLE = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function acceptOwnership()',
])
const FACTORY = parseAbi([
  'function paused() view returns (bool)',
  'function pause()',
  'function unpause()',
  'function hookImplementation() view returns (address)',
  'function circuitNFT() view returns (address)',
  'function ladderTreasury() view returns (address)',
  'function platformTreasury() view returns (address)',
  'function quoteAsset() view returns (address)',
  'function pogSigner() view returns (address)',
  'function UNCAPPED() view returns (uint256)',
])
const TREASURY = parseAbi([
  'function factory() view returns (address)',
  'function legacyFactory() view returns (address)',
  'function quoteAsset() view returns (address)',
  'function TRIGGER_STEP() view returns (uint256)',
  'function SPEND_BPS() view returns (uint256)',
  'function isLadderToken(address) view returns (bool)',
  'function addLadderToken(address)',
])
const REGISTRY = parseAbi(['function tokenToHook(address) view returns (address)'])
const HOOK = parseAbi([
  'function factory() view returns (address)',
  'function quoteAsset() view returns (address)',
  'function platformFeeRecipient() view returns (address)',
])

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function addrArg(name) {
  const v = arg(name)
  if (!v || !isAddress(v)) {
    console.error(`✗ --${name} 0x… is required`)
    process.exit(2)
  }
  return getAddress(v)
}

let failed = 0
function check(label, pass, detail) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failed++
  return pass
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

function usage() {
  console.error('usage: node scripts/redeployTx.mjs check   --factory 0x… --treasury 0x… --stage deployed|handed|live')
  console.error('       node scripts/redeployTx.mjs handoff --factory 0x… --treasury 0x…')
  console.error('       node scripts/redeployTx.mjs unpause --factory 0x…')
  console.error('       node scripts/redeployTx.mjs list    --factory 0x… --treasury 0x… --token 0x…')
  console.error('       [--rpc url] [--out file.json]')
  return 2
}

function builderFile({ chainId, safe, name, description, calls }) {
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
    transactions: calls.map(({ to, data }) => ({
      to, value: '0', data, contractMethod: null, contractInputsValues: null,
    })),
  }
}

async function main() {
  const mode = process.argv[2]
  if (!['check', 'handoff', 'unpause', 'list'].includes(mode)) return usage()

  loadRoleEnv(['BSC_RPC', 'PROD_OWNER_SAFE', 'POG_SIGNER_ADDRESS', 'DEPLOYER_ADDRESS'])
  const rpc = arg('rpc') ?? process.env.BSC_RPC
  if (!rpc) { console.error('✗ no RPC: pass --rpc or set BSC_RPC.'); return 2 }
  const safe = getAddress(process.env.PROD_OWNER_SAFE ?? '')
  const factory = addrArg('factory')
  if (same(factory, OLD_FACTORY)) { console.error('✗ --factory is the OLD factory.'); return 2 }

  const pub = createPublicClient({ transport: http(rpc, { retryCount: 4, retryDelay: 800 }) })
  const chainId = await pub.getChainId()
  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args })
  check('chain is BSC 56', chainId === 56, `rpc answered ${chainId}`)
  console.log(`safe     ${safe}\nfactory  ${factory}`)

  if (mode === 'check') return runCheck({ pub, read, factory, safe })

  const calls = []
  let name, description
  if (mode === 'handoff') {
    const treasury = addrArg('treasury')
    console.log(`treasury ${treasury}\n`)
    check('new factory pendingOwner is the Safe', same(await read(factory, OWNABLE, 'pendingOwner'), safe))
    check('new treasury pendingOwner is the Safe', same(await read(treasury, OWNABLE, 'pendingOwner'), safe))
    check('new factory is paused (deployer paused it after the broadcast)', await read(factory, FACTORY, 'paused'))
    check('new treasury is bound to the new factory', same(await read(treasury, TREASURY, 'factory'), factory))
    check('old factory owner is the Safe', same(await read(OLD_FACTORY, OWNABLE, 'owner'), safe))

    if (await read(OLD_FACTORY, FACTORY, 'paused')) {
      console.log('note  old factory is already paused — pause() left out of the batch')
    } else {
      calls.push({ label: `old factory ${OLD_FACTORY}.pause()`, to: OLD_FACTORY, data: encodeFunctionData({ abi: FACTORY, functionName: 'pause' }) })
    }
    calls.push({ label: `new factory ${factory}.acceptOwnership()`, to: factory, data: encodeFunctionData({ abi: OWNABLE, functionName: 'acceptOwnership' }) })
    calls.push({ label: `new treasury ${treasury}.acceptOwnership()`, to: treasury, data: encodeFunctionData({ abi: OWNABLE, functionName: 'acceptOwnership' }) })
    name = 'Tosh redeploy · handoff'
    description = calls.map(c => c.label).join('; ')
  } else if (mode === 'list') {
    const treasury = addrArg('treasury')
    const token = addrArg('token')
    console.log(`treasury ${treasury}\ntoken    ${token}\n`)
    check('new treasury owner is the Safe', same(await read(treasury, OWNABLE, 'owner'), safe))
    check('new treasury is bound to the new factory', same(await read(treasury, TREASURY, 'factory'), factory))
    check('new treasury legacyFactory() is the old factory', same(await read(treasury, TREASURY, 'legacyFactory'), OLD_FACTORY))
    check('token is not listed yet', !(await read(treasury, TREASURY, 'isLadderToken', [token])))
    const [newHook, oldHook] = await Promise.all([
      read(factory, REGISTRY, 'tokenToHook', [token]), read(OLD_FACTORY, REGISTRY, 'tokenToHook', [token]),
    ])
    check('token was launched by the new or the old factory', !same(newHook, zeroAddress) || !same(oldHook, zeroAddress),
      same(newHook, zeroAddress) ? `old factory hook ${oldHook}` : `new factory hook ${newHook}`)
    calls.push({ label: `new treasury ${treasury}.addLadderToken(${token})`, to: treasury, data: encodeFunctionData({ abi: TREASURY, functionName: 'addLadderToken', args: [token] }) })
    name = 'Tosh redeploy · list token on new treasury'
    description = calls[0].label
  } else {
    console.log('')
    check('new factory owner is the Safe', same(await read(factory, OWNABLE, 'owner'), safe))
    check('new factory pendingOwner is empty', same(await read(factory, OWNABLE, 'pendingOwner'), zeroAddress))
    check('new factory is currently paused', await read(factory, FACTORY, 'paused'))
    calls.push({ label: `new factory ${factory}.unpause()`, to: factory, data: encodeFunctionData({ abi: FACTORY, functionName: 'unpause' }) })
    name = 'Tosh redeploy · unpause new factory'
    description = calls[0].label
  }

  // Each call on its own, as the Safe. A batch executes them in order, and none
  // of these depends on an earlier one in the same batch, so the solo
  // simulation is the batch's outcome.
  for (const c of calls) {
    try {
      await pub.call({ account: safe, to: c.to, data: c.data })
      check(`simulated as the Safe: ${c.label}`, true)
    } catch (e) {
      check(`simulated as the Safe: ${c.label}`, false, (e.shortMessage ?? e.message ?? '').split('\n')[0])
    }
  }

  if (failed > 0) {
    console.error(`\n✗ ${failed} check(s) failed. No file written.`)
    return 1
  }
  const out = arg('out') ?? `safe-${mode}-${Date.now()}.json`
  writeFileSync(out, JSON.stringify(builderFile({ chainId, safe, name, description, calls }), null, 2))
  console.log(`\nbatch (${calls.length} call${calls.length > 1 ? 's' : ''}):`)
  for (const c of calls) console.log(`  · ${c.label}`)
  console.log(`\n✓ wrote ${out}`)
  console.log('  Safe web app → Apps → Transaction Builder → drag the file in → review → Create batch → Send batch → sign.')
  return 0
}

async function runCheck({ pub, read, factory, safe }) {
  const treasury = addrArg('treasury')
  const stage = arg('stage')
  if (!['deployed', 'handed', 'live'].includes(stage)) return usage()
  console.log(`treasury ${treasury}\nstage    ${stage}\n`)

  const impl = getAddress(await read(factory, FACTORY, 'hookImplementation'))
  const [factoryCode, implCode] = await Promise.all([
    pub.getCode({ address: factory }), pub.getCode({ address: impl }),
  ])
  const has = (code, sig) => (code ?? '').toLowerCase().includes(toFunctionSelector(sig).slice(2))

  console.log('— this build')
  check('hook implementation has collectGenesisFees()', has(implCode, 'function collectGenesisFees()'), impl)
  check('factory has launch(address)', has(factoryCode, 'function launch(address)'))
  check('factory has setDepositsPaused(address,bool)', has(factoryCode, 'function setDepositsPaused(address,bool)'))
  check('factory has setPogQuota(address[],uint256)', has(factoryCode, 'function setPogQuota(address[],uint256)'))
  check('factory UNCAPPED() == 2^128 - 1', (await read(factory, FACTORY, 'UNCAPPED')) === UNCAPPED)
  check('treasury TRIGGER_STEP() == 1000000000 (10 BEM)', (await read(treasury, TREASURY, 'TRIGGER_STEP')) === 1_000_000_000n)
  check('treasury SPEND_BPS() == 5000', (await read(treasury, TREASURY, 'SPEND_BPS')) === 5000n)

  console.log('— wiring')
  check('factory.ladderTreasury() is the new treasury', same(await read(factory, FACTORY, 'ladderTreasury'), treasury))
  check('treasury.factory() is the new factory', same(await read(treasury, TREASURY, 'factory'), factory))
  check('treasury.legacyFactory() is the old factory (TO stays listable)', same(await read(treasury, TREASURY, 'legacyFactory'), OLD_FACTORY))
  check('hook implementation factory() is the new factory', same(await read(impl, HOOK, 'factory'), factory))
  for (const [label, addr, abi] of [['factory', factory, FACTORY], ['treasury', treasury, TREASURY], ['hook implementation', impl, HOOK]]) {
    check(`${label} quoteAsset() is BEM`, same(await read(addr, abi, 'quoteAsset'), BEM))
  }
  check('factory.platformTreasury() is the Safe', same(await read(factory, FACTORY, 'platformTreasury'), safe))
  check('hook platformFeeRecipient() is the Safe', same(await read(impl, HOOK, 'platformFeeRecipient'), safe))
  if (process.env.POG_SIGNER_ADDRESS) {
    check('factory.pogSigner() is POG_SIGNER_ADDRESS', same(await read(factory, FACTORY, 'pogSigner'), process.env.POG_SIGNER_ADDRESS))
  }
  const nft = await read(factory, FACTORY, 'circuitNFT')
  check('circuitNFT is deployed', ((await pub.getCode({ address: nft })) ?? '0x') !== '0x', nft)

  console.log(`— stage: ${stage}`)
  const fOwner = await read(factory, OWNABLE, 'owner')
  const tOwner = await read(treasury, OWNABLE, 'owner')
  const fPending = await read(factory, OWNABLE, 'pendingOwner')
  const tPending = await read(treasury, OWNABLE, 'pendingOwner')
  const paused = await read(factory, FACTORY, 'paused')
  const oldPaused = await read(OLD_FACTORY, FACTORY, 'paused')
  if (stage === 'deployed') {
    const deployer = process.env.DEPLOYER_ADDRESS
    check('factory owner is the deployer', same(fOwner, deployer), fOwner)
    check('treasury owner is the deployer', same(tOwner, deployer), tOwner)
    check('factory pendingOwner is the Safe', same(fPending, safe), fPending)
    check('treasury pendingOwner is the Safe', same(tPending, safe), tPending)
    check('new factory is paused', paused)
  } else {
    check('factory owner is the Safe', same(fOwner, safe), fOwner)
    check('treasury owner is the Safe', same(tOwner, safe), tOwner)
    check('factory pendingOwner is empty', same(fPending, zeroAddress), fPending)
    check('treasury pendingOwner is empty', same(tPending, zeroAddress), tPending)
    check('old factory is paused', oldPaused)
    check(stage === 'handed' ? 'new factory is still paused' : 'new factory is unpaused', stage === 'handed' ? paused : !paused)
  }

  console.log(failed ? `\n✗ ${failed} check(s) failed.` : '\n✓ all checks passed.')
  return failed ? 1 : 0
}

main().then(code => { process.exitCode = code ?? 0 }, e => { console.error(e); process.exitCode = 1 })
