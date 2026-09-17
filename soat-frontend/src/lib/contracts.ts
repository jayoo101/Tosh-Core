// ─────────────────────────────────────────────────────────────────────────────
// Tosh Protocol — canonical on-chain bindings (v5.0, ETH-native).
//
// SINGLE SOURCE OF TRUTH for:
//   • Physical constants (addresses, chain IDs, hard floors mirrored from
//     Solidity constants).
//   • Pre-bound `{ address, abi }` tuples for ergonomic wagmi / viem use:
//        useReadContract({ ...factoryContract, functionName: 'launchFee' })
//        useReadContract({ ...hookContract(addr), functionName: 'tierStatus' })
//   • Audit-cliff guards that the UI MUST honour locally so the wallet popup
//     never opens for an obviously doomed transaction
//     (M-01 MIN_SOFT_CAP_PROD, L-01 dust mints, 105 % shelf ceiling).
//
// LAYOUT NOTE
// ───────────
// Canonical import: `@/lib/contracts`. Generated ABIs live at
// `@/app/lib/abis` because the extract scripts write them there.
//
// ENV WIRING
// ──────────
//   NEXT_PUBLIC_FACTORY_ADDRESS     — deployed ToshFactory (required)
//   NEXT_PUBLIC_CHAIN_ID            — settlement chain (default 31337, devnet)
//   NEXT_PUBLIC_POSITION_MANAGER    — V4 posm; BSC address if unset
//   NEXT_PUBLIC_PERMIT2             — Permit2; canonical address if unset
//   NEXT_PUBLIC_STATE_VIEW          — V4 StateView; BSC address if unset
//   POG_SIGNER_PRIVATE_KEY          — server-only PoG oracle key (NEVER expose)
//   POG_PRIVATE_KEY                 — spec-compliant fallback alias of the above
//
//   POOL_MANAGER is deliberately NOT env-bound.  A wrong one silently
//   mis-CREATE2s every hook, so flipping it is a source change.
// ─────────────────────────────────────────────────────────────────────────────

import type { Address } from 'viem'
import { FACTORY_ABI, HOOK_ABI, TREASURY_ABI, ERC20_ABI } from '@/app/lib/abis'
import { envAddress } from '@/lib/chain'

export { FACTORY_ABI, HOOK_ABI, TREASURY_ABI, ERC20_ABI }
export {
  TARGET_CHAIN_ID,
  BSC_ID,
  BSC_TESTNET_ID,
  FOUNDRY_CHAIN_ID,
  isSupportedPogChain,
  supportedPogChainLabel,
  MAINNET_CHAIN_LABEL,
  ACTIVE_CHAIN_LABEL,
  IS_TESTNET,
  CHAIN_BYLINE,
  CHAIN_STATUS_BADGE,
  CHAIN_POSITIONING,
  BADGE_NAMES_SETTLEMENT_CHAIN,
  CHAIN_STAGING_NOTE,
  testnetExplorerTx,
  testnetExplorerAddress,
  targetChain,
} from '@/lib/chain'

if (!process.env.NEXT_PUBLIC_FACTORY_ADDRESS) {
  throw new Error('Missing env: NEXT_PUBLIC_FACTORY_ADDRESS')
}

/**
 * A present-but-unusable factory address is worse than a missing one: the app
 * boots, every read returns `0x`, and the failure surfaces as a viem decode
 * error deep inside whichever panel happened to call first.
 *
 * The addresses below 0x100 are the precompile range and can never host
 * ToshFactory, so seeing one means the value came from somewhere other than
 * `.env.local` — most often a stale `NEXT_PUBLIC_FACTORY_ADDRESS` exported in
 * the shell that launched the editor. Next's env loader does not override
 * variables already present in `process.env`, so `.env.local` loses that race
 * silently and a dev-server restart does not clear it.
 */
if (/^0x0{38}[0-9a-fA-F]{2}$/.test(process.env.NEXT_PUBLIC_FACTORY_ADDRESS)) {
  throw new Error(
    `NEXT_PUBLIC_FACTORY_ADDRESS is ${process.env.NEXT_PUBLIC_FACTORY_ADDRESS}, which is in the ` +
    'precompile range and cannot be a ToshFactory. An exported shell variable of the same name ' +
    'takes precedence over .env.local — clear it and restart the dev server.',
  )
}

export const FACTORY_ADDRESS = process.env.NEXT_PUBLIC_FACTORY_ADDRESS as Address

