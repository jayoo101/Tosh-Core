import type { Address, Chain } from 'viem'
import { base, baseSepolia, foundry, mainnet } from 'viem/chains'

/**
 * Settlement chain the UI talks to.
 *
 * `NEXT_PUBLIC_CHAIN_ID` is the switch.  POOL_MANAGER stays a source-code
 * constant in `contracts.ts` (a wrong one silently mis-CREATE2s every hook);
 * everything else — periphery addresses, explorer URLs, wagmi's chain list —
 * follows this id so a mainnet cutover is env, not a rebuild of the UI.
 */
function parseChainId(): number {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID
  const n = raw ? Number(raw) : 84532
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 84532
}

export const TARGET_CHAIN_ID = parseChainId()
export const BASE_SEPOLIA_ID = 84532 as const
export const BASE_MAINNET_ID = 8453 as const
export const ETHEREUM_ID = 1 as const
export const FOUNDRY_CHAIN_ID = 31337 as const

const CHAINS_BY_ID: Record<number, Chain> = {
  [ETHEREUM_ID]: mainnet,
  [BASE_MAINNET_ID]: base,
  [BASE_SEPOLIA_ID]: baseSepolia,
  [FOUNDRY_CHAIN_ID]: foundry,
}

export const targetChain: Chain = CHAINS_BY_ID[TARGET_CHAIN_ID] ?? baseSepolia

export const SUPPORTED_POG_CHAIN_IDS = [TARGET_CHAIN_ID, FOUNDRY_CHAIN_ID] as const

export function isSupportedPogChain(chainId: number): boolean {
  return (SUPPORTED_POG_CHAIN_IDS as readonly number[]).includes(chainId)
}

export const MAINNET_CHAIN_LABEL =
  TARGET_CHAIN_ID === ETHEREUM_ID ? 'Ethereum'
  : TARGET_CHAIN_ID === BASE_MAINNET_ID ? 'Base'
  : 'Ethereum'

export const TESTNET_CHAIN_LABEL =
  TARGET_CHAIN_ID === BASE_SEPOLIA_ID ? 'Base Sepolia'
  : TARGET_CHAIN_ID === FOUNDRY_CHAIN_ID ? 'Foundry'
  : targetChain.name

export const CHAIN_STATUS_BADGE =
  TARGET_CHAIN_ID === BASE_SEPOLIA_ID ? 'TESTNET · BASE SEPOLIA'
  : TARGET_CHAIN_ID === BASE_MAINNET_ID ? 'MAINNET · BASE'
  : TARGET_CHAIN_ID === ETHEREUM_ID ? 'MAINNET · ETHEREUM'
  : `CHAIN ${TARGET_CHAIN_ID}`

export const CHAIN_POSITIONING =
  TARGET_CHAIN_ID === BASE_SEPOLIA_ID
    ? 'Settlement on Ethereum — currently staging on Base Sepolia testnet.'
    : TARGET_CHAIN_ID === BASE_MAINNET_ID
      ? 'Settled on Base.'
      : TARGET_CHAIN_ID === ETHEREUM_ID
        ? 'Settled on Ethereum.'
        : `Settled on ${targetChain.name}.`

function explorerBase(): string {
  if (TARGET_CHAIN_ID === BASE_MAINNET_ID) return 'https://basescan.org'
  if (TARGET_CHAIN_ID === ETHEREUM_ID) return 'https://etherscan.io'
  return 'https://sepolia.basescan.org'
}

export function testnetExplorerTx(hash: string): string {
  return `${explorerBase()}/tx/${hash}`
}

export function testnetExplorerAddress(addr: string): string {
  return `${explorerBase()}/address/${addr}`
}

export function envAddress(name: string, fallback: Address): Address {
  const v = process.env[name]
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v.trim())) {
    return v.trim() as Address
  }
  return fallback
}
