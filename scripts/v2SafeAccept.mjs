#!/usr/bin/env node
/**
 * Safe Transaction Builder batch for the step `DeployV2.s.sol` leaves to the
 * Safe: `acceptOwnership()` on both factories and both treasuries.
 *
 *   node scripts/v2SafeAccept.mjs [chainId=56] [--v3] [--handoff]
 *
 * Reads `deployments/v2-<chainId>.json` and writes `safe-v2-accept-<chainId>.json`
 * (with `--v3`: `deployments/v3-<chainId>.json` from `DeployV3.s.sol`, written
 * to `safe-v3-accept-<chainId>.json`; the v3 AutoLps have no owner, so the
 * batch is the same four accepts) for upload in the Safe app (Transaction Builder → drag and drop).
 *
 * `--handoff` appends the optional gateway handoff for each factory:
 * `factory.transferOwnership(gateway)` then `gateway.execute(acceptOwnership())`.
 * After it, listing goes through the gateway's launchers and every other
 * factory power still needs the Safe (via `gateway.execute`).
 *
 * No dependencies: the repo root has no node_modules, and three fixed
 * selectors do not need an ABI encoder.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ACCEPT = '0x79ba5097' // acceptOwnership()
const TRANSFER = '0xf2fde38b' // transferOwnership(address)
const EXECUTE = '0x09c5eabe' // execute(bytes)

const args = process.argv.slice(2)
const handoff = args.includes('--handoff')
const ver = args.includes('--v3') ? 'v3' : 'v2'
const chainId = Number(args.find(a => /^\d+$/.test(a)) ?? 56)

const dep = JSON.parse(readFileSync(`deployments/${ver}-${chainId}.json`, 'utf8'))
const need = ['bnbFactory', 'bnbTreasury', 'bnbGateway', 'usdtFactory', 'usdtTreasury', 'usdtGateway']
const a = {}
for (const k of need) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(dep[k] ?? '')) throw new Error(`deployments/${ver}-${chainId}.json: bad ${k}`)
  a[k] = dep[k]
}

const word = hex => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const transferTo = addr => TRANSFER + word(addr)
// execute(bytes): offset 0x20, length 4, selector left-aligned in one word.
const executeAccept = EXECUTE + word('20') + word('4') + ACCEPT.slice(2).padEnd(64, '0')

const calls = [
  { to: a.bnbFactory, data: ACCEPT },
  { to: a.bnbTreasury, data: ACCEPT },
  { to: a.usdtFactory, data: ACCEPT },
  { to: a.usdtTreasury, data: ACCEPT },
]
if (handoff) {
  for (const [f, g] of [[a.bnbFactory, a.bnbGateway], [a.usdtFactory, a.usdtGateway]]) {
    calls.push({ to: f, data: transferTo(g) })
    calls.push({ to: g, data: executeAccept })
  }
}

const batch = {
  version: '1.0',
  chainId: String(chainId),
  createdAt: Date.now(),
  meta: {
    name: `ToshX ${ver}: accept ownership${handoff ? ' + gateway handoff' : ''}`,
    description: `acceptOwnership on both ${ver} factories and treasuries${handoff ? ', then hand each factory to its gateway' : ''}.`,
  },
  transactions: calls.map(c => ({ to: c.to, value: '0', data: c.data, contractMethod: null, contractInputsValues: null })),
}
const out = `safe-${ver}-accept-${chainId}.json`
writeFileSync(out, JSON.stringify(batch, null, 2) + '\n')
console.log(`${out}: ${calls.length} transactions`)
for (const c of calls) console.log(`  ${c.to}  ${c.data.slice(0, 10)}`)
