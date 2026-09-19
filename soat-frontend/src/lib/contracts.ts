// ─────────────────────────────────────────────────────────────────────────────
// Tosh Protocol — canonical on-chain bindings (v5.0, BEM quote asset, PancakeSwap Infinity).
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
//   NEXT_PUBLIC_QUOTE_ASSET         — the token `factory.quoteAsset()` returns
//                                     (required, and deliberately has no default)
//   NEXT_PUBLIC_QUOTE_SYMBOL        — its ticker for display; 'BEM' if unset
//   NEXT_PUBLIC_CHAIN_ID            — settlement chain (default 97, BSC testnet)
//   NEXT_PUBLIC_POSITION_MANAGER    — Infinity CLPositionManager; the target
//                                     chain's address if unset
//   NEXT_PUBLIC_PERMIT2             — Permit2; PancakeSwap's deployment if unset,
//                                     which is NOT Uniswap's canonical address
//   POG_SIGNER_PRIVATE_KEY          — server-only PoG oracle key (NEVER expose)
//   POG_PRIVATE_KEY                 — spec-compliant fallback alias of the above
//
//   CL_POOL_MANAGER is deliberately NOT env-bound.  It is named inside every
//   `PoolKey` this app encodes, so a wrong one hashes to a pool id that was
//   never initialised — flipping it is a source change, reviewed.
// ─────────────────────────────────────────────────────────────────────────────

import type { Address } from 'viem'
import { FACTORY_ABI, HOOK_ABI, TREASURY_ABI, ERC20_ABI } from '@/app/lib/abis'
import { envAddress, TARGET_CHAIN_ID, BSC_ID, BSC_TESTNET_ID } from '@/lib/chain'

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
 * The quote asset every raise, fee, shelf price and buyback is denominated in.
 *
 * REQUIRED, with no per-chain default, and that is deliberate. The authority is
 * `factory.quoteAsset()` — an immutable with no setter on the factory, the hook
 * implementation and the treasury alike. A default here would let the app approve
 * one token while the factory pulls another, which does not fail at approve time:
 * the allowance is granted, the button enables, and the deposit reverts. On chain
 * 56 the value is BEM; on 97 BEM has no deployment at all, so whatever 8-decimal
 * token the testnet factory was constructed against is the only correct answer and
 * this file cannot guess it.
 *
 * `npm run check:quote` reconciles this against the deployed factory, the hook
 * implementation and the treasury, and refuses a factory that has no `quoteAsset()`
 * at all — which is what turns "required" into "verified". It is a `check:*` rather
 * than a `guard:*` because what it reports is the state of a deployment, not of
 * this tree.
 */
if (!process.env.NEXT_PUBLIC_QUOTE_ASSET) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_QUOTE_ASSET — must be the token `factory.quoteAsset()` returns',
  )
}
export const QUOTE_ASSET = process.env.NEXT_PUBLIC_QUOTE_ASSET as Address

/**
 * Eight, not eighteen, and nothing may assume otherwise.
 *
 * The hook's constructor asserts `decimals() == 8` and refuses to deploy against
 * anything else, so this is a protocol invariant rather than a property of a
 * particular token. It is mirrored here because the ten-orders-of-magnitude gap
 * between this and the project token's 18 is the single most common way a display
 * or an input silently misreads a balance by a factor of 10^10 — `formatUnits(x, 18)`
 * on a quote amount shows 0.0000000928 where 9.28 belongs, and reads as a rounding
 * artefact rather than as a bug.
 */
export const QUOTE_DECIMALS = 8

/**
 * What to call it on screen.
 *
 * Read from env so the testnet's stand-in token is not labelled BEM: chain 97 runs
 * against some other 8-decimal token by necessity, and calling that BEM in the UI
 * would be the interface asserting something the chain does not support.
 */
export const QUOTE_SYMBOL = process.env.NEXT_PUBLIC_QUOTE_SYMBOL ?? 'BEM'

