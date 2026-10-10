/**
 * Addresses, ABIs and event topics for the local dashboard.
 *
 * Every signature here was read off the contracts in `src/` rather than
 * remembered, because a getter that does not exist fails as an empty panel
 * rather than as an error — you get a dashboard that looks fine and reports
 * nothing.
 */

import { ethers } from 'ethers'

export const CHAIN_ID = 56

const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

/**
 * The retired BEM-era factories, with the treasury each was deployed beside.
 * Cross-checked against `factory()` on their hooks and treasuries, which are
 * independent contracts that agree.
 */
const RETIRED = {
  '0x20de906a96ffb89be6fd6267a0876a68017792f7': { treasury: '0x7105d36715e4d2bFbBEaD2B7c085e6CDE6f85a4B' },
  '0xbca66f7382aac0c6ee2b833fc2072ca607367f2c': { treasury: '0x3009e10a696AC43465C8bdb9AFD8C989aB9cebdE' },
}

/**
 * The factory this dashboard reads. `POG_FACTORY` selects it; the default is
 * the first-generation factory, whose launches are the history this dashboard
 * was built to watch. Any factory outside `RETIRED` is the WBNB one, whose
 * treasury has to be named too: `DASHBOARD_LADDER_TREASURY`.
 */
export const FACTORY = process.env.POG_FACTORY
  || '0x20dE906A96FfB89BE6fd6267A0876A68017792F7'

const retired = RETIRED[FACTORY.toLowerCase()]
if (!retired && !process.env.DASHBOARD_LADDER_TREASURY) {
  throw new Error(
    `POG_FACTORY ${FACTORY} is not a retired BEM factory, so it is the WBNB one and ` +
    'DASHBOARD_LADDER_TREASURY must name its treasury (factory.ladderTreasury()).',
  )
}

/** True for the WBNB-era factory: 18-decimal quote, factory-scoped band keys. */
export const IS_WBNB_ERA = !retired

export const LADDER_TREASURY = retired ? retired.treasury : process.env.DASHBOARD_LADDER_TREASURY

/** The quote asset: BEM at 8 decimals on a retired factory, WBNB at 18 on the current one. */
export const QUOTE_ASSET = retired ? BEM : WBNB
export const QUOTE_DECIMALS = retired ? 8 : 18
export const QUOTE_SYMBOL = retired ? 'BEM' : 'BNB'
export const TOKEN_DECIMALS = 18

export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD'

/** PancakeSwap Infinity's CL pool manager on 56. Provenance: test/ToshV5Fork.t.sol. */
export const CL_POOL_MANAGER = '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b'

/** The pool shape every launch gets. `soat-frontend/src/lib/contracts.ts`. */
export const POOL_FEE = 3000
export const TICK_SPACING = 200

/**
 * The hook's cut of every swap INPUT, in basis points.
 *
 * Not a pool fee and not charged by the pool: `ToshLaunchpadHook.beforeSwap`
 * skims it before the swap prices, so the amount that reaches the curve is
 * `amountIn * (1 - TAX_BPS/1e4)`. A quote that forgets this overstates the
 * output by a full percent.
 */
export const TAX_BPS = 100n
export const BPS = 10_000n

/** Where the buyback trigger sits, from ToshLadderTreasury.TRIGGER_STEP. */
export const TRIGGER_STEP = retired ? 10n * 10n ** 8n : 3n * 10n ** 17n // 10 BEM | 0.3 BNB

export const FACTORY_ABI = [
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function pogSigner() view returns (address)',
  'function platformTreasury() view returns (address)',
  'function maxPogAllocationLimit() view returns (uint256)',
  'function cooldownDuration() view returns (uint256)',
  'function quotaWindowDuration() view returns (uint256)',
  'function globalLadderHaltedUntil() view returns (uint256)',
  'function globalDepositsPaused() view returns (bool)',
  'function pogQuota(address) view returns (uint256)',
  'function MAX_POG_ALLOCATION_LIMIT() view returns (uint256)',
]

