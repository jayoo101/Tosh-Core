/**
 * node scripts/auditLaunch.mjs <hook> [rpc]
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads a launched hook, its token and its Infinity CL pool, and checks the
 * numbers against the arithmetic `launch()` performs — rather than against a
 * screenshot of the app, which reads the same chain through the same assumptions
 * and so cannot disagree with itself.
 *
 * Every expected value here is derived from `ToshLaunchpadHook.launch()`:
 *
 *     commissionPool = totalReferralReserved + orphanReferral
 *     lpNative          = totalNativeDeposited - commissionPool
 *     p0             = lpNative * 1e18 / GENESIS_LP_SUPPLY
 *     shelfP0        = p0 * SHELF_PREMIUM_BPS / 10_000
 *
 * `orphanReferral` is zeroed by `launch()` itself, so the split cannot be
 * recomputed from present state alone. The `Launched` event carries the values
 * as they were, and this reconciles state against the event rather than assuming
 * one of them.
 *
 * Pool state is read from `CLPoolManager.getSlot0` / `getLiquidity` against the
 * PoolKey the hook itself publishes (`getPoolKey()`). That is deliberately not
 * the app's reconstructed key: the point is a second opinion, and reconstructing
 * a five-member V4 key here would hash to a pool that was never initialised.
 */

import { ethers } from 'ethers'
import { CheckFailed, installFailureExit } from './lib/checkExit.mjs'

installFailureExit()

const HOOK = process.argv[2]
const RPC = process.argv[3] ?? process.env.BSC_RPC ?? process.env.BSC_TESTNET_RPC

if (!/^0x[0-9a-fA-F]{40}$/.test(HOOK ?? '')) {
  console.log('usage: node scripts/auditLaunch.mjs <hook> [rpc]')
  throw new CheckFailed('a hook address is required')
}
if (!RPC) {
  throw new CheckFailed('pass an RPC URL or set BSC_RPC / BSC_TESTNET_RPC')
}

/** Mirrors of the hook's own constants. A drift here is a finding, not a typo. */
const GENESIS_SUPPLY      = 8_400_000n * 10n ** 18n
const GENESIS_CLAIM_SUPPLY = 4_620_000n * 10n ** 18n
const GENESIS_LP_SUPPLY   = 3_780_000n * 10n ** 18n
const TIER_COUNT          = 4000n
const TIER_SIZE           = 3_150n * 10n ** 18n
const SHELF_PREMIUM_BPS   = 10_500n
const BPS                 = 10_000n

const CL_POOL_MANAGERS = {
  56: '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b',
  97: '0x36A12c70c9Cf64f24E89ee132BF93Df2DCD199d4',
}
const POOL_FEE      = 3000
const TICK_SPACING  = 200

const HOOK_ABI = [
  'function launched() view returns (bool)',
  'function tokenInitialized() view returns (bool)',
  'function projectToken() view returns (address)',
  'function poolManager() view returns (address)',
  'function vault() view returns (address)',
  'function quoteAsset() view returns (address)',
  'function getHooksRegistrationBitmap() view returns (uint16)',
  'function getPoolKey() view returns (tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters))',
  'function ladderTreasury() view returns (address)',
  'function platformFeeRecipient() view returns (address)',
  'function creator() view returns (address)',
  'function projectTreasury() view returns (address)',
  'function projectAdmin() view returns (address)',
  'function softCap() view returns (uint256)',
  'function perWalletCap() view returns (uint256)',
  'function genesisDeadline() view returns (uint256)',
  'function genesisDuration() view returns (uint256)',
  'function totalNativeDeposited() view returns (uint256)',
  'function totalReferralReserved() view returns (uint256)',
  'function totalReferralClaimed() view returns (uint256)',
  'function orphanReferral() view returns (uint256)',
  'function p0() view returns (uint256)',
  'function shelfP0() view returns (uint256)',
  'function currentTierIndex() view returns (uint256)',
  'function currentTierSold() view returns (uint256)',
  'function phase2Minted() view returns (uint256)',
  'function canRefund() view returns (bool)',
  'function ladderViable() view returns (bool)',
  'function refundAnnounced() view returns (bool)',
  'function nativeDeposited(address) view returns (uint256)',
  'function genesisShareClaimed(address) view returns (bool)',
  'function referralAccrued(address) view returns (uint256)',
  'event Launched(uint256 totalNative, uint256 lpNative, uint128 lpLiquidity, uint160 sqrtPriceX96, uint256 p0)',
  'event OrphanReferralForwarded(uint256 amount)',
  'event GenesisShareClaimed(address indexed user, uint256 tokenAllocation)',
]

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
]

