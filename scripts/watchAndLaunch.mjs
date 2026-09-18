#!/usr/bin/env node
/*
 * watchAndLaunch.mjs
 * ──────────────────
 * Watch one hook's genesis deadline and call `launch()` the moment it is both
 * due and eligible, from the creator wallet.
 *
 *   node scripts/watchAndLaunch.mjs --hook 0x… [--interval 30] [--dry-run]
 *
 * ── Why this needs a script at all ──────────────────────────────────────────
 *
 * `launch()` is gated by `OnlyCreator` on an address baked into the clone's
 * immutable args, so there is exactly one wallet in the world that can ever
 * call it, and a 7-day `LAUNCH_WINDOW` after the deadline in which to do so.
 * Miss the window and the raise cannot be launched at all — it falls to the
 * refund path, permanently. That is a deadline enforced by a contract against a
 * human remembering, which is the shape of problem a watcher is for.
 *
 * ── What it refuses to do ───────────────────────────────────────────────────
 *
 * Four states are reported and NOT retried, because in each of them sending
 * the transaction would burn gas on a revert that no amount of waiting fixes:
 *
 *   - already launched
 *   - the caller is not `creator()`
 *   - the raise never reached `softCap()` and the deadline has passed
 *   - the launch window has closed
 *
 * The last two are terminal by design. Reporting them as failures rather than
 * looping is the whole value: a watcher that retries forever against a closed
 * window looks identical to one that is working.
 *
 * ── The key ─────────────────────────────────────────────────────────────────
 *
 * Read from the environment or a dotfile, never from argv. `scripts/
 * e2eLaunchFlow.mjs` takes `--pk` and predates the incident in which a deployer
 * key reached PowerShell history; on Windows every argv value does. This script
 * does not offer the option.
 *
 * ── Which dotfile ───────────────────────────────────────────────────────────
 *
 * Resolved by `loadRoleEnv`: `.env.production` first, then `.env`. Each value's
 * origin is printed, which is not politeness. `.env` is a perfectly valid
 * TESTNET config — its `FACTORY_ADDRESS` is a real contract on 97 and has no
 * code at all on 56 — so a mainnet script that quietly prefers it fails in a
 * way that reads like a chain problem rather than a config one. The chain-id
 * check below is the backstop for exactly that.
 *
 * ── Why `process.exitCode` and never `process.exit()` ───────────────────────
 *
 * On Windows, `process.exit()` races the flush of a piped stdout: Node aborts
 * inside libuv with `!(handle->flags & UV_HANDLE_CLOSING)` and the shell sees a
 * crash code instead of the intended one. Observed on this script's own
 * not-the-creator path. Anything scheduling this run would read that as an
 * unknown failure rather than the specific, actionable one it is, so every exit
 * here sets `process.exitCode` and returns, letting Node leave on its own once
 * the output is actually out.
 */

import { createPublicClient, createWalletClient, http, parseAbi, formatEther, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { loadRoleEnv } from './loadRoleEnv.mjs'

const MAINNET_ID = 56

const ROLES = ['BSC_RPC', 'LAUNCH_CREATOR_PRIVATE_KEY']
const { source: roleSource } = loadRoleEnv(ROLES)

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}
const flag = (name) => process.argv.includes('--' + name)

const HOOK_ABI = parseAbi([
  'function creator() view returns (address)',
  'function launched() view returns (bool)',
  'function genesisDeadline() view returns (uint256)',
  'function totalNativeDeposited() view returns (uint256)',
  'function softCap() view returns (uint256)',
  'function LAUNCH_WINDOW() view returns (uint256)',
  'function launch()',
])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = (t) => new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z'

