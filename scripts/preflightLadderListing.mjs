#!/usr/bin/env node
/*
 * preflightLadderListing.mjs
 * ──────────────────────────
 * Run this before signing an `addLadderToken` transaction on the Safe.
 *
 * SECURITY.md accepts one residual on the grounds that it is held
 * shut by an operational rule: do not list a token until its TWAP matures,
 * because `_buybackSqrtFloor` treats a zero reading as "no reference, fill
 * unbounded" and a token listed inside its first `TWAP_WINDOW` therefore has no
 * anti-sandwich bound on its buyback legs, on the pool whose liquidity is
 * thinnest.  Measured at 0.93 ETH of a 3.33 ETH leg, repeatable per block.
 *
 * The audit's own verdict on that trade is that it "is exactly as strong as the
 * runbook and the alert pipeline".  This script is the part of that sentence
 * that was missing.  The rule was written in three places and checked in none
 * of them before the signature; `STATE-07` catches a violation AFTER the fact,
 * hourly, which is recovery rather than prevention.
 *
 * Since 2026-09-11 `addLadderToken` enforces the rule itself, and since the
 * 2026-09-12 deployment the live treasury is one that carries the gate — the
 * platform WAS replaced, for an unrelated reason, and this arrived with it.
 * So the exposure above is now held shut by the contract rather than by the
 * signer reading this output.
 *
 * That does not retire the script.  The gate fires ONCE, at listing, while
 * `_buybackSqrtFloor` runs on every leg thereafter, and a premature listing is
 * still the one owner call that decides where reservoir ETH gets spent.  What
 * it does change is the claim this script is entitled to make about itself: it
 * is a second control now, not the only one, and on a treasury it cannot prove
 * is gated it must say so rather than guess.
 *
 * It used to guess, and guessed wrong.  The regime was read by scanning the
 * runtime bytecode for `TwapNotMature()`'s selector, and that selector is not
 * in the bytecode of EITHER treasury — not the gated one and not the ungated
 * one.  Measured 2026-09-12 on `0x25572222…` (gated, 6,159 B) and
 * `0x99aD248d…` (ungated, 6,035 B): absent from both, as it is from this
 * tree's own build.  Several of this contract's no-argument custom errors are
 * absent the same way while others are present, so the selector is evidently
 * not always emitted as a literal; whatever the codegen reason, a scan that
 * answers "no" for a contract that does enforce the rule is worse than no
 * scan, because it answers confidently.  The regime is now derived from the
 * simulation the script already runs, which observes the gate only when there
 * is a premature token to observe it with — and that is the only case where
 * the answer changes a decision.
 *
 * Read-only.  It holds no key, signs nothing and sends nothing.
 *
 * Usage:  node scripts/preflightLadderListing.mjs <token> <treasury>
 * Exit:   0 safe to sign · 1 do not sign · 2 could not determine
 */

import { ethers } from 'ethers'

const MAINNET_ID = 56n

// Chain-named, so a testnet endpoint cannot answer for mainnet by accident.
// `BSC_RPC` is the same name the fork suites, the preflight and the frontend's
// server leg already read.
//
// No default treasury. The previous one was a retired chain-4663 reservoir
// (`0x255722…`), and omitting the argument ran every check against that
// address on a BSC RPC — which is the shape of a "safe to sign" that is
// talking about a contract that is not on the chain being signed for.
const RPC = process.env.BSC_RPC || 'https://bsc-dataseed1.bnbchain.org'

// `error TwapNotMature()`, kept only to decode a revert that arrives without an
// ABI match. It is NOT a bytecode fingerprint — see the header for why the scan
// that used it was removed.
const TWAP_NOT_MATURE = ethers.id('TwapNotMature()').slice(0, 10)

const TREASURY_ABI = [
  'function owner() view returns (address)',
  'function factory() view returns (address)',
  'function isLadderToken(address) view returns (bool)',
  'function ladderTokenCount() view returns (uint256)',
  'function addLadderToken(address)',
  // Every revert `addLadderToken` can produce, so the simulation below can NAME
  // what happened. "Unknown custom error" is not an acceptable thing to show
  // someone who is deciding whether to sign.
  'error ZeroAddress()',
  'error TokenAlreadyListed()',
  'error FactoryNotSet()',
  'error TokenNotLaunchedHere()',
  'error PoolNotLaunched()',
  'error TwapNotMature()',
  'error InvalidPoolKey()',
  'error OwnableUnauthorizedAccount(address)',
]
const FACTORY_ABI = ['function tokenToHook(address) view returns (address)']
const HOOK_ABI = [
  'function launched() view returns (bool)',
  'function twapSqrtPriceX96() view returns (uint160)',
  'function lastObservationTs() view returns (uint32)',
  'function genesisDeadline() view returns (uint256)',
  'function TWAP_WINDOW() view returns (uint32)',
  'function projectToken() view returns (address)',
]

