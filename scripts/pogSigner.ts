/**
 * pogSigner.ts — Tosh Fair Launchpad backend PoG oracle (standalone)
 *
 * Generates EIP-191 signed PoG attestations that match the Solidity check:
 *   keccak256(abi.encode(sender, maxAlloc, nonce, deadline, factory, chainId))
 *
 * Quota source-of-truth: `../soat-frontend/src/app/lib/pogQuota.ts`
 * The same module is imported by the Next.js `/api/pog` route, so the
 * standalone CLI and the web API never disagree on `maxAlloc`/`deadline`.
 *
 * Usage:
 *   ts-node scripts/pogSigner.ts
 *   # or: npx tsx scripts/pogSigner.ts
 */

import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
import * as path from 'path'

import {
  computeMaxAllocFromWei,
  isPogEligible,
  computeDeadline,
  fetchPogBand,
  pogCapWei,
} from '../soat-frontend/src/app/lib/pogQuota'
import { scanGasHistory } from '../soat-frontend/src/app/lib/gasHistory'

dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

// ─── Config ──────────────────────────────────────────────────────────────────

const POG_SIGNER_PRIVATE_KEY: string =
  process.env.POG_SIGNER_PRIVATE_KEY ?? (() => { throw new Error('POG_SIGNER_PRIVATE_KEY not set in .env') })()

// Both are required rather than defaulted, and the reason is the digest below:
// `chainid` and the factory address are signed INTO it. A stale default does not
// fail here, it produces a well-formed signature the factory rejects — and the
// revert an operator sees is a generic bad-signature error that says nothing
// about which of the six signed fields was wrong. The previous defaults pointed
// at the retired Base Sepolia staging deployment, so they were exactly that trap
// waiting to be stepped in.
const FACTORY_ADDRESS: string =
  process.env.FACTORY_ADDRESS ?? (() => { throw new Error('FACTORY_ADDRESS not set in .env — it is signed into the PoG digest, so there is no safe default') })()
const CHAIN_ID: bigint =
  BigInt(process.env.CHAIN_ID ?? (() => { throw new Error('CHAIN_ID not set in .env — 4663 for Robinhood Chain, 46630 for its testnet') })())

/** Admin API base URL for fetching the current gas-to-SATO rate. */
const ADMIN_API_URL: string = process.env.ADMIN_API_URL ?? 'http://localhost:3000'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PoGSignatureBundle {
  userAddress: string
  maxAlloc: string     // hex/decimal string of bigint, 18-decimal
  deadline: number
  nonce: number | bigint
  signature: string
  gasToSatoRate: number
  /** Total gas spend the allocation was derived from, in wei as a decimal
   *  string. Was `totalGasEth: number`; a float cannot hold a wei figure near
   *  the cap without losing its low digits, and this is the number the
   *  attestation is about. */
  totalGasWei: string
}

// ─── Step A: Multi-chain gas scan ────────────────────────────────────────────

/**
 * Reads the wallet's real gas history from the same module the API route uses.
 *
 * This used to log a constant table and return it. It now calls the live scan,
 * because the reason this CLI and the route share `pogQuota.ts` at all is that
 * they must sign the SAME allocation for the same wallet — and they cannot, if
 * one of them is looking at five chains and the other at a hard-coded four rows.
 *
 * It calls `scanGasHistory` directly rather than going through `/api/pog-scan`
 * on purpose: this is the break-glass signer, used when the web path is the
 * thing that is broken, so depending on a web endpoint would defeat it. The
 * cost is that it does not share the route's hourly cache and always re-reads
 * the chains, which for a manual tool is the right trade.
 */
async function scanMultiChainGas(userAddress: string, capWei: bigint): Promise<bigint> {
  console.log(`[PoG] Scanning gas history for ${userAddress} …`)
  const history = await scanGasHistory(userAddress, capWei)
  for (const c of history.chains) {
    console.log(
      `  ${c.chain.padEnd(10)} ${ethers.formatEther(c.weiSpent).padStart(14)} ETH`
      + `  sent=${c.sentTxs}${c.skipped ? '  (skipped: already at cap)' : ''}`
      + `${c.truncated ? '  (TRUNCATED — lower bound)' : ''}`
      + `${c.execFeeOnly && c.sentTxs > 0 ? '  (execution fees only)' : ''}`)
  }
  if (history.truncated) {
    console.warn('[PoG] WARNING: page budget exhausted on at least one chain. '
      + 'The total is a lower bound, so the allocation is conservative.')
  }
  return history.totalWei
}

// ─── Core: issuePoGSignature ──────────────────────────────────────────────────

/**
 * Issues a signed PoG attestation bundle.
 *
 * @param userAddress   The user's wallet address (checksummed or lowercase)
 * @param currentNonce  The user's current pogNonces value from the contract
 */
