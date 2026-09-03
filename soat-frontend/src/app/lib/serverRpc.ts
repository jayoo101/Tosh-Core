// ─────────────────────────────────────────────────────────────────────────────
//  serverRpc.ts — the one place that decides which RPC the SERVER talks to.
//
//  WHY THIS IS CENTRAL
//  ───────────────────
//  Four server modules used to pick an endpoint themselves, and all four had
//  the same shape (the names below are the Base-era ones this module was
//  written against; the argument is identical for their Robinhood successors):
//
//      process.env.BASE_SEPOLIA_RPC
//        ?? process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC
//        ?? 'https://sepolia.base.org'
//
//  paired with `createPublicClient({ chain: targetChain, ... })`. Neither half
//  knows what the other picked, so the chain and the transport are free to
//  disagree: a production build that never sets an RPC lands on the hardcoded
//  *testnet* default and reads a chain it was never pointed at. A stray
//  testnet RPC exported in the deploy shell does the same thing, and Next's env
//  loader will not override an already-present variable, so `.env.production`
//  loses that race silently.
//
//  That is not a cosmetic misconfiguration. `POST /api/projects` authenticates
//  a directory listing by reading the launch's receipt and trusting the
//  `LaunchCreated` creator in it. Read that receipt on the wrong chain and a
//  launch minted on a free testnet authenticates a listing in the production
//  directory — the exact phishing vector the signature check was added to
//  close, one chain over and cheaper.
//
//  THE RULE
//  ────────
//  A chain-scoped env name is only ever consulted when that chain is the
//  target, and a fallback is only ever that chain's own public endpoint.
//  Nothing here can return an endpoint for a chain other than the one asked
//  for — the worst case is a wrong URL for the right chain, which
//  `assertServerChain` then catches at the call sites that cannot tolerate it.
// ─────────────────────────────────────────────────────────────────────────────

import { createPublicClient, http } from 'viem'
import type { Chain, PublicClient } from 'viem'
import { foundry, robinhood, robinhoodTestnet } from 'viem/chains'

import {
  FOUNDRY_CHAIN_ID,
  ROBINHOOD_ID,
  ROBINHOOD_TESTNET_ID,
  TARGET_CHAIN_ID,
  targetChain,
} from '@/lib/chain'

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim()
  return t && t.length > 0 ? t : undefined
}

/**
 * Public endpoint of last resort, per chain.
 *
 * Keyed by chain id precisely so that no entry can ever be handed out for a
 * different chain — the bug this module exists to make unrepresentable.
 */
const PUBLIC_FALLBACK: Record<number, string> = {
  [ROBINHOOD_ID]:          'https://rpc.mainnet.chain.robinhood.com',
  [ROBINHOOD_TESTNET_ID]:  'https://rpc.testnet.chain.robinhood.com',
  [FOUNDRY_CHAIN_ID]:      'http://127.0.0.1:8545',
}

const CHAINS_BY_ID: Record<number, Chain> = {
  [ROBINHOOD_ID]:         robinhood,
  [ROBINHOOD_TESTNET_ID]: robinhoodTestnet,
  [FOUNDRY_CHAIN_ID]:     foundry,
}

/**
 * Env names that carry a chain in the name, and are therefore only meaningful
 * for that chain. `ROBINHOOD_TESTNET_RPC` on a production build is stale
 * configuration, not an override.
 */
function scopedEnvUrl(chainId: number): string | undefined {
  switch (chainId) {
    case ROBINHOOD_ID:
      return trimmed(process.env.ROBINHOOD_RPC)
        ?? trimmed(process.env.NEXT_PUBLIC_ROBINHOOD_RPC)
    case ROBINHOOD_TESTNET_ID:
      return trimmed(process.env.ROBINHOOD_TESTNET_RPC)
        ?? trimmed(process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC)
    case FOUNDRY_CHAIN_ID:
      return trimmed(process.env.LOCAL_RPC)
    default:
      return undefined
  }
}

/**
 * `NEXT_PUBLIC_RPC_URL` is the chain-agnostic override: it names no chain, so
 * it is taken to mean "the endpoint for whatever chain this build targets" and
 * applies only to the target chain.
 */
export function serverRpcUrl(chainId: number = TARGET_CHAIN_ID): string {
  if (chainId === TARGET_CHAIN_ID) {
    const generic = trimmed(process.env.NEXT_PUBLIC_RPC_URL)
    if (generic) return generic
  }

  const scoped = scopedEnvUrl(chainId)
  if (scoped) return scoped

  const fallback = PUBLIC_FALLBACK[chainId]
  if (!fallback) {
    throw new Error(
      `[serverRpc] No endpoint known for chain ${chainId}. Set NEXT_PUBLIC_RPC_URL, ` +
      'or add the chain to PUBLIC_FALLBACK / CHAINS_BY_ID in serverRpc.ts.',
    )
  }
  return fallback
}

const clientCache = new Map<number, PublicClient>()

/**
 * A client whose `chain` and `transport` are chosen together, so the two can
 * never describe different networks.
 */
export function serverPublicClient(chainId: number = TARGET_CHAIN_ID): PublicClient {
  const cached = clientCache.get(chainId)
  if (cached) return cached

  const chain = chainId === TARGET_CHAIN_ID ? targetChain : CHAINS_BY_ID[chainId]
  if (!chain) {
    throw new Error(`[serverRpc] Unsupported chain ${chainId}.`)
  }

  const client = createPublicClient({
    chain,
    transport: http(serverRpcUrl(chainId), { timeout: 6_000 }),
  }) as PublicClient
  clientCache.set(chainId, client)
  return client
}

/**
 * Cached per endpoint: the answer cannot change without a redeploy, and the
 * auth-critical callers run on the hot path of a user-facing POST.
 *
 * A rejected probe is evicted rather than memoised, so a transient outage at
 * boot does not permanently mark a correct endpoint as unusable.
 */
const chainIdProbes = new Map<string, Promise<number>>()

/**
 * Is the endpoint we are about to trust actually on the chain we think?
 *
 * Selection above makes a cross-chain endpoint unrepresentable *given correct
 * env values*; this catches the remaining case where the value itself is wrong
 * — a copy-pasted Alchemy URL for the wrong network, say. Call it before any
 * read whose answer authorises something.
 */
export async function assertServerChain(chainId: number = TARGET_CHAIN_ID): Promise<boolean> {
  const url = serverRpcUrl(chainId)
  let probe = chainIdProbes.get(url)
  if (!probe) {
    probe = serverPublicClient(chainId).getChainId()
    chainIdProbes.set(url, probe)
  }
  try {
    return (await probe) === chainId
  } catch {
    chainIdProbes.delete(url)
    return false
  }
}
