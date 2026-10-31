#!/usr/bin/env node
/**
 * Safe Transaction Builder batch for the step `DeployV2.s.sol` leaves to the
 * Safe: `acceptOwnership()` on both factories and both treasuries.
 *
 *   node scripts/v2SafeAccept.mjs [chainId=56] [--v3 | --tag=v3.1] [--handoff]
 *
 * `--tag=<t>` reads `deployments/<t>-<chainId>.json` (the `DEPLOY_TAG` the
 * deploy ran with) and writes `safe-<t>-accept-<chainId>.json`.
 *
 * Reads `deployments/v2-<chainId>.json` and writes `safe-v2-accept-<chainId>.json`
 * (with `--v3`: `deployments/v3-<chainId>.json` from `DeployV3.s.sol`, written
 * to `safe-v3-accept-<chainId>.json`; the v3 AutoLps have no owner, so the
 * batch is the same four accepts) for upload in the Safe app (Transaction Builder → drag and drop).
 *
 * `--tag=v3.1` (`DeployV31.s.sol`) has one USDT factory and no owned
 * treasury (its buyback has no owner), so that batch is one accept.
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
const tagArg = args.find(a => a.startsWith('--tag='))?.slice('--tag='.length)
const ver = tagArg || (args.includes('--v3') ? 'v3' : 'v2')
if (!/^v[0-9.]+$/.test(ver)) throw new Error(`--tag: "${ver}" is not a deployment tag like v3.1`)
const chainId = Number(args.find(a => /^\d+$/.test(a)) ?? 56)

const file = `deployments/${ver}-${chainId}.json`
const dep = JSON.parse(readFileSync(file, 'utf8'))
const isAddr = v => /^0x[0-9a-fA-F]{40}$/.test(v ?? '')
// v3.1 is one USDT stack whose treasury is the ownerless buyback, so a stack
// is whatever `<side>Factory` the record names, and a treasury is optional.
const sides = ['bnb', 'usdt'].filter(s => dep[`${s}Factory`] !== undefined)
if (sides.length === 0) throw new Error(`${file}: no bnbFactory or usdtFactory`)
const stacks = sides.map(s => {
  for (const k of [`${s}Factory`, `${s}Gateway`]) if (!isAddr(dep[k])) throw new Error(`${file}: bad ${k}`)
  const treasury = dep[`${s}Treasury`]
  if (treasury !== undefined && !isAddr(treasury)) throw new Error(`${file}: bad ${s}Treasury`)
  if (treasury === undefined && !isAddr(dep.buyback)) throw new Error(`${file}: ${s} has neither a treasury nor a buyback`)
  return { factory: dep[`${s}Factory`], gateway: dep[`${s}Gateway`], treasury }
})

const word = hex => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const transferTo = addr => TRANSFER + word(addr)
// execute(bytes): offset 0x20, length 4, selector left-aligned in one word.
const executeAccept = EXECUTE + word('20') + word('4') + ACCEPT.slice(2).padEnd(64, '0')

const calls = []
for (const s of stacks) {
  calls.push({ to: s.factory, data: ACCEPT })
  if (s.treasury) calls.push({ to: s.treasury, data: ACCEPT })
}
if (handoff) {
  for (const s of stacks) {
    calls.push({ to: s.factory, data: transferTo(s.gateway) })
    calls.push({ to: s.gateway, data: executeAccept })
  }
}
const what = stacks.length === 2 ? 'both factories and treasuries' : 'the factory'

const batch = {
  version: '1.0',
  chainId: String(chainId),
  createdAt: Date.now(),
  meta: {
    name: `ToshX ${ver}: accept ownership${handoff ? ' + gateway handoff' : ''}`,
    description: `acceptOwnership on ${what} of ${ver}${handoff ? ', then hand each factory to its gateway' : ''}.`,
  },
  transactions: calls.map(c => ({ to: c.to, value: '0', data: c.data, contractMethod: null, contractInputsValues: null })),
}
const out = `safe-${ver}-accept-${chainId}.json`
writeFileSync(out, JSON.stringify(batch, null, 2) + '\n')
console.log(`${out}: ${calls.length} transactions`)
for (const c of calls) console.log(`  ${c.to}  ${c.data.slice(0, 10)}`)
