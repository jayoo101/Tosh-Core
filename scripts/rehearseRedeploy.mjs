#!/usr/bin/env node
/*
 * rehearseRedeploy.mjs — the WBNB redeploy runbook (docs/DEPLOY_DAY_RUNBOOK_zh.md)
 * end to end on a local anvil fork of BSC 56, using the runbook's own commands.
 *
 *   node scripts/rehearseRedeploy.mjs [--fork-url url] [--port 8547] [--keep]
 *
 *   step 3–4   DeployMainnet dry run, then broadcast
 *   step 5     deployer pause(), redeployTx check --stage deployed
 *   step 6     redeployTx handoff → batch executed as the Safe,
 *              check --stage handed, VerifyDeployment (EXPECTED_PAUSED=true)
 *   step 10    redeployTx unpause → executed, check --stage live, VerifyDeployment
 *   step 12.5  DeployLaunchGateway, safeLaunchTx gateway-handoff → executed
 *   step 13    safeLaunchTx create (uncapped, 1.3 BNB wallet cap, 3h) → executed,
 *              PoG quota via gateway.execute(setPogQuota), depositNative ×2,
 *              time past the deadline, safeLaunchTx launch → executed
 *
 * The deployer is a throwaway key generated here and never printed: the deploy
 * script refuses anvil's well-known accounts, and the real deploy key stays with
 * its owner. Safe batches run through anvil_impersonateAccount, one CALL per
 * transaction from the Safe — what MultiSendCallOnly does after the signatures.
 *
 * Forge's broadcast logs go to a temp dir (FOUNDRY_BROADCAST) and the script
 * cache it writes under cache/<script>/56 is restored afterwards: runbook step 4
 * (--resume) and step 9 (deploy block) read those files, and they must keep
 * describing the real broadcast, not this one.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createPublicClient, createWalletClient, http, parseAbi, getAddress, parseEther, formatEther, encodeFunctionData,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { loadRoleEnv } from './loadRoleEnv.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const FORK_URL = arg('fork-url', 'https://bsc-dataseed.bnbchain.org')
const PORT = Number(arg('port', '8547'))
const RPC = `http://127.0.0.1:${PORT}`
const KEEP = process.argv.includes('--keep')
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

const FACTORY = parseAbi([
  'function pause()',
  'function paused() view returns (bool)',
  'function owner() view returns (address)',
  'function setPogQuota(address[] users, uint256 quota)',
  'function depositNative(address hook, address referrer) payable',
  'function registeredHooks(address) view returns (bool)',
])
const GATEWAY = parseAbi([
  'function execute(bytes data) returns (bytes)',
  'function canLaunch(address) view returns (bool)',
])
const HOOK = parseAbi([
  'function genesisDeadline() view returns (uint256)',
  'function totalNativeDeposited() view returns (uint256)',
  'function launched() view returns (bool)',
])
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

let failures = 0
const results = []
function record(step, ok, detail = '') {
  results.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const banner = (s) => console.log(`\n══ ${s} ${'═'.repeat(Math.max(0, 66 - s.length))}`)

// ── environment ─────────────────────────────────────────────────────────────
const ROLE_KEYS = ['INFINITY_CL_POOL_MANAGER', 'INFINITY_VAULT', 'POG_SIGNER_ADDRESS', 'PLATFORM_TREASURY', 'PROD_OWNER_SAFE']
const { missing } = loadRoleEnv(ROLE_KEYS)
if (missing.length) {
  console.error(`✗ missing ${missing.join(', ')} (environment or .env.production)`)
  process.exit(2)
}
const SAFE = getAddress(process.env.PROD_OWNER_SAFE)
const deployerKey = generatePrivateKey()
const deployer = privateKeyToAccount(deployerKey)

/** Env for every child. Everything a script reads is pinned here, so neither a
 *  stale shell export nor an auto-loaded .env can shadow a role. */
const broadcastDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosh-rehearse-'))
const childEnv = {
  ...process.env,
  FOUNDRY_BROADCAST: broadcastDir,
  TARGET_CHAIN_ID: '56',
  TARGET_RPC: RPC,
  BSC_RPC: RPC,
  QUOTE_ASSET: WBNB,
  LEGACY_FACTORY_ADDRESS: '0x0000000000000000000000000000000000000000',
  DEPLOYER_ADDRESS: deployer.address,
  EXPECTED_OWNER: SAFE,
  EXPECTED_POG_SIGNER: process.env.POG_SIGNER_ADDRESS,
  EXPECTED_PLATFORM_TREASURY: process.env.PLATFORM_TREASURY,
}
delete childEnv.PRIVATE_KEY

/** Run a child, show only lines matching `show`, return { ok, out }. The deploy
 *  key reaches forge through the child env only, and is masked if echoed. */
function run(label, cmd, args, { env = {}, show = /PASS|FAIL|✓|✗|note|ALL CHECKS|Error|error|revert|Paused\?|Owner  |simulated|wrote|deployed|ToshLaunchGateway:|predicted hook|COMPLETE/ } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT, env: { ...childEnv, ...env }, encoding: 'utf8', maxBuffer: 64 << 20, shell: false,
  })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.replaceAll(deployerKey, '<deployer key>').replaceAll(deployerKey.slice(2), '<deployer key>')
  for (const line of out.split(/\r?\n/)) if (show.test(line)) console.log(`   │ ${line.trim()}`)
  const ok = r.status === 0
  record(label, ok, ok ? '' : `exit ${r.status}${r.error ? ` (${r.error.message})` : ''}`)
  return { ok, out }
}
const node = (label, script, args, opts) => run(label, process.execPath, [script, ...args, '--rpc', RPC], opts)
const forge = (label, args, opts) => run(label, 'forge', ['script', ...args, '--rpc-url', RPC], opts)
const pick = (out, re) => out.match(re)?.[1]

// ── chain helpers ───────────────────────────────────────────────────────────
const pub = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) })
const rpc = (method, params = []) => pub.request({ method, params })
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args })

async function sendAs(from, { to, data, value = 0n }) {
  await rpc('anvil_impersonateAccount', [from])
  const hash = await rpc('eth_sendTransaction', [{ from, to, data, value: `0x${value.toString(16)}` }])
  const rc = await pub.waitForTransactionReceipt({ hash })
  await rpc('anvil_stopImpersonatingAccount', [from])
  return rc
}

/** Execute a Transaction Builder file as the Safe it names. */
async function executeBatch(label, file) {
  const batch = JSON.parse(fs.readFileSync(file, 'utf8'))
  const safe = getAddress(batch.meta.createdFromSafeAddress)
  let ok = safe === SAFE && batch.chainId === '56'
  for (const tx of batch.transactions) {
    const rc = await sendAs(safe, { to: tx.to, data: tx.data, value: BigInt(tx.value) })
    ok = ok && rc.status === 'success'
  }
  return record(`${label}: Safe executes ${batch.transactions.length} call(s) from ${path.basename(file)}`, ok)
}

async function startAnvil() {
  const child = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(PORT), '--silent', '--timeout', '120000', '--retries', '8'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (child.exitCode !== null) throw new Error(`anvil exited: ${err.trim()}`)
    try { if ((await pub.getChainId()) === 56) return child } catch { /* not up yet */ }
  }
  child.kill()
  throw new Error('anvil did not answer within 120 s')
}

/** Back up forge's script cache for the chain-56 runs so the rehearsal can't
 *  replace the real deploy's run-latest.json. */
function snapshotScriptCache() {
  const dirs = ['DeployMainnet.s.sol', 'DeployLaunchGateway.s.sol'].map((s) => path.join(ROOT, 'cache', s, '56'))
  const saved = dirs.map((d) => {
    const bak = fs.existsSync(d) ? path.join(broadcastDir, 'cache-bak', path.basename(path.dirname(d))) : null
    if (bak) fs.cpSync(d, bak, { recursive: true })
    return { d, bak }
  })
  return () => {
    for (const { d, bak } of saved) {
      fs.rmSync(d, { recursive: true, force: true })
      if (bak) fs.cpSync(bak, d, { recursive: true })
    }
  }
}

