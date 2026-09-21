/*
 * loadRoleEnv.mjs
 * ───────────────
 * The PM-D4 scripts check the prospective Safe owners against the other
 * privileged roles — the deployer EOA and the PoG signer — because
 * `DeployMainnet.s.sol:requireDistinctRoles` will assert those are distinct and
 * a collision found at broadcast time is found too late.
 *
 * Those addresses live in .env, which Foundry loads automatically and Node does
 * not. That difference is the whole reason this file exists. Without it the
 * collision checks do not fail when a role is unset — they simply do not run,
 * and the script prints a pass. A guard that is satisfied by the absence of its
 * own input is worse than no guard, because it produces evidence.
 *
 * So: load the files, and make every role that is still missing say so out loud
 * in the caller's output.
 */

import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

/** Minimal KEY=VALUE reader. No interpolation, no export, no quotes handling
 *  beyond stripping a matched pair — this reads addresses, not shell script. */
function parse(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/**
 * An unfilled template value, in either of the two shapes the templates use.
 *
 * The `0x` is optional, and it did not used to be: this read
 * `/^0x?REPLACE_ME/i`, which requires a literal leading `0` and therefore only
 * recognised a placeholder that looked like an address. Every role var happens
 * to be an address or a chain id and every one of their placeholders is written
 * `0xREPLACE_ME…`, so nothing slipped through in practice — the only var in any
 * template that this missed is `ETHERSCAN_API_KEY=REPLACE_ME_ETHERSCAN_V2_KEY`,
 * and no caller passes that key.
 *
 * Fixed anyway, because the hole is exactly the shape of this function's one
 * job and the failure is silent: a placeholder that reads as a real value is
 * set into `process.env`, so the caller's "is it missing" gate passes and the
 * value goes on to be used. The next non-address role — an API key, an RPC URL,
 * a bare chain id — would have been the first to pay for it.
 */
const PLACEHOLDER = /^(0x)?(REPLACE_ME|YOUR)/i

/**
 * Fill in role vars from .env.production, then .env, without overwriting
 * anything already in the real environment.
 *
 * .env.production comes first deliberately. The mainnet scripts care about
 * mainnet roles, and .env currently holds testnet values where
 * POG_SIGNER_ADDRESS and PLATFORM_TREASURY are both the deployer — a set that
 * would fail all three of requireDistinctRoles' assertions. Reading those as
 * though they were the mainnet roles would produce loud, confusing, wrong
 * failures.
 *
 * @param {string[]} keys role vars the caller depends on
 * @returns {{ source: Record<string,string>, missing: string[] }}
 */
export function loadRoleEnv(keys) {
  const files = ['.env.production', '.env'].map(f => path.join(REPO_ROOT, f))
  const source = {}

  for (const file of files) {
    const parsed = parse(file)
    for (const key of keys) {
      if (process.env[key] || source[key]) continue
      if (parsed[key] && !PLACEHOLDER.test(parsed[key])) {
        process.env[key] = parsed[key]
        source[key] = path.basename(file)
      }
    }
  }
  for (const key of keys) {
    if (process.env[key] && !source[key]) source[key] = 'environment'
  }

  return { source, missing: keys.filter(k => !process.env[k]) }
}

/**
 * Print where each role came from, and — the part that matters — state plainly
 * which checks are NOT running because their input is missing.
 */
export function reportRoleEnv(keys, { source, missing }) {
  for (const key of keys) {
    if (source[key]) {
      const shown = key.includes('PRIVATE') ? '(set)' : process.env[key]
      console.log(`  ${key.padEnd(22)} ${shown}   ← ${source[key]}`)
    }
  }
  if (missing.length) {
    console.log('')
    for (const key of missing) {
      console.log(`  ⚠ ${key} is unset, in the environment and in both env files.`)
    }
    console.log('  The collision checks that depend on those are SKIPPED, not passed.')
    console.log('  DeployMainnet.s.sol asserts these roles are distinct, so a collision')
    console.log('  hidden here surfaces mid-broadcast at C1 instead. Set them and re-run.')
  }
  console.log('')
}