/**
 * Ladder treasury (set after deploy).  Optional: the public UI boots without
 * it and only the admin console's curation panel actually needs it, so an
 * unset value degrades to a disabled panel rather than a hard boot failure.
 *
 * `NEXT_PUBLIC_TREASURY_ADDRESS` is the name the deploy scripts print;
 * `NEXT_PUBLIC_LADDER_TREASURY` is the older alias.  Both are accepted so a
 * stale `.env.local` does not silently blank the panel.
 */
export const LADDER_TREASURY_ADDRESS = (process.env.NEXT_PUBLIC_TREASURY_ADDRESS ??
  process.env.NEXT_PUBLIC_LADDER_TREASURY ??
  '') as Address | ''

export const hasLadderTreasury = /^0x[0-9a-fA-F]{40}$/.test(LADDER_TREASURY_ADDRESS)

// Both set, disagreeing, is the case the `??` above resolves silently — and the
// stale one is not obviously stale. A `.env.local` carried the previous
// deployment's treasury under the alias while the canonical name held the
// current one; both addresses were live contracts of identical size, because
// they are the same contract from two deploys. Had the canonical name ever gone
// missing, the console would have pointed at the old treasury with nothing on
// screen looking wrong.
//
// A warning rather than a throw: the public UI boots without a treasury by
// design, so failing closed here would take the whole site down over an
// admin-only panel. Delete the alias instead of resolving it.
if (
  process.env.NEXT_PUBLIC_TREASURY_ADDRESS &&
  process.env.NEXT_PUBLIC_LADDER_TREASURY &&
  process.env.NEXT_PUBLIC_TREASURY_ADDRESS.toLowerCase() !==
    process.env.NEXT_PUBLIC_LADDER_TREASURY.toLowerCase()
) {
  console.warn(
    '[Tosh] NEXT_PUBLIC_TREASURY_ADDRESS and its older alias ' +
    'NEXT_PUBLIC_LADDER_TREASURY are both set, to different addresses. ' +
    `Using ${process.env.NEXT_PUBLIC_TREASURY_ADDRESS}; ` +
    `ignoring ${process.env.NEXT_PUBLIC_LADDER_TREASURY}. ` +
    'Unset the alias — verify against `factory.ladderTreasury()` on chain.',
  )
}

/** Uniswap V4 PoolManager.  Hard-coded — not env-bound on purpose: a wrong
 *  PoolManager would silently mis-CREATE2 every hook.  Mainnet cutover is a
 *  source change here, reviewed, not an env flip.
 *
 *  ⚠ DEAD CONSTANT, AND THE WARNING ABOVE IT IS NOT TRUE ANY MORE. Nothing in
 *    `src/` reads this. Kept only long enough to be deleted deliberately, and
 *    documented because the paragraph above claims it is load-bearing, which is
 *    exactly the sort of comment that gets a stale value trusted.
 *
 *    Two things stopped being true. It is Uniswap's V4 PoolManager, and this
 *    protocol now runs on PancakeSwap Infinity — so the address names the wrong
 *    AMM. And hook addresses are no longer predicted from it: the launch page
 *    reads `factory.hookInitcodeHash(...)` off the chain, so the prediction
 *    tracks whatever factory is deployed and cannot be desynchronised by a
 *    constant here.
 *
 *    Infinity's manager for the record — `CLPoolManager`, 56
 *    0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b, 97
 *    0x36A12c70c9Cf64f24E89ee132BF93Df2DCD199d4 — plus a `Vault`, which V4 had no
 *    equivalent of. The contracts take both as constructor arguments; the
 *    frontend needs neither. */
export const POOL_MANAGER: Address = '0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF'

/**
 * Uniswap V4 PositionManager — the retail LP entry point.
 *
 * ⚠ THIS IS THE WRONG AMM AND THE RETAIL LP FEATURE IS CURRENTLY BROKEN. Not a
 *   copy problem; recorded here rather than quietly repointed because fixing it
 *   is a port, not an address swap.
 *
 *   Every pool this protocol creates is now a PancakeSwap Infinity CL pool. This
 *   address is Uniswap's V4 PositionManager, and Uniswap deployed no V4 to BSC
 *   testnet at all — measured, it has NO CODE on 97 (see
 *   docs/PANCAKESWAP_INFINITY.md §7). So `useLpPosition.ts` and
 *   `LiquidityPanel.tsx` are talking to an address with nothing behind it on the
 *   chain this build targets.
 *
 *   Infinity's equivalent is `CLPositionManager`:
 *     56  0x55f4c8abA71A1e923edC303eb4fEfF14608cC226
 *     97  0x77DedB52EC6260daC4011313DBEE09616d30d122
 *
 *   Swapping the address alone would trade a no-code failure for a revert: the
 *   two managers do not share an encoding. `POSM_ABI` and the `modifyLiquidities`
 *   action bytes in `lpAbis.ts` are V4's, and Infinity's take a six-member
 *   `PoolKey` that names its pool manager. The genesis position itself is
 *   unaffected — the hook seeds it directly through the Vault, with no periphery
 *   involved — so this is retail LP only.
 *
 *   The fallback is left pointing at V4 deliberately, so nobody reads a plausible
 *   Infinity address here and concludes the feature works.
 */
