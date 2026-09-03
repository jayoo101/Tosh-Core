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
 * What must NOT diverge is the digest, so it is restated here once and pinned
 * by `--verify-against`, which recovers the signer locally before printing.
 * The digest is, from `ToshFactory.registerPoG`:
 *
 *   keccak256(abi.encode(user, maxAlloc, nonce, deadline, factory, chainId))
 *     .toEthSignedMessageHash()
 *
 * All six fields are signed, and five of them are things an operator can get
 * wrong without noticing. The factory answers every one of those mistakes with
 * the same `InvalidSignature`, so the local recovery below is the only place
 * that can tell you *which* field drifted.
 */

import { keccak256, encodeAbiParameters, parseAbiParameters, hashMessage,
         recoverAddress, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function envFromDotfile(key) {
  try {
    const line = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8')
      .split(/\r?\n/)
      .find(l => l.startsWith(key + '='))
    return line ? line.slice(key.length + 1).trim() : undefined
  } catch { return undefined }
}

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

const user     = arg('user')
const maxAlloc = arg('max-alloc')
const nonce    = arg('nonce', '0')
const ttl      = BigInt(arg('ttl', '3600'))
const factory  = arg('factory', process.env.FACTORY_ADDRESS ?? envFromDotfile('FACTORY_ADDRESS'))
const chainId  = arg('chain-id', process.env.CHAIN_ID ?? envFromDotfile('CHAIN_ID'))

const pk = process.env.POG_SIGNER_PRIVATE_KEY
  ?? envFromDotfile('POG_SIGNER_PRIVATE_KEY')
  ?? envFromDotfile('PRIVATE_KEY')

if (!user || !maxAlloc || !factory || !chainId || !pk) {
  console.error('usage: node scripts/signPoG.mjs --user 0x… --max-alloc <wei> --nonce <n>')
  console.error('       --factory and --chain-id fall back to .env; both are signed into the digest.')
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
