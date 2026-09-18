/**
 * Chains this protocol has left, and a refusal to operate on one.
 *
 * ── Why this is a module and not a comment in five scripts ──────────────────
 *
 * `checkStatusPage.mjs` already learned the lesson this file generalises: it
 * held its departed-chain regex as a `const` inside one check, a second check
 * needed the same list, and the fix was to hoist it to module scope rather than
 * copy it — because a copy goes stale on one side and stays green on the other.
 * Five scripts in this directory pin a retired chain. Five copies of the list
 * is the same mistake with more surface.
 *
 * ── The failure this prevents, which is NOT an error ────────────────────────
 *
 * The reflex is that a retired chain's endpoint stops answering and a script
 * pointed at one dies with a network error, loudly, in a way nobody can
 * misread. That reflex is wrong here, and it was checked rather than assumed:
 * on 2026-09-18 `https://rpc.testnet.chain.robinhood.com` answered
 * `eth_chainId` with `0xb626` — 46630, alive and serving.
 *
 * So the four drill harnesses pinned to it do not fail. They connect, they read
 * the old factory at `0x2E690A91b383eDB21f6b5B4180Cc4a2C905C6BeA`, they find
 * real contracts with real state, and they print a pass. What they produce is
 * governance evidence about a deployment this protocol no longer settles on,
 * indistinguishable at a glance from evidence about the live one. That is the
 * same shape as the Safe signing message that named 4663 for the whole Infinity
 * port: correct-looking, internally consistent, and about the wrong chain.
 *
 * A drill that scores a criterion against a departed chain is worse than a
 * drill that did not run, because the second state is visible.
 *
 * ── Why exit 2 rather than 1 ───────────────────────────────────────────────
 *
 * `checkExit.mjs` reserves 2 for "the check could not run", as distinct from
 * "the check ran and found a problem". A script pinned to a retired chain has
 * not discovered anything about the protocol; it has discovered something about
 * itself. Reporting that as a finding would send someone to investigate a
 * deployment when the thing to fix is a constant.
 */

import { CheckFailed } from './checkExit.mjs'

/**
 * Retired chain ids, with what each one was.
 *
 * Keyed by id because that is what a script has in hand — either as a pinned
 * constant or as the answer to `eth_chainId` — and matching on the id rather
 * than on a name means a script that only ever wrote `46630` is still covered.
 */
export const RETIRED_CHAINS = {
  4663: {
    name: 'Robinhood Chain mainnet',
    left: 'Settlement moved to BNB Smart Chain 56 with PancakeSwap Infinity.',
  },
  46630: {
    name: 'Robinhood Chain testnet',
    left: 'Rehearsals moved to BNB Smart Chain testnet 97; the live testnet '
      + 'factory is the one named by FACTORY_ADDRESS in .env.',
  },
}

/** What `chainId` was, or `null` when it is a chain this protocol still uses. */
export function retiredChain(chainId) {
  return RETIRED_CHAINS[String(BigInt(chainId))] ?? null
}

/**
 * Stop, with the reason, when `chainId` is one this protocol has left.
 *
 * `reArm` is the part that cannot be generic: each caller needs something
 * different before it can point at a live chain, and one of them needs a Safe
 * that does not exist yet. Saying "repoint this" without saying at what is how
 * a refusal becomes a thing people comment out.
 */
export function refuseIfRetired(chainId, { script, reArm }) {
  const chain = retiredChain(chainId)
  if (!chain) return

  const lines = [
    '',
    `REFUSING TO RUN — ${script} is pinned to chain ${chainId}, which is`,
    `${chain.name}, a chain this protocol has left.`,
    '',
    `  ${chain.left}`,
    '',
    '  This is a refusal rather than a failure because that endpoint still',
    '  answers. Left alone this script would have connected, read the old',
    '  contracts, and printed a pass about a deployment that settles nothing.',
    '',
    '  To re-arm:',
    ...reArm.map(l => `    · ${l}`),
    '',
  ]
  for (const l of lines) console.error(l)
  throw new CheckFailed(`pinned to retired chain ${chainId}`, 2)
}
