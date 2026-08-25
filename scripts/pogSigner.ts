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
  MOCK_CHAIN_GAS,
  totalGasEth,
  computeMaxAllocWei,
  computeDeadline,
  fetchGasToSatoRate,
  type ChainGasData,
} from '../soat-frontend/src/app/lib/pogQuota'

dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

// ─── Config ──────────────────────────────────────────────────────────────────

const POG_SIGNER_PRIVATE_KEY: string =
  process.env.POG_SIGNER_PRIVATE_KEY ?? (() => { throw new Error('POG_SIGNER_PRIVATE_KEY not set in .env') })()

const FACTORY_ADDRESS: string = process.env.FACTORY_ADDRESS ?? '0x59c3749548e0cb0b3b6b0209001a0bb5819aae49'
const CHAIN_ID: bigint = BigInt(process.env.CHAIN_ID ?? '84532')

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
  totalGasEth: number
}

// ─── Step A: Multi-chain gas scan ────────────────────────────────────────────

/**
 * Returns the canonical mock gas-history dataset.
 * Replace each entry with a real RPC / indexer call in production.
 * Kept thin (just async-shaped wrapper around the shared constant) so the
 * Next API and this CLI always agree on what gets signed.
 */
async function scanMultiChainGas(userAddress: string): Promise<ChainGasData[]> {
  console.log(`[PoG] Scanning gas history for ${userAddress} …`)
  MOCK_CHAIN_GAS.forEach(d => console.log(`  ${d.chain}: ${d.ethGasUsed} ETH`))
  // No-op await so the function can be drop-in replaced with a real query later
  await Promise.resolve()
  return MOCK_CHAIN_GAS
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

  const gasData     = await scanMultiChainGas(userAddress)
  const gasEth      = totalGasEth(gasData)
  const gasToSatoRate = await fetchGasToSatoRate(ADMIN_API_URL)

  const maxAlloc = computeMaxAllocWei(gasEth, gasToSatoRate)
  console.log(`[PoG] totalGasEth=${gasEth} rate=${gasToSatoRate} -> maxAlloc=${ethers.formatEther(maxAlloc)} SATO`)

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
    totalGasEth: gasEth,
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
 *   cast call $FACTORY_ADDRESS "pogNonces(address)(uint256)" $TEST_ADDRESS --rpc-url $BASE_SEPOLIA_RPC
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
