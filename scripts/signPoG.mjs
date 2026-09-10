#!/usr/bin/env node
/*
 * signPoG.mjs
 * ───────────
 * Issue one PoG attestation with an explicitly chosen `maxAlloc`, and print the
 * four arguments `ToshFactory.registerPoG` wants.
 *
 *   node scripts/signPoG.mjs --user 0x… --max-alloc <wei> --nonce <n> \
 *     [--factory 0x…] [--chain-id <n>] [--ttl 3600]
 *
 * ── Why this exists next to scripts/pogSigner.ts ────────────────────────────
 *
 * `pogSigner.ts` is the production oracle: it decides `maxAlloc` for you from a
 * multi-chain gas scan and a live gas-to-SATO rate pulled off the admin API.
 * That is the right behaviour for the real thing and the wrong behaviour for a
 * deployment rehearsal, where the whole point is to pin every input by hand and
 * stay under a deliberately small `maxPogAllocationLimit`. Asking the heuristic
 * for a number and hoping it lands under the cap is not a test of anything.
 *
 * What must NOT diverge is the digest, so it is restated here once and the
 * signer is recovered locally before anything is printed. The digest is, from
 * `ToshFactory.registerPoG`:
 *
 *   keccak256(abi.encode(user, maxAlloc, nonce, deadline, factory, chainId))
 *     .toEthSignedMessageHash()
 *
 * All six fields are signed, and five of them are things an operator can get
 * wrong without noticing. The factory answers every one of those mistakes with
 * the same `InvalidSignature`, so the local recovery below is the only place
 * that can tell you *which* field drifted.
 *
 * ── Local recovery is necessary and not sufficient ──────────────────────────
 *
 * It proves the signature matches the key that made it. It cannot prove that
 * key is the one the factory will accept, or that `--factory` and `--chain-id`
 * name the deployment you meant. Those are facts about the chain, so when an
 * RPC is reachable they are checked against the chain: `pogSigner()` must equal
 * the signing account, and the endpoint's own chain id must equal the one being
 * signed into the digest.
 *
 * That check is not hypothetical. On 2026-09-10 `.env.production` still named
 * the pre-rotation signer and `.env` named a testnet one, so both files
 * disagreed with `ToshFactory.pogSigner()`; an attestation cut from either
 * would have reverted `InvalidSignature` with nothing local to explain it.
 * Role vars therefore resolve through `loadRoleEnv`, which reads
 * `.env.production` before `.env` — the previous hard-coded read of `.env`
 * alone would silently pick the testnet factory, an address with no code on
 * mainnet at all.
 */

