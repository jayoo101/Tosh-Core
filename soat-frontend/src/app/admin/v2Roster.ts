import type { Address, Hex } from 'viem'

export interface RosterProject {
  token: Address
  hook: Address
  factory: Address
  launched: boolean
  symbol: string
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** This factory's launched projects that the treasury does not list yet. */
export function rosterCandidates<P extends RosterProject>(projects: readonly P[], factory: Address, listed: readonly Address[]): P[] {
  return projects.filter(p => p.launched && same(p.factory, factory) && !listed.some(t => same(t, p.token)))
}

/**
 * `addLadderToken` refuses a hook whose TWAP reads zero or reverts: the first
 * `TWAP_WINDOW` (30 min) after `launch()`.
 */
export function twapReady(read: { status: 'success' | 'failure'; result?: unknown } | undefined): boolean {
  return read?.status === 'success' && typeof read.result === 'bigint' && read.result !== 0n
}

/** A Safe Transaction Builder batch: drop the file into the Safe app and sign. */
export function safeBatch(chainId: number, name: string, description: string, calls: readonly { to: Address; data: Hex }[]) {
  return {
    version: '1.0',
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name, description },
    transactions: calls.map(c => ({ to: c.to, value: '0', data: c.data, contractMethod: null, contractInputsValues: null })),
  }
}

export function downloadJson(filename: string, body: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
