/**
 * Every project on the platform, what state it is in, and whether it can pay.
 *
 * WHY THIS IS A SOLVENCY REPORT AND NOT A LISTING. The question it exists to
 * answer is "if this round fails, is the money there" — so the load-bearing line
 * per project is `quote balance` against `totalNativeDeposited`. For an
 * unlaunched hook those two must satisfy balance >= deposited, which is the
 * property `invariant_unlaunchedHookCanPayEveryRefund` asserts in the test suite.
 * Reading it live is the only way to know it still holds against real state.
 *
 * ⚠ REFUNDS DO NOT TOUCH THE FACTORY, AND THAT IS THE POINT OF SEPARATING THE
 *   TWO COLUMNS BELOW. `ToshLaunchpadHook.refund()` is called by the depositor
 *   ON THE HOOK; every clause it checks (`launched`, `genesisDeadline`,
 *   `canRefund()`, `nativeDeposited[msg.sender]`) is hook-local storage, and
 *   `_payQuote` is a plain `safeTransfer` out of the hook's own balance. No
 *   factory call, no blacklist check, no quota check.
 *
 *   `ToshFactory.deposit` is the opposite: it gates on `registeredHooks[hook]`,
 *   `blacklistedUntil`, `pogQuota` and `userLaunchCooldownEnd`, all factory
 *   storage. So a factory redeployment can stop money going IN to an existing
 *   round while being unable to affect money coming BACK OUT. Anyone reasoning
 *   about a migration needs those two facts kept apart.
 */
import { ethers } from 'ethers'

import { connect, withFallback } from './lib/bscProvider.mjs'
import {
  FACTORY, QUOTE_ASSET, QUOTE_DECIMALS, ERC20_ABI, fmt,
} from './dashboard/config.mjs'

const FACTORY_ABI = [
  'function launchCount() view returns (uint256)',
  'function launches(uint256) view returns (address token, address hook, address creator, uint256 createdAt)',
  'function registeredHooks(address) view returns (bool)',
]

const HOOK_ABI = [
  'function launched() view returns (bool)',
  'function tokenInitialized() view returns (bool)',
  'function refundAnnounced() view returns (bool)',
  'function canRefund() view returns (bool)',
  'function ladderViable() view returns (bool)',
  'function genesisDeadline() view returns (uint256)',
  'function totalNativeDeposited() view returns (uint256)',
  'function LAUNCH_WINDOW() view returns (uint256)',
  'function softCap() view returns (uint256)',
  'function creator() view returns (address)',
]

const bem = (v) => `${fmt(v, QUOTE_DECIMALS, 4)} BEM`

/** Seconds as something a human can act on. */
function ago(seconds) {
  const s = Math.abs(seconds)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const parts = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
  return seconds >= 0 ? `in ${parts}` : `${parts} ago`
}