export const POSITION_MANAGER: Address = envAddress(
  process.env.NEXT_PUBLIC_POSITION_MANAGER,
  '0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b',
)

/** Permit2 — canonical address on every chain, overridable just in case.
 *  The one address the migration did not have to touch. */
export const PERMIT2: Address = envAddress(
  process.env.NEXT_PUBLIC_PERMIT2,
  '0x000000000022D473030F116dDEE9F6B43aC78BA3',
)

/** V4 StateView — read-only `getSlot0`, so the LP panel can size a deposit
 *  off the real sqrtPriceX96 rather than a derived spot.  BSC mainnet.
 *
 *  ⚠ Same breakage as `POSITION_MANAGER` above, and Infinity has no drop-in
 *    counterpart: it does not ship a `StateView`. `CLPoolManager` exposes pool
 *    state directly, so the port is a call-site change and not a new address.
 *    Left as V4's for the same reason — an honest broken pointer beats a
 *    plausible one. */
export const STATE_VIEW: Address = envAddress(
  process.env.NEXT_PUBLIC_STATE_VIEW,
  '0xd13Dd3D6E93f276FAfc9Db9E6BB47C1180aeE0c4',
)

/** Full-range bounds, mirroring the hook's genesis position (TICK_SPACING 200). */
export const TICK_LOWER = -887_200
export const TICK_UPPER = 887_200
export const POOL_FEE = 3000
export const TICK_SPACING = 200

/**
 * `ToshLaunchpadHook.PLATFORM_TAX_BPS` — the platform's cut of PHASE-2 SHELF
 * PROCEEDS, in basis points. Mirrored here for the same reason the soft-cap
 * floor above is: the project page states the remainder as a headline number
 * ("99% of shelf earnings route back to the project"), and a claim about where
 * a user's money goes should not be a literal typed into a component.
 *
 * ⚠ NOT `TAX_BPS`, which is also 100 and means something entirely different —
 * the 1.00% toll on a SWAP INPUT, split between the buyback reservoir and the
 * platform. This one is 1.00% of what a shelf mint COSTS. The hook's own
 * natspec carries the same warning; see `test/ToshV5.t.sol`'s
 * `test_TaxConstants_MeanDifferentThings`.
 */
export const PLATFORM_TAX_BPS = 100

/**
 * `ToshLaunchpadHook.TAX_BPS` — the 1.00% toll on a SWAP INPUT, and the one
 * cost of using this protocol that no screen stated.
 *
 * Mirrored because the project page was disclosing `POOL_FEE` alone: a reader
 * was told trading costs 0.30% when it costs 1.30%, which is not a rounding
 * difference but a fourfold understatement of the fee on a page people trade
 * from. `POOL_FEE` is V4's and goes to liquidity providers; this is the hook's
 * and is stacked on top of it.
 *
 * THE TWO LEGS DO DIFFERENT THINGS WITH IT, which is why the UI cannot
 * describe it as one destination:
 *
 *   • buy  — split. `PLATFORM_SWAP_FEE_BPS` (30) of the ETH input goes to the
 *            platform, the remaining 70 bps to the ladder treasury.
 *   • sell — not split. The full 100 bps of the TOKEN input is burned.
 *
 * ⚠ NOT `PLATFORM_TAX_BPS` above, which is also 100. See the warning there.
 */
export const TAX_BPS = 100

/**
 * `ToshLaunchpadHook.PLATFORM_SWAP_FEE_BPS` — the platform's share of the buy
 * leg's `TAX_BPS`, in basis points of the ETH input.
 *
 * Only the buy leg splits, and only this slice is platform revenue. An indexer
 * that sums `BuyTaxToTreasury` as well is double-counting; see the wire notes
 * at the top of `app/lib/abis.ts`.
 */
export const PLATFORM_SWAP_FEE_BPS = 30

/**
 * `ToshLaunchpadHook.REFERRAL_BPS` — the total referral cut of a genesis
 * deposit.
 *
 * 10%, and it comes out of the reserve the hook holds against
 * `totalReferralReserved`, not out of the depositor's allocation. Mirrored so
 * the referral panel states a number the contract defines rather than one
 * typed into a component.
 */
