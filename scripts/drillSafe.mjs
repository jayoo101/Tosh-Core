// Drill harness for the mainnet Step 1 path: Safe → pause() / acceptOwnership.
//
// The 2026-09-04 rehearsal proved a Safe can make an arbitrary contract call on
// this chain, but it deliberately called `paused()` — a view — so it changed no
// state and touched no ownership. The path a real P0 uses is Safe -> pause(),
// which is onlyOwner, so it has never run. Neither has PM-C2's acceptOwnership.
// This drives both.
//
// The two stand-in signers are derived from Foundry's default test mnemonic,
// which is public knowledge. That is the point: they are visibly not secrets,
// the script is reproducible by anyone, and they hold nothing and own nothing
// once the drill hands ownership back. They exist only so the threshold is a
// real 2, matching the decided mainnet 2-of-3 — a 1-of-1 cannot measure the
// thing Step 1 claims.
//
// Usage:  node scripts/.drill-safe.mjs <deploy|state|accept|pause|unpause|giveback>

import { ethers } from 'ethers'
import fs from 'node:fs'
import { installFailureExit } from './lib/checkExit.mjs'
import { refuseIfRetired } from './lib/retiredChains.mjs'

installFailureExit()

const RPC = process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com'
const FACTORY = '0x2E690A91b383eDB21f6b5B4180Cc4a2C905C6BeA'
const PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' // SafeProxyFactory 1.4.1
const SAFE_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' // SafeL2 1.4.1 — L2, not the plain singleton
const FALLBACK = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99' // CompatibilityFallbackHandler 1.4.1
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'
const STATE = 'scripts/.drill-state.json'

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

// Refuse to run anywhere but the rehearsal chain.
//
// Two of the three owners below are derived from a mnemonic printed in
// Foundry's documentation, so the "2-of-3" this script builds is a 1-of-1 that
// anyone on earth can co-sign. On 46630 that is the point — it makes the drill
// reproducible and the keys worthless. On 4663 it would be a Safe with two
// public keys holding the protocol's emergency brake, which is worse than the
// single EOA it would be replacing. That mistake is one wrong RPC away, so it
// is checked rather than warned about.
const TESTNET_ID = 46630n

// The assertion below is right in spirit and pinned to the wrong constant, and
// the two failures are opposite enough to be worth separating. It refuses
// unless you are on 46630, which protected the drill while 46630 WAS the
// rehearsal chain; now it is the thing holding this script there, and it holds
// it silently, because that endpoint still answers. So the retirement is
// reported first and on its own terms: "you are not on 46630" is a confusing
// way to say "46630 is gone".
refuseIfRetired(TESTNET_ID, {
  script: 'drillSafe.mjs',
  reArm: [
    'point TESTNET_ID and the RPC at the current testnet (97), and FACTORY at '
      + 'the factory named by FACTORY_ADDRESS in .env',
    'fund the deployer and leave the two stand-in owners at zero — they sign, '
      + 'they never pay',
    'keep the refusal below: its reasoning survives the move intact, because '
      + 'two owners from a public mnemonic are as unacceptable on 56 as on 4663',
  ],
})

const net = await provider.getNetwork()
if (net.chainId !== TESTNET_ID) {
  console.error(
    `✗ refusing to run: connected to chain ${net.chainId}, and this script only\n`
    + `  runs on ${TESTNET_ID}. Two of the three Safe owners it creates come from\n`
    + '  Foundry\'s public test mnemonic — a real deployment owned by those keys\n'
    + '  would be strictly worse than no Safe at all. Build the mainnet Safe\n'
    + '  through app.safe.global with real signers (PM-D4), not with this.')
  process.exit(1)
}

const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider)
const stand = [1, 2].map(i =>
  ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`))

const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {})
const writeState = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 2))
const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider)
const iface = new ethers.Interface(FACTORY_ABI)

async function showState() {
  const s = readState()
  const [owner, pending, paused, block] = await Promise.all([
    factory.owner(), factory.pendingOwner(), factory.paused(), provider.getBlockNumber(),
  ])
  console.log(`  block         ${block}`)
  console.log(`  factory       ${FACTORY}`)
  console.log(`    owner       ${owner}`)
  console.log(`    pending     ${pending}`)
  console.log(`    paused      ${paused}`)
  console.log(`  deployer      ${deployer.address}`)
  console.log(`    balance     ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH`)
  if (s.safe) {
    const safe = new ethers.Contract(s.safe, SAFE_ABI, provider)
    console.log(`  drill safe    ${s.safe}`)
    console.log(`    version     ${await safe.VERSION()}`)
    console.log(`    threshold   ${await safe.getThreshold()} of ${(await safe.getOwners()).length}`)
    console.log(`    nonce       ${await safe.nonce()}`)
    console.log(`    owners      ${(await safe.getOwners()).join('\n                ')}`)
  }
}

async function deploySafe() {
  const owners = [deployer.address, stand[0].address, stand[1].address]
  console.log(`  owners (2-of-3, matching the decided mainnet shape):`)
  owners.forEach((o, i) => console.log(`    ${i === 0 ? 'deployer  ' : 'stand-in  '} ${o}`))

  const initializer = new ethers.Interface(SETUP_ABI).encodeFunctionData('setup', [
    owners, 2, ethers.ZeroAddress, '0x', FALLBACK, ethers.ZeroAddress, 0, ethers.ZeroAddress,
  ])
  const pf = new ethers.Contract(PROXY_FACTORY, PF_ABI, deployer)
  const t0 = Date.now()
  const tx = await pf.createProxyWithNonce(SAFE_L2, initializer, BigInt(Date.now()))
  const rc = await tx.wait()
  const ev = rc.logs.map(l => { try { return pf.interface.parseLog(l) } catch { return null } })
    .find(x => x?.name === 'ProxyCreation')
  const safe = ev.args.proxy
  console.log(`\n  deployed      ${safe}`)
  console.log(`  tx            ${rc.hash}`)
  console.log(`  gas           ${rc.gasUsed}`)
  console.log(`  wall          ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  writeState({ ...readState(), safe, deployTx: rc.hash, deployGas: rc.gasUsed.toString() })
}

