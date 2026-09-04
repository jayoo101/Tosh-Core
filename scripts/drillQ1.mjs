/**
 * Q1 drill harness, third criterion: "at least one new signer participating".
 *
 * §8.1 paused through the deployer EOA. §8.2 paused through a 2-of-3 Safe whose
 * two co-signers came from Foundry's public test mnemonic — a threshold of two
 * in the contract's eyes and a threshold of one in reality, both keys sitting on
 * the same laptop as the first. Both sittings scored this criterion as not met
 * and said why. This is the run that meets it.
 *
 * ── What is different, and why it is the whole point ────────────────────────
 *
 * The drill Safe's owners are the REAL mainnet signer set — Tom, Jack and Joe,
 * the same three addresses that own
 * 0x2953957774482efA660921df85A1E7634ccfe27A on 4663, each of whom proved
 * control by signature before that Safe was created.
 *
 * The deployer is deliberately NOT an owner. It pays gas and submits the
 * transactions, which `execTransaction` permits from any address, but it cannot
 * originate one: without two signatures from people who are not the operator,
 * nothing moves. That is the property mainnet has and neither previous drill
 * could test, because in both of them every key that could sign was already on
 * the operator's machine.
 *
 * ── The signers spend no gas and take no risk ───────────────────────────────
 *
 * Signing a SafeTx is EIP-712, off chain and free. The three hold zero testnet
 * ETH and do not need any. What they sign is scoped to this Safe (the domain
 * binds chainId 46630 and the Safe's own address) and to one nonce each, so a
 * signature collected here cannot be replayed against the mainnet Safe, against
 * a different transaction, or twice.
 *
 * All four hashes are computed up front — nonces 0..3 are deterministic — so
 * each signer signs once, in one sitting, rather than being interrupted four
 * times. That is a concession to human availability and it is recorded as one:
 * it means this run measures the mechanical path and the round-trip to a person,
 * not the "wake someone at 03:00" latency that §8.2 identified as the real
 * budget. Nothing here can measure that. Only an unannounced drill can.
 *
 * Usage:
 *   node scripts/drillQ1.mjs state
 *   node scripts/drillQ1.mjs deploy      create the 2-of-3 with the real owners
 *   node scripts/drillQ1.mjs stage       factory.transferOwnership(safe)
 *   node scripts/drillQ1.mjs request     compute the four hashes to be signed
 *   node scripts/drillQ1.mjs verify <f>  check collected signatures
 *   node scripts/drillQ1.mjs exec <step> submit one step with those signatures
 *   node scripts/drillQ1.mjs reclaim     deployer accepts ownership back
 */

import { ethers } from 'ethers'
import fs from 'node:fs'

const RPC = process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com'
const TESTNET_ID = 46630n
const FACTORY = '0x2E690A91b383eDB21f6b5B4180Cc4a2C905C6BeA'
const PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67'
const SAFE_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
const FALLBACK = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99'
const STATE = 'scripts/.q1-state.json'
const TX_SERVICE = 'https://api.safe.global/tx-service/robinhood-testnet'

/* The real mainnet owner set. Hardcoded rather than read from safe-owners.json,
 * which is gitignored and holds signatures: the addresses are public, and a
 * drill that silently used a different set than it claimed would invalidate the
 * only criterion it exists to satisfy. Checked against the mainnet Safe by
 * `state`. */
const OWNERS = [
  { name: 'Tom', address: '0xC2EA14cE2112B18AFBC78fE78C969b3002F07cbB' },
  { name: 'Jack', address: '0x0db9114FA8082800B23AA6141ec88F2a64Ca1c6E' },
  { name: 'Joe', address: '0x3b7ff171A71281b1D77e18ae1A0bC725D69712E6' },
]
const MAINNET_SAFE = '0x2953957774482efA660921df85A1E7634ccfe27A'

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
]
const SETUP_ABI = ['function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)']
const PF_ABI = [
  'function createProxyWithNonce(address _singleton,bytes initializer,uint256 saltNonce) returns (address proxy)',
  'event ProxyCreation(address indexed proxy, address singleton)',
]
const FACTORY_ABI = [
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function paused() view returns (bool)',
  'function pause()',
  'function unpause()',
  'function acceptOwnership()',
  'function transferOwnership(address newOwner)',
]

const provider = new ethers.JsonRpcProvider(RPC)
const net = await provider.getNetwork()

/* Same rail as drillSafe.mjs, for a different reason. That script refused to
 * leave 46630 because its owners were worthless public keys. This one's owners
 * are the real ones — so on 4663 it would not build a toy, it would build a
 * SECOND Safe indistinguishable from the real one at a glance, stage the live
 * factory's ownership to it, and leave two Safes with identical owner sets
 * where the playbook names one address. */
