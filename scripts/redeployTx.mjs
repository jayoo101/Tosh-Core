#!/usr/bin/env node
/*
 * redeployTx.mjs — the deploy-day reads and Safe batches for the BSC 56 WBNB
 * redeploy (docs/BNB_QUOTE_MIGRATION_zh.md, docs/DEPLOY_DAY_RUNBOOK_zh.md).
 *
 *   check   --factory 0x… --treasury 0x… --stage deployed|handed|live [--deploy-block N]
 *           Read-only. Proves the pair is this build (selectors, constants,
 *           wiring, WBNB everywhere), that ownership / pause match the named
 *           stage, and — at deployed and handed, where --deploy-block is
 *           required — that the deployer key did nothing but deploy, pause and
 *           hand off while it owned them (event audit from N; LOGS_RPC when
 *           the main RPC refuses eth_getLogs).
 *
 *   handoff --factory 0x… --treasury 0x…
 *           Transaction Builder batch, one Safe signature round:
 *             pause() on every retired factory still unpaused
 *               (direct when the Safe owns it, gateway.execute(pause()) when a
 *                ToshLaunchGateway does)
 *             new factory acceptOwnership()
 *             new treasury acceptOwnership()
 *
 *   unpause --factory 0x…
 *           Transaction Builder batch: new factory unpause().
 *
 *   list    --factory 0x… --treasury 0x… --token 0x…
 *           Transaction Builder batch: new treasury addLadderToken(token).
 *           The token must come from the NEW factory. Launches on the retired
 *           BEM factories are priced in BEM and stay with their own treasuries;
 *           a WBNB treasury refuses their pools (InvalidPoolKey).
 *
 * The new addresses are always passed explicitly. `.env.production` still
 * names the BEM factory as FACTORY_ADDRESS until the frontend switches, so
 * falling back to it would build a batch against the contract being retired.
 *
 * Every batch call is simulated as the Safe (eth_call from the Safe address)
 * before the file is written; a call the Safe could not make writes nothing.
 */

import { writeFileSync } from 'node:fs'
import {
  createPublicClient, http, parseAbi, encodeFunctionData, getAddress, isAddress,
  toFunctionSelector, zeroAddress, decodeEventLog,
} from 'viem'

import { loadRoleEnv } from './loadRoleEnv.mjs'

/** Every factory this redeploy retires. Pausing blocks createLaunch and
 *  registerPoG only; deposits, refunds, launch() and claims on their projects
 *  keep working. */