const CL_POOL_ABI = [
  'function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 id) view returns (uint128 liquidity)',
]

const problems = []
const notes = []
const fail = (m) => problems.push(m)

const quote = (v) => `${ethers.formatUnits(v, 8)} quote`
const tok = (v) => Number(ethers.formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: 4 })

/** Pass/fail on an exact bigint identity, printed either way. */
function expect(label, actual, wanted, format = String) {
  const ok = actual === wanted
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(42)} ${format(actual)}`)
  if (!ok) fail(`${label}: chain says ${format(actual)}, launch() arithmetic says ${format(wanted)}`)
}

const provider = new ethers.JsonRpcProvider(RPC)
const hook = new ethers.Contract(HOOK, HOOK_ABI, provider)

const [
  launched, tokenInit, tokenAddr, pmAddr, ladderTreasury, platformFee,
  creator, projectTreasury, projectAdmin, softCap, perWalletCap,
  genesisDeadline, genesisDuration, totalNative, refReserved, refClaimed, orphan,
  p0, shelfP0, tierIndex, tierSold, phase2, canRefund, zombie,
] = await Promise.all([
  hook.launched(), hook.tokenInitialized(), hook.projectToken(), hook.poolManager(),
  hook.ladderTreasury(), hook.platformFeeRecipient(), hook.creator(),
  hook.projectTreasury(), hook.projectAdmin(), hook.softCap(), hook.perWalletCap(),
  hook.genesisDeadline(), hook.genesisDuration(), hook.totalNativeDeposited(),
  hook.totalReferralReserved(), hook.totalReferralClaimed(), hook.orphanReferral(),
  hook.p0(), hook.shelfP0(), hook.currentTierIndex(), hook.currentTierSold(),
  hook.phase2Minted(), hook.canRefund(), hook.refundAnnounced(),
])

console.log(`\nHook   ${HOOK}`)
console.log(`RPC    ${RPC}`)

if (!launched) fail('this hook has not launched — nothing below describes a live pool')
if (!tokenInit) fail('tokenInitialized() is false on a launched hook')

// ── Wiring ───────────────────────────────────────────────────────────────────
console.log('\nWiring')
console.log(`        token             ${tokenAddr}`)
console.log(`        creator           ${creator}`)
console.log(`        project admin     ${projectAdmin}`)
console.log(`        project treasury  ${projectTreasury}`)
console.log(`        ladder treasury   ${ladderTreasury}`)
console.log(`        platform fee to   ${platformFee}`)
const knownManagers = Object.values(CL_POOL_MANAGERS).map((a) => a.toLowerCase())
if (!knownManagers.includes(pmAddr.toLowerCase())) {
  fail(`poolManager() is ${pmAddr}, which is not the Infinity CLPoolManager on BSC 56 or 97`)
}

// ── The raise, and the split launch() made of it ─────────────────────────────
const iface = new ethers.Interface(HOOK_ABI)
const launchedTopic = iface.getEvent('Launched').topicHash
let ev = null
try {
  const logs = await provider.send('eth_getLogs', [{
    address: HOOK, topics: [launchedTopic], fromBlock: '0x0', toBlock: 'latest',
  }])
  if (logs.length > 0) ev = iface.decodeEventLog('Launched', logs[0].data, logs[0].topics)
  if (logs.length > 1) notes.push(`${logs.length} Launched events on one hook — launch() guards against this`)
} catch (err) {
  notes.push(`could not read the Launched event (${err.shortMessage ?? err.message}); `
    + 'the split below is reconciled against present state only')
}

console.log('\nThe raise')
console.log(`        deposited         ${quote(totalNative)}`)
console.log(`        soft cap          ${quote(softCap)}  (not a gate — read by nothing)`)
console.log(`        per-wallet cap    ${quote(perWalletCap)}`)
console.log(`        referral reserved ${quote(refReserved)}   claimed ${quote(refClaimed)}`)
console.log(`        orphan referral   ${quote(orphan)}`)

// ⚠ THIS USED TO `fail()` ON `totalNative < softCap`, WHICH FAILS A HEALTHY
//   LAUNCH. Nothing reads the soft cap — deposits do not stop at it, `launch()`
//   does not check it — so a raise below it is the ordinary case and the live
//   97 rehearsal is one. An audit that reports FAIL on a correct hook trains
//   its reader to ignore it, which costs more than the check was ever worth.
//
//   The door `launch()` actually came through is `ladderViable()`, so that is
//   what gets asserted. It reads `totalNativeDeposited` net of the commission
//   carve, and `launch()` zeroes `orphanReferral` on its way out — so the
//   post-launch answer is computed over a slightly LARGER quote than the one
//   the door saw. It can therefore only be true here if it was true then,
//   which is the direction that makes this safe to check after the fact.
const viable = await hook.ladderViable()
if (!viable) {
  fail('a launched hook whose raise cannot carry a monotone ladder — '
    + 'launch() reverts RaiseTooSmallForLadder on this, so it should not exist')
}

// `launch()` zeroes `orphanReferral` after forwarding it, so present state can
// only reproduce the split if the event says how much was forwarded.
const orphanAtLaunch = ev ? ev.totalNative - ev.lpNative - refReserved : orphan
const lpNative = totalNative - (refReserved + orphanAtLaunch)

console.log('\nThe split  (lpNative = deposited - referralReserved - orphanReferral)')
if (ev) {
  expect('Launched.totalNative == totalNativeDeposited', ev.totalNative, totalNative, quote)
  expect('lpNative reconciles with the reserves', ev.lpNative, lpNative, quote)
  console.log(`        orphan at launch  ${quote(orphanAtLaunch)}`)
  if (orphan !== 0n) fail(`orphanReferral is ${quote(orphan)} after launch — launch() forwards and zeroes it`)
}

// ── The anchor prices ────────────────────────────────────────────────────────
const wantP0 = (lpNative * 10n ** 18n) / GENESIS_LP_SUPPLY
const wantShelf = (wantP0 * SHELF_PREMIUM_BPS) / BPS

console.log('\nAnchor prices  (p0 = lpNative / 3.78M, shelfP0 = p0 * 1.05)')
expect('p0', p0, wantP0, (v) => `${ethers.formatUnits(v, 8)} quote/token`)
expect('shelfP0', shelfP0, wantShelf, (v) => `${ethers.formatUnits(v, 8)} quote/token`)
if (ev) expect('p0 matches the Launched event', p0, ev.p0, (v) => `${ethers.formatUnits(v, 8)} quote/token`)

// ── Token supply and where it sits ───────────────────────────────────────────
const [vaultAddr, poolKey] = await Promise.all([hook.vault(), hook.getPoolKey()])
const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider)
const [name, symbol, decimals, supply, hookBal, vaultTokenBal] = await Promise.all([
  token.name(), token.symbol(), token.decimals(), token.totalSupply(),
  token.balanceOf(HOOK), token.balanceOf(vaultAddr),
])

console.log(`\nToken  ${name} (${symbol}), ${decimals} decimals`)
console.log(`        total supply      ${tok(supply)}`)
console.log(`        held by hook      ${tok(hookBal)}   (unclaimed genesis)`)
console.log(`        held by vault     ${tok(vaultTokenBal)}   (pool reserves)`)

// launch() mints exactly GENESIS_SUPPLY; Phase 2 mints on top of it as shelves
// sell, so supply is the genesis mint plus whatever the ladder has issued.
expect('total supply == genesis + phase2 minted', supply, GENESIS_SUPPLY + phase2, tok)

// What the hook still holds must be the claim allocation minus every claim
// actually paid out. Summing the events is the only independent way to say so —
// comparing the balance to itself would pass on any number.
let claimedSum = null
try {
  const claimTopic = iface.getEvent('GenesisShareClaimed').topicHash
  const logs = await provider.send('eth_getLogs', [{
    address: HOOK, topics: [claimTopic], fromBlock: '0x0', toBlock: 'latest',
  }])
  claimedSum = logs.reduce(
    (sum, l) => sum + iface.decodeEventLog('GenesisShareClaimed', l.data, l.topics).tokenAllocation,
    0n,
  )
  console.log(`        claims paid        ${tok(claimedSum)} over ${logs.length} claim(s)`)

  // Solvency, not equality. `_addInitialLiquidity` derives the token amount from
  // the liquidity Infinity computes for the price, which can round to slightly LESS
  // than GENESIS_LP_SUPPLY — so the hook keeps a few wei of dust on top of the
  // claim allocation. Asserting equality would fail on that dust while missing
  // the property that matters: whatever is still owed can still be paid.
  const owed = GENESIS_CLAIM_SUPPLY - claimedSum
  const dust = hookBal - owed
  if (dust < 0n) {
    fail(`the hook holds ${hookBal} wei of ${symbol} but still owes ${owed} — `
      + `${-dust} short, so some depositor's claim would revert`)
  } else {
    console.log(`  ok    can pay every remaining claim         ${owed} wei owed, ${dust} wei spare`)
  }
} catch (err) {
  notes.push(`could not sum GenesisShareClaimed (${err.shortMessage ?? err.message}); `
    + 'the hook balance is only bounds-checked')
}
if (hookBal > GENESIS_CLAIM_SUPPLY) {
  fail(`hook holds ${tok(hookBal)}, more than the ${tok(GENESIS_CLAIM_SUPPLY)} claim allocation`)
}
console.log(`        unclaimed          ${tok(hookBal)} of ${tok(GENESIS_CLAIM_SUPPLY)}`)

