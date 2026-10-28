/**
 * Addresses, ABIs and event topics for the local dashboard: ToshX v2 on chain 56.
 *
 * The addresses are the ones `script/DeployV2.s.sol` wrote to
 * `deployments/v2-56.json`. That file is not committed, so they are pinned here
 * and `checkDeploymentFile` compares the two whenever the file is present: a
 * redeploy that updates one and not the other is a dashboard reporting on
 * contracts nobody uses any more, and it would look perfectly healthy.
 *
 * Every signature below was read off the compiled ABIs in `out/`, because a
 * getter that does not exist fails as an empty panel rather than as an error.
 */

import { ethers } from 'ethers'
import { existsSync, readFileSync } from 'node:fs'

export const CHAIN_ID = 56

/** First block of the v2 deployment. Nothing of ours emitted a log before it. */
export const DEPLOY_BLOCK = 130_243_379

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT = '0x55d398326f99059fF775485246999027B3197955'

export const BID_BOOK = '0x485d09C723295709dAc8A9721539b39D10B4Bf4E'
export const LENS = '0xd01A2B50580F15f6f83A5AFAc2c3f86C46671f8a'

/** Owns both treasuries directly and both factories through their gateways. */
export const OWNER_SAFE = '0x02DE4629129D104C63329D13A6Ca67E43db7B310'
export const SAFE_OWNERS = 3
export const SAFE_THRESHOLD = 2

/**
 * One factory, gateway and ladder treasury per quote asset. BSC's USDT has 18
 * decimals, unlike Ethereum's, so both markets share the token's scale.
 *
 * `sizes` are the buy sizes the pool panel prices, in whole quote units, and
 * `probe` the one its round-trip cost is quoted at. USDT's are scaled to
 * roughly the same money as BNB's.
 */
export const MARKETS = [
  {
    key: 'bnb',
    symbol: 'BNB',
    quote: WBNB,
    quoteDecimals: 18,
    factory: '0x1f20E128DEF70584fAA4d00A3E6C0f87eee622a8',
    gateway: '0xdaA1F95d4D319B04792759551587E24c751f2EaA',
    treasury: '0xb38710619B6b4a6fd84554d6C125ed816e3402D2',
    sizes: [0.1, 0.5, 1, 5, 10],
    probe: 1,
  },
  {
    key: 'usdt',
    symbol: 'USDT',
    quote: USDT,
    quoteDecimals: 18,
    factory: '0xBeBc716Db4454AB080714fFC2fEB0F0619E8985c',
    gateway: '0x16efaC5111417F810f23817B5EEB95Cb14801881',
    treasury: '0x902Cf9327498Aa5cE666316077f3C6Fd8d5d2926',
    sizes: [50, 250, 500, 2500, 5000],
    probe: 500,
  },
]

/** `deployments/v2-56.json` key for each pinned address above. */
const DEPLOYMENT_KEYS = {
  bidBook: BID_BOOK,
  lens: LENS,
  bnbFactory: MARKETS[0].factory,
  bnbGateway: MARKETS[0].gateway,
  bnbTreasury: MARKETS[0].treasury,
  usdtFactory: MARKETS[1].factory,
  usdtGateway: MARKETS[1].gateway,
  usdtTreasury: MARKETS[1].treasury,
}

/** Disagreements between the pinned addresses and the deploy record, if it exists. */
export function checkDeploymentFile() {
  const path = new URL('../../deployments/v2-56.json', import.meta.url)
  if (!existsSync(path)) return { present: false, mismatches: [] }
  const file = JSON.parse(readFileSync(path, 'utf8'))
  const mismatches = Object.entries(DEPLOYMENT_KEYS)
    .filter(([k, v]) => String(file[k] || '').toLowerCase() !== v.toLowerCase())
    .map(([k, v]) => `${k}: pinned ${v}, deployments/v2-56.json has ${file[k] || 'nothing'}`)
  return { present: true, mismatches }
}

export const TOKEN_DECIMALS = 18

/** PancakeSwap Infinity's CL pool manager on 56, read back from `hook.poolManager()`. */
export const CL_POOL_MANAGER = '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b'

/** The pool shape every launch gets: `ToshLaunchpadHook.POOL_FEE` and `TICK_SPACING`. */
export const POOL_FEE = 3000
export const TICK_SPACING = 200

/**
 * The hook's cut of every swap INPUT, in basis points (`ToshLaunchpadHook.TAX_BPS`).
 *
 * Not a pool fee and not charged by the pool: the hook skims it before the swap
 * prices, so the amount that reaches the curve is `amountIn * (1 - TAX_BPS/1e4)`.
 * On a buy 30 of the 100 bps go to the platform and 70 to the ladder reservoir;
 * on a sell all 100 are burned. A quote that forgets it overstates the output by
 * a full percent.
 */
export const TAX_BPS = 100n
export const BPS = 10_000n