/** Pre-bound quote-asset tuple, for allowance reads and approve writes. */
export const quoteContract = {
  address: QUOTE_ASSET,
  abi:     ERC20_ABI,
} as const

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

/**
 * The sentinel a chain with no Infinity deployment resolves to.
 *
 * ⚠ NOT a fallback and never dereferenced on purpose. Reads against it come
 *   back empty and `toshPoolKey` REFUSES it outright, because the alternative —
 *   a plausible address for some other chain — is the failure mode this repo
 *   has already paid for twice (see `POSITION_MANAGER`'s history below and the
 *   `LADDER_TREASURY` alias warning above). Zero is unmistakably "unset"; a
 *   real address from the wrong chain is not.
 */
const NO_INFINITY_DEPLOYMENT: Address = '0x0000000000000000000000000000000000000000'

/**
 * The target chain's Infinity address, or the zero sentinel if it has none.
 *
 * ⚠ THE PER-CHAIN TABLE IS THE POINT. This file used to hold one hard-coded
 *   singleton per periphery contract, and the comment explaining why rested on
 *   the two chains it then targeted sharing an address — true of the Robinhood
 *   era, and NOT true of Infinity: 56 and 97 are different deployments at
 *   different addresses (docs/PANCAKESWAP_INFINITY.md §7). A single constant
 *   would therefore be right on one chain and silently wrong on the other.
 */
function infinityAddress(byChain: Record<number, Address>): Address {
  return byChain[TARGET_CHAIN_ID] ?? NO_INFINITY_DEPLOYMENT
}

/**
 * Infinity's `CLPoolManager` — the AMM half of what V4 called a PoolManager.
 *
 * Hard-coded per chain, not env-bound on purpose, and LOAD-BEARING for two
 * independent reasons:
 *
 *   • It is a MEMBER OF EVERY `PoolKey` this app encodes. Infinity names its
 *     manager in the key and `CLPoolManager` reverts `PoolManagerMismatch` on a
 *     key that names someone else, so a wrong value here hashes to a pool id
 *     that was never initialised and every deposit reverts.
 *   • It is where pool state reads go. Infinity ships no `StateView`; the
 *     manager exposes `getSlot0` and `getLiquidity` itself.
 *
 * Neither was true of the V4 constant this replaces, which was genuinely dead —
 * hook addresses stopped being predicted from it when the launch page started
 * reading `factory.hookInitcodeHash(...)` off the chain. It is not dead now.
 *
 * Chain 31337 has no entry: a devnet deploys its own Infinity and there is no
 * canonical address to name. It resolves to the zero sentinel, which
 * `toshPoolKey` refuses by name rather than encoding into a well-formed key.
 */
export const CL_POOL_MANAGER: Address = infinityAddress({
  [BSC_ID]:         '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b',
  [BSC_TESTNET_ID]: '0x36A12c70c9Cf64f24E89ee132BF93Df2DCD199d4',
})

/**
 * Infinity's `CLPositionManager` — the retail LP entry point.
 *
 * ⚠ THIS USED TO BE UNISWAP'S V4 PositionManager, and the retail LP feature was
 *   broken rather than mislabelled: Uniswap never deployed V4 to BSC testnet, so
 *   the old default `0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b` has NO CODE on
 *   chain 97 (measured; docs/PANCAKESWAP_INFINITY.md §7). Swapping the address
 *   alone would only have traded a no-code failure for a revert, because the two
 *   managers do not share an encoding — Infinity's `modifyLiquidities` mint
 *   params carry a six-member `PoolKey` that names its pool manager and packs
 *   `tickSpacing` into a `bytes32`. That port is in `clMath.ts` and
 *   `lpActions.ts`; this address is only its last mile.
 *
 *   The genesis position was never affected: the hook seeds it directly through
 *   the Vault with no periphery involved. This is retail LP only.
 *
 * Function names and signatures are unchanged from V4 — `modifyLiquidities`,
 * `getPoolAndPositionInfo`, `getPositionLiquidity`, plus ERC-721 — so the ABI in
 * `lpAbis.ts` differs from the old one in exactly one place, the embedded
 * `PoolKey` tuple.
 *
 * The env override stays — it is how a devnet names its own deployment — and it
 * is written out as the literal `process.env.NEXT_PUBLIC_…` rather than passed
 * in as a name to look up: Next substitutes those textually at build time, so a
 * computed key is simply `undefined` in the browser. See
 * `scripts/checkPublicEnv.mjs`, which enforces it.
 */