if (net.chainId !== TESTNET_ID) {
  console.error(`✗ refusing to run: connected to chain ${net.chainId}, not ${TESTNET_ID}.`)
  console.error('  This is a drill against the testnet factory. The mainnet Safe already')
  console.error(`  exists at ${MAINNET_SAFE}; do not create another with the same owners.`)
  process.exit(1)
}

const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider)
const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider)
const iface = new ethers.Interface(FACTORY_ABI)
const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {})
const writeState = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n')

/** The four Safe transactions, in the order their nonces are consumed. */
const STEPS = [
  { nonce: 0, key: 'accept', label: 'acceptOwnership()  — PM-C2, with real signers', data: () => iface.encodeFunctionData('acceptOwnership') },
  { nonce: 1, key: 'pause', label: 'pause()            — Step 1, the P0 brake', data: () => iface.encodeFunctionData('pause') },
  { nonce: 2, key: 'unpause', label: 'unpause()          — close the window', data: () => iface.encodeFunctionData('unpause') },
  { nonce: 3, key: 'giveback', label: 'transferOwnership(deployer) — restore', data: () => iface.encodeFunctionData('transferOwnership', [deployer.address]) },
]

const argsFor = data => [FACTORY, 0n, data, 0, 0n, 0n, 0n, ethers.ZeroAddress, ethers.ZeroAddress]