function human(seconds) {
  const s = Number(seconds)
  if (s <= 0) return 'now'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`
}

/** Print to stderr and hand back an exit code, for `return fail(...)`. */
function fail(...lines) {
  for (const l of lines) console.error(l)
  return 1
}

async function main() {
  const hookArg = arg('hook')
  const intervalSec = Number(arg('interval', '30'))
  const dryRun = flag('dry-run')

  if (!hookArg) {
    return fail(
      'usage: node scripts/watchAndLaunch.mjs --hook 0x… [--interval 30] [--dry-run]',
      '       signing key: LAUNCH_CREATOR_PRIVATE_KEY (environment, .env.production or .env)',
    ) + 1 // 2: usage, distinct from an operational failure
  }
  const hook = getAddress(hookArg)

  const rpc = arg('rpc', process.env.BSC_RPC ?? 'https://bsc-dataseed1.bnbchain.org')
  const pk = process.env.LAUNCH_CREATOR_PRIVATE_KEY

  if (!pk) {
    return fail(
      '✗ LAUNCH_CREATOR_PRIVATE_KEY is unset in the environment, .env.production and .env.',
      '  This must be the key for the wallet that called createLaunch: OnlyCreator admits no other.',
    ) + 1
  }

  const account = privateKeyToAccount(pk.startsWith('0x') ? pk : '0x' + pk)
  const pub = createPublicClient({ transport: http(rpc) })
  const wallet = createWalletClient({ account, transport: http(rpc) })
  const read = (functionName) => pub.readContract({ address: hook, abi: HOOK_ABI, functionName })

  // ── Pre-flight. Fatal, and none of it changes while we wait ──────────────

  console.log('resolved configuration:')
  console.log(`  BSC_RPC                    ${rpc}   ← ${arg('rpc') ? 'command line' : roleSource.BSC_RPC ?? 'built-in default'}`)
  console.log(`  LAUNCH_CREATOR_PRIVATE_KEY (set)   ← ${roleSource.LAUNCH_CREATOR_PRIVATE_KEY}`)
  console.log(`  caller                     ${account.address}`)
  console.log(`  hook                       ${hook}\n`)

  const chainId = await pub.getChainId()
  if (chainId !== MAINNET_ID) {
    return fail(
      `✗ connected to chain ${chainId}, not BNB Smart Chain mainnet (${MAINNET_ID}).`,
      '  Refusing to run: .env may still carry the testnet TARGET_CHAIN_ID.',
    )
  }

  if ((await pub.getCode({ address: hook })) === undefined) {
    return fail(`✗ no contract at ${hook}.`)
  }

  const creator = await read('creator')
  if (getAddress(creator) !== getAddress(account.address)) {
    return fail(
      '✗ this wallet cannot ever launch this hook.',
      `    creator()  ${creator}`,
      `    caller     ${account.address}`,
      '  `creator` is an immutable clone argument. No key rotation or admin call changes it.',
    )
  }

  const [deadline, softCap, launchWindow] = await Promise.all([
    read('genesisDeadline'), read('softCap'), read('LAUNCH_WINDOW'),
  ])
  const windowCloses = deadline + launchWindow

  console.log('genesis:')
  console.log(`  softCap        ${formatEther(softCap)} ETH`)
  console.log(`  deadline       ${stamp(deadline)}`)
  console.log(`  window closes  ${stamp(windowCloses)}  (LAUNCH_WINDOW ${human(launchWindow)})`)
  console.log(`  polling every  ${intervalSec}s${dryRun ? '   [DRY RUN: will not send]' : ''}\n`)

  // ── The loop ─────────────────────────────────────────────────────────────

  let lastLine = ''
  for (;;) {
    const [launched, raised] = await Promise.all([read('launched'), read('totalNativeDeposited')])
    const now = BigInt((await pub.getBlock()).timestamp)

    if (launched) {
      console.log('✓ launched. The pool is open; nothing left for this script to do.')
      return 0
    }

    if (now > windowCloses) {
      return fail(
        `✗ the launch window closed at ${stamp(windowCloses)}. \`launch()\` can no longer succeed.`,
        '  The raise falls to the refund path. See `canRefund()` and `refund()`.',
      )
    }

    const met = raised >= softCap && raised > 0n

    if (now < deadline) {
      // Still taking deposits. Report progress but do not act: `launch()` before
      // the deadline reverts; more ETH may still arrive.
      const line = `  waiting · ${human(deadline - now)} to deadline`
        + ` · raised ${formatEther(raised)}/${formatEther(softCap)} ETH${met ? ' (target met)' : ''}`
      if (line !== lastLine) { console.log(line); lastLine = line }
      await sleep(intervalSec * 1000)
      continue
    }

    if (raised === 0n) {
      return fail(
        '✗ deadline passed with nothing raised.',
        '  `launch()` rejects a zero raise (`ZeroAmount`); there is no pool to seed.',
        '  The name can be freed with `releaseAbandonedName` after the launch window lapses.',
      )
    }

    // Due. The soft cap is a progress target, not a gate — any non-zero raise
    // may open the pool until the 7-day launch window lapses.
    console.log(`  due · raised ${formatEther(raised)} ETH · target ${formatEther(softCap)} ETH · simulating…`)
    try {
      await pub.simulateContract({ address: hook, abi: HOOK_ABI, functionName: 'launch', account })
    } catch (e) {
      return fail(
        '✗ simulation reverted; not sending:',
        '  ' + (e.shortMessage ?? e.message ?? '').split('\n')[0],
        `  ${human(windowCloses - now)} left in the launch window. Fix and re-run.`,
      )
    }

    if (dryRun) {
      console.log('✓ simulation passed. [DRY RUN] not sending. Re-run without --dry-run to launch.')
      return 0
    }

    const hash = await wallet.writeContract({ address: hook, abi: HOOK_ABI, functionName: 'launch', chain: null })
    console.log(`  sent ${hash}, waiting for the receipt…`)
    const receipt = await pub.waitForTransactionReceipt({ hash })

    if (receipt.status !== 'success') {
      return fail(`✗ launch() reverted on chain. ${human(windowCloses - now)} left in the window.`)
    }
    console.log(`\n✓ launched in block ${receipt.blockNumber} · ${receipt.gasUsed.toLocaleString()} gas · ${hash}`)
    return 0
  }
}

process.exitCode = await main().catch((e) => {
  console.error('✗ ' + (e.shortMessage ?? e.message ?? e))
  return 1
})
