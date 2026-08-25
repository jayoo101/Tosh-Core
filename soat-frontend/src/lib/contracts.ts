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
// This file lives at the conventional Next.js `src/lib/` path.  The legacy
// import surface at `src/app/lib/contracts.ts` re-exports from here.
//
// ENV WIRING
// ──────────
//   NEXT_PUBLIC_FACTORY_ADDRESS     — deployed ToshFactory (required)
//   NEXT_PUBLIC_CHAIN_ID            — settlement chain (default 84532)
//   NEXT_PUBLIC_POSITION_MANAGER    — V4 posm; Sepolia fallback if unset
//   NEXT_PUBLIC_PERMIT2             — Permit2; canonical address if unset
//   NEXT_PUBLIC_STATE_VIEW          — V4 StateView; Sepolia fallback if unset
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
  BASE_SEPOLIA_ID,
  FOUNDRY_CHAIN_ID,
  SUPPORTED_POG_CHAIN_IDS,
  isSupportedPogChain,
  MAINNET_CHAIN_LABEL,
  TESTNET_CHAIN_LABEL,
  CHAIN_STATUS_BADGE,
  CHAIN_POSITIONING,
  testnetExplorerTx,
  testnetExplorerAddress,
  targetChain,
} from '@/lib/chain'

if (!process.env.NEXT_PUBLIC_FACTORY_ADDRESS) {
  throw new Error('Missing env: NEXT_PUBLIC_FACTORY_ADDRESS')
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

/** Uniswap V4 PoolManager.  Hard-coded — not env-bound on purpose: a wrong
 *  PoolManager would silently mis-CREATE2 every hook.  Mainnet cutover is a
 *  source change here, reviewed, not an env flip. */
export const POOL_MANAGER: Address = '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408'

/**
 * Uniswap V4 PositionManager — the retail LP entry point.
 *
 * NOTE: an earlier Base Sepolia posm (`0xda4910cd…`) was deployed against the
 * WRONG PoolManager and every liquidity call against it reverts.  The fallback
 * below is the corrected Sepolia deployment; override with
 * `NEXT_PUBLIC_POSITION_MANAGER` on any other chain.
 */
export const POSITION_MANAGER: Address = envAddress(
  'NEXT_PUBLIC_POSITION_MANAGER',
  '0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80',
)

/** Permit2 — canonical address on every chain, overridable just in case. */
export const PERMIT2: Address = envAddress(
  'NEXT_PUBLIC_PERMIT2',
  '0x000000000022D473030F116dDEE9F6B43aC78BA3',
)

/** V4 StateView — read-only `getSlot0`, so the LP panel can size a deposit
 *  off the real sqrtPriceX96 rather than a derived spot. */
export const STATE_VIEW: Address = envAddress(
  'NEXT_PUBLIC_STATE_VIEW',
  '0x571291b572ed32ce6751a2cb2486ebee8defb9b4',
)

/** Full-range bounds, mirroring the hook's genesis position (TICK_SPACING 200). */
export const TICK_LOWER = -887_200
export const TICK_UPPER = 887_200
export const POOL_FEE = 3000
export const TICK_SPACING = 200

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
 * Below this floor `p0 = (lpEth * 1e18) / GENESIS_LP_SUPPLY` truncates to zero.
 *   0.01 ether → 10^16 wei, which keeps p0 around 2.38e9 wei/token.
 */
export const MIN_SOFT_CAP_PROD: bigint = 10n ** 16n
export const MIN_SOFT_CAP_PROD_LABEL = '0.01'

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