export const REFERRAL_BPS = 1000

/**
 * `ToshLaunchpadHook.PROJECT_REFERRAL_SHARE_BPS` — the project referrer's
 * share OF that cut, not of the deposit.
 *
 * 80% of 10%, so 8% of the deposit goes to whoever brought the depositor to
 * this project and the remaining 2% to whoever first brought them to the
 * platform. Expressed the same way the contract expresses it, because the two
 * are pinned to each other by `checkContractConstants`.
 */
export const PROJECT_REFERRAL_SHARE_BPS = 8000

/**
 * The two legs as shares of the DEPOSIT, which is the only form a user is ever
 * shown.
 *
 * Derived rather than typed, so the panel cannot promise 8% and 2% while the
 * contract splits it some other way — and the subtraction mirrors the hook's,
 * where the second leg is the remainder for exactness reasons that matter far
 * more on chain than they do here.
 */
export const PROJECT_REFERRAL_BPS = (REFERRAL_BPS * PROJECT_REFERRAL_SHARE_BPS) / 10_000
export const LIFETIME_REFERRAL_BPS = REFERRAL_BPS - PROJECT_REFERRAL_BPS

/** v4-periphery `Actions` opcodes used by the LP panel. */
export const V4_ACTIONS = {
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR:   0x0d,
  TAKE_PAIR:     0x11,
  SWEEP:         0x14,
} as const


export const factoryContract = {
  address: FACTORY_ADDRESS,
  abi:     FACTORY_ABI,
} as const

export function hookContract(hookAddress: Address) {
  return { address: hookAddress, abi: HOOK_ABI } as const
}

/** Pre-bound treasury tuple.  Only valid when `hasLadderTreasury` is true. */
export const treasuryContract = {
  address: LADDER_TREASURY_ADDRESS as Address,
  abi:     TREASURY_ABI,
} as const

/**
 * M-01 — minimum acceptable `defaultSoftCap` (mirrors Factory.MIN_SOFT_CAP_PROD).
 * Below this floor `p0 = (lpNative * 1e18) / GENESIS_LP_SUPPLY` truncates to zero.
 *   0.035 BNB → 3.5 × 10^16 wei, which keeps p0 around 8.3e9 wei/token and
 *   `shelfP0` at 8,749,999,999 with a 16,646,947-wei first step.
 */
export const MIN_SOFT_CAP_PROD: bigint = 35n * 10n ** 15n
export const MIN_SOFT_CAP_PROD_LABEL = '0.035'

/**
 * Ceiling on `launchFee` (mirrors `Factory.MAX_LAUNCH_FEE`).
 *
 * Mirrored here for the same reason the soft-cap floor and the cooldown maximum
 * are: the admin panel is where the value is typed, and the slip this ceiling
 * exists to catch — `0.1 ether` entered as `0.1e18 ether` — is a keystroke. A
 * bound that lives only on-chain turns that keystroke into a reverted owner
 * transaction instead of an inline refusal.
 */
export const MAX_LAUNCH_FEE: bigint = 35n * 10n ** 18n
export const MAX_LAUNCH_FEE_LABEL = '35'

/**
 * Ceilings on the other two ETH dials (mirror `Factory.MAX_DEFAULT_SOFT_CAP` and
 * `Factory.MAX_POG_ALLOCATION_LIMIT`).
 *
 * Far looser than `MAX_LAUNCH_FEE`, and read the Solidity natspec before
 * tightening either: a value picked for neatness here would reject raises and
 * wallet caps this repo's own test fixtures and rehearsal scripts depend on.
 * These catch wei/ether confusion and nothing subtler — in particular a
 * per-wallet limit under the ceiling is not evidence that PoG still caps whales.
 */
export const MAX_DEFAULT_SOFT_CAP: bigint = 1_000_000n * 10n ** 18n
export const MAX_DEFAULT_SOFT_CAP_LABEL = '1,000,000'

export const MAX_POG_ALLOCATION_LIMIT: bigint = 1_000_000n * 10n ** 18n
export const MAX_POG_ALLOCATION_LIMIT_LABEL = '1,000,000'

/**
 * The 40 / 60 genesis-to-ladder split (mirrors `Hook.GENESIS_SUPPLY` and
 * friends).  Genesis is 55 % claim / 45 % LP, which is what makes the
 * depositors' opening premium exactly 10 % against the 10 % referral carve.
 */
export const GENESIS_SUPPLY: bigint = 8_400_000n * 10n ** 18n
export const GENESIS_CLAIM_SUPPLY: bigint = 4_620_000n * 10n ** 18n
export const GENESIS_LP_SUPPLY: bigint = 3_780_000n * 10n ** 18n
export const BONDING_MAX: bigint = 12_600_000n * 10n ** 18n