export const CL_POSITION_MANAGER: Address = envAddress(
  process.env.NEXT_PUBLIC_POSITION_MANAGER,
  infinityAddress({
    [BSC_ID]:         '0x55f4c8abA71A1e923edC303eb4fEfF14608cC226',
    [BSC_TESTNET_ID]: '0x77DedB52EC6260daC4011313DBEE09616d30d122',
  }),
)

/** Permit2 — PancakeSwap's deployment, NOT Uniswap's canonical address.
 *
 *  ⚑ This was wrong, and the wrong value was the plausible one. It read
 *  `0x000000000022D473030F116dDEE9F6B43aC78BA3` with a comment calling it "the one
 *  address the migration did not have to touch". That address is genuinely live on
 *  BSC and genuinely is a working Permit2, so approving it succeeds and nothing
 *  complains — right up to the swap or the mint, which reverts with
 *  `AllowanceExpired` from a contract the caller never named.
 *
 *  PancakeSwap's periphery consults its own deployment. Both `UniversalRouter` and
 *  `CLPositionManager` do, and the same address serves mainnet 56 and testnet 97,
 *  confirmed by calling `CLPositionManager.permit2()` on each. `ToshV5Fork.t.sol`
 *  asserts the agreement so a future periphery bump cannot move it silently. */