import { keccak256, encodeAbiParameters, parseAbiParameters, hashMessage,
         recoverAddress, getAddress, createPublicClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { loadRoleEnv } from './loadRoleEnv.mjs'

// `CHAIN_ID` is accepted but has never existed in either env file; the files
// spell it `TARGET_CHAIN_ID`, which is what Foundry reads.
loadRoleEnv([
  'FACTORY_ADDRESS', 'TARGET_CHAIN_ID', 'CHAIN_ID', 'ROBINHOOD_RPC',
  'POG_SIGNER_PRIVATE_KEY', 'PRIVATE_KEY',
])

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

const user     = arg('user')
const maxAlloc = arg('max-alloc')
const nonce    = arg('nonce', '0')
const ttl      = BigInt(arg('ttl', '3600'))
const factory  = arg('factory', process.env.FACTORY_ADDRESS)
const chainId  = arg('chain-id', process.env.CHAIN_ID ?? process.env.TARGET_CHAIN_ID)

const pk = process.env.POG_SIGNER_PRIVATE_KEY ?? process.env.PRIVATE_KEY

if (!user || !maxAlloc || !factory || !chainId || !pk) {
  console.error('usage: node scripts/signPoG.mjs --user 0x… --max-alloc <wei> --nonce <n>')
  console.error('       --factory and --chain-id fall back to .env.production, then .env;')
  console.error('       both are signed into the digest, so a wrong one is an InvalidSignature on chain.')
  console.error('       signing key: POG_SIGNER_PRIVATE_KEY, else PRIVATE_KEY')
  process.exit(1)
}

// MAX_SIG_VALIDITY is 24 h and the factory rejects a deadline beyond it, so a
// generous ttl fails closed rather than opening a long-lived attestation.
if (ttl > 86_400n) {
  console.error('--ttl exceeds ToshFactory.MAX_SIG_VALIDITY (24 h); registerPoG would revert SignatureTooLong')
  process.exit(1)
}

const deadline = BigInt(Math.floor(Date.now() / 1000)) + ttl

const digest = keccak256(encodeAbiParameters(
  parseAbiParameters('address, uint256, uint256, uint256, address, uint256'),
  [getAddress(user), BigInt(maxAlloc), BigInt(nonce), deadline, getAddress(factory), BigInt(chainId)]
))

const account   = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x' + pk)
const signature = await account.signMessage({ message: { raw: digest } })

// Recover before printing. The contract's `InvalidSignature` cannot distinguish
// a wrong key from a wrong chain id, so if the two disagree it has to be caught
// here or not at all.
const recovered = await recoverAddress({ hash: hashMessage({ raw: digest }), signature })
if (getAddress(recovered) !== getAddress(account.address)) {
  console.error('local recovery disagrees with the signing account — digest construction is wrong')
  process.exit(1)
}

// Then against the chain, which is the only thing that can say whether this key
// and this factory are the ones `registerPoG` will accept. Skipped, loudly, when
// no endpoint answers: an operator signing offline is a supported case, and
// failing here would push them toward removing the check rather than reading it.
const rpc = arg('rpc', process.env.ROBINHOOD_RPC)
if (rpc) {
  try {
    const pub = createPublicClient({ transport: http(rpc) })
    const liveChainId = await pub.getChainId()
    if (BigInt(liveChainId) !== BigInt(chainId)) {
      console.error(`✗ --chain-id ${chainId} is signed into the digest, but ${rpc} is chain ${liveChainId}.`)
      console.error('  One of the two is the wrong network. .env holds testnet values; .env.production holds mainnet.')
      process.exit(1)
    }
    if ((await pub.getCode({ address: getAddress(factory) })) === undefined) {
      console.error(`✗ no contract at --factory ${getAddress(factory)} on chain ${liveChainId}.`)
      process.exit(1)
    }
    const onChainSigner = await pub.readContract({
      address: getAddress(factory),
      abi: parseAbi(['function pogSigner() view returns (address)']),
      functionName: 'pogSigner',
    })
    if (getAddress(onChainSigner) !== getAddress(account.address)) {
      console.error('✗ this key is not the signer the factory accepts.')
      console.error(`    factory.pogSigner()  ${getAddress(onChainSigner)}`)
      console.error(`    key derives to       ${account.address}`)
      console.error('  registerPoG would revert InvalidSignature. Check POG_SIGNER_PRIVATE_KEY,')
      console.error('  and note that both env files have carried a stale POG_SIGNER_ADDRESS before.')
      process.exit(1)
    }
    console.log(`verified against ${rpc} — chain ${liveChainId}, factory.pogSigner() agrees.\n`)
  } catch (e) {
    // `process.exit` above terminates rather than throwing, so nothing reaches
    // here except a genuine transport or decode failure.
    console.error(`⚠ could not verify against ${rpc}: ${(e.shortMessage ?? e.message ?? e).split('\n')[0]}`)
    console.error('  Signing anyway. The digest is locally consistent but UNCHECKED against the chain.\n')
  }
} else {
  console.error('⚠ no --rpc and no ROBINHOOD_RPC: signer and chain id are UNCHECKED against the chain.\n')
}

console.log('signer      : ' + account.address + '   (must equal factory.pogSigner())')
console.log('user        : ' + getAddress(user))
console.log('maxAlloc    : ' + maxAlloc)
console.log('nonce       : ' + nonce)
console.log('deadline    : ' + deadline + '   (' + new Date(Number(deadline) * 1000).toISOString() + ')')
console.log('factory     : ' + getAddress(factory))
console.log('chainId     : ' + chainId)
console.log('digest      : ' + digest)
console.log('signature   : ' + signature)
console.log('')
console.log('registerPoG(uint256,uint256,uint256,bytes) args:')
console.log('  ' + maxAlloc + ' ' + deadline + ' ' + nonce + ' ' + signature)