// ── The pool itself, read from CLPoolManager against the hook's own key ──────
if (poolKey.poolManager.toLowerCase() !== pmAddr.toLowerCase()) {
  fail(`getPoolKey().poolManager is ${poolKey.poolManager}, poolManager() is ${pmAddr}`)
}
if (poolKey.hooks.toLowerCase() !== HOOK.toLowerCase()) {
  fail(`getPoolKey().hooks is ${poolKey.hooks}, not this hook`)
}
if (Number(poolKey.fee) !== POOL_FEE) {
  fail(`getPoolKey().fee is ${poolKey.fee}, not the ${POOL_FEE} the hook seeds`)
}

const poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ['tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters)'],
  [[
    poolKey.currency0,
    poolKey.currency1,
    poolKey.hooks,
    poolKey.poolManager,
    poolKey.fee,
    poolKey.parameters,
  ]],
))

const pm = new ethers.Contract(pmAddr, CL_POOL_ABI, provider)
const quoteAddr = await hook.quoteAsset()
const quoteToken = new ethers.Contract(quoteAddr, ERC20_ABI, provider)
const [slot0, liquidity, vaultQuote] = await Promise.all([
  pm.getSlot0(poolId),
  pm.getLiquidity(poolId),
  quoteToken.balanceOf(vaultAddr),
])