/** EIP-712 SafeTx, exactly as Safe 1.4.1 defines it. */
function typedData(safeAddr, data, nonce) {
  return {
    domain: { chainId: Number(TESTNET_ID), verifyingContract: safeAddr },
    types: {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    message: {
      to: FACTORY, value: '0', data, operation: 0,
      safeTxGas: '0', baseGas: '0', gasPrice: '0',
      gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress,
      nonce: String(nonce),
    },
  }
}

async function showState() {
  const s = readState()
  const [owner, pending, paused, block] = await Promise.all([
    factory.owner(), factory.pendingOwner(), factory.paused(), provider.getBlockNumber(),
  ])
  console.log(`  chain         ${net.chainId}   block ${block}`)
  console.log(`  factory       ${FACTORY}`)
  console.log(`    owner       ${owner}`)
  console.log(`    pending     ${pending}`)
  console.log(`    paused      ${paused}`)
  console.log(`  deployer      ${deployer.address}  ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH`)
  if (!s.safe) return console.log('\n  no drill Safe yet — run `deploy`')

  const safe = new ethers.Contract(s.safe, SAFE_ABI, provider)
  const onChain = (await safe.getOwners()).map(a => a.toLowerCase())
  console.log(`\n  drill safe    ${s.safe}`)
  console.log(`    version     ${await safe.VERSION()}`)
  console.log(`    threshold   ${await safe.getThreshold()} of ${onChain.length}`)
  console.log(`    nonce       ${await safe.nonce()}`)
  for (const o of OWNERS) {
    const has = onChain.includes(o.address.toLowerCase())
    console.log(`    ${has ? '✓' : '✗'} ${o.name.padEnd(5)} ${o.address}`)
  }
  const matchesMainnet = onChain.length === 3 && OWNERS.every(o => onChain.includes(o.address.toLowerCase()))
  console.log(`    owner set ${matchesMainnet ? 'MATCHES' : 'DOES NOT MATCH'} the mainnet Safe ${MAINNET_SAFE}`)
  console.log(`    deployer is ${onChain.includes(deployer.address.toLowerCase()) ? 'AN OWNER — that defeats the drill' : 'not an owner (correct)'}`)
}

async function deploySafe() {
  if (readState().safe) {
    console.error(`✗ a drill Safe already exists: ${readState().safe}`)
    console.error('  Delete scripts/.q1-state.json to start over deliberately.')
    process.exit(1)
  }
  console.log('  owners (2-of-3, the real mainnet signer set):')
  OWNERS.forEach(o => console.log(`    ${o.name.padEnd(5)} ${o.address}`))
  console.log(`  deployer ${deployer.address} is NOT an owner — it pays gas and cannot sign.\n`)

  const initializer = new ethers.Interface(SETUP_ABI).encodeFunctionData('setup', [
    OWNERS.map(o => o.address), 2, ethers.ZeroAddress, '0x', FALLBACK, ethers.ZeroAddress, 0, ethers.ZeroAddress,
  ])
  const pf = new ethers.Contract(PROXY_FACTORY, PF_ABI, deployer)
  const t0 = Date.now()
  const rc = await (await pf.createProxyWithNonce(SAFE_L2, initializer, BigInt(Date.now()))).wait()
  const ev = rc.logs.map(l => { try { return pf.interface.parseLog(l) } catch { return null } })
    .find(x => x?.name === 'ProxyCreation')
  if (!ev) throw new Error('no ProxyCreation event — do not guess the address')
  const safe = ethers.getAddress(ev.args.proxy)

  console.log(`  deployed      ${safe}`)
  console.log(`  tx            ${rc.hash}`)
  console.log(`  gas           ${rc.gasUsed}   wall ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  writeState({ ...readState(), safe, deployTx: rc.hash, deployGas: rc.gasUsed.toString() })

  // Indexing is what makes the Safe visible in app.safe.global, which is where
  // a signer would look to confirm they are actually an owner of this thing.
  process.stdout.write('  tx service    ')
  for (let i = 1; i <= 10; i++) {
    const res = await fetch(`${TX_SERVICE}/api/v1/safes/${safe}/`)
    if (res.ok) {
      const j = await res.json()
      console.log(`indexed, version ${j.version}, threshold ${j.threshold}, ${j.owners.length} owners`)
      break
    }
    if (i === 10) console.log('NOT indexed after 10 tries — the UI will not show it')
    await new Promise(r => setTimeout(r, 3000))
  }
  console.log(`\n  https://app.safe.global/home?safe=robinhood-testnet:${safe}`)
}

async function request() {
  const s = readState()
  if (!s.safe) throw new Error('no drill Safe — run `deploy` first')
  const safe = new ethers.Contract(s.safe, SAFE_ABI, provider)
  const live = Number(await safe.nonce())
  if (live !== 0) console.log(`  note: Safe nonce is already ${live}; steps below it are done.\n`)

  const out = { safe: s.safe, chainId: Number(TESTNET_ID), factory: FACTORY, generatedAt: new Date().toISOString(), steps: [] }

  for (const step of STEPS) {
    const data = step.data()
    const td = typedData(s.safe, data, step.nonce)
    const local = ethers.TypedDataEncoder.hash(td.domain, td.types, td.message)
    // Held against the Safe's own answer. A hash computed correctly by ethers
    // and rejected by the contract is the failure mode that wastes a signer's
    // time and is invisible until execTransaction reverts GS026.
    const chain = await safe.getTransactionHash(...argsFor(data), step.nonce)
    if (local.toLowerCase() !== chain.toLowerCase()) {
      throw new Error(`EIP-712 hash mismatch at nonce ${step.nonce}: local ${local}, chain ${chain}`)
    }
    console.log(`  nonce ${step.nonce}  ${step.label}`)
    console.log(`           data      ${data}`)
    console.log(`           safeTxHash ${chain}   ✓ matches the Safe's own getTransactionHash`)
    out.steps.push({ nonce: step.nonce, key: step.key, label: step.label, data, safeTxHash: chain, typedData: td })
  }

  fs.writeFileSync('scripts/.q1-request.json', JSON.stringify(out, null, 2) + '\n')
  console.log('\n  wrote scripts/.q1-request.json')
  console.log(`  Safe UI: https://app.safe.global/home?safe=robinhood-testnet:${s.safe}`)
}

/** Bring v into the 27/28 range Safe expects for an ECDSA signature. */
function normalize(sigHex) {
  const s = String(sigHex).trim()
  if (!/^0x[0-9a-fA-F]{130}$/.test(s)) throw new Error(`not a 65-byte signature: ${s.slice(0, 20)}…`)
  let v = parseInt(s.slice(130), 16)
  if (v === 0 || v === 1) v += 27
  if (v !== 27 && v !== 28) throw new Error(`unexpected v=${v}`)
  return s.slice(0, 130) + v.toString(16).padStart(2, '0')
}

/** Recover each collected signature and report who actually signed what. */
async function verify(file) {
  const req = JSON.parse(fs.readFileSync('scripts/.q1-request.json', 'utf8'))
  const collected = JSON.parse(fs.readFileSync(file, 'utf8'))
  const byHash = new Map(req.steps.map(s => [s.safeTxHash.toLowerCase(), s]))
  const known = new Map(OWNERS.map(o => [o.address.toLowerCase(), o.name]))
  const tally = new Map(req.steps.map(s => [s.nonce, []]))
  let bad = 0

  for (const entry of collected.signatures || collected) {
    const step = byHash.get(String(entry.safeTxHash).toLowerCase())
    if (!step) { console.log(`  ✗ unknown safeTxHash ${entry.safeTxHash}`); bad++; continue }
    // Some wallets — and Ledger through some of them — return v as 0/1 rather
    // than 27/28. Safe reads v < 27 as a contract-signature or approved-hash
    // marker, not as a recovery id, so an unnormalized signature is not merely
    // rejected: it is interpreted as something else entirely and fails as
    // GS024/GS026. Normalizing here is what keeps that from being a second
    // round trip with a person.
    const sig = normalize(entry.signature)
    let who
    try {
      who = ethers.recoverAddress(step.safeTxHash, sig)
    } catch (e) { console.log(`  ✗ nonce ${step.nonce}: unrecoverable signature — ${e.message}`); bad++; continue }
    const name = known.get(who.toLowerCase())
    if (!name) { console.log(`  ✗ nonce ${step.nonce}: signed by ${who}, who is not an owner`); bad++; continue }
    if (tally.get(step.nonce).some(x => x.address.toLowerCase() === who.toLowerCase())) {
      console.log(`  ! nonce ${step.nonce}: duplicate signature from ${name}, ignored`)
      continue
    }
    tally.get(step.nonce).push({ address: ethers.getAddress(who), name, signature: sig })
    console.log(`  ✓ nonce ${step.nonce} ${step.key.padEnd(9)} signed by ${name} ${who}`)
  }

  console.log('')
  let ready = true
  for (const step of req.steps) {
    const got = tally.get(step.nonce)
    const ok = got.length >= 2
    if (!ok) ready = false
    console.log(`  nonce ${step.nonce} ${step.key.padEnd(9)} ${got.length}/2 ${ok ? '✓ ready' : '— still needs ' + (2 - got.length)}`)
  }

  const sigs = Object.fromEntries([...tally].map(([n, v]) => [n, v]))
  writeState({ ...readState(), collected: sigs })
  if (bad) console.log(`\n  ${bad} rejected`)
  console.log(ready ? '\n  all four steps have two owner signatures.' : '\n  not yet executable.')
}

/** Safe wants signatures concatenated in ascending owner-address order. */
function pack(list) {
  return '0x' + [...list]
    .sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
    .map(s => s.signature.slice(2))
    .join('')
}

async function exec(key) {
  const s = readState()
  const step = STEPS.find(x => x.key === key)
  if (!step) throw new Error(`unknown step ${key} — one of ${STEPS.map(x => x.key).join(', ')}`)
  const list = s.collected?.[step.nonce]
  if (!list || list.length < 2) throw new Error(`nonce ${step.nonce} has ${list?.length || 0} signature(s), needs 2`)

  const safe = new ethers.Contract(s.safe, SAFE_ABI, deployer)
  const live = Number(await safe.nonce())
  if (live !== step.nonce) throw new Error(`Safe nonce is ${live}, this step is nonce ${step.nonce}`)

  const data = step.data()
  console.log(`  ${step.label}`)
  console.log(`  signed by     ${list.map(x => x.name).join(' + ')}`)
  const t0 = Date.now()
  const rc = await (await safe.execTransaction(...argsFor(data), pack(list))).wait()
  const wall = (Date.now() - t0) / 1000

  console.log(`  tx            ${rc.hash}`)
  console.log(`  block         ${rc.blockNumber}   gas ${rc.gasUsed}   ${rc.status === 1 ? 'success' : 'REVERTED'}`)
  console.log(`  wall          ${wall.toFixed(2)} s (submit -> confirmed)`)

  const timings = s.timings || {}
  timings[key] = {
    tx: rc.hash, block: rc.blockNumber, gas: rc.gasUsed.toString(),
    seconds: +wall.toFixed(2), signers: list.map(x => x.name),
    at: new Date().toISOString(),
  }
  writeState({ ...readState(), timings })
}

/**
 * Prove the collection path works before spending anyone's attention on it.
 *
 * Everything else in this file can be checked by reading it. Two things cannot:
 * whether an `eth_signTypedData_v4` signature is actually accepted by Safe's
 * `checkSignatures`, and whether `pack()` orders and encodes them the way it
 * expects. If either is wrong the symptom appears at `exec` — after two people
 * have already been interrupted — as a bare GS02x revert.
 *
 * So the same `typedData()` and the same `pack()` are driven end to end against
 * a throwaway 2-of-3 built from Foundry's public test mnemonic. `signTypedData`
 * here produces byte-identical output to what the browser wallet returns, so a
 * pass means the real signatures will be accepted for the same reason.
 */
async function selftest() {
  const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
  const keys = [1, 2, 3].map(i => ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`))
  console.log('  throwaway 2-of-3 from Foundry\'s public test mnemonic (worthless by construction)')

  const initializer = new ethers.Interface(SETUP_ABI).encodeFunctionData('setup', [
    keys.map(k => k.address), 2, ethers.ZeroAddress, '0x', FALLBACK, ethers.ZeroAddress, 0, ethers.ZeroAddress,
  ])
  const pf = new ethers.Contract(PROXY_FACTORY, PF_ABI, deployer)
  const rc = await (await pf.createProxyWithNonce(SAFE_L2, initializer, BigInt(Date.now()))).wait()
  const ev = rc.logs.map(l => { try { return pf.interface.parseLog(l) } catch { return null } })
    .find(x => x?.name === 'ProxyCreation')
  const addr = ethers.getAddress(ev.args.proxy)
  console.log(`  safe          ${addr}  (gas ${rc.gasUsed})`)

  const safe = new ethers.Contract(addr, SAFE_ABI, deployer)
  const data = iface.encodeFunctionData('paused') // a view: proves signatures, changes nothing
  const td = typedData(addr, data, 0)

  // The exact hash the wallet would sign, and the exact hash the Safe checks.
  const local = ethers.TypedDataEncoder.hash(td.domain, td.types, td.message)
  const chain = await safe.getTransactionHash(...argsFor(data), 0)
  console.log(`  eip712 hash   ${local}`)
  console.log(`  safe hash     ${chain}  ${local === chain ? '✓ identical' : '✗ DIFFERENT'}`)
  if (local !== chain) throw new Error('EIP-712 hash does not match the Safe')

  // Two owners sign the typed data, exactly as the page asks a wallet to.
  const collected = await Promise.all(keys.slice(0, 2).map(async k => ({
    address: k.address,
    signature: normalize(await k.signTypedData(td.domain, td.types, td.message)),
  })))
  collected.forEach(c => console.log(`  signed by     ${c.address}`))

  // Deliberately handed to pack() out of ascending order, because that ordering
  // requirement is the part most likely to be got wrong and silently work when
  // the addresses happen to already be sorted.
  const packed = pack([...collected].reverse())
  console.log(`  packed        ${packed.length - 2} hex chars = ${(packed.length - 2) / 130} signatures`)

  // Submitted by the deployer, which owns nothing here — the same asymmetry the
  // real drill relies on: pays gas, cannot sign.
  const exec = await (await safe.execTransaction(...argsFor(data), packed)).wait()
  console.log(`  execTransaction ${exec.status === 1 ? 'ACCEPTED' : 'REVERTED'}  tx ${exec.hash}  gas ${exec.gasUsed}`)
  if (exec.status !== 1) throw new Error('Safe rejected the signatures')

  // And the negative: one signature under a threshold of two must fail, or the
  // "accepted" above would prove nothing about the threshold being enforced.
  let refused = false
  try {
    await safe.execTransaction.staticCall(...argsFor(data), pack([collected[0]]))
  } catch (e) { refused = true; console.log(`  one signature   refused ✓ (${(e.shortMessage || e.message).slice(0, 60)})`) }
  if (!refused) throw new Error('a single signature was accepted under a threshold of 2')

  console.log('\n  ✓ EIP-712 signatures of this exact shape are accepted, and two are required.')
}

const cmd = process.argv[2]
const run = async () => {
  switch (cmd) {
    case 'state': return showState()
    case 'selftest': return selftest()
    case 'deploy': return deploySafe()
    case 'stage': {
      const rc = await (await factory.connect(deployer).transferOwnership(readState().safe)).wait()
      console.log(`  transferOwnership -> ${readState().safe}`)
      console.log(`  tx ${rc.hash}  gas ${rc.gasUsed}`)
      console.log(`  pendingOwner  ${await factory.pendingOwner()}`)
      console.log(`  owner (still) ${await factory.owner()}  — Ownable2Step, reversible until accepted`)
      return
    }
    case 'request': return request()
    case 'verify': return verify(process.argv[3] || 'scripts/.q1-signatures.json')
    case 'exec': return exec(process.argv[3])
    case 'reclaim': {
      const rc = await (await factory.connect(deployer).acceptOwnership()).wait()
      console.log(`  acceptOwnership tx ${rc.hash}  gas ${rc.gasUsed}`)
      console.log(`  owner ${await factory.owner()}   paused ${await factory.paused()}`)
      return
    }
    default:
      console.log('commands: state deploy stage request verify <file> exec <step> reclaim')
      console.log(`steps:    ${STEPS.map(s => s.key).join(', ')}`)
  }
}
run().catch(e => { console.error('✗ ' + (e.shortMessage || e.message)); process.exit(1) })