export const PERMIT2: Address = envAddress(
  process.env.NEXT_PUBLIC_PERMIT2,
  '0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768',
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
 * from. `POOL_FEE` is the Infinity CL pool's own fee and goes to liquidity
 * providers; this is the hook's and is stacked on top of it.
 *
 * THE TWO LEGS DO DIFFERENT THINGS WITH IT, which is why the UI cannot
 * describe it as one destination:
 *
 *   • buy  — split. `PLATFORM_SWAP_FEE_BPS` (30) of the quote-asset input goes to the
 *            platform, the remaining 70 bps to the ladder treasury.
 *   • sell — not split. The full 100 bps of the TOKEN input is burned.
 *
 * ⚠ NOT `PLATFORM_TAX_BPS` above, which is also 100. See the warning there.
 */
export const TAX_BPS = 100

/**
 * `ToshLaunchpadHook.PLATFORM_SWAP_FEE_BPS` — the platform's share of the buy
 * leg's `TAX_BPS`, in basis points of the quote-asset input.
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

/**
 * infinity-periphery `Actions` opcodes used by the LP panel.
 *
 * ⚠ ALL FIVE VALUES ARE NUMERICALLY IDENTICAL TO UNISWAP V4'S — 0x02, 0x03,
 *   0x0d, 0x11, 0x14 mean CL_MINT_POSITION/MINT_POSITION,
 *   CL_BURN_POSITION/BURN_POSITION, SETTLE_PAIR, TAKE_PAIR and SWEEP in both
 *   peripheries. So the packed `actions` string `lpActions.ts` builds is
 *   BYTE-IDENTICAL whichever AMM it was meant for, and no inspection of a
 *   payload's opcodes can tell which one it targets.
 *
 *   THE RENAME IS THE ONLY SIGNAL A READER GETS. That is why the keys are
 *   Infinity's spelling rather than V4's, and why
 *   `scripts/checkLpActionsAbi.mjs` pins them BY NAME against
 *   `lib/infinity-periphery/src/libraries/Actions.sol`: a check on the values
 *   alone would pass just as happily against v4-periphery, which is exactly the
 *   near-miss this file is trying not to repeat (see
 *   docs/PANCAKESWAP_INFINITY.md §9.3 for the router-tuple version of it).
 *
 *   The one structural difference between the two AMMs' payloads is the
 *   six-member `PoolKey` inside the mint params; see `PoolKeyStruct` in
 *   `clMath.ts`.
 */
export const CL_ACTIONS = {
  CL_MINT_POSITION: 0x02,
  CL_BURN_POSITION: 0x03,
  SETTLE_PAIR:      0x0d,
  TAKE_PAIR:        0x11,
  SWEEP:            0x14,
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
 * Below this floor `p0 = (lpQuote * 1e18) / GENESIS_LP_SUPPLY` truncates to zero.
 *
 * ⚑ 100 BEM, and this floor is now LOAD-BEARING rather than a formality. It was
 * 0.035 BNB, an 18-decimal amount that cleared the point where the shelf ladder
 * degenerates by sixteen million to one. BEM has eight decimals: 100 BEM gives
 * `p0` = 2380 and `shelfP0` = 2499 against a break-even of 526, a margin of 4.75.
 * Below roughly 21 BEM two adjacent shelves round onto one price, which would let a
 * buyer clear the upper shelf at the lower shelf's price.
 *
 * So lowering this is not a UX decision. `ToshV5Fuzz.t.sol`
 * (`test_smallestReachableShelfP0_stillStepsTheLadder` and
 * `test_belowTheSoftCapFloor_theLadderStopsStepping`) holds both sides of it, and
 * `docs/BEM_QUOTE_ASSET.md` §2.2 is the argument.
 */
export const MIN_SOFT_CAP_PROD: bigint = 100n * 10n ** 8n
export const MIN_SOFT_CAP_PROD_LABEL = '100'

/**
 * Ceiling on `launchFee` (mirrors `Factory.MAX_LAUNCH_FEE`).
 *
 * Mirrored here for the same reason the soft-cap floor and the cooldown maximum
 * are: the admin panel is where the value is typed, and the slip this ceiling
 * exists to catch — an order-of-magnitude slip — is a keystroke. A bound that lives
 * only on-chain turns that keystroke into a reverted owner transaction instead of
 * an inline refusal.
 *
 * 928 BEM, a hundred times the 9.28 BEM default.
 */
export const MAX_LAUNCH_FEE: bigint = 928n * 10n ** 8n
export const MAX_LAUNCH_FEE_LABEL = '928'

/**
 * Ceilings on the other two quote-denominated dials (mirror
 * `Factory.MAX_DEFAULT_SOFT_CAP` and `Factory.MAX_POG_ALLOCATION_LIMIT`).
 *
 * Far looser than `MAX_LAUNCH_FEE`, and read the Solidity natspec before
 * tightening either: a value picked for neatness here would reject raises and
 * wallet caps this repo's own test fixtures and rehearsal scripts depend on.
 * These catch order-of-magnitude confusion and nothing subtler — in particular a
 * per-wallet limit under the ceiling is not evidence that PoG still caps whales.
 *
 * 20,000 BEM rather than the old 1,000,000: with a fixed-supply quote asset the
 * ceiling has to sit under the asset's own float to mean anything, and 20,000 BEM
 * is around a tenth of supply. A 1,000,000 ceiling would have sat several times
 * ABOVE it and refused nothing — see `ToshFactory.MAX_DEFAULT_SOFT_CAP`'s natspec.
 */
export const MAX_DEFAULT_SOFT_CAP: bigint = 20_000n * 10n ** 8n
export const MAX_DEFAULT_SOFT_CAP_LABEL = '20,000'

export const MAX_POG_ALLOCATION_LIMIT: bigint = 20_000n * 10n ** 8n
export const MAX_POG_ALLOCATION_LIMIT_LABEL = '20,000'

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