async function main() {
  const { provider, url, blockNumber } = await connect()
  const now = (await provider.getBlock(blockNumber)).timestamp
  console.log(`chain 56 · block ${blockNumber} · ${url}`)
  console.log(`factory ${FACTORY}\n`)

  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider)
  const count = Number(await factory.launchCount())
  console.log(`${count} project${count === 1 ? '' : 's'} ever created\n`)

  let atRisk = 0
  let owedTotal = 0n

  for (let i = 0; i < count; i++) {
    const row = await withFallback(async (p) => {
      const f = new ethers.Contract(FACTORY, FACTORY_ABI, p)
      const l = await f.launches(i)
      const hook = new ethers.Contract(l.hook, HOOK_ABI, p)
      const token = new ethers.Contract(l.token, ERC20_ABI, p)
      const quote = new ethers.Contract(QUOTE_ASSET, ERC20_ABI, p)

      // `canRefund` and `ladderViable` revert on a hook whose token was never
      // initialised, so each is asked for separately rather than in one
      // Promise.all that a single revert would take down.
      const safe = async (fn, fallback) => { try { return await fn() } catch { return fallback } }

      return {
        ...l.toObject(),
        symbol: await safe(() => token.symbol(), '??'),
        launched: await safe(() => hook.launched(), null),
        initialized: await safe(() => hook.tokenInitialized(), null),
        refundAnnounced: await safe(() => hook.refundAnnounced(), null),
        canRefund: await safe(() => hook.canRefund(), null),
        ladderViable: await safe(() => hook.ladderViable(), null),
        deadline: await safe(() => hook.genesisDeadline(), 0n),
        deposited: await safe(() => hook.totalNativeDeposited(), 0n),
        window: await safe(() => hook.LAUNCH_WINDOW(), 0n),
        balance: await safe(() => quote.balanceOf(l.hook), 0n),
      }
    })

    const phase = row.launched ? 'LAUNCHED'
      : !row.initialized ? 'UNINITIALISED'
      : row.refundAnnounced ? 'REFUNDING'
      : Number(row.deadline) > now ? 'GENESIS OPEN'
      : row.canRefund ? 'REFUNDABLE'
      : 'AWAITING LAUNCH'

    console.log(`[${i}] ${row.symbol}  ·  ${phase}`)
    console.log(`     hook     ${row.hook}`)
    console.log(`     token    ${row.token}`)
    console.log(`     raised   ${bem(row.deposited)}`)
    console.log(`     holds    ${bem(row.balance)}`)

    if (Number(row.deadline) > 0) {
      console.log(`     genesis  closes ${ago(Number(row.deadline) - now)}`)
      if (!row.launched && row.window > 0n) {
        const hard = Number(row.deadline) + Number(row.window)
        console.log(`     refund   unconditional ${ago(hard - now)}  (deadline + LAUNCH_WINDOW)`)
      }
    }

    if (!row.launched) {
      /*
       * ⚠ `raised` IS A PEAK, NOT A LIVE LIABILITY. Comparing it against the
       *   balance is the obvious solvency test and it is WRONG — the first draft
       *   of this script did exactly that and reported three projects as unable
       *   to pay their depositors, which was a false alarm about user funds.
       *
       *   `refund()` zeroes `nativeDeposited[msg.sender]` and deliberately does
       *   NOT decrement `totalNativeDeposited`, because `claimTokens` divides by
       *   that total. So it stays at its high-water mark forever, and a fully
       *   refunded round reads as "raised 5.78, holds 0" — which looks like
       *   insolvency and is the opposite: it is the round having paid everyone.
       *
       *   THE BALANCE IS THE LIABILITY. Before launch the only BEM inflow is a
       *   deposit and the only outflow is a refund — `claimReferralReward` is
       *   `if (!launched) revert NotLaunched()`, the orphan-referral forward and
       *   the vault settlement both live inside `launch()`, and the Phase-2
       *   shelf pulls from the buyer rather than paying out of this balance. Each
       *   refund therefore reduces the balance and the outstanding claims by the
       *   same amount, so `balance == sum of unrefunded nativeDeposited` exactly.
       *
       *   An unlaunched hook is consequently solvent BY CONSTRUCTION, and the
       *   deposit-time guard `balanceOf < totalNativeDeposited + amount` is what
       *   establishes it on the way in.
       */
      const refunded = row.deposited > row.balance ? row.deposited - row.balance : 0n
      owedTotal += row.balance

      console.log(`     owed now ${bem(row.balance)}  <- the live refund liability`)
      if (refunded > 0n) {
        const pct = row.deposited > 0n ? Number((refunded * 10_000n) / row.deposited) / 100 : 0
        console.log(`     paid out ${bem(refunded)} already (${pct.toFixed(1)}% of the peak)`)
      }

      // The only arrangement that would be a genuine alarm: money has left a
      // hook that never opened refunds. Nothing else can move it, so this would
      // mean an outflow with no matching claim.
      if (!row.refundAnnounced && row.balance < row.deposited) {
        atRisk++
        console.log(`     ⚠ ${bem(row.deposited - row.balance)} LEFT THIS HOOK WITHOUT REFUNDS`)
        console.log('       BEING OPEN. refund() is the only pre-launch outflow, so')
        console.log('       this should be unreachable — investigate before migrating.')
      }
      console.log('     refund   hook.refund() — depositor calls the HOOK, not the factory')
    }
    console.log('')
  }

  console.log('── SUMMARY ' + '─'.repeat(52))
  console.log(`  live refund liability across all unlaunched hooks: ${bem(owedTotal)}`)
  console.log(`  hooks with an unexplained outflow: ${atRisk}`)
  console.log('')
  console.log('  A factory redeployment cannot affect any of the above. Deposits')
  console.log('  are factory-gated and would stop; refunds are hook-local and')
  console.log('  would not. See the header of this file for the two code paths.')
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1) })