const sqrtPriceX96 = slot0.sqrtPriceX96
const tick = slot0.tick
const protocolFee = Number(slot0.protocolFee)
const lpFee = Number(slot0.lpFee)
const tickSpacing = Number((BigInt(poolKey.parameters) >> 16n) & 0xffffffn)

console.log(`\nPool   id ${poolId}`)
console.log(`        currency0         ${poolKey.currency0} (quote)`)
console.log(`        currency1         ${poolKey.currency1}`)
console.log(`        poolManager       ${poolKey.poolManager}`)
console.log(`        fee / spacing     ${poolKey.fee} / ${tickSpacing}`)
console.log(`        parameters        ${poolKey.parameters}`)
console.log(`        sqrtPriceX96      ${sqrtPriceX96}`)
console.log(`        tick              ${tick}`)
console.log(`        lpFee             ${lpFee}${lpFee === POOL_FEE ? '' : `  (expected ${POOL_FEE})`}`)
console.log(`        protocolFee       ${protocolFee}`)
console.log(`        liquidity         ${liquidity}`)
console.log(`        vault quote       ${quote(vaultQuote)}  (all pools on this Vault)`)

if (sqrtPriceX96 === 0n) {
  fail('the pool is not initialized: getSlot0 returned sqrtPriceX96 0. '
    + 'Either it was never created or the PoolKey the hook publishes is not the one launch() used')
}
if (liquidity === 0n) fail('the pool is initialized but holds no liquidity')
if (tickSpacing !== TICK_SPACING) {
  fail(`tickSpacing packed in parameters is ${tickSpacing}, not ${TICK_SPACING}`)
}
if (ev) expect('liquidity matches the Launched event', liquidity, ev.lpLiquidity, String)