// Execute `data` on the factory through the Safe, with a real threshold of two
// signatures. Timed from the moment the transaction hash exists (what a signer
// is handed) to the moment it is confirmed on chain.
async function execThroughSafe(label, data) {
  const s = readState()
  if (!s.safe) throw new Error('no drill safe yet — run `deploy` first')
  const safe = new ethers.Contract(s.safe, SAFE_ABI, deployer)
  const nonce = await safe.nonce()
  const args = [FACTORY, 0n, data, 0, 0n, 0n, 0n, ethers.ZeroAddress, ethers.ZeroAddress]

  const t0 = Date.now()
  const txHash = await safe.getTransactionHash(...args, nonce)
  console.log(`  safeTxHash    ${txHash}`)

  // Safe requires signatures concatenated in ascending owner-address order.
  // Two of the three owners sign: the deployer and one stand-in.
  const signers = [deployer, stand[0]]
    .sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
  const signatures = '0x' + signers.map(w => {
    // Raw-hash signature: v is 27/28, which is the branch Safe ecrecovers
    // against the safeTxHash directly rather than an eth_sign-prefixed digest.
    const sig = w.signingKey.sign(txHash)
    return sig.serialized.slice(2)
  }).join('')
  signers.forEach(w => console.log(`  signed by     ${w.address}`))
  const tSigned = Date.now()

  const tx = await safe.execTransaction(...args, signatures)
  const rc = await tx.wait()
  const t1 = Date.now()

  console.log(`  tx            ${rc.hash}`)
  console.log(`  block         ${rc.blockNumber}`)
  console.log(`  gas           ${rc.gasUsed}`)
  console.log(`  status        ${rc.status === 1 ? 'success' : 'REVERTED'}`)
  console.log(`  sign window   ${((tSigned - t0) / 1000).toFixed(2)} s (2 signatures)`)
  console.log(`  total wall    ${((t1 - t0) / 1000).toFixed(2)} s (hash -> confirmed)`)

  const timings = readState().timings || {}
  timings[label] = {
    tx: rc.hash, block: rc.blockNumber, gas: rc.gasUsed.toString(),
    signSeconds: +((tSigned - t0) / 1000).toFixed(2),
    totalSeconds: +((t1 - t0) / 1000).toFixed(2),
  }
  writeState({ ...readState(), timings })
  return rc
}

const cmd = process.argv[2]
const run = async () => {
  switch (cmd) {
    case 'state':
      return showState()
    case 'deploy':
      return deploySafe()

    case 'stage': {
      // Ownable2Step: this only sets pendingOwner. The deployer stays owner
      // until the Safe accepts, so this step is reversible on its own.
      const t0 = Date.now()
      const tx = await factory.connect(deployer).transferOwnership(readState().safe)
      const rc = await tx.wait()
      console.log(`  transferOwnership -> ${readState().safe}`)
      console.log(`  tx            ${rc.hash}`)
      console.log(`  gas           ${rc.gasUsed}   wall ${((Date.now() - t0) / 1000).toFixed(1)} s`)
      console.log(`  pendingOwner  ${await factory.pendingOwner()}`)
      console.log(`  owner (still) ${await factory.owner()}`)
      return
    }
    case 'accept': // PM-C2, through the Safe
      return execThroughSafe('acceptOwnership', iface.encodeFunctionData('acceptOwnership'))
    case 'pause': // Step 1, mainnet path
      return execThroughSafe('pause', iface.encodeFunctionData('pause'))
    case 'unpause':
      return execThroughSafe('unpause', iface.encodeFunctionData('unpause'))
    case 'giveback': // hand ownership back to the deployer, from the Safe
      return execThroughSafe('transferOwnershipBack',
        iface.encodeFunctionData('transferOwnership', [deployer.address]))
    case 'reclaim': { // deployer accepts it back
      const tx = await factory.connect(deployer).acceptOwnership()
      const rc = await tx.wait()
      console.log(`  acceptOwnership tx ${rc.hash}  gas ${rc.gasUsed}`)
      console.log(`  owner         ${await factory.owner()}`)
      return
    }
    default:
      console.log('commands: state deploy stage accept pause unpause giveback reclaim')
  }
}
run().catch(e => { console.error('✗ ' + (e.shortMessage || e.message)); process.exit(1) })
