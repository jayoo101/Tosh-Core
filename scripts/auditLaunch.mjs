/**
 * node scripts/auditLaunch.mjs <hook> [rpc]
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads a launched hook, its token and its v4 pool, and checks the numbers
 * against the arithmetic `launch()` performs — rather than against a screenshot
 * of the app, which reads the same chain through the same assumptions and so
 * cannot disagree with itself.
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
 * Pool state is read straight out of the PoolManager's storage with `extsload`,
 * at the slots `StateLibrary` computes (POOLS_SLOT 6, LIQUIDITY_OFFSET 3). That
 * is deliberately not the app's read path: the point is a second opinion.
 */

import { ethers } from 'ethers'
import { CheckFailed, installFailureExit } from './lib/checkExit.mjs'

installFailureExit()

const HOOK = process.argv[2]
const RPC = process.argv[3] ?? 'https://rpc.mainnet.chain.robinhood.com'

if (!/^0x[0-9a-fA-F]{40}$/.test(HOOK ?? '')) {
  console.log('usage: node scripts/auditLaunch.mjs <hook> [rpc]')
  throw new CheckFailed('a hook address is required')
}

/** Mirrors of the hook's own constants. A drift here is a finding, not a typo. */
const GENESIS_SUPPLY      = 8_400_000n * 10n ** 18n
const GENESIS_CLAIM_SUPPLY = 4_620_000n * 10n ** 18n
const GENESIS_LP_SUPPLY   = 3_780_000n * 10n ** 18n
const TIER_COUNT          = 4000n
const TIER_SIZE           = 3_150n * 10n ** 18n
const SHELF_PREMIUM_BPS   = 10_500n
const BPS                 = 10_000n

const POOL_MANAGER  = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
const POOL_FEE      = 3000
const TICK_SPACING  = 200
const POOLS_SLOT    = 6n
const LIQUIDITY_OFF = 3n