const RETIRED_FACTORIES = [
  { label: 'BEM factory', address: '0xBCa66f7382aaC0C6EE2b833fc2072CA607367f2c' },
  { label: 'first factory', address: '0x20dE906A96FfB89BE6fd6267A0876A68017792F7' },
]
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const UNCAPPED = (1n << 128n) - 1n
const E18 = 10n ** 18n

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
  'function QUOTE_UNIT() view returns (uint256)',
  'function MIN_HARD_CAP() view returns (uint256)',
  'function MAX_HARD_CAP() view returns (uint256)',
  'function MAX_POG_ALLOCATION_LIMIT() view returns (uint256)',
  'function maxPogAllocationLimit() view returns (uint256)',
])
const GATEWAY = parseAbi([
  'function factory() view returns (address)',
  'function safe() view returns (address)',
  'function execute(bytes data) returns (bytes)',
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

/** Every event the new factory and treasury can emit. All owner-only calls
 *  emit one, so the log is a complete record of what the deployer key did. */
const EVENTS = parseAbi([
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event Paused(address account)',
  'event Unpaused(address account)',
  'event LaunchCreated(uint256 indexed launchId, address indexed token, address indexed hook, address developer, string name, string symbol)',
  'event Blacklisted(address indexed user, uint256 untilTimestamp)',
  'event PoGRegistered(address indexed user, uint256 quota)',
  'event GenesisDeposit(address indexed user, address indexed hook, uint256 amount, address indexed referrer, address lifetimeReferrer)',
  'event ReferralBound(address indexed user, address indexed referrer)',
  'event ProjectReferralBound(address indexed user, address indexed hook, address indexed referrer)',
  'event PogSignerUpdated(address indexed newSigner)',
  'event CooldownDurationUpdated(uint256 duration)',
  'event QuotaWindowDurationUpdated(uint256 duration)',
  'event MaxPogAllocationLimitUpdated(uint256 newLimit)',
  'event CircuitIssued(uint256 indexed tokenId, address indexed hook, address indexed developer, address vault)',
  'event QuotaWindowReset(address indexed user, uint256 windowEnd)',
  'event NameReleased(address indexed hook, bytes32 indexed nameKey)',
  'event LadderMintingHalted(address indexed hook, uint256 until)',
  'event LadderMintingResumed(address indexed hook)',
  'event DepositsPausedSet(address indexed hook, bool paused)',
  'event FactorySet(address indexed factory)',
  'event LadderTokenAdded(address indexed token, uint256 index)',
  'event LadderTokenRemoved(address indexed token, uint256 index)',
  'event TaxReceived(address indexed from, uint256 amount)',
  'event PiggybackExecuted(uint256 nativeSpent, uint256 tokensServiced, uint256 newCursor)',
  'event BuybackBurned(address indexed token, uint256 nativeIn, uint256 tokensBurned)',
  'event BuybackSkipped(address indexed token, uint256 nativeIn)',
])
/** Not owner actions: anyone can pay tax in, and the buyback runs from hooks. */
const PASSIVE = new Set(['TaxReceived', 'PiggybackExecuted', 'BuybackBurned', 'BuybackSkipped'])
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
  console.error('usage: node scripts/redeployTx.mjs check   --factory 0x… --treasury 0x… --stage deployed|handed|live [--deploy-block N]')
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

/**
 * The call that pauses `factory` when sent from the Safe, or null after a
 * FAIL line. A factory behind a ToshLaunchGateway is owned by the gateway,
 * and only `gateway.execute` (onlySafe) can reach its owner-gated surface.
 */
async function pauseCall(read, safe, { label, address }) {
  const owner = getAddress(await read(address, OWNABLE, 'owner'))
  const pauseData = encodeFunctionData({ abi: FACTORY, functionName: 'pause' })
  if (same(owner, safe)) {
    return { label: `${label} ${address}.pause()`, to: address, data: pauseData }
  }
  let gwFactory, gwSafe
  try {
    ;[gwFactory, gwSafe] = await Promise.all([read(owner, GATEWAY, 'factory'), read(owner, GATEWAY, 'safe')])
  } catch {
    check(`${label} is owned by the Safe or by a gateway the Safe controls`, false, `owner ${owner}`)
    return null
  }
  if (!check(`${label} gateway ${owner} fronts this factory for this Safe`, same(gwFactory, address) && same(gwSafe, safe),
    `gateway.factory ${gwFactory}, gateway.safe ${gwSafe}`)) return null
  return {
    label: `${label} ${address}.pause() via gateway ${owner}.execute`,
    to: owner,
    data: encodeFunctionData({ abi: GATEWAY, functionName: 'execute', args: [pauseData] }),
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
  const retired = RETIRED_FACTORIES.find(r => same(r.address, factory))
  if (retired) { console.error(`✗ --factory is the retired ${retired.label}.`); return 2 }

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
    check('new factory quoteAsset() is WBNB', same(await read(factory, FACTORY, 'quoteAsset'), WBNB))

    for (const r of RETIRED_FACTORIES) {
      if (await read(r.address, FACTORY, 'paused')) {
        console.log(`note  ${r.label} ${r.address} is already paused — left out of the batch`)
        continue
      }
      const c = await pauseCall(read, safe, r)
      if (c) calls.push(c)
    }
    calls.push({ label: `new factory ${factory}.acceptOwnership()`, to: factory, data: encodeFunctionData({ abi: OWNABLE, functionName: 'acceptOwnership' }) })
    calls.push({ label: `new treasury ${treasury}.acceptOwnership()`, to: treasury, data: encodeFunctionData({ abi: OWNABLE, functionName: 'acceptOwnership' }) })
    name = 'Tosh WBNB redeploy · handoff'
    description = calls.map(c => c.label).join('; ')
  } else if (mode === 'list') {
    const treasury = addrArg('treasury')
    const token = addrArg('token')
    console.log(`treasury ${treasury}\ntoken    ${token}\n`)
    check('new treasury owner is the Safe', same(await read(treasury, OWNABLE, 'owner'), safe))
    check('new treasury is bound to the new factory', same(await read(treasury, TREASURY, 'factory'), factory))
    check('token is not listed yet', !(await read(treasury, TREASURY, 'isLadderToken', [token])))
    const newHook = await read(factory, REGISTRY, 'tokenToHook', [token])
    check('token was launched by the new factory', !same(newHook, zeroAddress),
      same(newHook, zeroAddress) ? 'not a launch of this factory; BEM-era tokens stay with their own treasury' : `hook ${newHook}`)
    calls.push({ label: `new treasury ${treasury}.addLadderToken(${token})`, to: treasury, data: encodeFunctionData({ abi: TREASURY, functionName: 'addLadderToken', args: [token] }) })
    name = 'Tosh WBNB redeploy · list token on new treasury'
    description = calls[0].label
  } else {
    console.log('')
    check('new factory owner is the Safe', same(await read(factory, OWNABLE, 'owner'), safe))
    check('new factory pendingOwner is empty', same(await read(factory, OWNABLE, 'pendingOwner'), zeroAddress))
    check('new factory is currently paused', await read(factory, FACTORY, 'paused'))
    calls.push({ label: `new factory ${factory}.unpause()`, to: factory, data: encodeFunctionData({ abi: FACTORY, functionName: 'unpause' }) })
    name = 'Tosh WBNB redeploy · unpause new factory'
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
  check('factory has depositNative(address,address)', has(factoryCode, 'function depositNative(address,address)'))
  check('factory has setDepositsPaused(address,bool)', has(factoryCode, 'function setDepositsPaused(address,bool)'))
  check('factory has setPogQuota(address[],uint256)', has(factoryCode, 'function setPogQuota(address[],uint256)'))
  check('factory UNCAPPED() == 2^128 - 1', (await read(factory, FACTORY, 'UNCAPPED')) === UNCAPPED)
  check('factory QUOTE_UNIT() == 1e18', (await read(factory, FACTORY, 'QUOTE_UNIT')) === E18)
  check('factory MIN_HARD_CAP() == 1 BNB', (await read(factory, FACTORY, 'MIN_HARD_CAP')) === E18)
  check('factory MAX_HARD_CAP() == 500 BNB', (await read(factory, FACTORY, 'MAX_HARD_CAP')) === 500n * E18)
  check('factory MAX_POG_ALLOCATION_LIMIT() == 500 BNB', (await read(factory, FACTORY, 'MAX_POG_ALLOCATION_LIMIT')) === 500n * E18)
  const walletCap = await read(factory, FACTORY, 'maxPogAllocationLimit')
  check('factory maxPogAllocationLimit() == 1.3 BNB (deploy default)', walletCap === 13n * E18 / 10n,
    `${walletCap} wei — a later setMaxPogAllocationLimit makes this an expected FAIL`)
  check('treasury TRIGGER_STEP() == 0.3 BNB', (await read(treasury, TREASURY, 'TRIGGER_STEP')) === 3n * E18 / 10n)
  check('treasury SPEND_BPS() == 5000', (await read(treasury, TREASURY, 'SPEND_BPS')) === 5000n)

  console.log('— wiring')
  check('factory.ladderTreasury() is the new treasury', same(await read(factory, FACTORY, 'ladderTreasury'), treasury))
  check('treasury.factory() is the new factory', same(await read(treasury, TREASURY, 'factory'), factory))
  check('treasury.legacyFactory() is unset (BEM-era launches cannot be listed)',
    same(await read(treasury, TREASURY, 'legacyFactory'), zeroAddress))
  check('hook implementation factory() is the new factory', same(await read(impl, HOOK, 'factory'), factory))
  for (const [label, addr, abi] of [['factory', factory, FACTORY], ['treasury', treasury, TREASURY], ['hook implementation', impl, HOOK]]) {
    check(`${label} quoteAsset() is WBNB`, same(await read(addr, abi, 'quoteAsset'), WBNB))
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
    for (const r of RETIRED_FACTORIES) {
      check(`${r.label} ${r.address} is paused`, await read(r.address, FACTORY, 'paused'))
    }
    check(stage === 'handed' ? 'new factory is still paused' : 'new factory is unpaused', stage === 'handed' ? paused : !paused)
  }

  if (stage !== 'live') await auditDeployerWindow({ pub, factory, treasury, safe })

  console.log(failed ? `\n✗ ${failed} check(s) failed.` : '\n✓ all checks passed.')
  return failed ? 1 : 0
}

async function getLogsChunked(pub, address, fromBlock, toBlock) {
  const logs = []
  let step = 5000n
  for (let start = fromBlock; start <= toBlock;) {
    const end = start + step - 1n > toBlock ? toBlock : start + step - 1n
    try {
      logs.push(...await pub.getLogs({ address, fromBlock: start, toBlock: end }))
      start = end + 1n
    } catch (e) {
      if (step <= 50n) throw e
      step /= 4n
    }
  }
  return logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)))
}