/**
 * native per token, which is the INVERSE of what sqrtPriceX96 encodes here.
 *
 * `currency0` is native, so `(sqrtPriceX96 / 2^96)^2` is currency1 per
 * currency0 — tokens per native. Reporting that as "native/token" inverted
 * would print a price around 3e8 for a token worth 3e-9 and invite exactly
 * the wrong conclusion.
 */
const Q192 = 1n << 192n
const tokensPerNative = (sqrtPriceX96 * sqrtPriceX96) >> 192n
const spot = tokensPerNative === 0n ? 0n : (Q192 * 10n ** 18n) / (sqrtPriceX96 * sqrtPriceX96)
console.log(`        spot              ${ethers.formatUnits(spot, 8)} quote/token  (${tokensPerNative} token-wei per quote-unit)`)

// The pool price moves the instant anyone trades, so a difference from the
// opening price is information rather than a fault. Only the direction has to
// make sense against which way the reserves moved.
if (ev && sqrtPriceX96 !== ev.sqrtPriceX96) {
  const bps = ((sqrtPriceX96 - ev.sqrtPriceX96) * 20_000n) / ev.sqrtPriceX96
  const richer = sqrtPriceX96 < ev.sqrtPriceX96
  notes.push(
    `spot has moved ${bps < 0n ? -bps : bps} bps from the opening price: the token is `
    + `${richer ? 'DEARER' : 'CHEAPER'} in native than at launch, which agrees with the pool `
    + `holding ${tok(GENESIS_LP_SUPPLY - vaultTokenBal)} ${symbol} ${vaultTokenBal < GENESIS_LP_SUPPLY ? 'less' : 'more'} `
    + `than the ${tok(GENESIS_LP_SUPPLY)} seeded — someone has ${richer ? 'bought' : 'sold'}`,
  )
  if (richer !== (vaultTokenBal < GENESIS_LP_SUPPLY)) {
    fail('the price moved one way and the token reserve moved the other — '
      + 'a swap cannot do that, so one of these two reads is not of this pool')
  }
}