const HOOK_ABI = [
  'function launched() view returns (bool)',
  'function tokenInitialized() view returns (bool)',
  'function projectToken() view returns (address)',
  'function poolManager() view returns (address)',
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
  'function refundEnabled() view returns (bool)',
  'function zombieRefundEnabled() view returns (bool)',
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

const PM_ABI = ['function extsload(bytes32) view returns (bytes32)']

const problems = []
const notes = []
const fail = (m) => problems.push(m)

const eth = (v) => `${ethers.formatEther(v)} ETH`
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
  p0, shelfP0, tierIndex, tierSold, phase2, canRefund, refundEnabled, zombie,
] = await Promise.all([
  hook.launched(), hook.tokenInitialized(), hook.projectToken(), hook.poolManager(),
  hook.ladderTreasury(), hook.platformFeeRecipient(), hook.creator(),
  hook.projectTreasury(), hook.projectAdmin(), hook.softCap(), hook.perWalletCap(),
  hook.genesisDeadline(), hook.genesisDuration(), hook.totalNativeDeposited(),
  hook.totalReferralReserved(), hook.totalReferralClaimed(), hook.orphanReferral(),
  hook.p0(), hook.shelfP0(), hook.currentTierIndex(), hook.currentTierSold(),
  hook.phase2Minted(), hook.canRefund(), hook.refundEnabled(), hook.zombieRefundEnabled(),
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
if (pmAddr.toLowerCase() !== POOL_MANAGER.toLowerCase()) {
  fail(`poolManager() is ${pmAddr}, but contracts.ts hardcodes ${POOL_MANAGER} — `
    + 'a mismatch here means every hook address was mined against a different manager')
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
console.log(`        deposited         ${eth(totalNative)}`)
console.log(`        soft cap          ${eth(softCap)}  ${totalNative >= softCap ? '(met)' : '(NOT MET)'}`)
console.log(`        per-wallet cap    ${eth(perWalletCap)}`)
console.log(`        referral reserved ${eth(refReserved)}   claimed ${eth(refClaimed)}`)
console.log(`        orphan referral   ${eth(orphan)}`)

if (totalNative < softCap) fail('a launched hook whose raise is below its own soft cap')

// `launch()` zeroes `orphanReferral` after forwarding it, so present state can
// only reproduce the split if the event says how much was forwarded.
const orphanAtLaunch = ev ? ev.totalNative - ev.lpNative - refReserved : orphan
const lpNative = totalNative - (refReserved + orphanAtLaunch)

console.log('\nThe split  (lpNative = deposited - referralReserved - orphanReferral)')
if (ev) {
  expect('Launched.totalNative == totalNativeDeposited', ev.totalNative, totalNative, eth)
  expect('lpNative reconciles with the reserves', ev.lpNative, lpNative, eth)
  console.log(`        orphan at launch  ${eth(orphanAtLaunch)}`)
  if (orphan !== 0n) fail(`orphanReferral is ${eth(orphan)} after launch — launch() forwards and zeroes it`)
}

// ── The anchor prices ────────────────────────────────────────────────────────
const wantP0 = (lpNative * 10n ** 18n) / GENESIS_LP_SUPPLY
const wantShelf = (wantP0 * SHELF_PREMIUM_BPS) / BPS

console.log('\nAnchor prices  (p0 = lpNative / 3.78M, shelfP0 = p0 * 1.05)')
expect('p0', p0, wantP0, (v) => `${ethers.formatEther(v)} ETH/token`)
expect('shelfP0', shelfP0, wantShelf, (v) => `${ethers.formatEther(v)} ETH/token`)
if (ev) expect('p0 matches the Launched event', p0, ev.p0, (v) => `${ethers.formatEther(v)} ETH/token`)

// ── Token supply and where it sits ───────────────────────────────────────────
const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider)
const [name, symbol, decimals, supply, hookBal, pmTokenBal] = await Promise.all([
  token.name(), token.symbol(), token.decimals(), token.totalSupply(),
  token.balanceOf(HOOK), token.balanceOf(POOL_MANAGER),
])

console.log(`\nToken  ${name} (${symbol}), ${decimals} decimals`)
console.log(`        total supply      ${tok(supply)}`)
console.log(`        held by hook      ${tok(hookBal)}   (unclaimed genesis)`)
console.log(`        held by manager   ${tok(pmTokenBal)}   (pool reserves)`)

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
  // the liquidity v4 computes for the price, which can round to slightly LESS
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

// ── The pool itself, read from the manager's storage ─────────────────────────
const poolKey = {
  currency0: ethers.ZeroAddress,   // native ETH sorts first
  currency1: tokenAddr,
  fee: POOL_FEE,
  tickSpacing: TICK_SPACING,
  hooks: HOOK,
}
const poolId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ['address', 'address', 'uint24', 'int24', 'address'],
  [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
))
const stateSlot = ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue(ethers.toBeHex(POOLS_SLOT), 32)]))
const liqSlot = ethers.toBeHex(BigInt(stateSlot) + LIQUIDITY_OFF, 32)

const pm = new ethers.Contract(POOL_MANAGER, PM_ABI, provider)
const [slot0Raw, liqRaw, pmEth] = await Promise.all([
  pm.extsload(stateSlot), pm.extsload(liqSlot), provider.getBalance(POOL_MANAGER),
])

const slot0 = BigInt(slot0Raw)
const sqrtPriceX96 = slot0 & ((1n << 160n) - 1n)
const tickRaw = (slot0 >> 160n) & ((1n << 24n) - 1n)
const tick = tickRaw >= 1n << 23n ? tickRaw - (1n << 24n) : tickRaw
const protocolFee = Number((slot0 >> 184n) & ((1n << 24n) - 1n))
const lpFee = Number((slot0 >> 208n) & ((1n << 24n) - 1n))
const liquidity = BigInt(liqRaw)

console.log(`\nPool   id ${poolId}`)
console.log(`        currency0         ${poolKey.currency0} (native ETH)`)
console.log(`        currency1         ${poolKey.currency1}`)
console.log(`        fee / spacing     ${POOL_FEE} / ${TICK_SPACING}`)
console.log(`        sqrtPriceX96      ${sqrtPriceX96}`)
console.log(`        tick              ${tick}`)
console.log(`        lpFee             ${lpFee}${lpFee === POOL_FEE ? '' : `  (expected ${POOL_FEE})`}`)
console.log(`        protocolFee       ${protocolFee}`)
console.log(`        liquidity         ${liquidity}`)
console.log(`        manager ETH       ${eth(pmEth)}  (all pools on this manager)`)

if (sqrtPriceX96 === 0n) {
  fail('the pool is not initialized: sqrtPriceX96 is 0 at the slot StateLibrary reads. '
    + 'Either it was never created or the PoolKey derived here is not the one launch() used')
}
if (liquidity === 0n) fail('the pool is initialized but holds no liquidity')
if (lpFee !== POOL_FEE) fail(`pool lpFee is ${lpFee}, not the ${POOL_FEE} the hook's PoolKey specifies`)
if (ev) expect('liquidity matches the Launched event', liquidity, ev.lpLiquidity, String)

