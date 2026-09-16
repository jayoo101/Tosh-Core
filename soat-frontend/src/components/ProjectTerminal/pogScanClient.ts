/**
 * Client half of an unsigned PoG gas lookup.
 *
 * Starts `/api/pog-scan` without a wallet signature and polls until the job is
 * finished. Attestation (`sign-allocation` + `registerPoG`) is a separate step
 * that still needs custody — this module only reads public fee totals.
 */

import type { Address } from 'viem'

export interface PogChainSpend {
  chain: string
  chainId: number
  gasWei: string
  sentTxs: number
  truncated: boolean
  skipped: boolean
  unavailable?: boolean
}

export interface PogScanResult {
  status: 'running' | 'done' | 'failed' | 'absent'
  eligible?: boolean
  totalGasWei?: string
  maxAllocWei?: string
  floorWei: string
  truncated?: boolean
  unavailableChains?: string[]
  chains?: PogChainSpend[]
  error?: string
  retryAfterMs?: number
}

const POLL_BUDGET_MS = 135_000
const POLL_INTERVAL_MS = 2_000

/**
 * Start (or join) a scan for `userAddress` and wait for the finished figures.
 * No wallet prompt.
 */
export async function runUnsignedPogScan(
  userAddress: Address,
  chainId: number,
  opts?: { force?: boolean; signal?: AbortSignal },
): Promise<PogScanResult & { totalGasWei: string; chains: PogChainSpend[] }> {
  const started = await fetch('/api/pog-scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userAddress,
      chainId,
      ...(opts?.force ? { force: true } : {}),
    }),
    signal: opts?.signal,
  })
  const first = (await started.json()) as PogScanResult
  if (!started.ok) {
    const wait = first.retryAfterMs
    throw new Error(
      (first.error ?? `HTTP ${started.status}`)
      + (wait ? ` Try again in ${Math.ceil(wait / 60_000)} min.` : ''),
    )
  }

  let latest = first
  const deadline = Date.now() + POLL_BUDGET_MS
  while (latest.status === 'running') {
    if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (Date.now() > deadline) throw new Error('Gas scan timed out. Try again.')
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    const polled = await fetch(
      `/api/pog-scan?address=${userAddress}`,
      { cache: 'no-store', signal: opts?.signal },
    )
    latest = (await polled.json()) as PogScanResult
    if (!polled.ok) throw new Error(latest.error ?? `HTTP ${polled.status}`)
  }

  if (latest.status !== 'done' || typeof latest.totalGasWei !== 'string') {
    throw new Error(latest.error ?? 'Gas scan failed. Try again.')
  }
  return {
    ...latest,
    totalGasWei: latest.totalGasWei,
    chains: latest.chains ?? [],
  }
}