/**
 * Did the raise actually reach the pool?
 *
 * Derived from L and the current price rather than from `balanceOf`, because the
 * Vault is shared: its native balance is every pool's at once and says nothing
 * about this one. For a position spanning ±887 200 the bounds are far enough out
 * that dropping them costs a fraction of a percent, so this is checked as a
 * magnitude — it answers "the native is in there", not "to the wei".
 */
const poolEth = (liquidity << 96n) / sqrtPriceX96
const poolTokens = (liquidity * sqrtPriceX96) >> 96n
console.log(`        implied reserves  ${quote(poolEth)}  +  ${tok(poolTokens)} ${symbol}`)

const within = (a, b, pct) => {
  const diff = a > b ? a - b : b - a
  return b === 0n ? a === 0n : diff * 100n <= b * BigInt(pct)
}
if (!within(poolEth, lpNative, 2)) {
  fail(`the pool implies ${quote(poolEth)} of quote but launch() put in ${quote(lpNative)} — `
    + 'the raise did not land in the position it was supposed to')
} else {
  console.log(`  ok    pool quote is the raise less commission      ${quote(lpNative)} expected`)
}
if (!within(poolTokens, pmTokenBal, 2)) {
  notes.push(`reserves derived from L (${tok(poolTokens)}) and the manager's balance `
    + `(${tok(pmTokenBal)}) differ by more than 2% — worth a look if it grows`)
}

// ── Phase 2 / the shelf ladder ───────────────────────────────────────────────
console.log('\nLadder')
console.log(`        shelf index       ${tierIndex} of ${TIER_COUNT}`)
console.log(`        sold on shelf     ${tok(tierSold)} of ${tok(TIER_SIZE)}`)
console.log(`        phase 2 minted    ${tok(phase2)} of ${tok(TIER_COUNT * TIER_SIZE)}`)
if (tierIndex >= TIER_COUNT) notes.push('the ladder is exhausted')
if (phase2 !== tierIndex * TIER_SIZE + tierSold) {
  fail(`phase2Minted ${tok(phase2)} does not equal shelf*size+sold `
    + `(${tok(tierIndex * TIER_SIZE + tierSold)})`)
}

// ── Refunds must be dead ─────────────────────────────────────────────────────
console.log('\nRefunds')
console.log(`        canRefund()       ${canRefund}`)
// `canRefund()` is the authority; `refundAnnounced` is only an event-dedup
// flag and stays false until the first claimant. A `refundEnabled` getter used
// to print beside these and always read false, because nothing ever set it.
console.log(`        refundAnnounced   ${zombie}  (event dedup, not a gate)`)
if (canRefund) fail('canRefund() is true on a launched hook — depositors could withdraw a live pool')

// ── The creator's own position ───────────────────────────────────────────────
const [creatorDep, creatorClaimed, creatorRef] = await Promise.all([
  hook.nativeDeposited(creator), hook.genesisShareClaimed(creator), hook.referralAccrued(creator),
])
const creatorShare = totalNative === 0n ? 0n : (creatorDep * GENESIS_CLAIM_SUPPLY) / totalNative
console.log(`\nCreator ${creator}`)
console.log(`        deposited         ${quote(creatorDep)} of ${quote(totalNative)}`)
console.log(`        genesis claim     ${tok(creatorShare)} ${symbol} ${creatorClaimed ? '(claimed)' : '(unclaimed)'}`)
console.log(`        referral accrued  ${quote(creatorRef)}`)

// ── Verdict ──────────────────────────────────────────────────────────────────
if (notes.length > 0) {
  console.log('\nNotes')
  for (const n of notes) console.log(`  - ${n}`)
}

if (problems.length > 0) {
  console.log(`\n${problems.length} problem(s):`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  throw new CheckFailed('launch state does not match what launch() should have produced')
}

console.log('\nEvery derived value matches the chain. Pool live, refunds dead, supply accounted for.\n')