const token = process.argv[2]
const treasuryAddr = process.argv[3]
if (!token || !ethers.isAddress(token) || !treasuryAddr || !ethers.isAddress(treasuryAddr)) {
  console.error('usage: node scripts/preflightLadderListing.mjs <token> <treasury>')
  console.error('  treasury is required. There is no default — a missing one used to')
  console.error('  silently point at a retired chain-4663 address on a BSC RPC.')
  process.exit(1)
}

const problems = []
const unknowns = []
const notes = []

const provider = new ethers.JsonRpcProvider(RPC)
const net = await provider.getNetwork()
console.log(`rpc      ${RPC}`)
console.log(`chain    ${net.chainId}${net.chainId === MAINNET_ID ? '' : `  (NOT mainnet ${MAINNET_ID})`}`)
console.log(`treasury ${ethers.getAddress(treasuryAddr)}`)
console.log(`token    ${ethers.getAddress(token)}`)
console.log()

if (net.chainId !== MAINNET_ID) {
  notes.push(`this is chain ${net.chainId}, not mainnet ${MAINNET_ID}. Nothing below says anything `
    + 'about the transaction you are being asked to sign unless it is bound for this same chain.')
}

const treasury = new ethers.Contract(treasuryAddr, TREASURY_ABI, provider)

// ── Is there anything there at all ──────────────────────────────────────────
//
// `gated` is decided further down, from the simulation, and stays null unless
// the chain actually demonstrates the gate. Nothing here infers it: the only
// evidence that a treasury enforces the rule is watching it refuse.
let gated = null
try {
  if ((await provider.getCode(treasuryAddr)) === '0x') {
    problems.push(`nothing is deployed at ${treasuryAddr}.`)
  }
} catch (err) {
  unknowns.push(`could not read the treasury's bytecode (${err.message}), so nothing below can `
    + 'be trusted about the contract you are being asked to call.')
}

// ── Provenance: is this a token of ours, and is its pool open ───────────────
let hook = null
try {
  const factoryAddr = await treasury.factory()
  if (factoryAddr === ethers.ZeroAddress) {
    problems.push('the treasury has no factory bound, so it cannot verify provenance and '
      + '`addLadderToken` would revert `FactoryNotSet`.')
  } else {
    const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider)
    const h = await factory.tokenToHook(token)
    if (h === ethers.ZeroAddress) {
      problems.push(`the factory at ${factoryAddr} does not know this token, so it was not `
        + 'launched on this platform and `addLadderToken` would revert `TokenNotLaunchedHere`. '
        + 'Check the address you were given before anything else: a listing is the one owner '
        + 'call that decides where reservoir ETH gets spent.')
    } else {
      hook = new ethers.Contract(h, HOOK_ABI, provider)
      console.log(`hook     ${h}`)
    }
  }
} catch (err) {
  unknowns.push(`could not resolve the token's hook through the treasury's factory (${err.message}).`)
}

if (await treasury.isLadderToken(token).catch(() => false)) {
  problems.push('this token is ALREADY listed. `addLadderToken` would revert '
    + '`TokenAlreadyListed`, so the transaction you were handed is not the one you were told '
    + 'about, and that is worth resolving away from the signing screen.')
}

// ── The check this script exists for ────────────────────────────────────────
if (hook) {
  try {
    const launched = await hook.launched()
    if (!launched) {
      problems.push('the pool is not open yet (`launched() == false`). There is nothing to buy '
        + 'into, and no TWAP can have started.')
    }

    const twap = await hook.twapSqrtPriceX96()
    const window = Number(await hook.TWAP_WINDOW())
    const lastObs = Number(await hook.lastObservationTs())
    const now = (await provider.getBlock('latest')).timestamp

    console.log(`\ntwapSqrtPriceX96()   ${twap}`)
    console.log(`TWAP_WINDOW          ${window} s`)
    console.log(`lastObservationTs    ${lastObs}  (${new Date(lastObs * 1000).toISOString()})`)
    console.log(`chain now            ${now}  (${new Date(now * 1000).toISOString()})`)

    // An UNLAUNCHED hook answers 2^96 here, not 0, and it means nothing.
    // `_prevCheckpointTs` is written at `launch()`, so before that it is still
    // zero, `span` is the whole unix epoch, and `_twapSqrtPriceX96` takes its
    // "no swap for a full window, so the price was flat" branch and reports
    // `getSqrtPriceAtTick(lastTick)` with `lastTick` also still zero.  Measured
    // on hook 0xF40B2F1Dfb4fE4549F8812A4914FCA9a27Da7eEE, an abandoned launch:
    // 79228162514264337593543950336 exactly.
    //
    // `addLadderToken` is not fooled by this, because it checks `launched()`
    // BEFORE reading the TWAP and returns `PoolNotLaunched` first — an ordering
    // that turns out to be load bearing rather than cosmetic.  This script has
    // to repeat the ordering rather than inherit it, or it would print
    // reassurance about a pool that has no oracle at all.
    const TICK_ZERO = 79228162514264337593543950336n
    if (!launched) {
      console.log(`\n(the reading above is not a TWAP. An unlaunched hook has no initialised`
        + ` checkpoint, so it reports tick 0${twap === TICK_ZERO ? ' — exactly 2^96, as here' : ''}.`
        + ' It is ignored.)')
    } else if (twap === 0n) {
      // `_prevCheckpointTs <= lastObservationTs` always, and maturity is
      // `now - _prevCheckpointTs >= TWAP_WINDOW`, so this is an upper bound on
      // when the reading starts answering — not a promise about the exact
      // second, which needs a storage slot this deliberately does not read.
      const by = lastObs + window
      problems.push('THE TWAP IS NOT MATURE. This is the listing that §2.3 is about: '
        + '`_buybackSqrtFloor` would fall back to unbounded and every buyback leg on this pool '
        + 'would have no price bound at all. DO NOT SIGN.')
      notes.push('Nothing is forfeited by waiting. The reservoir is not spent on an unlisted '
        + 'token, and the window closes on the clock alone with no swap needed to close it — so '
        + `re-running after ${new Date(by * 1000).toISOString()} (${Math.max(0, by - now)} s from `
        + 'now) will answer differently. That timestamp is an upper bound derived from '
        + '`lastObservationTs`, not the exact second.')
    } else {
      console.log('\n✓ the TWAP answers non-zero, so the buyback band will be live for this pool '
        + 'from the moment it is listed.')
    }
  } catch (err) {
    unknowns.push(`could not read the hook's TWAP state (${err.message}). A hook that will not `
      + 'answer `twapSqrtPriceX96()` is the SECOND of `_buybackSqrtFloor`\'s two doors to '
      + 'unbounded, so a read that fails here is a reason not to sign rather than an '
      + 'inconvenience — treat it as a failure until you know why it failed.')
  }
}