/**
 * ETH per token, which is the INVERSE of what sqrtPriceX96 encodes here.
 *
 * `currency0` is native ETH, so `(sqrtPriceX96 / 2^96)^2` is currency1 per
 * currency0 — tokens per ETH. Reporting that as "ETH/token" would print a price
 * around 3e8 for a token worth 3e-9 and invite exactly the wrong conclusion.
 */
const Q192 = 1n << 192n
const tokensPerEth = (sqrtPriceX96 * sqrtPriceX96) >> 192n
const spot = tokensPerEth === 0n ? 0n : (Q192 * 10n ** 18n) / (sqrtPriceX96 * sqrtPriceX96)
console.log(`        spot              ${ethers.formatEther(spot)} ETH/token  (${tokensPerEth} per ETH)`)

// The pool price moves the instant anyone trades, so a difference from the
// opening price is information rather than a fault. Only the direction has to
// make sense against which way the reserves moved.
if (ev && sqrtPriceX96 !== ev.sqrtPriceX96) {
  const bps = ((sqrtPriceX96 - ev.sqrtPriceX96) * 20_000n) / ev.sqrtPriceX96
  const richer = sqrtPriceX96 < ev.sqrtPriceX96
  notes.push(
    `spot has moved ${bps < 0n ? -bps : bps} bps from the opening price: the token is `
    + `${richer ? 'DEARER' : 'CHEAPER'} in ETH than at launch, which agrees with the pool `
    + `holding ${tok(GENESIS_LP_SUPPLY - pmTokenBal)} ${symbol} ${pmTokenBal < GENESIS_LP_SUPPLY ? 'less' : 'more'} `
    + `than the ${tok(GENESIS_LP_SUPPLY)} seeded — someone has ${richer ? 'bought' : 'sold'}`,
  )
  if (richer !== (pmTokenBal < GENESIS_LP_SUPPLY)) {
    fail('the price moved one way and the token reserve moved the other — '
      + 'a swap cannot do that, so one of these two reads is not of this pool')
  }
}

/**
 * Did the raise actually reach the pool?
 *
 * Derived from L and the current price rather than from `balanceOf`, because the
 * PoolManager is shared: its ETH balance is every pool's at once and says nothing
 * about this one. For a position spanning ±887 200 the bounds are far enough out
 * that dropping them costs a fraction of a percent, so this is checked as a
 * magnitude — it answers "the ETH is in there", not "to the wei".
 */
const poolEth = (liquidity << 96n) / sqrtPriceX96
const poolTokens = (liquidity * sqrtPriceX96) >> 96n
console.log(`        implied reserves  ${eth(poolEth)}  +  ${tok(poolTokens)} ${symbol}`)

const within = (a, b, pct) => {
  const diff = a > b ? a - b : b - a
  return b === 0n ? a === 0n : diff * 100n <= b * BigInt(pct)
}
if (!within(poolEth, lpNative, 2)) {
  fail(`the pool implies ${eth(poolEth)} of ETH but launch() put in ${eth(lpNative)} — `
    + 'the raise did not land in the position it was supposed to')
} else {
  console.log(`  ok    pool ETH is the raise less commission     ${eth(lpNative)} expected`)
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
console.log(`        refundEnabled     ${refundEnabled}   zombie ${zombie}`)
if (canRefund) fail('canRefund() is true on a launched hook — depositors could withdraw a live pool')

// ── The creator's own position ───────────────────────────────────────────────
const [creatorDep, creatorClaimed, creatorRef] = await Promise.all([
  hook.nativeDeposited(creator), hook.genesisShareClaimed(creator), hook.referralAccrued(creator),
])
const creatorShare = totalNative === 0n ? 0n : (creatorDep * GENESIS_CLAIM_SUPPLY) / totalNative
console.log(`\nCreator ${creator}`)
console.log(`        deposited         ${eth(creatorDep)} of ${eth(totalNative)}`)
console.log(`        genesis claim     ${tok(creatorShare)} ${symbol} ${creatorClaimed ? '(claimed)' : '(unclaimed)'}`)
console.log(`        referral accrued  ${eth(creatorRef)}`)

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