/**
 * The deployer key owns both contracts from the broadcast until the Safe's
 * acceptOwnership(). The stage checks above read end state, which misses an
 * owner who acted and then put things back: re-pointed the pending owner, or
 * unpaused, created a launch, granted PoG quota or listed a token, and paused
 * again. Every owner-only call emits an event, so this walks both contracts'
 * logs from the deploy block and allows, before the Safe owns a contract, only
 * the deploy itself, pause(), setFactory and transfers to the Safe.
 */
async function auditDeployerWindow({ pub, factory, treasury, safe }) {
  console.log('— deployer window (every event since the deploy block)')
  const fromArg = arg('deploy-block')
  if (!check('--deploy-block given', /^\d+$/.test(fromArg ?? ''),
    'the first receipt\'s blockNumber in broadcast/DeployMainnet.s.sol/56/run-latest.json')) return
  const fromBlock = BigInt(fromArg)
  const toBlock = await pub.getBlockNumber()
  const expectedDeployer = process.env.DEPLOYER_ADDRESS

  // bsc-dataseed answers every eth_getLogs with "Request exceeds defined limit",
  // whatever the range; publicnode serves 5000-block ranges over recent blocks.
  const logsUrl = process.env.LOGS_RPC ?? 'https://bsc-rpc.publicnode.com'
  const logsPub = createPublicClient({ transport: http(logsUrl, { retryCount: 4, retryDelay: 800 }) })
  for (const [label, address] of [['factory', factory], ['treasury', treasury]]) {
    let logs
    try {
      logs = await getLogsChunked(pub, address, fromBlock, toBlock)
    } catch {
      try {
        logs = await getLogsChunked(logsPub, address, fromBlock, toBlock)
        console.log(`note  ${label} logs read from ${process.env.LOGS_RPC ? 'LOGS_RPC' : logsUrl}: the main RPC refuses eth_getLogs`)
      } catch (e) {
        check(`${label} logs readable from block ${fromBlock}`, false,
          `${(e.shortMessage ?? e.message ?? '').split('\n')[0]} — set LOGS_RPC to a node that serves eth_getLogs`)
        continue
      }
    }
    let owner = null
    let deployer = null
    const bad = []
    for (const log of logs) {
      let ev
      try {
        ev = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics })
      } catch {
        bad.push(`unrecognised event ${log.topics[0]} at block ${log.blockNumber}`)
        continue
      }
      const at = `${ev.eventName} at block ${log.blockNumber}`
      const safeOwns = same(owner, safe)
      if (ev.eventName === 'OwnershipTransferred') {
        if (owner === null && same(ev.args.previousOwner, zeroAddress)) {
          owner = deployer = ev.args.newOwner
        } else if (same(ev.args.newOwner, safe)) {
          owner = safe
        } else if (!safeOwns) {
          bad.push(`${at}: ownership moved to ${ev.args.newOwner}, not the Safe`)
          owner = ev.args.newOwner
        } else {
          owner = ev.args.newOwner
        }
      } else if (ev.eventName === 'OwnershipTransferStarted') {
        if (!safeOwns && !same(ev.args.newOwner, safe)) bad.push(`${at}: pending owner set to ${ev.args.newOwner}, not the Safe`)
      } else if (safeOwns || PASSIVE.has(ev.eventName)) {
        // the Safe's own actions, or nobody's
      } else if (ev.eventName === 'Paused') {
        // braking is always allowed
      } else if (ev.eventName === 'FactorySet' && same(ev.args.factory, factory)) {
        // the deploy binding the treasury
      } else {
        bad.push(`${at} while ${owner ?? 'nobody yet'} owned it, before the Safe`)
      }
    }
    check(`${label}: deployed by the expected key`, deployer !== null && (!expectedDeployer || same(deployer, expectedDeployer)),
      `${deployer ?? `no constructor OwnershipTransferred since block ${fromBlock}`}`)
    check(`${label}: nothing but deploy / pause / handoff before the Safe took over`, bad.length === 0,
      bad.length ? bad.slice(0, 6).join('; ') + (bad.length > 6 ? `; +${bad.length - 6} more` : '') : `${logs.length} event(s), blocks ${fromBlock}–${toBlock}`)
  }
}

main().then(code => { process.exitCode = code ?? 0 }, e => { console.error(e); process.exitCode = 1 })