// ── Ask the chain, rather than only reasoning about it ──────────────────────
if (hook) {
  try {
    const owner = await treasury.owner()
    await provider.call({
      to: treasuryAddr,
      from: owner,
      data: treasury.interface.encodeFunctionData('addLadderToken', [token]),
    })
    console.log(`\n✓ simulated as ${owner}: the call succeeds.`)
  } catch (err) {
    const data = err?.data ?? err?.info?.error?.data
    let named = null
    if (typeof data === 'string' && data.length >= 10) {
      named = treasury.interface.parseError?.(data)?.name
        ?? (data.slice(0, 10) === TWAP_NOT_MATURE ? 'TwapNotMature' : null)
    }
    if (named) {
      // A named revert is a fact about the transaction, not a gap in this
      // script's knowledge, so it belongs with the findings rather than in the
      // "could not determine" bucket. The checks above have usually already
      // said why; this is the chain agreeing with them.
      console.log(`\n✗ simulated from the owner: reverts \`${named}\`.`)

      // The only positive evidence of the gate that exists. A gated treasury
      // and an ungated one differ in exactly one observable way — what they do
      // when handed a premature token — so this is where the regime is settled,
      // and it settles only in the direction that can be seen.
      if (named === 'TwapNotMature') {
        gated = true
        console.log('  which is the on-chain gate refusing the listing, not this script. '
          + 'The contract enforces the rule itself.')
      }
      if (!problems.length) {
        problems.push(`the call reverts \`${named}\` when simulated from the treasury's owner, `
          + 'and none of the checks above explains why. Do not sign a transaction whose '
          + 'failure mode is not understood.')
      }
    } else {
      unknowns.push('the simulated call did not succeed and the revert could not be decoded '
        + `(${err.shortMessage ?? err.message}). A simulation is not the signature, so this on `
        + 'its own does not mean the transaction is unsafe — but it does mean it will not do '
        + 'what you were told it would.')
    }
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log()
for (const n of notes) console.log('  ⚠ ' + n)

if (problems.length) {
  console.error('\n✗ DO NOT SIGN:\n')
  for (const p of problems) console.error('  · ' + p)
  if (unknowns.length) {
    console.error('\n  also could not determine:\n')
    for (const u of unknowns) console.error('  · ' + u)
  }
  console.error('\n  If a listing is already live and premature, the recovery is '
    + '`removeLadderToken(token)` via the Safe, wait for maturity, re-add '
    + '(the STATE-07 action).')
  process.exit(1)
}

if (unknowns.length) {
  console.error('\n✗ could not finish the check. This is not a pass:\n')
  for (const u of unknowns) console.error('  · ' + u)
  process.exit(2)
}

console.log('\n✓ safe to sign: launched on this platform, pool open, not already listed, '
  + 'TWAP mature, and the call simulates clean.')
if (gated === null) {
  console.log('\n  One thing this run could NOT establish: whether the treasury would have '
    + 'refused a premature listing on its own. A gated and an ungated treasury behave '
    + 'identically on a token whose TWAP is already mature, which is the token you just '
    + 'checked, so the question did not come up and has not been answered. Everything above '
    + 'is a measurement of THIS token taken now — re-run per token, and assume nothing on '
    + 'chain will catch the next one.')
}