export const TREASURY_ABI = [
  'function reservoir() view returns (uint256)',
  'function ladderTokenCount() view returns (uint256)',
  'function isLadderToken(address) view returns (bool)',
  'function untilNextTrigger() view returns (uint256)',
  'function nextSpendAmount() view returns (uint256)',
  'function currentCursor() view returns (uint256)',
  'function owner() view returns (address)',
]

export const HOOK_ABI = [
  'function projectToken() view returns (address)',
  'function quoteAsset() view returns (address)',
  'function projectAdmin() view returns (address)',
  'function creator() view returns (address)',
  'function ladderTreasury() view returns (address)',
  'function platformFeeRecipient() view returns (address)',
  'function hardCap() view returns (uint256)',
  'function tokenInitialized() view returns (bool)',
  'function launched() view returns (bool)',
  'function refundAnnounced() view returns (bool)',
  'function genesisDeadline() view returns (uint256)',
  'function totalNativeDeposited() view returns (uint256)',
  'function totalReferralReserved() view returns (uint256)',
  'function totalReferralClaimed() view returns (uint256)',
  'function orphanReferral() view returns (uint256)',
  'function getHooksRegistrationBitmap() view returns (uint16)',
  'function getPoolKey() view returns (tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters))',
]

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]

/**
 * Event topics.
 *
 * `GenesisDeposit` is the one that matters most and the one whose shape is
 * easiest to get wrong: it has THREE indexed address fields (user, hook,
 * projectReferrer) and carries `amount` plus an unindexed `lifetimeReferrer` in
 * data. Three topics is the EVM ceiling, which is why the lifetime referrer is
 * the field that got demoted.
 */
export const TOPICS = {
  PoGRegistered: ethers.id('PoGRegistered(address,uint256)'),
  GenesisDeposit: ethers.id('GenesisDeposit(address,address,uint256,address,address)'),
  LaunchCreated: ethers.id('LaunchCreated(uint256,address,address,address,string,string)'),
  BuybackBurned: ethers.id('BuybackBurned(address,uint256,uint256)'),
  BuybackSkipped: ethers.id('BuybackSkipped(address,uint256)'),
  TaxReceived: ethers.id('TaxReceived(address,uint256)'),
  LadderTokenAdded: ethers.id('LadderTokenAdded(address,uint256)'),
  PogSignerUpdated: ethers.id('PogSignerUpdated(address)'),
  DepositsPausedSet: ethers.id('DepositsPausedSet(address,bool)'),
  MaxPogAllocationLimitUpdated: ethers.id('MaxPogAllocationLimitUpdated(uint256)'),
  Blacklisted: ethers.id('Blacklisted(address,uint256)'),
  LadderMintingHalted: ethers.id('LadderMintingHalted(address,uint256)'),
}

/**
 * Upstash keys the production app writes. `scanJobStore.ts`, `pogParams.ts`.
 * The band is factory-scoped since the WBNB cutover; the BEM factories' band
 * lives under the old unscoped keys.
 */
const BAND = retired ? 'tosh:pog:' : `tosh:pog:${FACTORY.toLowerCase()}:`
export const REDIS_KEYS = {
  floorWei: `${BAND}floorWei`,
  gasToSatoRate: `${BAND}gasToSatoRate`,
  maxAllocWei: `${BAND}maxAllocWei`,
  credits: 'tosh:pogscan:credits',
  scanJobPattern: 'tosh:pogscan:*',
  globalLimitPattern: 'tosh:rl:pog-scan:global:*',
}

/** Defaults the frontend seeds when Redis holds no override. `pogQuota.ts`. */
export const POG_DEFAULTS = retired
  ? { floorWei: 25n * 10n ** 15n, gasToAllocRate: 46.4, maxAllocWei: 464n * 10n ** 7n } // 46.4 BEM
  : { floorWei: 25n * 10n ** 15n, gasToAllocRate: 1.3, maxAllocWei: 13n * 10n ** 17n }  // 1.3 BNB

export const fmt = (v, decimals, places = 4) =>
  Number(ethers.formatUnits(v ?? 0n, decimals)).toLocaleString('en-US', { maximumFractionDigits: places })

/** An address out of a log topic. */
export const topicAddress = (topic) => ethers.getAddress('0x' + topic.slice(26))