export const FACTORY_ABI = [
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function paused() view returns (bool)',
  'function globalGenesisPaused() view returns (bool)',
  'function globalLadderHaltedUntil() view returns (uint256)',
  'function hookGenesisPaused(address) view returns (bool)',
  'function ladderMintingHalted(address) view returns (bool)',
  'function minBuy() view returns (uint256)',
  'function minHardCap() view returns (uint256)',
  'function maxHardCap() view returns (uint256)',
  'function minAgentCap() view returns (uint256)',
  'function maxAgentCap() view returns (uint256)',
  'function launchCount() view returns (uint256)',
  'function launches(uint256) view returns (address token, address hook, address creator, uint256 createdAt)',
  'function ladderTreasury() view returns (address)',
  'function bidBook() view returns (address)',
  'function quoteAsset() view returns (address)',
  'event LaunchCreated(uint256 indexed launchId, address indexed token, address indexed hook, address creator, string name, string symbol)',
  'event LaunchParams(address indexed hook, uint256 hardCap, uint256 perAgentCap, uint256 genesisDuration, address projectFund)',
  'event GenesisPausedSet(address indexed hook, bool paused)',
  'event Blacklisted(address indexed user, uint256 untilTimestamp)',
  'event LadderMintingHalted(address indexed hook, uint256 until)',
  'event LadderMintingResumed(address indexed hook)',
  'event HardCapBoundsSet(uint256 min, uint256 max)',
  'event AgentCapBoundsSet(uint256 min, uint256 max)',
  'event NameReleased(address indexed hook, bytes32 indexed nameKey)',
  'event Paused(address account)',
  'event Unpaused(address account)',
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
]

export const GATEWAY_ABI = [
  'function factory() view returns (address)',
  'function safe() view returns (address)',
  'event Executed(bytes4 indexed selector)',
]

export const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
]

export const TREASURY_ABI = [
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function factory() view returns (address)',
  'function reservoir() view returns (uint256)',
  'function nextSpendAmount() view returns (uint256)',
  'function untilNextTrigger() view returns (uint256)',
  'function ladderTokenCount() view returns (uint256)',
  'function piggybackActive() view returns (bool)',
  'event TaxReceived(address indexed from, uint256 amount)',
  'event BuybackBurned(address indexed token, uint256 nativeIn, uint256 tokensBurned)',
  'event BuybackSkipped(address indexed token, uint256 nativeIn)',
  'event PiggybackExecuted(uint256 nativeSpent, uint256 tokensServiced, uint256 newCursor)',
  'event LadderTokenAdded(address indexed token, uint256 index)',
  'event LadderTokenRemoved(address indexed token, uint256 index)',
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
]

export const BIDBOOK_ABI = [
  'function initialized() view returns (bool)',
  'function nextBidId() view returns (uint256)',
  'function feeRecipient() view returns (address)',
  'function escrowTotal(address) view returns (uint256)',
  'function feesAccrued(address) view returns (uint256)',
  'event BidPlaced(uint256 indexed bidId, address indexed hook, address indexed bidder, uint256 price, uint256 qty, uint256 escrow)',
  'event BidFilled(uint256 indexed bidId, address indexed hook, address indexed seller, uint256 qty, uint256 price, uint256 gross, uint256 buyerFee, uint256 sellerFee)',
  'event BidCancelled(uint256 indexed bidId, address indexed hook, uint256 refund)',
  'event FeesSwept(address indexed quote, uint256 amount)',
]

export const LENS_ABI = [
  'function genesisState(address hook) view returns (tuple(address quoteAsset, address token, bool acceptsNative, uint256 minBuy, uint256 hardCap, uint256 perAgentCap, uint256 basePrice, uint256 currentPrice, uint256 sold, uint256 raised, uint256 genesisDeadline, uint256 soldOutAt, uint256 launchStart, uint256 publicLaunchAt, bool launched, address projectController, address projectFund, uint256 fundAvailable) s)',
]

export const HOOK_ABI = [
  'function getPoolKey() view returns (tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters))',
  'function getHooksRegistrationBitmap() view returns (uint16)',
  'function tierStatus() view returns (uint256 tierIndex, uint256 tierPrice, uint256 remaining, uint256 spotPrice, uint256 twapPrice, uint256 ceiling, bool unlocked)',
  'function phase2Minted() view returns (uint256)',
  'event GenesisBuy(address indexed buyer, bytes32 indexed agentKey, uint256 paid, uint256 tokens, uint256 soldAfter)',
  'event SoldOut(uint256 timestamp)',
  'event Launched(uint256 raised, uint256 lpQuote, uint256 lpTokens, uint256 burned, uint128 lpLiquidity, uint160 sqrtPriceX96, uint256 p0)',
  'event TierMinted(address indexed buyer, uint256 indexed tierIndex, uint256 tierPrice, uint256 tokensOut, uint256 nativeIn)',
  'event SellTaxBurned(uint256 tokenAmount)',
  'event FundWithdrawn(address indexed to, uint256 amount)',
  'event PiggybackPokeFailed(address indexed treasury)',
]

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]

export const fmt = (v, decimals, places = 4) =>
  Number(ethers.formatUnits(v ?? 0n, decimals)).toLocaleString('en-US', { maximumFractionDigits: places })