// ── the rehearsal ───────────────────────────────────────────────────────────
async function main() {
  const restoreCache = snapshotScriptCache()
  banner(`anvil fork of BSC 56 on :${PORT}`)
  const anvil = await startAnvil()
  const forkBlock = await pub.getBlockNumber()
  console.log(`fork block ${forkBlock} · safe ${SAFE} · throwaway deployer ${deployer.address}`)
  const work = path.join(broadcastDir, 'batches')
  fs.mkdirSync(work)
  const out = (n) => path.join(work, n)

  try {
    await rpc('anvil_setBalance', [deployer.address, `0x${parseEther('5').toString(16)}`])
    await rpc('anvil_setBalance', [SAFE, `0x${parseEther('5').toString(16)}`])
    const dep = { env: { PRIVATE_KEY: deployerKey } }

    banner('step 3 · dry run')
    const dry = forge('step 3 DeployMainnet dry run', ['script/DeployMainnet.s.sol:DeployMainnetScript', '-vvvv'],
      { ...dep, show: /Chain ID|Deployer|PROD owner|PoG Signer|Platform fee|Quote asset|Legacy factory|MAX_POG_ALLOC_WEI|SIMULATION COMPLETE|Error|revert/ })
    record('step 3 MAX_POG_ALLOC_WEI = 1.3 BNB', /MAX_POG_ALLOC_WEI\s*=\s*1300000000000000000/.test(dry.out))
    if (!dry.ok) return

    banner('step 4 · broadcast')
    const live = forge('step 4 DeployMainnet broadcast', ['script/DeployMainnet.s.sol:DeployMainnetScript', '--broadcast', '--slow', '-vvvv'],
      { ...dep, show: /deployed|ONCHAIN EXECUTION COMPLETE|Error|revert/ })
    const factory = pick(live.out, /ToshFactory deployed\s*:\s*(0x[0-9a-fA-F]{40})/)
    const treasury = pick(live.out, /ToshLadderTreasury deployed\s*:\s*(0x[0-9a-fA-F]{40})/)
    if (!record('step 4 factory and treasury addresses in the output', Boolean(factory && treasury), `${factory} / ${treasury}`)) return

    banner('step 5 · deployer pauses')
    const wallet = createWalletClient({ account: deployer, transport: http(RPC) })
    const ph = await wallet.writeContract({ address: factory, abi: FACTORY, functionName: 'pause', chain: { id: 56, name: 'bsc-fork', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } })
    await pub.waitForTransactionReceipt({ hash: ph })
    record('step 5 new factory paused()', await read(factory, FACTORY, 'paused'))
    node('step 5 check --stage deployed', 'scripts/redeployTx.mjs', ['check', '--factory', factory, '--treasury', treasury, '--stage', 'deployed'])

    banner('step 6 · Safe batch 1: retire BEM factory + accept ownership')
    const h = node('step 6 handoff batch built and simulated', 'scripts/redeployTx.mjs', ['handoff', '--factory', factory, '--treasury', treasury, '--out', out('safe-handoff.json')])
    if (!h.ok) return
    await executeBatch('step 6', out('safe-handoff.json'))
    node('step 6 check --stage handed', 'scripts/redeployTx.mjs', ['check', '--factory', factory, '--treasury', treasury, '--stage', 'handed'])
    forge('step 6 VerifyDeployment (paused)', ['script/VerifyDeployment.s.sol:VerifyDeploymentScript', '--sig', 'run(address)', factory],
      { env: { EXPECTED_PAUSED: 'true' } })

    banner('step 10 · Safe batch 2: unpause')
    const u = node('step 10 unpause batch built and simulated', 'scripts/redeployTx.mjs', ['unpause', '--factory', factory, '--out', out('safe-unpause.json')])
    if (!u.ok) return
    await executeBatch('step 10', out('safe-unpause.json'))
    node('step 10 check --stage live', 'scripts/redeployTx.mjs', ['check', '--factory', factory, '--treasury', treasury, '--stage', 'live'])
    forge('step 10 VerifyDeployment (live)', ['script/VerifyDeployment.s.sol:VerifyDeploymentScript', '--sig', 'run(address)', factory],
      { env: { EXPECTED_PAUSED: 'false' } })

    banner('step 12.5 · launch gateway')
    const g = forge('step 12.5 DeployLaunchGateway broadcast', ['script/DeployLaunchGateway.s.sol', '--broadcast'],
      { env: { PRIVATE_KEY: deployerKey, FACTORY_ADDRESS: factory, PROD_OWNER_SAFE: SAFE } })
    const gateway = pick(g.out, /ToshLaunchGateway:\s*(0x[0-9a-fA-F]{40})/)
    if (!record('step 12.5 gateway address in the output', Boolean(gateway), gateway)) return
    const gh = node('step 12.5 gateway-handoff batch built and simulated', 'scripts/safeLaunchTx.mjs', ['gateway-handoff', '--factory', factory, '--gateway', gateway, '--out', out('safe-gateway-handoff.json')])
    if (!gh.ok) return
    await executeBatch('step 12.5', out('safe-gateway-handoff.json'))
    record('step 12.5 factory.owner() is the gateway', getAddress(await read(factory, FACTORY, 'owner')) === getAddress(gateway))
    record('step 12.5 gateway.canLaunch(Safe)', await read(gateway, GATEWAY, 'canLaunch', [SAFE]))

    banner('step 13 · first project')
    const developer = privateKeyToAccount(generatePrivateKey()).address
    const c = node('step 13 create batch built and simulated', 'scripts/safeLaunchTx.mjs',
      ['create', '--factory', factory, '--name', 'Rehearsal Project', '--symbol', 'RHRSL', '--developer', developer,
        '--hard-cap', 'none', '--wallet-cap', '1.3', '--duration', '3h', '--out', out('safe-create.json')])
    if (!c.ok) return
    const predicted = getAddress(pick(c.out, /predicted hook (0x[0-9a-fA-F]{40})/))
    await executeBatch('step 13', out('safe-create.json'))
    const hook = predicted
    record('step 13 hook registered at the predicted address', await read(factory, FACTORY, 'registeredHooks', [hook]), hook)

    const users = [0, 1].map(() => privateKeyToAccount(generatePrivateKey()).address)
    const quota = parseEther('1.3')
    const setQuota = encodeFunctionData({ abi: FACTORY, functionName: 'setPogQuota', args: [users, quota] })
    const q = await sendAs(SAFE, { to: gateway, data: encodeFunctionData({ abi: GATEWAY, functionName: 'execute', args: [setQuota] }) })
    record('step 13 Safe grants 1.3 BNB PoG quota via gateway.execute(setPogQuota)', q.status === 'success')
    const depositData = encodeFunctionData({ abi: FACTORY, functionName: 'depositNative', args: [hook, '0x0000000000000000000000000000000000000000'] })
    for (const u of users) {
      await rpc('anvil_setBalance', [u, `0x${parseEther('2').toString(16)}`])
      const rc = await sendAs(u, { to: factory, data: depositData, value: parseEther('1.3') })
      record(`step 13 depositNative 1.3 BNB from ${u.slice(0, 10)}…`, rc.status === 'success')
    }
    const raised = await read(hook, HOOK, 'totalNativeDeposited')
    record('step 13 hook raised 2.6 BNB', raised === parseEther('2.6'), `${formatEther(raised)} BNB`)
    record('step 13 hook holds 2.6 WBNB', (await read(WBNB, ERC20, 'balanceOf', [hook])) >= parseEther('2.6'))

    const deadline = await read(hook, HOOK, 'genesisDeadline')
    const now = (await pub.getBlock()).timestamp
    await rpc('evm_increaseTime', [`0x${(deadline - now + 60n).toString(16)}`])
    await rpc('evm_mine')
    const l = node('step 13 launch batch built and simulated', 'scripts/safeLaunchTx.mjs', ['launch', '--factory', factory, '--hook', hook, '--out', out('safe-launch.json')])
    if (!l.ok) return
    await executeBatch('step 13 launch', out('safe-launch.json'))
    record('step 13 hook launched()', await read(hook, HOOK, 'launched'))
  } finally {
    restoreCache()
    if (KEEP) {
      console.log(`\n--keep: anvil left running on ${RPC}; batches in ${work}`)
    } else {
      anvil.kill()
      fs.rmSync(broadcastDir, { recursive: true, force: true })
    }
  }
}

main().then(() => {
  banner('summary')
  console.log(`${results.length - failures}/${results.length} passed`)
  if (failures) for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL ${r.step}${r.detail ? ` — ${r.detail}` : ''}`)
  process.exitCode = failures ? 1 : 0
}, (e) => {
  console.error(e)
  process.exitCode = 1
})