/**
 * How long after the genesis deadline the creator still has to call `launch()`
 * (mirrors `Hook.LAUNCH_WINDOW`).  Once it lapses the hook opens `refund()` to
 * everyone instead, so the UI has to count it down rather than leave a raise
 * looking merely idle.
 */
export const LAUNCH_WINDOW_SECONDS: bigint = 7n * 24n * 60n * 60n

/** The three genesis windows the hook's constructor will accept, in seconds. */
export const GENESIS_DURATIONS = {
  fast:     3n * 60n * 60n,
  standard: 24n * 60n * 60n,
  slow:     72n * 60n * 60n,
} as const

/** Discrete Phase-2 ladder (mirrors Hook.TIER_COUNT / TIER_SIZE). */
export const TIER_COUNT = 4000
export const TIER_SIZE: bigint = 3_150n * 10n ** 18n

/**
 * Geometric price step per shelf, 1e18 fixed point (mirrors
 * `Hook.TIER_STEP_E18`).  4000 rungs of +0.19025 % compound to a 2000x span.
 * Display only — never quote from it, always read `tierPriceAt` / `quoteMint`.
 */
export const TIER_STEP_E18: bigint = 1_001_902_508_266_805_824n
export const LADDER_SPAN = 2000

/** 105 % of the anti-spike reference — mature window: min(spot, TWAP); until then: min(spot, p0). */
export const PRICE_CEILING_BPS = 10_500

/**
 * Oracle window the anti-spike reference is averaged over (mirrors
 * `Hook.TWAP_WINDOW`).  `_twapSqrtPriceX96()` reports 0 — not a stub average —
 * until a FULL window has elapsed, so a zero TWAP means "not mature yet" and
 * must never be rendered as a price.
 */
export const TWAP_WINDOW_SECONDS = 1800
export const TWAP_WINDOW_LABEL = '30M'

/**
 * Most shelves one `mintBondingCurve` call may sweep (mirrors
 * `Hook.MAX_TIERS_PER_TX`).  A gas bound only — an order larger than this is
 * still reachable, it just needs a second transaction.  Sized so the 105 %
 * ceiling (~26 shelves wide at this step) binds before the leg cap does.
 * Prefer the live `maxMintable()` read over deriving a cap from this.
 */
export const MAX_TIERS_PER_TX = 32

export const ADMIN_BATCH_MAX = 200 as const

/**
 * Ceiling both `setCooldownDuration` and `setQuotaWindowDuration` enforce
 * (mirrors `Factory.MAX_COOLDOWN`).  Anything above reverts, so the console
 * blocks it locally rather than opening a doomed wallet prompt.
 */
export const MAX_COOLDOWN_SECONDS = 7 * 24 * 60 * 60

/** `type(uint256).max` — the sentinel `setBlacklist` reads as "never expires". */
export const PERMANENT_BAN: bigint = (1n << 256n) - 1n

/**
 * How far out a ban expiry stops being a date.  `setBlacklist` stores the
 * permanent sentinel verbatim but nothing stops an owner storing a duration
 * just as unreachable, and either one overflows `Date` — so anything past this
 * horizon is named rather than counted down or formatted as a timestamp.
 */
export const UNBOUNDED_BAN_SECONDS: bigint = 100n * 365n * 24n * 60n * 60n

/**
 * Ban presets offered by the console.  `setBlacklist` takes a DURATION and
 * adds it to `block.timestamp` on-chain, except for the permanent sentinel
 * which it stores verbatim.
 */
export const BAN_DURATIONS = {
  '24 HOURS': 24n * 60n * 60n,
  '7 DAYS':   7n * 24n * 60n * 60n,
  '30 DAYS':  30n * 24n * 60n * 60n,
  PERMANENT:  PERMANENT_BAN,
} as const

export type BanDurationKey = keyof typeof BAN_DURATIONS

/** Where the treasury's buyback proceeds go.  Mirrors `Hook.DEAD_ADDRESS`. */
export const DEAD_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD'

export const POG_SCAN_AUTH_DOMAIN = 'Tosh PoG Scan Request' as const
export const POG_SESSION_AUTH_TTL_MS = 1_800_000 as const

export function buildPoGScanAuthMessage(address: string, timestampMs: number): string {
  return `${POG_SCAN_AUTH_DOMAIN}\nAddress: ${address}\nTimestamp: ${timestampMs}`
}

/** Zero address used as the "no referrer" sentinel on `deposit(hook, referrer)`. */
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'