export async function issuePoGSignature(
  userAddress: string,
  currentNonce: number | bigint
): Promise<PoGSignatureBundle> {
  const wallet = new ethers.Wallet(POG_SIGNER_PRIVATE_KEY)

  // The band first, because it decides how far the scan needs to page. All
  // three values come from the one endpoint read: a CLI that fetched the rate
  // and held its own floor would be back to two signers with two answers.
  const band = await fetchPogBand(ADMIN_API_URL)
  const gasToSatoRate = band.rate

  const totalGasWei = await scanMultiChainGas(userAddress, pogCapWei(band))

  // The floor is refused here too, and for the same reason the route refuses it:
  // a zero allocation registers successfully and then fails at `deposit` with
  // `NoPogQuota`, so signing one would cost the wallet gas to be turned away.
  if (!isPogEligible(totalGasWei, band)) {
    throw new Error(
      `[PoG] ${userAddress} has ${ethers.formatEther(totalGasWei)} ETH of gas history, `
      + `below the ${ethers.formatEther(band.floorWei)} ETH minimum. Refusing to sign.`)
  }

  const maxAlloc = computeMaxAllocFromWei(totalGasWei, band)
  console.log(`[PoG] totalGas=${ethers.formatEther(totalGasWei)} ETH rate=${gasToSatoRate}`
    + ` floor=${ethers.formatEther(band.floorWei)} ceiling=${ethers.formatEther(band.maxAllocWei)}`
    + ` -> maxAlloc=${ethers.formatEther(maxAlloc)} ETH`)

  const deadline = computeDeadline()

  // ABI-encode exactly as the Solidity contract expects:
  //   keccak256(abi.encode(address, uint256, uint256, uint256, address, uint256))
  const coder = ethers.AbiCoder.defaultAbiCoder()
  const encoded = coder.encode(
    ['address', 'uint256', 'uint256', 'uint256', 'address', 'uint256'],
    [
      ethers.getAddress(userAddress),
      maxAlloc,
      BigInt(currentNonce),
      BigInt(deadline),
      ethers.getAddress(FACTORY_ADDRESS),
      CHAIN_ID,
    ]
  )

  const messageHash = ethers.keccak256(encoded)

  // EIP-191: wallet.signMessage prepends "\x19Ethereum Signed Message:\n32"
  // → matches Solidity `MessageHashUtils.toEthSignedMessageHash`.
  const signature = await wallet.signMessage(ethers.getBytes(messageHash))
  console.log(`[PoG] Signed by ${wallet.address}`)

  return {
    userAddress: ethers.getAddress(userAddress),
    maxAlloc: maxAlloc.toString(),
    deadline,
    nonce: currentNonce,
    signature,
    gasToSatoRate,
    totalGasWei: totalGasWei.toString(),
  }
}

// ─── Test entry-point ─────────────────────────────────────────────────────────

/**
 * Resolve the PoG nonce for CLI test runs.
 *
 * Priority:
 *   1. `TEST_NONCE` environment variable
 *   2. `--nonce=<n>` or `--nonce <n>` command-line flag
 *   3. First bare numeric positional argument (e.g. `ts-node pogSigner.ts 3`)
 *   4. Default `0`
 *
 * Fetch the live value from chain when testing repeat scans:
 *   cast call $FACTORY_ADDRESS "pogNonces(address)(uint256)" $TEST_ADDRESS --rpc-url $ROBINHOOD_TESTNET_RPC
 */
function parseTestNonce(): bigint {
  const envRaw = process.env.TEST_NONCE
  if (envRaw !== undefined && envRaw.trim() !== '') {
    return BigInt(envRaw.trim())
  }

  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--nonce=')) {
      const val = arg.slice('--nonce='.length).trim()
      if (val !== '') return BigInt(val)
    }
    if (arg === '--nonce' && argv[i + 1] !== undefined) {
      const val = argv[i + 1].trim()
      if (val !== '') return BigInt(val)
    }
    if (!arg.startsWith('-') && /^\d+$/.test(arg)) {
      return BigInt(arg)
    }
  }

  return 0n
}

async function main() {
  const TEST_ADDRESS = '0x73db078fa94607893270079AC8F5c7492aB480cd'
  const nonce        = parseTestNonce()

  console.log('═══════════════════════════════════════════')
  console.log('  Tosh PoG Signer — Test Run')
  console.log(`  Factory : ${FACTORY_ADDRESS}`)
  console.log(`  Chain   : ${CHAIN_ID}`)
  console.log(`  Wallet  : ${TEST_ADDRESS}`)
  console.log('═══════════════════════════════════════════')
  console.log(` Generating signature with Nonce: ${nonce}`)

  const bundle = await issuePoGSignature(TEST_ADDRESS, nonce)

  console.log('\n✅ Signature bundle:')
  console.log(JSON.stringify(bundle, null, 2))
}

// Only run when executed directly (not when imported as a module)
if (require.main === module) {
  main().catch(err => {
    console.error('[PoG] Fatal error:', err)
    process.exit(1)
  })
}
